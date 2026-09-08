import { test, expect } from '@playwright/test';
import { hoverUntil } from './support/hoverCard';

// Regression: opacity inherits multiplicatively, so a hover card inside a
// dimmed future row rendered at 0.45 with later rows bleeding through -
// the hosting row must shed its dimming while the card is open.
test('card on a dimmed future row renders solid', async ({ page, isMobile }) => {
  test.skip(!!isMobile);
  await page.goto('/timetable');
  const tt = page.locator('[data-panel="tt"]');
  await tt.getByRole('button', { name: 'plan', exact: true }).click();
  await tt.locator('[data-act="cohort"]').selectOption('ay2026');
  // currentTerm defaults to T1, so T2 is a dimmed future row
  const card = tt.locator('[data-card]');
  await hoverUntil(tt.locator('[data-level="2"]').getByText('Algorithmic Thinking'), card);
  const eff = await card.evaluate((el) => {
    let node: HTMLElement | null = el as HTMLElement;
    let o = 1;
    while (node) { o *= parseFloat(getComputedStyle(node).opacity || '1'); node = node.parentElement; }
    return o;
  });
  expect(eff).toBe(1);
});
