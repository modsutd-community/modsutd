import { test, expect } from '@playwright/test';

// The window manager: drag, resize from any edge, persist, reset, and the
// toggle model - rail buttons open/close panels, re-clicking the selected
// mod closes its inspector, right-click pins extra inspectors. Includes the
// regression that motivated the state-driven rewrite: in the design mock,
// clicking anywhere after a drag snapped every panel back to default.

test.describe('workbench panels (desktop)', () => {
  test.skip(({ isMobile }) => !!isMobile, 'panels are a desktop affordance');

  test.beforeEach(async ({ page }) => {
    await page.goto('/mods');
    await page.evaluate(() => localStorage.removeItem('modsutd.workbench.layout.v3'));
    await page.reload();
  });

  const dragTitlebar = async (page: import('@playwright/test').Page, dx: number, dy: number) => {
    const bar = page.locator('[data-panel="cat"] header');
    const box = (await bar.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
    await page.mouse.up();
  };

  test('drag moves a panel - and clicking afterwards does NOT reset it', async ({ page }) => {
    const panel = page.locator('[data-panel="cat"]');
    const before = (await panel.boundingBox())!;

    await dragTitlebar(page, 140, 90);
    const after = (await panel.boundingBox())!;
    expect(Math.round(after.x - before.x)).toBeGreaterThan(120);
    expect(Math.round(after.y - before.y)).toBeGreaterThan(70);

    // The regression: click a catalogue row (state change → re-render).
    await panel.getByRole('button', { name: /10\.013/ }).click();
    const afterClick = (await panel.boundingBox())!;
    expect(Math.abs(afterClick.x - after.x)).toBeLessThan(2);
    expect(Math.abs(afterClick.y - after.y)).toBeLessThan(2);
  });

  test('panels resize from the corner AND from edges', async ({ page }) => {
    const panel = page.locator('[data-panel="cat"]');
    const before = (await panel.boundingBox())!;

    // south-east corner grows both axes
    const se = panel.getByRole('button', { name: 'resize MODS se', exact: true });
    const seBox = (await se.boundingBox())!;
    await page.mouse.move(seBox.x + seBox.width / 2, seBox.y + seBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(seBox.x + 90, seBox.y + 60, { steps: 6 });
    await page.mouse.up();
    let now = (await panel.boundingBox())!;
    expect(now.width).toBeGreaterThan(before.width + 60);
    expect(now.height).toBeGreaterThan(before.height + 30);

    // west edge resizes horizontally and keeps the right edge pinned -
    // give the panel slack from the rail first so the clamp can't bite.
    await dragTitlebar(page, 160, 0);
    now = (await panel.boundingBox())!;
    const w = panel.getByRole('button', { name: 'resize MODS w', exact: true });
    const wBox = (await w.boundingBox())!;
    const rightEdge = now.x + now.width;
    await page.mouse.move(wBox.x + wBox.width / 2, wBox.y + wBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(wBox.x - 60, wBox.y, { steps: 6 });
    await page.mouse.up();
    now = (await panel.boundingBox())!;
    expect(Math.abs(now.x + now.width - rightEdge)).toBeLessThan(2);
    expect(now.width).toBeGreaterThan(0);

    // north edge resizes vertically and keeps the bottom edge pinned
    const n = panel.getByRole('button', { name: 'resize MODS n', exact: true });
    const nBox = (await n.boundingBox())!;
    const bottomEdge = now.y + now.height;
    await page.mouse.move(nBox.x + nBox.width / 2, nBox.y + nBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(nBox.x, nBox.y + 40, { steps: 6 });
    await page.mouse.up();
    now = (await panel.boundingBox())!;
    expect(Math.abs(now.y + now.height - bottomEdge)).toBeLessThan(2);
  });

  test('panels never clip off-screen', async ({ page }) => {
    const panel = page.locator('[data-panel="cat"]');
    const viewport = page.viewportSize()!;
    await dragTitlebar(page, viewport.width, viewport.height);
    const box = (await panel.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  });

  test('layout survives a reload; reset restores defaults', async ({ page }) => {
    const panel = page.locator('[data-panel="cat"]');
    const before = (await panel.boundingBox())!;
    await dragTitlebar(page, 150, 60);
    const moved = (await panel.boundingBox())!;

    // The layout save is debounced - wait for localStorage to catch up
    // before reloading, or the test races the write.
    await page.waitForFunction(
      (x) => {
        const raw = localStorage.getItem('modsutd.workbench.layout.v3');
        return raw !== null && Math.abs((JSON.parse(raw).cat?.x ?? 0) - x) < 2;
      },
      moved.x,
    );
    await page.reload();
    const reloaded = (await panel.boundingBox())!;
    expect(Math.abs(reloaded.x - moved.x)).toBeLessThan(2);
    expect(Math.abs(reloaded.y - moved.y)).toBeLessThan(2);

    await page.locator('button[aria-label="Reset layout"]').click();
    const reset = (await panel.boundingBox())!;
    expect(Math.abs(reset.x - before.x)).toBeLessThan(2);
    expect(Math.abs(reset.y - before.y)).toBeLessThan(2);
  });

  test('rail buttons toggle their panel open/closed', async ({ page }) => {
    const panel = page.locator('[data-panel="cat"]');
    await expect(panel).toBeVisible();
    await page.locator('button[aria-label="Mods"]').click();
    await expect(panel).toHaveCount(0);
    await page.locator('button[aria-label="Mods"]').click();
    await expect(panel).toBeVisible();
  });

  test('re-clicking the selected mod toggles its inspector', async ({ page }) => {
    const row = page.locator('[data-panel="cat"]').getByRole('button', { name: /10\.013/ });
    await row.click();
    const inspector = page.locator('[data-panel="mod"]');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText('Modelling and Analysis');

    await row.click();
    await expect(inspector).toHaveCount(0);
  });

  test('one mod = one window: click and right-click never duplicate', async ({ page }) => {
    const row = page.locator('[data-panel="cat"]').getByRole('button', { name: /10\.013/ });
    const main = page.locator('[data-panel="mod"]');
    const pinnedPanel = page.locator('[data-panel="mod:10.013"]');

    // Main inspector open → right-click surfaces IT, no pinned duplicate.
    await row.click();
    await expect(main).toBeVisible();
    await row.click({ button: 'right' });
    await expect(pinnedPanel).toHaveCount(0);
    await expect(main).toBeVisible();

    // Close the main (re-click), then right-click pins a window.
    await row.click();
    await expect(main).toHaveCount(0);
    await row.click({ button: 'right' });
    await expect(pinnedPanel).toBeVisible();
    await expect(pinnedPanel).toContainText('Modelling and Analysis');

    // With a pinned window open, a normal click surfaces it - the main
    // inspector must NOT open a second copy.
    await row.click();
    await expect(main).toHaveCount(0);
    await expect(pinnedPanel).toBeVisible();

    // Pinned inspectors are independent windows - they carry a ✕.
    await pinnedPanel.getByRole('button', { name: /close 10\.013/ }).click();
    await expect(pinnedPanel).toHaveCount(0);
  });

  test('collapse and expand via the title bar', async ({ page }) => {
    const panel = page.locator('[data-panel="cat"]');
    await panel.getByRole('button', { name: /collapse MODS/i }).click();
    await expect(panel.getByRole('button', { name: /10\.013/ })).toHaveCount(0);
    await panel.getByRole('button', { name: /expand MODS/i }).click();
    await expect(panel.getByRole('button', { name: /10\.013/ })).toBeVisible();
  });
});
