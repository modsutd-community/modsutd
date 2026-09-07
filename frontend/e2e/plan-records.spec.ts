import { test, expect } from '@playwright/test';
import { hoverUntil } from './support/hoverCard';

// The plan (10 term levels, fixed Freshmore core in T1-3, automatic
// prerequisite checks) and per-mod records living in the chip hover card.
// Pinned fixtures: 50.001 "Information Systems & Programming" (T4, prereq
// 10.014 - freshmore-fixed) and 50.004 "Algorithms" (T4, prereq 50.001);
// 01.101 "Technologies for Sustainable Global Health" (T7, no prereqs) is
// the ONE mod whose page publishes a Learning-assessment table, so it
// carries the official-grading prefill coverage (Quiz-1/Quiz-2, 20% each);
// 02.001 "Global Humanities…" as a T1 HASS choice; 03.007 + "Calculus" in
// the AY2026 core.

test.describe('plan + records', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/mods');
    await page.evaluate(() => {
      localStorage.removeItem('modsutd.timetable.v1');
      localStorage.removeItem('modsutd.records.v1');
    });
    await page.reload();
  });

  test('freshmore core is pinned in T1-3 and satisfies prerequisites', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'plan interactions verified on desktop; the tree renders identically on the mobile tt tab');

    const cat = page.locator('[data-panel="cat"]');
    const ins = page.locator('[data-panel="mod"]');
    const tt = page.locator('[data-panel="tt"]');

    // Plan 50.001 (prereq 10.014). 10.014 is freshmore-fixed in T1, so the
    // chip must NOT be red even though the student never added it.
    await cat.getByRole('button', { name: /50\.001/ }).click();
    await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
    await cat.getByRole('button', { name: /50\.001/ }).click(); // close overlay

    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();

    // Fixed core renders without user input - and has no remove button.
    await expect(tt.locator('[data-level="1"]').getByText('10.013')).toBeVisible();
    await expect(tt.getByRole('button', { name: 'remove 10.013 from plan' })).toHaveCount(0);
    await expect(tt.locator('[data-act="plan-issues"]')).toHaveCount(0);

    // 50.004 needs 50.001 in an EARLIER term - both default to T4 → red.
    await cat.getByRole('button', { name: /50\.004/ }).click();
    await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
    await cat.getByRole('button', { name: /50\.004/ }).click();
    await expect(tt.locator('[data-act="plan-issues"]')).toHaveAttribute('data-count', '1');

    // Drag 50.004 down to T5 - prereq now in an earlier term, warning clears.
    const chip = tt.locator('[data-level="4"]').locator('span', { hasText: '50.004' }).first();
    const box = (await chip.boundingBox())!;
    const target = (await tt.locator('[data-level="5"]').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(tt.locator('[data-act="plan-issues"]')).toHaveCount(0);
  });

  test('the hover card stays open long enough to use - records live there', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'hover cards are the desktop affordance; mobile long-presses');

    const cat = page.locator('[data-panel="cat"]');
    const ins = page.locator('[data-panel="mod"]');
    const tt = page.locator('[data-panel="tt"]');

    await cat.getByRole('button', { name: /01\.101/ }).click();
    await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
    await cat.getByRole('button', { name: /01\.101/ }).click();

    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();

    // Hover the chip; the card must survive the pointer traveling into it
    // (the regression: it used to vanish instantly). The header is the mod
    // NAME - not "code · my record".
    // Wait on the card's hook, not on its wording: a selector made of copy is
    // one rename away from a mystery failure. The wording is still under test,
    // one line down, where it is an assertion rather than a way of finding
    // something.
    await hoverUntil(tt.locator('[data-level="7"]').getByText('01.101'), tt.locator('[data-card]'));
    // The header is the mod NAME - not "code · my record".
    await expect(tt.getByText('Technologies for Sustainable Global Health')).toBeVisible();

    // Components are prefilled from the OFFICIAL rubric - scores are POINTS
    // out of each row's max (Quiz-1 is 20).
    const quiz1 = page.getByLabel('Quiz-1 score for 01.101');
    await expect(quiz1).toBeVisible();
    await quiz1.fill('18');
    // Raw-mark fractions convert in place to points: 30/50 of a 20 → 12.
    const quiz2 = page.getByLabel('Quiz-2 score for 01.101');
    await quiz2.fill('30/50');
    await expect(quiz2).toHaveValue('12');
    // Footer sums sit under their columns: max 100%, attained 18+12 = 30%.
    const card = tt.locator('[data-card]');
    await expect(card.getByText('100%', { exact: true })).toBeVisible();
    await expect(card.getByText('30%', { exact: true })).toBeVisible();

    // Garbage (or more than the max) goes red without clobbering the score.
    await quiz1.fill('99');
    await expect(quiz1).toHaveAttribute('aria-invalid', 'true');
    await quiz1.fill('18');
    await expect(quiz1).toHaveAttribute('aria-invalid', 'false');

    await page.getByLabel('component 1 name for 01.101').fill('Participation (rescoped)');
    await page.getByLabel('notes for 01.101').fill('shark tank pitch week 13');

    // Reload → persisted. (The tt panel layout persists as open, so no
    // rail toggle - clicking it again would close the panel.)
    await page.reload();
    await expect(tt).toBeVisible();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();
    await hoverUntil(
      tt.locator('[data-level="7"]').getByText('01.101'),
      page.getByLabel('component 1 name for 01.101'),
    );
    await expect(page.getByLabel('component 1 name for 01.101')).toHaveValue('Participation (rescoped)');
    await expect(page.getByLabel('notes for 01.101')).toHaveValue('shark tank pitch week 13');

    await expect(tt.getByRole('button', { name: /export/ })).toBeVisible();
  });

  test('a chip with unmet prereqs shows only the prereqs - no record form', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'hover cards are the desktop affordance; mobile long-presses');

    const cat = page.locator('[data-panel="cat"]');
    const ins = page.locator('[data-panel="mod"]');
    const tt = page.locator('[data-panel="tt"]');

    // 50.004 without 50.001 → red chip, locked record.
    await cat.getByRole('button', { name: /50\.004/ }).click();
    await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
    await cat.getByRole('button', { name: /50\.004/ }).click();

    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();
    await hoverUntil(
      tt.locator('[data-level="4"]').getByText('50.004'),
      tt.locator('[data-card] [data-act="prereq-list"]'),
    );
    await expect(page.getByLabel('component 1 name for 50.004')).toHaveCount(0);
    // The missing prereq is right there, tappable - one tap plans it at its
    // default term (T4 - same level, so the chip stays red until dragged).
    await tt.locator('[data-act="add-prereq"][data-code="50.001"]').click();
    await expect(tt.locator('[data-level="4"]').getByRole('button', { name: '50.001', exact: true })).toBeVisible();
  });

  test('choice slots suggest their options and retire once filled', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'hover cards are the desktop affordance; mobile long-presses');

    const tt = page.locator('[data-panel="tt"]');
    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();

    const t1 = tt.locator('[data-level="1"]');
    await hoverUntil(t1.locator('[data-act="choice-slot"]'), tt.getByText(/Global Humanities/));
    await tt.getByText(/Global Humanities/).click();
    await expect(t1.getByText('02.001')).toBeVisible();
    await expect(t1.locator('[data-act="choice-slot"]')).toHaveCount(0);

    await t1.getByRole('button', { name: 'remove 02.001 from plan' }).click();
    await expect(t1.locator('[data-act="choice-slot"]')).toBeVisible();
  });

  test('the AY2026 toggle switches to a separate plan with its own core', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'verified on desktop; the toggle renders identically on the mobile tt tab');

    const cat = page.locator('[data-panel="cat"]');
    const ins = page.locator('[data-panel="mod"]');
    const tt = page.locator('[data-panel="tt"]');

    await cat.getByRole('button', { name: /50\.001/ }).click();
    await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
    await cat.getByRole('button', { name: /50\.001/ }).click();

    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();

    const t1 = tt.locator('[data-level="1"]');
    await expect(t1.getByText('10.013')).toBeVisible();

    await tt.getByLabel('use the AY2026 freshmore curriculum').check();
    // New core in T1: 03.007 plus the uncoded 99.999 placeholders (chips
    // label by NAME because the code isn't unique).
    await expect(t1.getByText('03.007')).toBeVisible();
    await expect(t1.getByText('Calculus', { exact: true })).toBeVisible();
    await expect(t1.getByText('10.013')).toHaveCount(0);
    // The curricula are SEPARATE plans: the classic 50.001 does not exist
    // on the AY2026 side…
    await expect(tt.locator('[data-level="4"]').getByText('50.001')).toHaveCount(0);

    await tt.getByLabel('use the AY2026 freshmore curriculum').uncheck();
    // …and toggling back finds the classic plan exactly as it was left.
    await expect(t1.getByText('10.013')).toBeVisible();
    await expect(tt.locator('[data-level="4"]').getByText('50.001')).toBeVisible();
  });

  // The core is pinned in T1-3 without being in selectedMods, so the button
  // read "+ ADD TO PLAN" for a mod already sitting in T1 of the tree - and
  // pressing it would have added a second copy of something nobody chose.
  test('a pinned freshmore core mod does not offer to be added', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'verified on desktop; the inspector renders identically on the mobile sheet');

    const cat = page.locator('[data-panel="cat"]');
    const ins = page.locator('[data-panel="mod"]');
    const tt = page.locator('[data-panel="tt"]');

    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();
    await tt.getByLabel('use the AY2026 freshmore curriculum').check();
    // 03.007 is fixed in AY2026 term 1, and the tree shows it there.
    await expect(tt.locator('[data-level="1"]').getByText('03.007')).toBeVisible();

    await cat.getByRole('button', { name: /03\.007/ }).click();
    const btn = ins.locator('[data-act="plan-btn"]');
    await expect(btn).toHaveText('✓ FRESHMORE CORE - T1');
    await expect(btn).toBeDisabled();
  });

  test('a catalogue row drags straight into the plan', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'drag is the desktop affordance; mobile keeps + ADD TO PLAN');

    const cat = page.locator('[data-panel="cat"]');
    const tt = page.locator('[data-panel="tt"]');
    await expect(tt).toBeHidden();

    const row = cat.getByRole('button', { name: /50\.004/ });
    await row.scrollIntoViewIfNeeded();
    const rb = (await row.boundingBox())!;
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    // Crossing the drag threshold surfaces the timetable panel on the plan.
    await page.mouse.move(rb.x + rb.width / 2 + 40, rb.y + rb.height / 2 + 40, { steps: 4 });
    await expect(tt).toBeVisible();
    const t5 = (await tt.locator('[data-level="5"]').boundingBox())!;
    await page.mouse.move(t5.x + t5.width / 2, t5.y + 12, { steps: 10 });
    await page.mouse.up();

    await expect(tt.locator('[data-level="5"]').getByText('50.004')).toBeVisible();

    // Releasing far from every term row cancels - nothing is planned.
    const row3 = cat.getByRole('button', { name: /50\.003/ });
    await row3.scrollIntoViewIfNeeded();
    const r3 = (await row3.boundingBox())!;
    await page.mouse.move(r3.x + r3.width / 2, r3.y + r3.height / 2);
    await page.mouse.down();
    await page.mouse.move(600, 30, { steps: 8 }); // topbar - nowhere near the plan
    await page.mouse.up();
    await expect(tt.getByText('50.003')).toHaveCount(0);
  });

  test('mobile: long-pressing a mod row drags it into the plan', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'long-press drag is the touch affordance');
    // Raw CDP touches: the 450ms hold engages the drag, the plan overlays
    // the (still-mounted) list, and releasing near T5 snaps the mod there.
    const row = page.getByRole('button', { name: /50\.004/ });
    await row.scrollIntoViewIfNeeded();
    const rb = (await row.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const x = rb.x + rb.width / 2;
    const y = rb.y + rb.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(650); // past the 450ms hold
    const t5 = (await page.locator('[data-level="5"]').boundingBox())!;
    const tx = t5.x + t5.width / 2;
    const ty = t5.y + 12;
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + ((tx - x) * i) / steps, y: y + ((ty - y) * i) / steps }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // The drop lands the mod and the shell follows it to the timetable tab.
    await expect(page.locator('[data-level="5"]').getByText('50.004')).toBeVisible();
  });
});
