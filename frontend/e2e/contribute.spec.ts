import { test, expect } from '@playwright/test';

// The panel that used to be ABOUT. It asks for things, so it has to say what
// they cost and who has already given them.

const CONTRIBUTORS = [
  { login: 'someone', html_url: 'https://github.com/someone', avatar_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', contributions: 120 },
  { login: 'another', html_url: 'https://github.com/another', avatar_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', contributions: 9 },
  { login: 'a-bot[bot]', html_url: 'https://github.com/apps/a-bot', avatar_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', contributions: 400 },
];

async function open(page: import('@playwright/test').Page, isMobile: boolean | undefined) {
  await page.goto('/');
  if (isMobile) {
    // Scoped to the bottom nav: "more" also appears elsewhere on the page, and
    // an unscoped name match is a strict-mode violation waiting for whichever
    // other control renders first.
    await page.locator('nav[aria-label="primary"]').getByRole('button', { name: /more/i }).click();
    await page.getByRole('button', { name: /contribute/i }).click();
  } else {
    await page.locator('button[aria-label="Contribute"]').click();
  }
}

test.describe('contribute panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api.github.com/repos/**/contributors**', (r) =>
      r.fulfill({ json: CONTRIBUTORS }));
  });

  test('ranks contributors by commits, and leaves the bots out', async ({ page, isMobile }) => {
    await open(page, isMobile);
    const list = page.locator('[data-act="contributors"] li');
    await expect(list).toHaveCount(2);
    await expect(list.first()).toContainText('someone');
    await expect(list.first()).toContainText('120');
    // A bot with 400 commits would top the list and mean nothing.
    await expect(page.locator('[data-act="contributors"]')).not.toContainText('a-bot');
  });

  // Asking for money without showing the bill is how a student project loses
  // people, so the accounting is in the panel, not a file somewhere else.
  test('the costs open in place, and start closed', async ({ page, isMobile }) => {
    await open(page, isMobile);
    const costs = page.locator('[data-act="costs"]');
    await expect(costs).toBeVisible();
    // Closed by default: a reader who only wants the one-line answer should
    // not have to scroll past a ledger to reach the rest of the panel.
    await expect(costs.locator('table')).toBeHidden();
    await costs.locator('summary').click();
    await expect(costs.getByText(/Student Developer Pack/i).first()).toBeVisible();
    await expect(costs.locator('table')).toBeVisible();
  });

  // GitHub goes down, rate-limits, and returns 403 to a browser often enough
  // that a permanent "loading…" would be the normal state.
  test('says so when github will not answer', async ({ page, isMobile }) => {
    await page.route('**/api.github.com/repos/**/contributors**', (r) =>
      r.fulfill({ status: 403, json: { message: 'rate limited' } }));
    await open(page, isMobile);
    await expect(page.getByText(/github is not answering/i)).toBeVisible();
  });

  // The card used to carry two links to the issue templates, and a reader who
  // clicked one filed an issue - which is the one thing the Discuss panel
  // exists to save them from. It raises that panel instead, the way the clock
  // raises the timetable.
  test('features & bugs opens the discuss panel, and never an issue form', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'the rail and panels are the desktop affordance');
    await open(page, isMobile);
    const panel = page.locator('[data-panel="contribute"]');
    await expect(panel.locator('a[href*="issues/new"]')).toHaveCount(0);

    await expect(page.locator('[data-panel="discuss"]')).toHaveCount(0);
    await panel.locator('[data-act="open-discuss"]').click();
    await expect(page.locator('[data-panel="discuss"]')).toBeVisible();
  });
});
