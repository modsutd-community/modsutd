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
});
