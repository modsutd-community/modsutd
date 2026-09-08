import { test, expect } from '@playwright/test';

// The disabled checkbox explains itself through a tooltip, and tooltips are
// suppressed on touch - so without the fallback a phone shows a dead control
// with no reason attached.
test.describe('anonymity notice', () => {
  test('desktop hides the prose and leaves it to the tooltip', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'desktop-only assertion');
    await page.goto('/mods/10.013');
    // Wait for the form itself, not merely the panel around it: the panel is
    // visible while the catalogue is still loading, and the form - and so this
    // element - mounts after. Anchoring on the panel still raced the fetch.
    const why = page.locator('#anon-why');
    await expect(page.locator('[data-act="review-form"]')).toBeVisible();
    await expect(why).toHaveCount(1);
    // Present for aria-describedby, but clipped to 1px so only the tooltip
    // shows it. Playwright counts a clipped 1px element as visible, so assert
    // on the box rather than on visibility.
    const box = await why.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(1);
    expect(box!.height).toBeLessThanOrEqual(1);
  });

  test('touch shows the prose, since the tooltip is suppressed there', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'touch-only assertion');
    await page.goto('/mods/10.013');
    const why = page.locator('#anon-why');
    await expect(why).toBeVisible();
    await expect(why).toContainText(/moderation/i);
    // and it must not push itself off the panel like the tooltip did
    const box = await why.boundingBox();
    const width = page.viewportSize()!.width;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  });
});
