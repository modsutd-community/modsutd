import { test, expect } from '@playwright/test';

// The primary mobile interactions: mod row → inspector bottom sheet,
// deep links landing in sheets, and the More-tab sheets. Desktop skips.
// 10.013 is a pinned fixture mod (same freeze as 2.101/1.102 in venues).

test.describe('mobile · sheets', () => {
  test.skip(({ isMobile }) => !isMobile, 'bottom sheets are the mobile affordance');

  test('tapping a mod row opens the inspector sheet; backdrop closes it', async ({ page }) => {
    await page.goto('/mods');
    await page.getByRole('button', { name: /10\.013/ }).first().click();

    const sheet = page.getByRole('dialog', { name: 'mod', exact: true });
    await expect(sheet).toBeVisible();
    // 10.013 is classic freshmore core, so the plan button says so rather than
    // offering to add a mod every freshmore already takes.
    await expect(sheet.locator('[data-act="plan-btn"]')).toHaveText(/FRESHMORE CORE/);

    await sheet.getByRole('button', { name: /close mod/i }).click();
    await expect(sheet).toHaveCount(0);
  });

  test('deep link /mods/10.013 lands in the inspector sheet', async ({ page }) => {
    await page.goto('/mods/10.013');
    const sheet = page.getByRole('dialog', { name: 'mod', exact: true });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Modelling and Analysis')).toBeVisible();
  });

  test('More tab opens the review sheet', async ({ page }) => {
    await page.goto('/timetable');
    await page.getByRole('button', { name: 'More' }).click();
    await page.locator('[data-act="more-review"]').click();
    const sheet = page.getByRole('dialog', { name: 'share', exact: true });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByPlaceholder(/search by code or name/i)).toBeVisible();
  });
});
