import { test, expect, type BrowserContext } from '@playwright/test';

// "if i clear my timetable from browser A (laptop), then on my browser B
// (mobile) it should be gone as well."
//
// Two real browser contexts running the real app - useSync, useAutoBackup,
// sectionSync, pushBackup all genuinely execute. Only GitHub is a stub, held
// in this one variable, so the two contexts share a gist the way two devices
// on one account do.
//
// Deletion is the case that used to be impossible: newerSections refused any
// empty section outright, so a clear could never leave the device that made it.

const DESC = 'modSUTD records (private) - notes, scores, plan backups';
const FILE = 'modsutd-records.json';
const TOKEN = 'modsutd.gh.token.v1';
const CONSENT = 'modsutd.timetable.consent.v3';
const TT = 'modsutd.timetable.v1';

const PASTE = `
01.106 - Engineering Management
1010 LE01 Lecture
   Mo 09:00 - 11:00 2.101
       Prof. Test Fixture
   01/09/2026 - 13/12/2026
`;

test('a clear on one browser reaches the other', async ({ browser, isMobile }) => {
  test.skip(!!isMobile, 'drives the desktop panel; the sync path underneath is shared');
  test.setTimeout(180_000);
  let gist: string | null = null; // the one shared gist, or none yet

  const wire = async (ctx: BrowserContext) => {
    await ctx.route('**/api/contribute', (r) => r.fulfill({ json: { ok: true } }));
    await ctx.route('https://api.github.com/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();
      if (url.includes('/gists?per_page')) {
        return route.fulfill({ json: gist === null ? [] : [{ id: 'g1', description: DESC }] });
      }
      if (url.includes('/gists/g1') && method === 'GET') {
        return route.fulfill({ json: { files: { [FILE]: { content: gist ?? '{}' } } } });
      }
      if (url.includes('/gists/g1') && method === 'PATCH') {
        gist = JSON.parse(req.postData() ?? '{}').files[FILE].content;
        return route.fulfill({ json: { id: 'g1' } });
      }
      if (url.endsWith('/gists') && method === 'POST') {
        gist = JSON.parse(req.postData() ?? '{}').files[FILE].content;
        return route.fulfill({ status: 201, json: { id: 'g1' } });
      }
      return route.fulfill({ json: {} }); // contents API and anything else
    });
  };

  const open = async () => {
    const ctx = await browser.newContext();
    await wire(ctx);
    const page = await ctx.newPage();
    await page.goto('/timetable');
    await page.evaluate(([t, c]) => {
      localStorage.setItem(t, 'tok');
      localStorage.setItem(c, 'yes');
    }, [TOKEN, CONSENT]);
    await page.reload();
    return { ctx, page };
  };

  const events = (p: import('@playwright/test').Page) =>
    p.evaluate((k) => {
      try {
        return (JSON.parse(localStorage.getItem(k) ?? '{}').events ?? []).length as number;
      } catch {
        return -1;
      }
    }, TT);

  // A pastes.
  const a = await open();
  await a.page.getByRole('button', { name: /generate timetable/i }).first().click();
  await a.page.locator('[data-panel="tt"]').locator('textarea').fill(PASTE);
  await a.page.getByRole('button', { name: /^parse/i }).first().click();
  await expect.poll(() => events(a.page), { timeout: 30_000 }).toBeGreaterThan(0);

  // ...and the autosave pushes it. Poll for the CONTENT, not for the gist to
  // exist: linking seeds an empty one straight away, so "a gist is there" is
  // true seconds before the paste is in it.
  await expect.poll(
    () => (gist ? JSON.parse(gist).timetable.length : 0),
    { timeout: 90_000 },
  ).toBeGreaterThan(0);

  // B opens and takes it.
  const b = await open();
  await expect.poll(() => events(b.page), { timeout: 60_000 }).toBeGreaterThan(0);

  // A clears.
  await a.page.getByRole('button', { name: /^clear$/ }).first().click();
  await expect.poll(() => events(a.page), { timeout: 15_000 }).toBe(0);
  await expect.poll(() => (gist ? JSON.parse(gist).timetable.length : -1), { timeout: 60_000 }).toBe(0);

  // B follows, with no reload and no navigation. This is the assertion the
  // whole feature exists for.
  await expect.poll(() => events(b.page), { timeout: 90_000 }).toBe(0);

  await a.ctx.close();
  await b.ctx.close();
});

// The shape the user actually hit: B is ALREADY open and idle, linked from a
// previous session, when A changes something. The test above opens B after the
// push, which is an easier case - B's first pull finds the change waiting.
// Here B has to notice on its own, with no reload and no relink.
test('a browser already open picks up a change it did not ask for', async ({ browser, isMobile }) => {
  test.skip(!!isMobile, 'drives the desktop panel; the sync path underneath is shared');
  test.setTimeout(420_000);
  let gist: string | null = null;

  const wire = async (ctx: BrowserContext) => {
    await ctx.route('**/api/contribute', (r) => r.fulfill({ json: { ok: true } }));
    await ctx.route('https://api.github.com/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();
      if (url.includes('/gists?per_page')) {
        return route.fulfill({ json: gist === null ? [] : [{ id: 'g1', description: DESC }] });
      }
      if (url.includes('/gists/g1') && method === 'GET') {
        return route.fulfill({ json: { files: { [FILE]: { content: gist ?? '{}' } } } });
      }
      if (url.includes('/gists/g1') && method === 'PATCH') {
        gist = JSON.parse(req.postData() ?? '{}').files[FILE].content;
        return route.fulfill({ json: { id: 'g1' } });
      }
      if (url.endsWith('/gists') && method === 'POST') {
        gist = JSON.parse(req.postData() ?? '{}').files[FILE].content;
        return route.fulfill({ status: 201, json: { id: 'g1' } });
      }
      return route.fulfill({ json: {} });
    });
  };

  const open = async () => {
    const ctx = await browser.newContext();
    await wire(ctx);
    const page = await ctx.newPage();
    await page.goto('/timetable');
    await page.evaluate(([t, c]) => {
      localStorage.setItem(t, 'tok');
      localStorage.setItem(c, 'yes');
    }, [TOKEN, CONSENT]);
    await page.reload();
    return { ctx, page };
  };

  const events = (p: import('@playwright/test').Page) =>
    p.evaluate((k) => {
      try {
        return (JSON.parse(localStorage.getItem(k) ?? '{}').events ?? []).length as number;
      } catch {
        return -1;
      }
    }, TT);

  // BOTH open first, both empty. B parks on the room whose heatmap the paste
  // will fill and then just sits there - no navigation for the rest of the test.
  const a = await open();
  const b = await open();
  await b.page.goto('/venues?focus=2.101');
  expect(await events(b.page)).toBe(0);

  // A pastes, well after B's own first pull has already come back empty.
  await a.page.getByRole('button', { name: /generate timetable/i }).first().click();
  await a.page.locator('[data-panel="tt"]').locator('textarea').fill(PASTE);
  await a.page.getByRole('button', { name: /^parse/i }).first().click();
  await expect.poll(() => events(a.page), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => gist, { timeout: 60_000 }).not.toBeNull();

  // B has to find it by itself. No reload, no navigation, no relink.
  await expect.poll(() => events(b.page), { timeout: 240_000 }).toBeGreaterThan(0);

  // And the CONTRIBUTED slots with it. This is the half the user actually
  // noticed missing: the room heatmap and the chat button both read the
  // overlaid schedules, and those live in `contributed`, not `timetable`.
  // Carrying one without the other syncs a calendar and no room availability.
  await expect.poll(
    () => b.page.evaluate(() => localStorage.getItem('modsutd.contributed.v3') ?? ''),
    { timeout: 60_000 },
  ).toContain('01.106');

  // Reaching localStorage is not enough: overlayLocal runs where the courses
  // are loaded, so without reloading those slices the heatmap stays empty
  // however complete the store is.
  //
  // B was already sitting on the room BEFORE the paste - navigating here now
  // would remount the app, re-run overlayLocal off localStorage, and pass
  // whether or not the sync repaints anything.
  await expect.poll(
    () => b.page.evaluate(() =>
      (document.querySelector('[data-act="room-heatmap"]') as HTMLElement)?.innerText?.includes('01.106') ?? false),
    { timeout: 180_000 },
  ).toBe(true);

  // The other half a reader notices: the chat button. It reads the same
  // overlaid schedules the heatmap does, so a sync that carries one and not
  // the other gives a phone a warm room and no way to join the cohort.
  // B never pasted, so this only exists if `contributed` really travelled.
  await b.page.goto('/mods/01.106');
  await expect.poll(
    () => b.page.evaluate(() => !!document.querySelector(
      '[data-act="tele-awaiting"], [data-act="tele-create"], [data-act="tele-creating"]')),
    { timeout: 60_000 },
  ).toBe(true);

  await a.ctx.close();
  await b.ctx.close();
});


// Paste FIRST, link SECOND - which is the order a student actually does it in.
// Both existing tests link before pasting, so the paste is what wakes the
// autosave and the gist gets seeded on the way past. Link afterwards and
// nothing about the bundle changes, so an effect keyed only on the bundle
// never runs again and the gist is never created at all. Nothing syncs, in
// either direction, for the whole life of the account.
test('linking after a paste still creates the gist', async ({ browser, isMobile }) => {
  test.skip(!!isMobile, 'drives the desktop panel; the sync path underneath is shared');
  test.setTimeout(180_000);
  let gist: string | null = null;

  const ctx = await browser.newContext();
  await ctx.route('**/api/contribute', (r) => r.fulfill({ json: { ok: true } }));
  await ctx.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    if (url.includes('/gists?per_page')) {
      return route.fulfill({ json: gist === null ? [] : [{ id: 'g1', description: DESC }] });
    }
    if (url.includes('/gists/g1') && method === 'GET') {
      return route.fulfill({ json: { files: { [FILE]: { content: gist ?? '{}' } } } });
    }
    if (url.includes('/gists/g1') && method === 'PATCH') {
      gist = JSON.parse(req.postData() ?? '{}').files[FILE].content;
      return route.fulfill({ json: { id: 'g1' } });
    }
    if (url.endsWith('/gists') && method === 'POST') {
      gist = JSON.parse(req.postData() ?? '{}').files[FILE].content;
      return route.fulfill({ status: 201, json: { id: 'g1' } });
    }
    return route.fulfill({ json: {} });
  });

  const page = await ctx.newPage();
  await page.goto('/timetable');
  // Consent only. NOT linked yet.
  await page.evaluate((c) => localStorage.setItem(c, 'yes'), CONSENT);
  await page.reload();
  await page.getByRole('button', { name: /generate timetable/i }).first().click();
  await page.locator('[data-panel="tt"]').locator('textarea').fill(PASTE);
  await page.getByRole('button', { name: /^parse/i }).first().click();
  await expect.poll(
    () => page.evaluate((k) => (JSON.parse(localStorage.getItem(k) ?? '{}').events ?? []).length as number, TT),
    { timeout: 30_000 },
  ).toBeGreaterThan(0);
  expect(gist, 'nothing should be pushed before linking').toBeNull();

  // NOW link, exactly as the banner does: write the token and announce it.
  await page.evaluate((t) => {
    localStorage.setItem(t, 'tok');
    window.dispatchEvent(new Event('modsutd:gh-link'));
  }, TOKEN);

  // The timetable that was already on screen has to reach the gist.
  await expect.poll(
    () => (gist ? JSON.parse(gist).timetable.length : 0),
    { timeout: 90_000 },
  ).toBeGreaterThan(0);

  await ctx.close();
});
