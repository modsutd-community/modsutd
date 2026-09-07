import { test, expect, Page } from '@playwright/test';
import { coursesWithSchedules } from './support/courses';

// The batch-chat button and its eligibility rules. Shipped data has no
// schedules (crowdsourced-only) and no live term, so both are injected at
// the network layer rather than committed as fake data.
const LIVE_TERM = { start: '2026-01-01', end: '2099-01-01' };

async function stub(page: Page, codes: string[], registry: Record<string, unknown>) {
  await page.route('**/data/term-window.json', (r) => r.fulfill({ json: LIVE_TERM }));
  await page.route('**/data/telegram-groups.json', (r) => r.fulfill({ json: registry }));
  await page.route('**/data/courses.json', (r) => r.fulfill({
    json: coursesWithSchedules(codes, [{
      type: 'Lecture', day: 'Monday', startTime: '09:00', endTime: '11:00',
      location: '2.101', instructors: [],
    }]),
  }));
}

test.describe('telegram batch chat', () => {
  const ENTRY = {
    '50.001': { linkEnc: 'v1:stub:stub', title: 'x', created: '2026-07', expires: '2099-01-01' },
  };

  test('an offered mod shows the branded join button', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await stub(page, ['50.001'], ENTRY);
    await page.goto('/mods/50.001');

    const join = page.locator('[data-panel="mod"]').getByRole('button', { name: /Join the Tele chat/ });
    await expect(join).toBeVisible();
    await expect(join.locator('svg')).toBeVisible();
    await expect(join).toHaveCSS('color', 'rgb(255, 255, 255)');
    // The registry is public, so it must never carry a usable link.
    expect(await page.content()).not.toContain('t.me/+');

    // The supergroup caveat is a hover, not a permanent line of small print
    // under the button - it is only worth reading once a link has refused, and
    // sitting there it reads as a warning about the button itself.
    await expect(join).toHaveAttribute('data-tip', /supergroup/);
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
    await stub(page, ['50.001'], {});
    await page.route(/telegram-groups\.json/, (r) => {
      reads += 1;
      return r.fulfill({ json: {} });
    });

    await page.clock.install();
    await page.goto('/mods/50.001');
    // fetchAll reads the registry twice, the bundled copy and the one on main,
    // and they land independently - so wait for both before taking a baseline
    // or the second one lands during the next assertion and reads as a refresh.
    await expect.poll(() => reads).toBe(2);
    const afterLoad = reads;

    const cat = page.locator('[data-panel="cat"]');
    const reopen = async () => {
      await cat.getByRole('button', { name: /10\.013/ }).first().click();
      await cat.getByRole('button', { name: /50\.001/ }).first().click();
      await expect(page.locator('[data-panel="mod"]')).toContainText('50.001');
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

  test('a refused link is explained in the top banner, not inline', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await stub(page, ['50.001'], ENTRY);
    await page.route('**/api/telegram-link', (r) =>
      r.fulfill({ status: 429, json: { code: 'quota', error: 'that is 8 join links today - the rest unlock tomorrow' } }));
    await page.goto('/mods/50.001');

    // Wait on the request, not on the banner appearing in time: notice.ts
    // clears itself after 7s, and the assertion's own budget is shorter than
    // that, so a stalled worker could let the banner come and go unseen.
    // Anchoring to the response means only the render is being waited on.
    const refused = page.waitForResponse('**/api/telegram-link');
    await page.locator('[data-panel="mod"]').getByRole('button', { name: /Join the Tele chat/ }).click();
    await refused;
    await expect(page.getByRole('status').getByText(/8 join links today/)).toBeVisible();
  });

  test('capstone and thesis mods never get a chat', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await stub(page, ['01.400', '20.512'], {});

    for (const code of ['01.400', '20.512']) {
      await page.goto(`/mods/${code}`);
      const mod = page.locator('[data-panel="mod"]');
      await expect(mod.locator(`[data-code="${code}"]`)).toBeVisible();
      await expect(mod.getByRole('button', { name: /Join the Tele chat/ })).toHaveCount(0);
    }
  });
});
