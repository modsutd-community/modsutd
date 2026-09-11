import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { hoverUntil } from './support/hoverCard';

// The plan (10 term levels, fixed Freshmore core in T1-3, automatic
// prerequisite checks) and per-mod records living in the chip hover card.
// Pinned fixtures: 50.001 "Information Systems & Programming" (T4, prereq is
// the cohort pair 10.014/10.025 - freshmore-fixed) and 50.003 "Elements of
// Software Construction" (T5, prereq 50.001). NOT 50.004: SUTD's page for it
// lists the CTD pair, not 50.001, so it can no longer stand for "needs another
// pillar mod".
// 01.101 "Technologies for Sustainable Global Health" (T7, no prereqs) is
// the ONE mod whose page publishes a Learning-assessment table, so it
// carries the official-grading prefill coverage (Quiz-1/Quiz-2, 20% each);
// 02.001 "Global Humanities…" as a T1 HASS choice; 03.007A + "Calculus" in
// the AY2026 core.

test.describe('plan + records', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/mods');
    await page.evaluate(() => {
      localStorage.removeItem('modsutd.timetable.v1');
      localStorage.removeItem('modsutd.records.v1');
      // The layout too: it carries the cohort and which mod is open, and a
      // test that inherits either from the one before it is a test that passes
      // alone and fails in the suite.
      localStorage.removeItem('modsutd.workbench.ui.v1');
    });
    await page.reload();
  });

  test('freshmore core is pinned in T1-3 and satisfies prerequisites', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'plan interactions verified on desktop; the tree renders identically on the mobile tt tab');

    const cat = page.locator('[data-panel="cat"]');
    const ins = page.locator('[data-panel="mod"]');
    const tt = page.locator('[data-panel="tt"]');

    // 10.013/10.014 are the AY2024-and-earlier core and AY2026 is the default,
    // so choose the cohort FIRST: each one keeps its own plan, and a mod added
    // before the switch lands in the plan that was showing at the time.
    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();
    await tt.locator('[data-act="cohort"]').selectOption('ay2024');

    // Plan 50.001 (prereq 10.014). 10.014 is freshmore-fixed in T1, so the
    // chip must NOT be red even though the student never added it.
    await cat.getByRole('button', { name: /50\.001/ }).click();
    await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
    await cat.getByRole('button', { name: /50\.001/ }).click(); // close overlay

    // Fixed core renders without user input - and has no remove button.
    await expect(tt.locator('[data-level="1"]').getByText('10.013')).toBeVisible();
    await expect(tt.getByRole('button', { name: 'remove 10.013 from plan' })).toHaveCount(0);
    await expect(tt.locator('[data-act="plan-issues"]')).toHaveCount(0);

    // 50.003 needs 50.001 in an EARLIER term. 50.001 defaults to T4 and 50.003
    // to T5, so the plan is clean as placed.
    await cat.getByRole('button', { name: /50\.003/ }).click();
    await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
    await cat.getByRole('button', { name: /50\.003/ }).click();
    await expect(tt.locator('[data-act="plan-issues"]')).toHaveCount(0);

    // Drag 50.001 down onto T5, alongside the mod that needs it: a prereq in
    // the same term is not a prereq met, so the warning appears.
    const chip = tt.locator('[data-level="4"]').locator('span', { hasText: '50.001' }).first();
    const box = (await chip.boundingBox())!;
    const target = (await tt.locator('[data-level="5"]').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(tt.locator('[data-act="plan-issues"]')).toHaveAttribute('data-count', '1');

    // And back up again clears it.
    const moved = tt.locator('[data-level="5"]').locator('span', { hasText: '50.001' }).first();
    const b2 = (await moved.boundingBox())!;
    const up = (await tt.locator('[data-level="4"]').boundingBox())!;
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.mouse.down();
    await page.mouse.move(up.x + up.width / 2, up.y + up.height / 2, { steps: 10 });
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

  // The button says "download json" and sits on one cohort's tab. It used to
  // write every cohort's plan plus the parsed timetable and the contributed
  // slots, so the file could not be used to move one plan anywhere.
  test('export writes the tab you are on, and nothing else', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'the export button lives in the desktop tt panel');

    const cat = page.locator('[data-panel="cat"]');
    const ins = page.locator('[data-panel="mod"]');
    const tt = page.locator('[data-panel="tt"]');

    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();
    await tt.locator('[data-act="cohort"]').selectOption('ay2024');

    await cat.getByRole('button', { name: /50\.001/ }).click();
    await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
    // Close the inspector: it overlaps the tt panel's toolbar, so the export
    // button is there but not clickable underneath it.
    await cat.getByRole('button', { name: /50\.001/ }).click();
    await expect(ins).toHaveCount(0);

    // The export control is a menu: the visible button opens it, and the
    // download is an item inside.
    await tt.locator('[data-act="export-menu"]').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      tt.locator('[data-act="export-json"]').click(),
    ]);
    expect(download.suggestedFilename()).toBe('modsutd-plan-ay2024.json');

    const path = await download.path();
    const file = JSON.parse(await readFile(path!, 'utf-8'));

    expect(file.kind).toBe('modsutd-plan');
    expect(file.curriculum).toBe('ay2024');
    expect(file.plan.selectedMods).toContain('50.001');
    // The whole browser is what it must NOT be.
    expect(file).not.toHaveProperty('plans');
    expect(file).not.toHaveProperty('timetable');
    expect(file).not.toHaveProperty('contributed');
  });

  // A plan file records the year it came from, so importing one is not a
  // question: an AY2024 file is an AY2024 plan wherever the reader is standing.
  test('import goes to the year the file came from, not the tab you are on', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'the export and import controls live in the desktop tt panel');

    const cat = page.locator('[data-panel="cat"]');
    const ins = page.locator('[data-panel="mod"]');
    const tt = page.locator('[data-panel="tt"]');

    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();
    const pick = tt.locator('[data-act="cohort"]');
    await pick.selectOption('ay2024');

    await cat.getByRole('button', { name: /50\.001/ }).click();
    await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
    await cat.getByRole('button', { name: /50\.001/ }).click();
    await expect(ins).toHaveCount(0);

    await tt.locator('[data-act="export-menu"]').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      tt.locator('[data-act="export-json"]').click(),
    ]);
    const file = (await download.path())!;

    // Stand somewhere else, and clear AY2024 so the import has to bring it back.
    await pick.selectOption('ay2026');
    await expect(tt.locator('[data-level="4"]').getByText('50.001')).toHaveCount(0);

    await tt.locator('[data-act="import-json"]').setInputFiles(file);

    // The panel follows the file: back on AY2024, with the plan restored, and
    // no dialog in between.
    await expect(pick).toHaveValue('ay2024');
    await expect(tt.locator('[data-level="4"]').getByText('50.001')).toBeVisible();
  });

  test('a chip with unmet prereqs shows only the prereqs - no record form', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'hover cards are the desktop affordance; mobile long-presses');

    const cat = page.locator('[data-panel="cat"]');
    const ins = page.locator('[data-panel="mod"]');
    const tt = page.locator('[data-panel="tt"]');

    // 50.003 without 50.001 → red chip, locked record.
    await cat.getByRole('button', { name: /50\.003/ }).click();
    await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
    await cat.getByRole('button', { name: /50\.003/ }).click();

    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();
    await hoverUntil(
      tt.locator('[data-level="5"]').getByText('50.003'),
      tt.locator('[data-card] [data-act="prereq-list"]'),
    );
    await expect(page.getByLabel('component 1 name for 50.003')).toHaveCount(0);
    // The missing prereq is right there, tappable - and one tap plans it a term
    // EARLIER than the mod that needs it. Placing it at its own catalogue term
    // put it at T4 alongside 50.004, where a prereq in the same term is not a
    // prereq met, so the tap answered the demand with a chip still red.
    await tt.locator('[data-act="add-prereq"][data-code="50.001"]').click();
    await expect(tt.locator('[data-level="4"]').getByRole('button', { name: '50.001', exact: true })).toBeVisible();
    await expect(tt.locator('[data-level="5"]').getByRole('button', { name: '50.001', exact: true })).toHaveCount(0);
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

  test('each cohort is a separate plan with its own core', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'verified on desktop; the dropdown renders identically on the mobile tt tab');

    const cat = page.locator('[data-panel="cat"]');
    const ins = page.locator('[data-panel="mod"]');
    const tt = page.locator('[data-panel="tt"]');

    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();
    const pick = tt.locator('[data-act="cohort"]');
    await pick.selectOption('ay2024');

    await cat.getByRole('button', { name: /50\.001/ }).click();
    await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
    await cat.getByRole('button', { name: /50\.001/ }).click();

    const t1 = tt.locator('[data-level="1"]');
    await expect(t1.getByText('10.013')).toBeVisible();

    await pick.selectOption('ay2026');
    // New core in T1: 03.007A plus the uncoded 99.999 placeholders (chips
    // label by NAME because the code isn't unique).
    await expect(t1.getByText('03.007A')).toBeVisible();
    await expect(t1.getByText('Calculus', { exact: true })).toBeVisible();
    await expect(t1.getByText('10.013')).toHaveCount(0);
    // The curricula are SEPARATE plans: the AY2024 50.001 does not exist
    // on the AY2026 side…
    await expect(tt.locator('[data-level="4"]').getByText('50.001')).toHaveCount(0);

    await pick.selectOption('ay2024');
    // …and switching back finds that plan exactly as it was left.
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
    await tt.locator('[data-act="cohort"]').selectOption('ay2026');
    // 03.007A is fixed in AY2026 term 1, and the tree shows it there. Exact,
    // because 03.007, 03.007A and 03.007B are now three different courses and
    // a loose match would resolve to whichever came first.
    await expect(tt.locator('[data-level="1"]').getByText('03.007A')).toBeVisible();

    await cat.getByRole('button', { name: /03\.007A/ }).click();
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

  // Three cohorts, each with its own plan and its own freshmore core. The
  // choice is saved with the layout, because being asked which year you
  // matriculated in on every visit is worse than a wrong default.
  test('the matriculation year is a choice that sticks', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'the plan header is desktop-only chrome');
    // Deliberately on an EMPTY plan: switching to a cohort you have not planned
    // yet must not take the control away with the tree, or there is no way back.
    const tt = page.locator('[data-panel="tt"]');
    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();

    const pick = page.locator('[data-act="cohort"]');
    await expect(pick).toBeVisible();
    // Newest first, and selected by default: most readers matriculated most
    // recently, and a plan is worth more than an unanswered question.
    await expect(pick).toHaveValue('ay2026');

    await pick.selectOption('ay2025');
    // The layout is written on a 300ms debounce, so wait for it to land rather
    // than racing the reload - a reload mid-debounce would read the old value
    // and this would look like a persistence bug that is not there.
    await expect.poll(() => page.evaluate(
      () => JSON.parse(localStorage.getItem('modsutd.workbench.ui.v1') ?? '{}').freshmoreMode,
    ), { timeout: 5_000 }).toBe('ay2025');

    // The panel's open/closed state is restored on reload but the tab within it
    // is not, so re-open the plan tab - and NOT via the rail, which would
    // toggle the whole panel shut.
    await page.reload();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();
    await expect(page.locator('[data-act="cohort"]')).toHaveValue('ay2025');
  });

  // 40.321 needs one of 40.002 / 60.008 - neither is freshmore core, so the
  // choice is the student's to make. The chip used to read the flat
  // prerequisites array, which cannot say "either": it demanded both codes and
  // stayed red after one was placed.
  test('an "either" prerequisite is one pick, and answering it clears the chip', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'plan interactions verified on desktop');
    const cat = page.locator('[data-panel="cat"]');
    const ins = page.locator('[data-panel="mod"]');
    const tt = page.locator('[data-panel="tt"]');

    await cat.getByRole('button', { name: /40\.321/ }).click();
    await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
    await cat.getByRole('button', { name: /40\.321/ }).click();
    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();

    await hoverUntil(tt.getByText('40.321', { exact: true }), tt.locator('[data-act="prereq-list"]'));
    const pick = tt.locator('[data-act="prereq-pick"]');
    await expect(pick).toBeVisible();
    // One slot holding both alternatives, not two separate demands.
    await expect(pick.locator('[data-act="add-prereq"]')).toHaveCount(2);
    await expect(pick).toContainText('40.002');
    await expect(pick).toContainText('60.008');

    // Clicking an option places it, and the pick becomes an answer.
    await pick.locator('[data-act="add-prereq"]').first().click();
    // The question is answered, and the card says which answer. Deliberately
    // not asserting the plan is issue-free: the mod just placed brings its own
    // prerequisites, and those are a different question.
    await expect(tt.locator('[data-act="prereq-pick"]')).toHaveCount(0);
    await hoverUntil(tt.getByText('40.321', { exact: true }), tt.locator('[data-act="prereq-list"]'));
    await expect(tt.locator('[data-act="prereq-list"]')).toContainText('40.002');
    await expect(tt.locator('[data-act="prereq-list"]')).toContainText('✓');
  });

  // Taking the answer back out has to reopen the question.
  test('removing the chosen mod reopens the pick', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'plan interactions verified on desktop');
    const cat = page.locator('[data-panel="cat"]');
    const ins = page.locator('[data-panel="mod"]');
    const tt = page.locator('[data-panel="tt"]');

    for (const code of [/40\.321/, /40\.002/]) {
      await cat.getByRole('button', { name: code }).click();
      await ins.getByRole('button', { name: '+ ADD TO PLAN' }).click();
      await cat.getByRole('button', { name: code }).click();
    }
    await page.locator('button[aria-label="Timetable"]').click();
    await tt.getByRole('button', { name: 'plan', exact: true }).click();

    await hoverUntil(tt.getByText('40.321', { exact: true }), tt.locator('[data-act="prereq-list"]'));
    await expect(tt.locator('[data-act="prereq-pick"]')).toHaveCount(0);

    // Close it before removing: the card is held open by the pointer, so the
    // second hover would be a no-op on an already-open card and the assertion
    // below would be racing the re-render rather than waiting for it.
    await tt.getByRole('button', { name: /close .* card/i }).click();
    await expect(tt.locator('[data-act="prereq-list"]')).toHaveCount(0);

    await tt.getByRole('button', { name: 'remove 40.002 from plan' }).click();
    await hoverUntil(tt.getByText('40.321', { exact: true }), tt.locator('[data-act="prereq-list"]'));
    await expect(tt.locator('[data-act="prereq-pick"]')).toBeVisible();
  });
});
