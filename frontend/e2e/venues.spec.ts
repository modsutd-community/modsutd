import { test, expect } from '@playwright/test';
import { coursesWithSchedules } from './support/courses';

// Room finder: every venue as a FREE/BUSY cell probed at (day, time), with
// the time typeable to ANY valid HH:MM - not just the quick chips. Clicking
// a room opens its detail: weekly heatmap, directions, campus map link.

// Shipped data carries NO schedules until students crowdsource them (the
// honesty rule) - so occupancy behaviour is exercised by injecting one
// synthetic slot at the network layer, never by committing fake data.
async function withSeededSlot(page: import('@playwright/test').Page) {
  await page.route('**/data/courses.json', (r) => r.fulfill({
    json: coursesWithSchedules(['10.013'], [{
      type: 'Lecture', day: 'Monday', startTime: '09:00', endTime: '11:00',
      location: '2.101', instructors: [],
    }]),
  }));
  await page.reload();
}

test.describe('room finder', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/venues');
  });

  test('lists venues incl. 1.102 (Albert Hong Lecture Theatre 1)', async ({ page }) => {
    await expect(page.locator('button[data-code="1.102"]')).toBeVisible();
  });

  test('probe time is typeable to any valid HH:MM and flips FREE/BUSY', async ({ page }) => {
    await withSeededSlot(page); // 10.013 Monday 09:00–11:00 in 2.101
    const time = page.getByLabel(/probe time/i);
    const room = page.locator('button[data-code="2.101"]');
    await page.getByLabel('probe day').selectOption('Monday');

    await time.fill('09:37');
    await time.press('Enter');
    await expect(room).toContainText('BUSY');

    await time.fill('07:15');
    await time.press('Enter');
    await expect(room).toContainText('FREE');
  });

  test('rejects nonsense times without changing the probe', async ({ page }) => {
    const time = page.getByLabel(/probe time/i);
    await time.fill('25:99');
    await time.press('Enter');
    await expect(time).toHaveAttribute('aria-invalid', 'true');
    const hint = page.locator('#wb-time-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/valid 24h time/i);
  });

  test('clicking a room opens its detail with the weekly heatmap', async ({ page }) => {
    await withSeededSlot(page);
    await page.locator('button[data-code="2.101"]').click();
    const heatmap = page.locator('[data-act="room-heatmap"]');
    await expect(heatmap).toBeVisible();
    // The seeded slot renders as an occupied cell carrying its mod.
    await expect(heatmap.getByText('10.013').first()).toBeVisible();
    // Where it is, which replaced nine hand-written sentences about which room
    // is next to which.
    await expect(page.locator('[data-act="campus-map"]')).toBeVisible();
    // "← rooms" always offers the way back - the detail must never trap you.
    await page.getByRole('button', { name: /← rooms/ }).click();
    await expect(page.locator('[data-act="room-heatmap"]')).toHaveCount(0);
  });

  // Both of these broke when the heatmap moved from whole-hour cells to
  // proportional bars, and neither is visible to a test that only asserts the
  // mod code is present.
  test('a busy hour answers per class, and the code is not painted over', async ({ page }) => {
    await withSeededSlot(page);
    await page.locator('button[data-code="2.101"]').click();
    const heatmap = page.locator('[data-act="room-heatmap"]');
    await expect(heatmap).toBeVisible();

    // Each bar carries its own tip, so two classes sharing an hour can be told
    // apart by pointing at one. A tip on the cell could not do that.
    const bars = heatmap.locator('i[data-tip]');
    // The WHOLE class, not the hour under the pointer. The seeded slot runs
    // 09:00-11:00 and is drawn as two bars; pointing at either has to say
    // 09:00-11:00, because when it ends is what the reader came to find out.
    await expect(bars.first()).toHaveAttribute('data-tip', /^09:00-11:00 10\.013/);
    await expect(bars.nth(1)).toHaveAttribute('data-tip', /^09:00-11:00 10\.013/);

    // The tip is an ::after of the bar. An ancestor that clips its overflow
    // clips the tip with it, which is what made hovering say nothing - and it
    // is invisible to any assertion about the tip's text.
    const clipped = await bars.first().evaluate((el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const o = getComputedStyle(n);
        if (o.overflowY === 'hidden' && n.getBoundingClientRect().height < 40) return true;
        if (n.hasAttribute('data-act') && n.dataset.act === 'room-heatmap') break;
      }
      return false;
    });
    expect(clipped, 'an hour cell is clipping the tooltip').toBe(false);

    // The bar has to actually be PAINTED. Asserting only that it carries a tip
    // missed the regression that adding the tip caused: [data-tip] sets
    // position:relative at the same specificity as .heatFill's absolute, so
    // source order decided it, the bars lost their absolute box, and every
    // one of them collapsed to zero width. The grid looked empty.
    const painted = await bars.first().evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { pos: s.position, w: r.width, h: r.height };
    });
    expect(painted.pos).toBe('absolute');
    expect(painted.w).toBeGreaterThan(1);
    expect(painted.h).toBeGreaterThan(1);

    // The bars are absolutely positioned, so a code left in static flow paints
    // UNDER its own bar and reads as a smudge.
    const code = heatmap.getByText('10.013').first();
    await expect(code).toBeVisible();
    const stacked = await code.evaluate((el) => {
      const s = getComputedStyle(el);
      return { pos: s.position, z: s.zIndex, color: s.color };
    });
    expect(stacked.pos).not.toBe('static');
    expect(stacked.color).toBe('rgb(255, 255, 255)');
  });

  // A phone has no hover, and every tooltip is suppressed on a coarse pointer
  // because long-press already means drag here. That left the heatmap with no
  // way at all to say which class a bar is.
  test('on a phone, tapping a bar names the class', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the tap path only exists on a coarse pointer');
    await withSeededSlot(page);
    await page.locator('button[data-code="2.101"]').click();
    const bar = page.locator('[data-act="room-heatmap"] i[data-tip]').first();
    await expect(bar).toBeVisible();

    // Opted in, or the coarse-pointer rule hides its tip like every other.
    await expect(bar).toHaveAttribute('data-tip-touch', '');
    await expect(bar).not.toHaveAttribute('data-hot', '');

    await bar.tap();
    await expect(bar).toHaveAttribute('data-hot', '');
    const shown = await bar.evaluate((el) =>
      getComputedStyle(el, '::after').display);
    expect(shown).not.toBe('none');

    // Tapping again puts it away - there is no pointer-leave to do it.
    await bar.tap();
    await expect(bar).not.toHaveAttribute('data-hot', '');
  });
});
