import { test, expect } from '@playwright/test';

// Venues need share links to direct students to the room finder heatmap and directions,
// whereas modules link out to official course pages directly.
test.describe('share link button', () => {
  test('venue inspector shares canonical venue URL and indicates copied state', async ({
    page,
    context,
    isMobile,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/venues/2.507');

    const scope = isMobile ? page.locator('body') : page.locator('[data-panel="rooms"]');
    const shareBtn = scope.locator('[data-act="share-venue-btn"]');
    await expect(shareBtn).toBeVisible();
    await expect(shareBtn).toHaveAttribute('data-tip', 'Share this venue');

    await shareBtn.click();
    await expect(shareBtn).toHaveAttribute('data-tip', 'copied!');
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('https://modsutd.tech/venues/2.507');
  });

  test('mod inspector omits share button to keep external source link authoritative', async ({
    page,
    isMobile,
  }) => {
    await page.goto('/mods/10.013');
    const scope = isMobile ? page.locator('body') : page.locator('[data-panel="mod"]');
    await expect(scope.locator('[data-act="share-mod-btn"]')).toHaveCount(0);
  });

  test('venue codes with spaces encode cleanly in the copied URL', async ({
    page,
    context,
    isMobile,
  }) => {
    test.skip(!!isMobile, 'desktop panel exercise for spaces in venue codes');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/venues');

    const roomBtn = page.locator('button[data-code="Antique House"]');
    await roomBtn.scrollIntoViewIfNeeded();
    await roomBtn.click();

    const shareBtn = page.locator('[data-panel="rooms"] [data-act="share-venue-btn"]');
    await expect(shareBtn).toBeVisible();
    await shareBtn.click();

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe('https://modsutd.tech/venues/Antique%20House');
  });
});
