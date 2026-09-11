import { test, expect } from '@playwright/test';

// The primary mobile interactions: mod row → inspector bottom sheet,
// deep links landing in sheets, and the More-tab sheets. Desktop skips.
// 10.013 is a pinned fixture mod (same freeze as 2.101/1.102 in venues).

test.describe('mobile · sheets', () => {
  test.skip(({ isMobile }) => !isMobile, 'bottom sheets are the mobile affordance');

  test('tapping a mod row opens the inspector sheet; backdrop closes it', async ({ page }) => {
    // 10.013 is core for AY2025 and earlier, not for the AY2026 default. Seeded
    // rather than clicked, because the cohort dropdown lives in the desktop
    // plan header - and seeded BEFORE navigation, because the app writes that
    // key on a 300ms debounce and would overwrite a value set afterwards.
    await page.addInitScript(() => {
      localStorage.setItem(
        'modsutd.workbench.ui.v1',
        // Deliberately the OLD key. A returning student has this in their
        // browser right now, and it has to keep selecting the same cohort.
        JSON.stringify({ freshmoreMode: 'classic' }),
      );
    });
    await page.goto('/mods');
    await page.getByRole('button', { name: /10\.013/ }).first().click();

    const sheet = page.getByRole('dialog', { name: 'mod', exact: true });
    await expect(sheet).toBeVisible();
    // 10.013 is AY2024 freshmore core, so the plan button says so rather than
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
