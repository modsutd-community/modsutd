import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read from the same two files the panel imports, so this cannot drift from
// them: reword a heading in the template and the assertion follows.
const TEMPLATES = join(process.cwd(), '..', '.github', 'ISSUE_TEMPLATE');
const firstHeading = (file: string) => {
  const line = readFileSync(join(TEMPLATES, file), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('### '));
  if (!line) throw new Error(`no "### " heading in ${file}`);
  return line.slice(4);
};
const FEATURE_HEADING = firstHeading('Feature_Request.md');
const BUG_HEADING = firstHeading('Bug_Report.md');

// Two boards, not two halves of one thread. giscus scopes to one category per
// embed, so the tab has to swap the category AND the thread - "the site should
// do X" and "X is broken" are read by different people on different days.
test.describe('discuss panel', () => {
  test('each tab is its own board, and a visited one is not reloaded', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'verified on desktop; the panel renders identically in the mobile sheet');
    await page.goto('/discuss');

    const board = (k: string) => page.locator(`[data-act="board-${k}"] iframe[title="Comments"]`);
    const paramsOf = async (k: string) => {
      const src = new URL((await board(k).getAttribute('src'))!);
      return { category: src.searchParams.get('category'), term: src.searchParams.get('term') };
    };

    await expect(board('feature')).toBeVisible();
    // Nothing loads a board nobody has asked for.
    await expect(board('bug')).toHaveCount(0);
    await expect.poll(async () => (await paramsOf('feature')).term).toBe('features');
    expect((await paramsOf('feature')).category).toBe('Features');

    await page.locator('[data-act="discuss-bug"]').click();
    await expect(board('bug')).toBeVisible();
    await expect.poll(async () => (await paramsOf('bug')).term).toBe('bugs');
    expect((await paramsOf('bug')).category).toBe('Bugs');

    // The first board is still there, hidden - unmounting a cross-origin frame
    // means paying for the whole load again on the way back.
    await expect(board('feature')).toBeHidden();
    await expect(board('feature')).toHaveCount(1);

    await page.locator('[data-act="discuss-feature"]').click();
    await expect(board('feature')).toBeVisible();
    await expect(board('bug')).toBeHidden();
  });

  // A callback prop handed to the embed as an inline arrow is a new function
  // every render, and with it in the effect's deps the iframe rebuilt itself,
  // emitted its discussion again, set state again, and reloaded on a loop -
  // losing whatever had been typed into it each time.
  test('a board that is up stays up', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'verified on desktop; the panel renders identically in the mobile sheet');
    // Freeze Date.now() so the panel cannot decide the board is stale halfway
    // through. A board older than STALE_MS is SUPPOSED to rebuild on the way
    // back in, and on a loaded machine the preamble here - a real cross-origin
    // load from giscus.app - can outlast it, which read as the reload loop
    // this test exists to catch. Timers still run on the real clock, so the
    // loop would still show itself.
    await page.clock.install();
    await page.clock.setFixedTime(new Date('2026-01-01T09:00:00Z'));
    await page.goto('/discuss');

    const feature = page.locator('[data-act="board-feature"] iframe[title="Comments"]');
    await expect(feature).toBeVisible();

    // Attach the counter, let startup settle, THEN zero it. The assertion
    // window starts at the reset, so nothing that happens while the board is
    // coming up can land inside it.
    //
    // Two shapes failed before this one. Waiting on the frame's HEIGHT and
    // attaching the counter after: giscus resizes the frame while it is still
    // loading, so on a slow runner the poll passed before the real load event
    // and the genuine first load counted as 1 - read as the rebuild this test
    // exists to catch, which is how it went red on main while the five runs
    // before it passed. Then waiting for the counter to reach 1: locally the
    // frame is already up before the listener attaches, so that load never
    // comes and the poll times out. A settle-then-reset needs neither event to
    // arrive in any particular order.
    await feature.evaluate((el) => {
      (window as unknown as {loads: number}).loads = 0;
      el.addEventListener('load', () => { (window as unknown as {loads: number}).loads += 1; });
    });
    await expect.poll(
      () => feature.evaluate((el) => el.style.height),
      { timeout: 20_000 },
    ).not.toBe('');
    await page.waitForTimeout(2000);
    await page.evaluate(() => { (window as unknown as {loads: number}).loads = 0; });

    // A rebuilt frame is a new src and a new load; a frame merely hidden and
    // shown again is neither.
    const loads = () => page.evaluate(() => (window as unknown as {loads: number}).loads);
    const src = await feature.getAttribute('src');

    await page.locator('[data-act="discuss-bug"]').click();
    await expect(page.locator('[data-act="board-bug"] iframe')).toBeVisible();
    await page.locator('[data-act="discuss-feature"]').click();
    await expect(feature).toBeVisible();

    // Give a reload loop a chance to show itself.
    await page.waitForTimeout(3000);
    expect(await loads()).toBe(0);
    expect(await feature.getAttribute('src')).toBe(src);
  });

  // giscus fetches a thread once and never polls, so a board that stays up
  // stays stale: somebody else's comment is simply not in it. It is rebuilt on
  // the way back IN to a board - never on a timer, because a rebuild throws
  // away whatever is in the box and that is somebody's half-written report.
  //
  // The rebuild loads behind the thread already on screen and takes over when
  // it has something to show, so there is never an empty panel.
  test('a stale board is rebuilt behind the one on screen', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'verified on desktop; the panel renders identically in the mobile sheet');
    await page.clock.install();
    await page.goto('/discuss');

    const feature = page.locator('[data-act="board-feature"] iframe[title="Comments"]');
    const next = page.locator('[data-act="board-feature-next"]');
    await expect.poll(
      () => feature.first().evaluate((el) => el.style.height),
      { timeout: 20_000 },
    ).not.toBe('');
    await expect(next).toHaveCount(0);

    // Mark the frame that is up. A rebuild replaces the element, so the mark
    // going missing is the rebuild happening - and it is the only way to see
    // it from out here, since the swap is meant to be invisible.
    const mark = () => feature.first().evaluate((el) => {
      (el as HTMLIFrameElement & {seen?: boolean}).seen = true;
    });
    const marked = () => feature.first().evaluate(
      (el) => (el as HTMLIFrameElement & {seen?: boolean}).seen === true,
    );
    await mark();

    // Switching away and straight back is not stale, so nothing is rebuilt and
    // the frame that was up is the frame still up.
    await page.locator('[data-act="discuss-bug"]').click();
    await page.locator('[data-act="discuss-feature"]').click();
    await expect(next).toHaveCount(0);
    expect(await marked()).toBe(true);

    // An hour later it is stale, so it rebuilds on its own - a board left open
    // has to pick up what other people have posted since.
    await page.clock.fastForward('01:00:00');

    // The board never blanks: the thread on screen stays up while the fresh
    // copy loads out of sight, and is replaced only once that one is ready.
    await expect(feature.first()).toBeVisible();
    await expect.poll(marked, { timeout: 25_000 }).toBe(false);
  });

  // The box is cross-origin so its contents cannot be read, but focus can be:
  // to type in it you have to be in it. Anyone who has been in there recently
  // keeps what they wrote, however stale the thread behind it gets.
  test('a board someone has been typing in is left alone', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'verified on desktop; the panel renders identically in the mobile sheet');
    await page.clock.install();
    await page.goto('/discuss');

    const feature = page.locator('[data-act="board-feature"] iframe[title="Comments"]');
    const next = page.locator('[data-act="board-feature-next"]');
    await expect.poll(
      () => feature.first().evaluate((el) => el.style.height),
      { timeout: 20_000 },
    ).not.toBe('');

    // Mark it, so a rebuild is visible from out here: a rebuild replaces the
    // element, and the mark goes with it.
    await feature.first().evaluate((el) => {
      (el as HTMLIFrameElement & {seen?: boolean}).seen = true;
      // Focus into the frame is what the page sees when someone starts writing.
      el.focus();
      window.dispatchEvent(new Event('blur'));
    });
    const marked = () => feature.first().evaluate(
      (el) => (el as HTMLIFrameElement & {seen?: boolean}).seen === true,
    );

    // Long past stale, and past two turns of the poll, and it stays put: a
    // fresher thread is not worth somebody's half-written report.
    await page.clock.fastForward('05:00');
    await page.waitForTimeout(1500);
    await expect(next).toHaveCount(0);
    expect(await marked()).toBe(true);
  });

  // The templates are imported from .github/ISSUE_TEMPLATE at build time, so
  // the panel copies them with no network at all - and never offers a link to
  // the issue form, which is where a reader used to end up filing the very
  // thing this panel exists to collect.
  //
  // The template is not on screen, so the clipboard is where to check it: that
  // is the only place it reaches a reader now.
  test('copies the real template, with no way to wander off into an issue', async ({ page, context, isMobile }) => {
    test.skip(!!isMobile, 'same markup on mobile; one run is enough');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // Nothing may reach out for it. A failed fetch used to leave a link to the
    // issue form as the only thing on screen.
    await page.route('**/api.github.com/**', (r) => r.abort());
    await page.goto('/discuss');

    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

    await page.locator('[data-act="discuss-copy"]').click();
    const feature = await clipboard();
    expect(feature).toContain(FEATURE_HEADING);
    // Frontmatter configures GitHub's issue form and is not part of what you
    // write, so it is stripped.
    expect(feature).not.toContain('labels:');

    await page.locator('[data-act="discuss-bug"]').click();
    await page.locator('[data-act="discuss-copy"]').click();
    expect(await clipboard()).toContain(BUG_HEADING);

    // No route out of the panel into the issue tracker.
    const panel = page.locator('[data-panel="discuss"]');
    await expect(panel.locator('a[href*="issues/new"]')).toHaveCount(0);
  });
});
