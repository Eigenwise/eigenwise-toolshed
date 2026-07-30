import { expect, test as base, type Page } from '@playwright/test';
import { seedTourProgress, startFixture } from './fixtures/sidequest-fixture.mjs';

type Dashboard = Awaited<ReturnType<typeof startFixture>>;
const test = base.extend<{ dashboard: Dashboard; tourSeen: boolean }>({
  tourSeen: [false, { option: true }],
  context: async ({ context, tourSeen }, use) => {
    await seedTourProgress(context, tourSeen);
    await use(context);
  },
  dashboard: [async ({}, use) => {
    const fixture = await startFixture();
    await use(fixture);
    await fixture.stop();
  }, { scope: 'worker' }]
});

const tour = (page: Page) => page.getByRole('dialog', { name: 'Product tour' });
const counter = (page: Page) => tour(page).locator('.counter');
const next = (page: Page) => tour(page).getByRole('button', { name: /^(Next|Finish)$/ });

async function openBoard(page: Page, dashboard: Dashboard) {
  await page.goto(dashboard.baseURL);
  await expect(page.getByRole('heading', { name: 'All boards' })).toBeVisible();
  await expect(tour(page)).toBeVisible();
}

async function advance(page: Page, count: number) {
  for (let index = 0; index < count; index += 1) await next(page).click();
}

async function finishTour(page: Page) {
  while (await next(page).filter({ hasText: 'Next' }).count()) await next(page).click();
  await next(page).click();
  await expect(tour(page)).toBeHidden();
}

test('auto-starts, advances through every seeded anchor, and stacks above the ticket dialog', async ({ page, dashboard }) => {
  await openBoard(page, dashboard);
  await expect(counter(page)).toHaveText('1 of 14');

  const rail = await page.locator('[data-tour="project-rail"]').boundingBox();
  expect(rail).not.toBeNull();
  await advance(page, 1);
  await expect(counter(page)).toHaveText('2 of 14');
  const search = await page.locator('[data-tour="search"]').boundingBox();
  expect(search).not.toBeNull();
  expect(search).not.toEqual(rail);

  for (const [id, count] of [['story-filter', 5], ['board-columns', 6], ['ticket-card', 7]] as const) {
    await advance(page, count - (count === 5 ? 1 : count === 6 ? 5 : 6));
    await expect(page.locator(`[data-tour="${id}"]`).first()).toBeVisible();
  }

  await advance(page, 2);
  await expect(counter(page)).toHaveText('10 of 14');
  await expect(page.getByRole('dialog', { name: 'New ticket' })).toBeVisible();
  await expect(next(page)).toBeVisible();
  await expect(next(page)).toBeEnabled();
  await next(page).click();
  await expect(counter(page)).toHaveText('11 of 14');

  const firstSpotlight = await page.locator('.spotlight').boundingBox();
  await next(page).click();
  await expect(counter(page)).toHaveText('12 of 14');
  const secondSpotlight = await page.locator('.spotlight').boundingBox();
  expect(secondSpotlight).not.toEqual(firstSpotlight);

  await advance(page, 2);
  await expect(counter(page)).toHaveText('14 of 14');
  await next(page).click();
  await expect(tour(page)).toBeHidden();
});

test('Escape skips and completion persists across reloads', async ({ page, dashboard }) => {
  await openBoard(page, dashboard);
  await page.keyboard.press('Escape');
  await expect(tour(page)).toBeHidden();
  await page.reload();
  await expect(tour(page)).toBeHidden();

  await page.evaluate(() => localStorage.removeItem('sq_tour'));
  await page.reload();
  await expect(tour(page)).toBeVisible();
  await finishTour(page);
  await page.reload();
  await expect(tour(page)).toBeHidden();
});

test('resumes from the saved step after a reload', async ({ page, dashboard }) => {
  await openBoard(page, dashboard);
  await advance(page, 3);
  await expect(counter(page)).toHaveText('4 of 14');
  await page.reload();
  await expect(counter(page)).toHaveText('4 of 14');
});

test('replays from Settings and starts from the board shortcut, but not from search', async ({ page, dashboard }) => {
  await openBoard(page, dashboard);
  await finishTour(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Replay the tour' }).click();
  await expect(page.getByRole('button', { name: 'Replay the tour' })).toBeHidden();
  await expect(counter(page)).toHaveText('1 of 14');
  await page.keyboard.press('Escape');

  await page.keyboard.press('?');
  await expect(counter(page)).toHaveText('1 of 14');
  await page.keyboard.press('Escape');
  const search = page.getByRole('textbox', { name: 'Search tickets' });
  await search.focus();
  await page.keyboard.press('?');
  await expect(tour(page)).toBeHidden();
});

test('completes on an empty board and skips optional board anchors', async ({ page, dashboard }) => {
  const tickets = await (await page.request.get(`${dashboard.baseURL}/api/tickets?project=all`)).json();
  for (const ticket of tickets.tickets ?? []) {
    await page.request.delete(`${dashboard.baseURL}/api/tickets/${ticket.id}?project=${ticket.project}`);
  }

  await openBoard(page, dashboard);
  await expect(page.getByText('No side quests yet')).toBeVisible();
  await expect(page.locator('[data-tour="board-columns"]')).toHaveCount(0);
  await expect(page.locator('[data-tour="ticket-card"]')).toHaveCount(0);
  await finishTour(page);
});
