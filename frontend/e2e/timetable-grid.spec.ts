import { test, expect } from '@playwright/test';

// Regression for the "squished timetable" defect: events must render with
// height proportional to their real duration inside a scrollable grid -
// never compressed into fixed 2-row blocks like the design mock.

const KEY = 'modsutd.timetable.consent.v3';

// Desktop needs panel scoping (the REVIEW panel also carries a textarea);
// mobile renders the timetable tab bare.
const scope = (page: import('@playwright/test').Page, isMobile: boolean | undefined) =>
  isMobile ? page.locator('body') : page.locator('[data-panel="tt"]');

// Synthetic MyPortal List View text, same grammar as the parser unit fixture.
// NOTE: instructor lines are load-bearing - without them the parser globs
// following lines into `instructors` (known fragility, tracked in
// a real MyPortal paste).
const PASTE = `
01.106 - Engineering Management
1010 LE01 Lecture
   Mo 09:00 - 11:00 2.101
       Prof. Test Fixture
   01/09/2026 - 13/12/2026
1010 CO01 Cohort Based Learning
   We 14:00 - 17:00 1.609
       Prof. Test Fixture
   01/09/2026 - 13/12/2026
`;

test.describe('timetable · grid geometry', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/timetable');
    await page.evaluate((k) => {
      localStorage.setItem(k, 'yes');
      localStorage.removeItem('modsutd.timetable.v1');
    }, KEY);
    await page.reload();
    // The panel now opens on the grid; pasting lives behind the first tab.
    await page.getByRole('button', { name: /generate timetable/i }).first().click();
  });

  test('event height is proportional to duration and the grid scrolls', async ({ page, isMobile }) => {
    // Parsing auto-contributes deidentified slots through the anonymous
    // relay - stub it and pin the privacy contract: only bare slot fields,
    // never instructors or dates.
    let contribution: { term?: string; slots?: Array<Record<string, unknown>> } | null = null;
    await page.route('**/api/contribute', async (route) => {
      contribution = route.request().postDataJSON();
      await route.fulfill({ status: 202, json: { accepted: contribution?.slots?.length ?? 0 } });
    });

    await scope(page, isMobile).locator('textarea').fill(PASTE);
    await page.getByRole('button', { name: /parse timetable/i }).click();

    await expect.poll(() => contribution !== null).toBe(true);
    const slots = contribution!.slots!;
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(Object.keys(s).sort()).toEqual(['day', 'end', 'mod', 'start', 'type', 'venue']);
    }

    // Scope to the grid: the header's now/next chip carries the same
    // "code @ room start-end" text whenever the fixture's weekday is today.
    const grid = page.locator('[data-act="tt-grid"]');
    const twoHour = grid.getByRole('button', { name: /01\.106.*09:00/s });
    const threeHour = grid.getByRole('button', { name: /01\.106.*14:00/s });
    await expect(twoHour).toBeVisible();
    await expect(threeHour).toBeVisible();

    const h2 = (await twoHour.boundingBox())!.height;
    const h3 = (await threeHour.boundingBox())!.height;
    // 3h block must be ~1.5× the 2h block (exact ratio, generous tolerance).
    expect(h3 / h2).toBeGreaterThan(1.4);
    expect(h3 / h2).toBeLessThan(1.6);
    // And it fills the day it is in. Every block carries data-tip, and
    // `[data-tip] { position: relative }` in global.scss has the same
    // specificity as the block's own class - the global sheet won, which made
    // left/right inert and shrank each block to the width of its own text.
    const col = page.locator('[data-act="tt-day"]').first();
    const colW = (await col.boundingBox())!.width;
    const evW = (await twoHour.boundingBox())!.width;
    expect(evW / colW).toBeGreaterThan(0.95);

    // And a 2h block is visibly two rows tall, not a squished sliver.
    expect(h2).toBeGreaterThan(50);

    // The grid lives in its own scroll container with a minimum width, so
    // narrow panels/viewports scroll instead of compressing the columns.
    await expect(grid).toBeVisible();
    const overflow = await grid.evaluate((el) => getComputedStyle(el).overflow);
    expect(overflow).toContain('auto');

    // The flagship export unlocks once events exist.
    // The button no longer counts the events, so this asserts it is offered at
    // all - the count was never what this test is about.
    await expect(page.getByRole('button', { name: /\.ics/ })).toBeEnabled();
  });
});
