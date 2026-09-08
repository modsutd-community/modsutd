import { test, expect } from '@playwright/test';

// A contribution has to be visible before the build that ships it, and it has
// to STAY visible across a reload - it lives in localStorage precisely so the
// reader who pasted is not told to come back later and then shown nothing.
const KEY = 'modsutd.timetable.consent.v3';
const STORE = 'modsutd.contributed.v3';

const PASTE = `
01.106 - Engineering Management
1010 LE01 Lecture
   Mo 09:00 - 11:00 2.101
       Prof. Test Fixture
   01/09/2026 - 13/12/2026
`;

test.describe('contributed overlay', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/contribute', (r) => r.fulfill({ json: { ok: true } }));
    await page.goto('/timetable');
    await page.evaluate((k) => localStorage.setItem(k, 'yes'), KEY);
    await page.reload();
    await page.getByRole('button', { name: /generate timetable/i }).first().click();
  });

  test('survives a reload', async ({ page, isMobile }) => {
    const box = (isMobile ? page.locator('body') : page.locator('[data-panel="tt"]')).locator('textarea');
    await box.fill(PASTE);
    await page.getByRole('button', { name: /^parse/i }).first().click();

    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), STORE), { timeout: 10_000 })
      .toContain('01.106');

    await page.reload();
    // The whole point: still there, and still attached to the mod.
    expect(await page.evaluate((k) => localStorage.getItem(k), STORE)).toContain('01.106');
    const sched = await page.evaluate(async () => {
      const r = await fetch('/data/courses.json');
      return ((await r.json()) as Array<{ code: string; schedules: unknown[] }>)
        .find((c) => c.code === '01.106')?.schedules.length;
    });
    expect(sched, 'deployed data must still be empty, or this proves nothing').toBe(0);
  });

  // The whole point of keeping the slots locally: both the heatmap and the
  // chat are usable the moment the paste is accepted. The chat works this
  // early because the relay validates against main, where the contribution
  // auto-commits in about a minute - the four-hour wait was only ever the
  // build, and nothing needs it.
  test('offers the heatmap and the chat straight away', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await page.route('**/data/term-window.json', (r) =>
      r.fulfill({ json: { start: '2026-01-01', end: '2099-01-01' } }));
    await page.route(/telegram-groups\.json/, (r) => r.fulfill({
      json: { '01.106': { linkEnc: 'v1:stub:stub', title: 'x', created: '2026-07', expires: '2099-01-01' } },
    }));

    const box = page.locator('[data-panel="tt"]').locator('textarea');
    await box.fill(PASTE);
    await page.getByRole('button', { name: /^parse/i }).first().click();
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), STORE), { timeout: 10_000 })
      .toContain('01.106');

    // The room the contribution filled is warm straight away.
    await page.goto('/venues?focus=2.101');
    await expect.poll(() => page.evaluate(() => document.body.innerText.includes('01.106')),
      { timeout: 10_000 }).toBe(true);

    // And so is the chat - the real button, not the waiting one.
    await page.goto('/mods/01.106');
    await expect(page.getByRole('button', { name: /Join the Tele chat/ })).toBeVisible();
    await expect(page.locator('[data-act="tele-awaiting"]')).toHaveCount(0);
  });
});
