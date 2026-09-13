import type { Page } from '@playwright/test';

/**
 * Make sure a panel is open, whatever the default layout says.
 *
 * The rail buttons TOGGLE, so a test that clicks one to "open" a panel closes
 * it instead the day that panel starts open. TIMETABLE became a default-open
 * panel and thirteen specs went red on exactly that: they were asserting the
 * old preset, not the behaviour they were written for.
 */
export async function ensurePanel(page: Page, label: string, id: string) {
  const panel = page.locator(`[data-panel="${id}"]`);
  if (await panel.isVisible()) return panel;
  await page.locator(`button[aria-label="${label}"]`).click();
  await panel.waitFor({ state: 'visible' });
  return panel;
}
