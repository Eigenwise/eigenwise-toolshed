import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { startFixture } from './fixtures/sidequest-fixture.mjs';

const test = base.extend<{ dashboard: Awaited<ReturnType<typeof startFixture>> }>({
  dashboard: [async ({}, use) => {
    const fixture = await startFixture();
    await use(fixture);
    await fixture.stop();
  }, { scope: 'worker' }]
});

function channel(value: number) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function contrast(first: string, second: string) {
  const luminance = (color: string) => {
    const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    if (channels.length !== 3) throw new Error(`Expected an RGB color, received ${color}`);
    return 0.2126 * channel(channels[0]) + 0.7152 * channel(channels[1]) + 0.0722 * channel(channels[2]);
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

async function tokenColor(page: Page, token: string) {
  return page.evaluate((name) => {
    const sample = document.createElement('span');
    sample.style.color = `var(${name})`;
    document.body.append(sample);
    const color = getComputedStyle(sample).color;
    sample.remove();
    return color;
  }, token);
}

async function questlineColor(card: Locator) {
  return card.locator('.questline').evaluate((element) => getComputedStyle(element).backgroundColor);
}

async function renderedCompactTextColors(row: Locator, selector: string) {
  return row.locator(selector).evaluate((element) => {
    const categoryRow = element.closest('.category-row');
    if (!categoryRow) throw new Error('Expected compact text inside a category row.');
    return {
      foreground: getComputedStyle(element).color,
      background: getComputedStyle(categoryRow).backgroundColor,
      opacity: getComputedStyle(categoryRow).opacity
    };
  });
}

async function renderedCardTextColors(chip: Locator) {
  return chip.evaluate((element) => {
    const rgb = (color: string) => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Expected a canvas context.');
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      if (alpha !== 255) throw new Error(`Expected an opaque chip color, received ${color}.`);
      return `rgb(${red}, ${green}, ${blue})`;
    };
    const style = getComputedStyle(element);
    return { foreground: rgb(style.color), background: rgb(style.backgroundColor) };
  });
}

async function cssColor(page: Page, color: string) {
  return page.evaluate((value) => {
    const sample = document.createElement('span');
    sample.style.backgroundColor = value;
    document.body.append(sample);
    const resolved = getComputedStyle(sample).backgroundColor;
    sample.remove();
    return resolved;
  }, color);
}

async function assertDialogGeometry(dialog: Locator) {
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(24);
  expect(box!.y).toBeGreaterThanOrEqual(24);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1416);
  expect(box!.y + box!.height).toBeLessThanOrEqual(876);
  expect(Math.abs((box!.x + box!.width / 2) - 720)).toBeLessThanOrEqual(1);
  expect(Math.abs((box!.y + box!.height / 2) - 450)).toBeLessThanOrEqual(1);
}

async function openBoard(page: Page, dashboard: Awaited<ReturnType<typeof startFixture>>) {
  await page.goto(dashboard.baseURL);
  await expect(page.getByRole('heading', { name: 'All boards' })).toBeVisible();
  await expect(page.getByText('Ship the dashboard parity suite')).toBeVisible();
  await expect(page.getByText('live', { exact: true })).toBeVisible();
}

async function cardFor(page: Page, title: string) {
  return page.locator('.card').filter({ hasText: title });
}

async function assertBoardCardGeometry(page: Page) {
  const geometry = await page.locator('.board').evaluate((board) => {
    const rect = (element: Element) => element.getBoundingClientRect();
    const columns = [...board.querySelectorAll('.column')];
    const cards = [...board.querySelectorAll('.column:first-child .card')];
    const firstCard = cards[0];
    const secondCard = cards[1];
    if (!columns.length || !firstCard || !secondCard) throw new Error('Expected two cards in the first board column.');
    const column = rect(columns[0]);
    const first = rect(firstCard);
    const second = rect(secondCard);
    const content = rect(firstCard.querySelector('.card-main')!);
    const cardStyle = getComputedStyle(firstCard);
    return {
      columnInset: first.left - column.left,
      cardGap: second.top - first.bottom,
      contentInset: Math.min(content.left - first.left, first.right - content.right, content.top - first.top),
      cardBorder: cardStyle.borderTopWidth,
      cardShadow: cardStyle.boxShadow,
      pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });
  expect(geometry.columnInset).toBeGreaterThanOrEqual(12);
  expect(geometry.cardGap).toBeGreaterThanOrEqual(8);
  expect(geometry.contentInset).toBeGreaterThanOrEqual(10);
  expect(geometry.cardBorder).toBe('1px');
  expect(geometry.cardShadow).not.toBe('none');
  expect(geometry.pageOverflows).toBeFalsy();
}

async function assertDialogTreatment(dialog: Locator, content: Locator, scrollBody: Locator) {
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: window.innerWidth - rect.right,
      top: rect.top,
      bottom: window.innerHeight - rect.bottom,
      overflow: getComputedStyle(element).overflow
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(24);
  expect(geometry.right).toBeGreaterThanOrEqual(24);
  expect(geometry.top).toBeGreaterThanOrEqual(24);
  expect(geometry.bottom).toBeGreaterThanOrEqual(24);
  expect(Math.abs(geometry.left - geometry.right)).toBeLessThanOrEqual(2);
  expect(geometry.overflow).toBe('hidden');

  const chrome = await content.evaluate((element) => {
    const contentRect = element.getBoundingClientRect();
    const dialogRect = element.closest('dialog')?.getBoundingClientRect();
    if (!dialogRect) throw new Error('Expected dialog content inside a dialog.');
    return { left: contentRect.left - dialogRect.left, top: contentRect.top - dialogRect.top };
  });
  expect(chrome.left).toBeGreaterThanOrEqual(20);
  expect(chrome.top).toBeGreaterThanOrEqual(20);

  const scroll = await scrollBody.evaluate((element) => ({ overflow: getComputedStyle(element).overflowY, scrollable: element.scrollHeight > element.clientHeight }));
  expect(scroll).toEqual({ overflow: 'auto', scrollable: true });
}

test('serves the committed production app and covers the seeded board surface', async ({ page, dashboard }) => {
  const shell = await page.request.get(`${dashboard.baseURL}/`);
  expect(shell.ok()).toBeTruthy();
  const html = await shell.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map((match) => match[1]);
  expect(assets.length).toBeGreaterThan(0);
  const bundle = (await Promise.all(assets.map(async (asset) => {
    const response = await page.request.get(`${dashboard.baseURL}${asset}`);
    expect(response.ok()).toBeTruthy();
    return response.text();
  }))).join('\n');
  expect(bundle).toContain('questline');
  expect(bundle).toContain('#f4f2ec');

  await openBoard(page, dashboard);
  await expect(page.getByText('Alpha board').first()).toBeVisible();
  await expect(page.getByText('Beta board').first()).toBeVisible();
  await expect(page.getByText('Parity rollout')).toBeVisible();
  await expect(page.getByText('General fallback', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('acceptance', { exact: true })).toBeVisible();
  await expect(page.getByText('comments 2', { exact: true })).toBeVisible();
  await expect(page.getByText('blocked', { exact: true })).toBeVisible();
  await expect(page.getByText('reminder', { exact: true })).toBeVisible();
  await expect(page.getByText('Archived boards', { exact: false })).toBeVisible();

  await page.getByRole('textbox', { name: 'Search tickets' }).fill('parity');
  await expect(page.getByText('Ship the dashboard parity suite')).toBeVisible();
  await expect(page.getByText('Beta board ticket')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search tickets' }).press('Escape');

  await page.getByRole('button', { name: /Assignee: Everyone/ }).click();
  await page.getByRole('menuitemradio', { name: 'Mine' }).click();
  await expect(page.getByText('Ship the dashboard parity suite')).toBeVisible();

  await page.getByRole('button', { name: /Sort: Manual/ }).click();
  await page.getByRole('menuitemradio', { name: 'Priority' }).click();
  await expect(page.getByRole('button', { name: /Sort: Priority/ })).toBeVisible();

  await page.getByRole('button', { name: 'Open fixture.png' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: /Ship the dashboard parity suite/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Legacy question should render as a plain comment.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Question/i })).toHaveCount(0);
  await expect(page.getByText('Legacy question should render as a plain comment.').locator('..').getByText('Comment')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
});

test('covers archive, notification, settings, create, and keyboard paths', async ({ page, dashboard }) => {
  await openBoard(page, dashboard);

  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('button', { name: /Archived ticket/ })).toBeVisible();
  await expect(page.getByText('Restore', { exact: true })).toBeVisible();
  await page.locator('.archive-button').click();

  await page.getByRole('button', { name: /Notifications/ }).click();
  await expect(page.getByRole('region', { name: 'Notifications' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.workspace').click({ position: { x: 5, y: 500 } });

  await page.getByRole('button', { name: /Settings/ }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.keyboard.press('n');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: /New ticket|Create ticket/ })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: /Ship the dashboard parity suite/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('textbox', { name: /Title/ }).press('Control+Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('returns focus to Settings and Ticket invokers for every close path', async ({ page, dashboard }) => {
  await openBoard(page, dashboard);

  const settingsTrigger = page.getByRole('button', { name: 'Settings' });
  const settings = page.locator('dialog[aria-label="Settings"]');
  for (const closeSettings of [
    async () => page.keyboard.press('Escape'),
    async () => page.getByRole('button', { name: 'Close settings' }).click(),
    async () => page.mouse.click(4, 4)
  ]) {
    await settingsTrigger.click();
    await expect(settings).toBeVisible();
    await closeSettings();
    await expect(settings).not.toHaveAttribute('open', '');
    await expect(settingsTrigger).toBeFocused();
  }

  const ticketTrigger = page.getByRole('button', { name: /Ship the dashboard parity suite/ });
  const ticket = page.locator('dialog.ticket-dialog');
  for (const closeTicket of [
    async () => page.keyboard.press('Escape'),
    async () => page.getByRole('button', { name: 'Close' }).click(),
    async () => page.mouse.click(4, 4),
    async () => page.getByRole('textbox', { name: 'Title' }).press('Control+Enter')
  ]) {
    await ticketTrigger.click();
    await expect(ticket).toBeVisible();
    await closeTicket();
    await expect(ticket).not.toHaveAttribute('open', '');
    await expect(ticketTrigger).toBeFocused();
  }
});

test('renders board routing previews and the profile library', async ({ page, dashboard }) => {
  await openBoard(page, dashboard);
  await page.locator('.rail').getByRole('button', { name: /Alpha board/ }).click();
  await page.getByRole('button', { name: 'Settings' }).click();

  await expect(page.getByText('Availability fallback', { exact: true })).toBeVisible();
  await expect(page.getByText('Board routing', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Profile library' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Routing profile' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Profile library' })).toBeVisible();
  await expect(page.getByText(/Following/)).toBeVisible();

  await page.getByRole('combobox', { name: 'Routing profile' }).click();
  await page.getByRole('option', { name: /Research fixture/ }).click();
  await expect(page.getByRole('combobox', { name: 'Routing profile' })).toContainText('Research fixture');

  await page.getByRole('combobox', { name: 'Profile library' }).click();
  await page.getByRole('option', { name: /Research fixture/ }).click();
  await expect(page.locator('.profile-library h3')).toHaveText('Research fixture');
});

test('keeps Questline state, accessible tokens, cards, and dialogs correct in both themes', async ({ page, dashboard }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBoard(page, dashboard);

  const storyCard = await cardFor(page, 'Ship the dashboard parity suite');
  const todoCard = await cardFor(page, 'Beta board ticket');
  const doingCard = await cardFor(page, 'Investigate stale agent claim');
  const doneCard = await cardFor(page, 'Completed seeded work');
  await expect(storyCard.locator('.claim-node')).toHaveCount(1);
  await expect(todoCard.locator('.claim-node')).toHaveCount(0);
  expect(await questlineColor(storyCard)).toBe(await cssColor(page, '#8c6cff'));
  expect(await questlineColor(todoCard)).toBe(await tokenColor(page, '--status-todo'));
  expect(await questlineColor(doingCard)).toBe(await tokenColor(page, '--status-doing'));
  expect(await questlineColor(doneCard)).toBe(await tokenColor(page, '--status-done'));
  await expect(page.locator('.cards').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(storyCard.locator('.card-main')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(storyCard).toHaveCSS('background-color', await tokenColor(page, '--surface-card'));
  await assertBoardCardGeometry(page);

  const lightbox = page.locator('dialog[aria-label^="Image"]');
  await expect(lightbox).toHaveCount(1);
  await expect(lightbox).not.toHaveAttribute('open', '');

  const tokenSets: string[][] = [];
  for (const theme of ['light', 'dark']) {
    await page.locator('html').evaluate((element, value) => element.dataset.theme = value, theme);
    for (const chip of [storyCard.locator('.story'), storyCard.locator('.priority.urgent'), doingCard.locator('.priority.high'), doingCard.locator('.chip.blocked'), storyCard.locator('.chip.reminder')]) {
      const rendered = await renderedCardTextColors(chip);
      expect(contrast(rendered.foreground, rendered.background)).toBeGreaterThanOrEqual(4.5);
    }
  }

  for (const theme of ['light', 'dark']) {
    await page.locator('html').evaluate((element, value) => element.dataset.theme = value, theme);
    const colors = await Promise.all(['--text-muted', '--surface-muted', '--accent-strong', '--surface-card'].map((token) => tokenColor(page, token)));
    tokenSets.push(colors);
    expect(contrast(colors[0], colors[1])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors[2], colors[3])).toBeGreaterThanOrEqual(3);

    const settingsTrigger = page.getByRole('button', { name: /Settings/ });
    await settingsTrigger.focus();
    await expect(settingsTrigger).toHaveCSS('box-shadow', /rgb/);
    await page.locator('.rail').getByRole('button', { name: /Alpha board/ }).click();
    await settingsTrigger.click();
    const settings = page.locator('dialog[aria-label="Settings"]');
    await expect(settings).toBeVisible();
    await assertDialogGeometry(settings);
    await assertDialogTreatment(settings, settings.locator('header h2'), settings.locator('.settings-body'));
    const profileRow = page.locator('.category-row').filter({ hasText: 'Fixture category 1' }).first();
    const profileBadge = profileRow.locator('.row-badge');
    await expect(profileBadge).toBeVisible();
    if (theme === 'light') await expect(profileBadge).toHaveText('Profile');
    const badgeStyle = await profileBadge.evaluate((element) => {
      const name = element.parentElement?.querySelector('strong');
      if (!name) throw new Error('Expected category name.');
      const badge = element.getBoundingClientRect();
      const title = name.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { gap: badge.left - title.right, border: style.borderTopWidth, background: style.backgroundColor };
    });
    expect(badgeStyle.gap).toBeGreaterThanOrEqual(8);
    expect(badgeStyle.border).toBe('0px');
    expect(badgeStyle.background).not.toBe('rgba(0, 0, 0, 0)');
    await page.getByRole('button', { name: 'Board changes' }).click();
    const fixtureCategoryId = page.locator('code', { hasText: /^fixture-category-1$/ });
    const categoryRow = page.locator('.category-row').filter({ has: fixtureCategoryId });
    await expect(categoryRow).toBeVisible();
    const disableCategory = categoryRow.getByRole('button', { name: 'Disable' });
    if (await disableCategory.count()) await disableCategory.click();
    const disabledCategory = page.locator('.category-row.disabled').filter({ has: fixtureCategoryId });
    await expect(disabledCategory).toBeVisible();
    await expect(disabledCategory.getByRole('button', { name: 'Edit' })).toBeEnabled();
    await expect(disabledCategory.getByRole('button', { name: 'Re-enable' })).toBeEnabled();
    for (const selector of ['code', 'small', '.category-meta']) {
      const colors = await renderedCompactTextColors(disabledCategory, selector);
      expect(colors.opacity).toBe('1');
      expect(contrast(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(await page.locator('.settings-body').evaluate((element) => element.scrollHeight > element.clientHeight)).toBeTruthy();
    await page.mouse.click(4, 4);
    await expect(settings).not.toHaveAttribute('open', '');

    await page.getByRole('button', { name: /Ship the dashboard parity suite/ }).click();
    const ticket = page.locator('dialog.ticket-dialog');
    await expect(ticket).toBeVisible();
    await assertDialogGeometry(ticket);
    await assertDialogTreatment(ticket, ticket.locator('.dialog-header h2'), page.locator('.main-grid'));
    expect(await page.locator('.main-grid').evaluate((element) => element.scrollHeight > element.clientHeight)).toBeTruthy();
    expect(await page.locator('.main-grid').evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Open fixture.png' }).click();
    await expect(lightbox).toBeVisible();
    await assertDialogGeometry(lightbox);
    await expect(lightbox.locator('img')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(lightbox).not.toHaveAttribute('open', '');
  }
  expect(tokenSets[0]).not.toEqual(tokenSets[1]);

  await page.getByRole('button', { name: 'Open fixture.png' }).click();
  await expect(lightbox).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(lightbox).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Open fixture.png' }).click();
  await expect(lightbox).toHaveAttribute('open', '');
});

test('keeps the layout usable at all parity breakpoints and honors reduced motion', async ({ page, dashboard }) => {
  await openBoard(page, dashboard);
  for (const width of [1024, 880, 820, 720, 700, 480]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.getByText('Ship the dashboard parity suite')).toBeVisible();
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const motion = await page.locator('body').evaluate((element) => getComputedStyle(element).getPropertyValue('--motion-fast').trim());
  expect(motion).toBe('0ms');
  await page.setViewportSize({ width: 820, height: 900 });
  expect(await page.locator('.rail').evaluate((element) => getComputedStyle(element).minHeight)).toBe('auto');
  await page.setViewportSize({ width: 720, height: 900 });
  await page.getByRole('button', { name: /Ship the dashboard parity suite/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const dialogColumns = await page.locator('.main-grid').evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(dialogColumns.split(' ').length).toBe(1);
});

test('recovers from offline refresh and reloads once on a health identity change', async ({ page, dashboard }) => {
  let healthCalls = 0;
  await page.route('**/api/health', async (route) => {
    healthCalls += 1;
    const response = await route.fetch();
    if (healthCalls === 1) {
      await route.fulfill({ response, json: { ok: true, name: 'sidequest', pid: 999, startedAt: new Date().toISOString(), version: 'fixture-reload' } });
      return;
    }
    await route.fulfill({ response });
  });
  await page.goto(dashboard.baseURL);
  await expect(page.getByText('live', { exact: true })).toBeVisible();
  await page.unroute('**/api/health');
  await page.route('**/api/projects', async (route) => route.abort());
  await page.waitForTimeout(2_700);
  await expect(page.getByText('offline', { exact: true })).toBeVisible();
  await page.unroute('**/api/projects');
  await page.reload();
  await expect(page.getByText('live', { exact: true })).toBeVisible();
});
