import { test, expect, Page } from '@playwright/test';
import { pasteWeekly, openPasteBox } from './support/weekly';
import { coursesWithSchedules } from './support/courses';

// The batch-chat button and its eligibility rules. Shipped data has no
// schedules (crowdsourced-only) and no live term, so both are injected at
// the network layer rather than committed as fake data.
const LIVE_TERM = { start: '2026-01-01', end: '2099-01-01' };

async function stub(page: Page, codes: string[], registry: Record<string, unknown>) {
  await page.route('**/data/term-window.json', (r) => r.fulfill({ json: LIVE_TERM }));
  // A regex, not a glob: fetchAll reads the registry twice, the bundled copy
  // and the one on main through raw.githubusercontent with a cache-busting
  // query. A glob on the path matches only the first, and the real registry
  // from main then leaks into a test that meant to supply its own.
  await page.route(/telegram-groups\.json/, (r) => r.fulfill({ json: registry }));
  await page.route('**/data/courses.json', (r) => r.fulfill({
    json: coursesWithSchedules(codes, [{
      type: 'Lecture', day: 'Monday', startTime: '09:00', endTime: '11:00',
      location: '2.101', instructors: [],
    }]),
  }));
}

test.describe('telegram batch chat', () => {
  // A T7 CSD elective, and it has to stay one. 50.040 stands here because a
  // course a student CHOOSES is the only kind that gets a chat: this suite used
  // 50.001 until it was read off CSD's own core listing, and every eligibility
  // test then asserted against a mod that is no longer eligible.
  const ENTRY = {
    '50.040': { linkEnc: 'v1:stub:stub', title: 'x', created: '2026-07', expires: '2099-01-01' },
  };

  test('an offered mod shows the branded join button', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await stub(page, ['50.040'], ENTRY);
    await page.goto('/mods/50.040');

    const join = page.locator('[data-panel="mod"]').getByRole('button', { name: /Join the Tele chat/ });
    await expect(join).toBeVisible();
    await expect(join.locator('svg')).toBeVisible();
    await expect(join).toHaveCSS('color', 'rgb(255, 255, 255)');
    // The registry is public, so it must never carry a usable link.
    expect(await page.content()).not.toContain('t.me/+');

    // The supergroup caveat is a hover, not a permanent line of small print
    // under the button - it is only worth reading once a link has refused, and
    // sitting there it reads as a warning about the button itself.
    // Asserted as "there is a tip", not as its wording: the cause a dead link
    // is blamed on has changed once already, and a regex on the copy would go
    // green by accident the next time it does.
    await expect(join).toHaveAttribute('data-tip', /.+/);
    await expect(page.locator('[data-panel="mod"]')).not.toContainText('link invalid?');
  });

  // The registry is a file on main, and a group is created by a workflow
  // minutes after somebody asks for one. Cached for the whole session, the
  // panel showed whatever was true at page load, so a chat that appeared since
  // only turned up on a reload - including for the person who asked for it.
  //
  // What is asserted is the fetch, not the button: the button needs a registry
  // that has changed underneath, and the fetch is the thing that was missing.
  // Navigation is inside the app, never page.goto - a reload wipes the module
  // cache and would pass whether or not the fix is there.
  test('a stale registry is re-read while the panel is open, without a reload', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    let reads = 0;
    // Registered LAST on purpose: Playwright tries the most recently added
    // route first, so a counting route added before stub() never fires.
    await stub(page, ['50.040'], {});
    await page.route(/telegram-groups\.json/, (r) => {
      reads += 1;
      return r.fulfill({ json: {} });
    });

    await page.clock.install();
    await page.goto('/mods/50.040');
    // fetchAll reads the registry twice, the bundled copy and the one on main,
    // and they land independently - so wait for both before taking a baseline
    // or the second one lands during the next assertion and reads as a refresh.
    await expect.poll(() => reads).toBe(2);
    const afterLoad = reads;

    const cat = page.locator('[data-panel="cat"]');
    const reopen = async () => {
      await cat.getByRole('button', { name: /10\.013/ }).first().click();
      await cat.getByRole('button', { name: /50\.040/ }).first().click();
      await expect(page.locator('[data-panel="mod"]')).toContainText('50.040');
    };

    // Inside the window, clicking through mods costs no fetch at all.
    await reopen();
    await reopen();
    await page.waitForTimeout(300);
    expect(reads).toBe(afterLoad);

    // Past it, the panel reads the registry again on its own - so a chat
    // created in the meantime is picked up with no reload anywhere.
    await page.clock.fastForward('05:00');
    await expect.poll(() => reads, { timeout: 15_000 }).toBeGreaterThan(afterLoad);
  });

  // Between the paste and the commit reaching main, a mod that was just
  // contributed looked exactly like one nobody is taking: no button and no
  // reason. It says so now, and only to the browser that pasted - nobody else
  // is owed the explanation. The wait is the ~11s commit, NOT the deploy.
  test('a mod this browser contributed says its slots are still saving', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await page.route('**/data/term-window.json', (r) => r.fulfill({ json: LIVE_TERM }));
    await page.route(/telegram-groups\.json/, (r) => r.fulfill({ json: {} }));
    // main has not got the slots yet - that is the state under test, and
    // without this stub the probe would flip it straight to ready.
    await page.route(/raw\.githubusercontent\.com.*courses/, (r) => r.fulfill({ json: { schedules: [] } }));
    // COMMITTING is "this browser pasted, the build has not caught up", and
    // overlayLocal never covers deployed data - so the bundle has to have no
    // slots for this mod. Emptied here rather than relying on the shipped file
    // still being empty: one contributed timetable would make that untrue and
    // this test would fail for a reason that has nothing to do with the state.
    await page.route('**/data/courses.json', (r) => r.fulfill({
      json: coursesWithSchedules(['50.040'], []),
    }));

    await page.goto('/mods/50.040');
    const waiting = page.locator('[data-act="tele-awaiting"]');
    // Nobody who has not pasted sees anything at all.
    await expect(waiting).toHaveCount(0);

    await page.evaluate(() => localStorage.setItem(
      'modsutd.contributed.v3',
      JSON.stringify({ '50.040': { at: Date.now(), termEnd: '2099-12-12', schedules: [
        { type: 'Cohort', day: 'Monday', startTime: '09:00', endTime: '11:00', location: '2.101', instructors: [] },
      ] } })));
    await page.reload();

    await expect(waiting).toBeVisible();
    await expect(waiting).toBeDisabled();
    // Seconds, not the next build: naming a deploy four hours out for an
    // eleven-second wait is what made this state read as a dead end.
    await expect(waiting).toHaveAttribute('data-tip', /seconds/);
  });

  // The state exists to cover the gap before a deploy, and on the first paste
  // of a term the deployed window is still empty - so gating it on that window
  // hid it during exactly the period it is for. The entry carries its own term
  // end instead.
  test('waits even when no term window has been deployed yet', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await page.route('**/data/term-window.json', (r) => r.fulfill({ json: {} }));
    await page.route(/term-window\.json/, (r) => r.fulfill({ json: {} }));
    await page.route(/telegram-groups\.json/, (r) => r.fulfill({ json: {} }));

    await page.route(/raw\.githubusercontent\.com.*courses/, (r) => r.fulfill({ json: { schedules: [] } }));
    // COMMITTING is "this browser pasted, the build has not caught up", and
    // overlayLocal never covers deployed data - so the bundle has to have no
    // slots for this mod. Emptied here rather than relying on the shipped file
    // still being empty: one contributed timetable would make that untrue and
    // this test would fail for a reason that has nothing to do with the state.
    await page.route('**/data/courses.json', (r) => r.fulfill({
      json: coursesWithSchedules(['50.040'], []),
    }));

    await page.goto('/mods/50.040');
    await page.evaluate(() => localStorage.setItem(
      'modsutd.contributed.v3',
      JSON.stringify({ '50.040': { at: Date.now(), termEnd: '2099-12-12', schedules: [
        { type: 'Cohort', day: 'Monday', startTime: '09:00', endTime: '11:00', location: '2.101', instructors: [] },
      ] } })));
    await page.reload();

    await expect(page.locator('[data-act="tele-awaiting"]')).toBeVisible();
  });

  // A weekly paste contributes nothing, so it must promise nothing. It returns
  // before the relay post, which is the only thing that records a mod here.
  test('a weekly paste promises no chat', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await page.route('**/data/term-window.json', (r) => r.fulfill({ json: LIVE_TERM }));
    await page.route(/telegram-groups\.json/, (r) => r.fulfill({ json: {} }));
    let posted = 0;
    await page.route('**/api/contribute', (r) => { posted += 1; return r.fulfill({ json: { ok: true } }); });

    await openPasteBox(page);
    await pasteWeekly(page);
    // it did render, so this is "contributed nothing", not "parsed nothing"
    await expect(page.locator('[data-act="tt-grid"]')).toBeVisible();

    expect(posted).toBe(0);
    const stored = await page.evaluate(() => localStorage.getItem('modsutd.contributed.v3'));
    expect(stored).toBe(null);

    await page.goto('/mods/50.040');
    await expect(page.locator('[data-act="tele-awaiting"]')).toHaveCount(0);
  });

  test('a refused link is explained in the top banner, not inline', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await stub(page, ['50.040'], ENTRY);
    await page.route('**/api/telegram-link', (r) =>
      r.fulfill({ status: 429, json: { code: 'quota', error: 'that is 8 join links today - the rest unlock tomorrow' } }));
    await page.goto('/mods/50.040');

    // Wait on the request, not on the banner appearing in time: notice.ts
    // clears itself after 7s, and the assertion's own budget is shorter than
    // that, so a stalled worker could let the banner come and go unseen.
    // Anchoring to the response means only the render is being waited on.
    const refused = page.waitForResponse('**/api/telegram-link');
    await page.locator('[data-panel="mod"]').getByRole('button', { name: /Join the Tele chat/ }).click();
    await refused;
    await expect(page.getByRole('status').getByText(/8 join links today/)).toBeVisible();
  });

  // 50.001 is the pillar-core half of this: everybody in CSD takes it, so the
  // chat would have the same membership as the cohort chat they are already in.
  // It is flagged by tools/scraper/gather_cores.py rather than by hand,
  // which is why it is worth an assertion - a listing that stops parsing takes
  // the flag off and nothing else would notice.
  test('capstones, thesis mods and pillar cores never get a chat', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await stub(page, ['01.400', '20.512', '50.001'], {});

    for (const code of ['01.400', '20.512', '50.001']) {
      await page.goto(`/mods/${code}`);
      const mod = page.locator('[data-panel="mod"]');
      await expect(mod.locator(`[data-code="${code}"]`)).toBeVisible();
      // tele-create is what an ELIGIBLE mod draws under these stubs: the term
      // is live and the slots are on main, so the only thing standing between
      // it and a chat is the flag. Asserting on the LIVE join button instead
      // would hold for every state, because the registry here is empty.
      await expect(mod.locator('[data-act="tele-create"]')).toHaveCount(0);
    }
  });

  // The catalogue marks a chat that EXISTS, not one that could. Eligibility is
  // a property of the record and would mark every HASS course in the catalogue
  // whether or not it runs this term; the registry is the only thing that
  // knows a group was actually made, and "there is a chat to join" is the
  // question a reader scanning the list is asking.
  test('the catalogue marks a chat that exists or one the button would make',
    async ({ page }) => {
      // 50.040 and 10.013 get slots, so both "run this term"; the registry is
      // empty, so nothing here has a chat yet.
      await stub(page, ['50.040', '10.013'], {});
      const only = async (code: string) => {
        await page.goto(`/mods?q=${code}`);
        await expect(page.getByText(code, { exact: false }).first()).toBeVisible();
        return page.locator('[data-act="tele-eligible"]');
      };

      // Eligible AND running, with no chat yet: one click would make one, so
      // the row is marked. This is the case the registry alone misses.
      await expect(await only('50.040')).toHaveCount(1);
      // Running this term, and freshmore, whose cohort already shares a chat.
      await expect(await only('10.013')).toHaveCount(0);
      // Eligible forever, HASS, and not offered this term: no slots, so
      // nothing anyone could create. This is the case that prompted the rule.
      await expect(await only('02.153')).toHaveCount(0);
      // And its sibling that IS offered this term is marked, on the strength
      // of one slot and no registry entry at all.
      await expect(await only('02.146')).toHaveCount(1);
      // A capstone, running or not.
      await expect(await only('01.400')).toHaveCount(0);
    });

  // A chat that exists is joinable whatever the catalogue says about the
  // course, so an entry outranks the rest of the rule.
  test('the catalogue marks a live chat for a mod with no slots', async ({ page }) => {
    await stub(page, [], ENTRY);
    await page.goto('/mods?q=50.040');
    await expect(page.getByText('50.040', { exact: false }).first()).toBeVisible();
    await expect(page.locator('[data-act="tele-eligible"]')).toHaveCount(1);
  });

  // An entry whose term has ended is not a chat anyone can join. Asserted on
  // 02.153, which has no slots: for a mod that IS running, the other half of
  // the rule marks the row whatever the old entry says, and rightly so.
  test('the catalogue drops the mark when the entry has expired', async ({ page }) => {
    await stub(page, [], {
      '02.153': { linkEnc: 'v1:stub:stub', title: 'x', created: '2020-01', expires: '2020-06-30' },
    });
    await page.goto('/mods?q=02.153');
    await expect(page.getByText('02.153', { exact: false }).first()).toBeVisible();
    await expect(page.locator('[data-act="tele-eligible"]')).toHaveCount(0);
  });

  // The registry lives on main and is read through raw.githubusercontent,
  // which serves `Cache-Control: max-age=300`. `no-store` only stops the
  // BROWSER reusing a response - the CDN in front of it answers with whatever
  // it has - so a chat created a minute ago stayed invisible for five, and a
  // hard reload was the only thing that shifted it. A unique query string is
  // part of the cache key, so it reaches the origin.
  test('asks the origin for the registry, not a five-minute-old copy', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    const raw: string[] = [];
    await page.route(/raw\.githubusercontent\.com/, (r) => {
      raw.push(r.request().url());
      return r.fulfill({ json: {} });
    });
    await page.goto('/mods/50.040');
    await expect.poll(() => raw.length, { timeout: 10_000 }).toBeGreaterThan(0);
    for (const url of raw) expect(url).toMatch(/[?&]t=\d+/);
  });
});
