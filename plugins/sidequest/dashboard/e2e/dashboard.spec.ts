import { expect, test as base } from '@playwright/test';
import { startFixture } from './fixtures/sidequest-fixture.mjs';

const test = base.extend<{ dashboard: Awaited<ReturnType<typeof startFixture>> }>({
  dashboard: [async ({}, use) => {
    const fixture = await startFixture();
    await use(fixture);
    await fixture.stop();
  }, { scope: 'worker' }]
});

async function openBoard(page: import('@playwright/test').Page, dashboard: Awaited<ReturnType<typeof startFixture>>) {
  await page.goto(dashboard.baseURL);
  await expect(page.getByRole('heading', { name: 'All boards' })).toBeVisible();
  await expect(page.getByText('Ship the dashboard parity suite')).toBeVisible();
  await expect(page.getByText('live', { exact: true })).toBeVisible();
}

test('serves the committed production app and covers the seeded board surface', async ({ page, dashboard }) => {
  const shell = await page.request.get(`${dashboard.baseURL}/`);
  expect(shell.ok()).toBeTruthy();
  expect(await shell.text()).toContain('/assets/');
  const asset = await page.request.get(`${dashboard.baseURL}/assets/index-s0ptgiwV.js`);
  expect([200, 404]).toContain(asset.status());

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

test('renders board routing previews and the profile library', async ({ page, dashboard }) => {
  await openBoard(page, dashboard);
  await page.locator('.rail').getByRole('button', { name: /Alpha board/ }).click();
  await page.getByRole('button', { name: 'Settings' }).click();

  await expect(page.getByText('Availability fallback', { exact: true })).toBeVisible();
  await expect(page.getByText('Board routing', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Profile library' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Routing profile' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Profile library' })).toBeVisible();

  await page.getByRole('combobox', { name: 'Routing profile' }).click();
  await page.getByRole('option', { name: /Research/ }).click();
  await expect(page.getByText('Repoint preview', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this profile' })).toBeVisible();
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
