import { test, expect } from '@playwright/test';
import { hoverUntil } from './support/hoverCard';
import { ensurePanel } from './support/panels';

// 'Reset layout' means LAYOUT. Records, plans and the parsed timetable
// must survive it byte-for-byte.
test('reset layout never touches user data', async ({ page, isMobile }) => {
  test.skip(!!isMobile, 'no reset button on mobile');

  await page.goto('/timetable');
  const tt = page.locator('[data-panel="tt"]');
  await tt.getByRole('button', { name: 'plan', exact: true }).click();
  // 10.013 is core for AY2024 and earlier; AY2026 is the default and does not
  // pin it, so there would be no chip to hover.
  await tt.locator('[data-act="cohort"]').selectOption('ay2024');
  await hoverUntil(tt.locator('[data-level="1"]').getByText('10.013'), page.getByLabel('notes for 10.013'));
  await page.getByLabel('notes for 10.013').fill('survives reset');
  await page.getByRole('button', { name: '+ component' }).click();
  await page.waitForTimeout(200);

  const grab = () => page.evaluate(() => ({
    records: localStorage.getItem('modsutd.records.v1'),
    timetable: localStorage.getItem('modsutd.timetable.v1'),
  }));
  const before = await grab();
  expect(before.records).toContain('survives reset');

  await page.locator('button[aria-label="Reset layout"]').click();
  await page.waitForTimeout(400);
  expect(await grab()).toEqual(before);

  // and the UI still shows it after reopening the plan
  await ensurePanel(page, 'Timetable', 'tt');
  await tt.getByRole('button', { name: 'plan', exact: true }).click();
  // 10.013 is core for AY2024 and earlier; AY2026 is the default and does not
  // pin it, so there would be no chip to hover.
  await tt.locator('[data-act="cohort"]').selectOption('ay2024');
  await hoverUntil(tt.locator('[data-level="1"]').getByText('10.013'), page.getByLabel('notes for 10.013'));
  await expect(page.getByLabel('notes for 10.013')).toHaveValue('survives reset');
});
