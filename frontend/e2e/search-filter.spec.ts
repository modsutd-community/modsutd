import { test, expect } from '@playwright/test';

// The global search: one input, filters mods AND rooms. Typing surfaces the
// MODS + ROOM FINDER panels (stacked) on desktop; '/' and ⌘K focus it.
// The workbench is one page - switching/searching never changes the URL.

test.describe('global search', () => {
  test('typing filters the catalogue down to matches', async ({ page, isMobile }) => {
    await page.goto('/mods');
    const input = isMobile
      ? page.getByLabel('search modules')
      : page.getByLabel('Global search (mods, rooms)');
    await expect(input).toBeVisible();

    // 02.101 "Darwin and Design" is a pinned fixture mod.
    await input.fill('darwin');
    await expect(page.getByText('Darwin and Design')).toBeVisible();
    await expect(page.getByText('02.102', { exact: false })).toHaveCount(0);

    await input.fill('');
    await expect(page.getByRole('button', { name: /10\.013/ }).first()).toBeVisible();
  });

  test('search covers rooms too and surfaces both panels (desktop)', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'panel surfacing is a desktop affordance');
    await page.goto('/timetable');
    // Close the room finder so we can observe the search re-opening it.
    const roomsRail = page.locator('button[aria-label="Room Finder"]');
    if (await page.locator('[data-panel="rooms"]').count()) await roomsRail.click();
    await expect(page.locator('[data-panel="rooms"]')).toHaveCount(0);

    const input = page.getByLabel('Global search (mods, rooms)');
    await input.fill('1.102');

    const rooms = page.locator('[data-panel="rooms"]');
    const cat = page.locator('[data-panel="cat"]');
    await expect(rooms).toBeVisible();
    await expect(cat).toBeVisible();
    // Stacked: MODS sits above ROOM FINDER.
    const catBox = (await cat.boundingBox())!;
    const roomsBox = (await rooms.boundingBox())!;
    expect(catBox.y).toBeLessThan(roomsBox.y);
    await expect(rooms.locator('button[data-code="1.102"]')).toBeVisible();
    await expect(rooms.locator('button[data-code="2.101"]')).toHaveCount(0);
  });

  test('the URL never changes while working the tools', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'rail is a desktop affordance');
    await page.goto('/');
    await page.locator('button[aria-label="Timetable"]').click();
    await page.locator('button[aria-label="Room Finder"]').click();
    await page.locator('[data-panel="cat"]').getByRole('button', { name: /10\.013/ }).click();
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('slash focuses the search from anywhere (desktop)', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'the / hotkey is a keyboard affordance');
    await page.goto('/timetable');
    await page.keyboard.press('/');
    await expect(page.getByLabel('Global search (mods, rooms)')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Global search (mods, rooms)')).not.toBeFocused();
    // ⌘K muscle-memory alias.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByLabel('Global search (mods, rooms)')).toBeFocused();
  });
});
