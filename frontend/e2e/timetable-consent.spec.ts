import { test, expect } from '@playwright/test';

// Consent gate is mandatory: no opt-out path. In the Workbench the consent
// card renders IN PLACE of the paste textarea until the user agrees.
// Pinning the contract:
//   1. First visit → consent card visible, no textarea at all, checkbox unchecked.
//   2. Tick the checkbox → card gone, textarea present + enabled, "thanks" pill shows.
//   3. localStorage persists consent across reloads.
//   4. No "change" link, no "private" / "share mode" badge anywhere.

const KEY = 'modsutd.timetable.consent.v3';

// Desktop needs panel scoping (the REVIEW panel also carries a textarea);
// mobile renders the timetable tab bare.
const scope = (page: import('@playwright/test').Page, isMobile: boolean | undefined) =>
  isMobile ? page.locator('body') : page.locator('[data-panel="tt"]');

test.describe('timetable · consent gate', () => {
  test.beforeEach(async ({ page, isMobile }) => {
    await page.goto('/timetable');
    await page.evaluate((k) => localStorage.removeItem(k), KEY);
    await page.reload();
    // The panel opens on the timetable now, not the paste screen - the consent
    // gate lives one tab across.
    await scope(page, isMobile).getByRole('button', { name: /generate timetable/i }).click();
  });

  test('first visit shows the consent card and no paste box', async ({ page, isMobile }) => {
    const gate = page.locator('[data-act="consent-gate"]');
    await expect(gate).toBeVisible();
    // What is being agreed to is the contract, so the wording IS under test
    // here - a silent reword of the terms should fail.
    await expect(gate).toContainText(/parsed mod \+ venue \+ day \+ time slots/i);
    await expect(gate).toContainText(/anonymously/i);
    await expect(scope(page, isMobile).locator('textarea')).toHaveCount(0);
    const checkbox = scope(page, isMobile).locator('input[type="checkbox"]');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
  });

  test('ticking the checkbox reveals the paste box and the thanks pill', async ({ page, isMobile }) => {
    const checkbox = scope(page, isMobile).locator('input[type="checkbox"]');
    await checkbox.scrollIntoViewIfNeeded();
    await checkbox.click();

    const textarea = scope(page, isMobile).locator('textarea');
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeEnabled();
    await expect(textarea).toHaveAttribute('placeholder', /paste myportal/i);
    // Pin the pill's existence, not its wording - the copy gets edited.
    await expect(scope(page, isMobile).locator('[data-act="contrib-thanks"]')).toBeVisible();
    await expect(page.locator('[data-act="consent-gate"]')).toHaveCount(0);
  });

  test('no "change" link and no mode badge after agreeing', async ({ page, isMobile }) => {
    await scope(page, isMobile).locator('input[type="checkbox"]').click();
    await expect(scope(page, isMobile).locator('textarea')).toBeVisible();
    // The ratchet: consent is one-way. No UI offers to revisit or soften it.
    // copy-assert: the absent thing IS the wording - no hook can express that.
    await expect(page.getByText(/change consent|private mode|share mode/i)).toHaveCount(0);
  });

  test('consent persists across reloads', async ({ page, isMobile }) => {
    await scope(page, isMobile).locator('input[type="checkbox"]').click();
    await expect(scope(page, isMobile).locator('textarea')).toBeVisible();

    await page.reload();
    // Which tab the panel lands on is a separate concern - come back to the
    // paste screen explicitly, so this stays a test about consent.
    await scope(page, isMobile).getByRole('button', { name: /generate timetable/i }).click();
    await expect(scope(page, isMobile).locator('textarea')).toBeVisible();
    await expect(page.locator('[data-act="consent-gate"]')).toHaveCount(0);
  });
});
