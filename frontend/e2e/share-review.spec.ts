import { test, expect } from '@playwright/test';

// One-click posting: with GitHub linked, the review posts via the API -
// no composer tab. The stub pins the outbound contract: structured
// markdown labels, the giscus-compatible thread title, one comment.
test.describe('share - direct review posting', () => {
  test('linked user posts a structured review in one click', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'the flow is identical in the mobile sheet');

    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    await page.route('https://api.github.com/graphql', async (route) => {
      const body = route.request().postDataJSON() as { query: string; variables: Record<string, unknown> };
      calls.push(body);
      if (body.query.includes('search(')) {
        await route.fulfill({ json: { data: { search: { nodes: [] } } } });
      } else if (body.query.includes('createDiscussion')) {
        await route.fulfill({ json: { data: { createDiscussion: { discussion: { id: 'D_1' } } } } });
      } else {
        await route.fulfill({ json: { data: { addDiscussionComment: { comment: { url: 'https://github.com/x/discussions/1#c-1' } } } } });
      }
    });

    await page.goto('/share');
    await page.evaluate(() => localStorage.setItem('modsutd.gh.token.v1', 'gho_stub'));
    await page.reload();

    const share = page.locator('[data-panel="share"]');
    await share.getByPlaceholder(/search by code or name/).fill('50.001');
    await share.getByRole('button', { name: /50\.001/ }).first().click();
    // Nothing filled in yet, so there is nothing to post on this path either.
    await expect(share.getByRole('button', { name: 'post review', exact: true })).toBeDisabled();
    await share.getByLabel('term taken').selectOption('T4');
    await share.getByLabel('academic year').selectOption({ index: 2 });
    await share.getByLabel('Best part').fill('the labs');
    await share.getByLabel('review body').fill('would take again');

    await share.getByRole('button', { name: 'post review', exact: true }).click();
    await expect(share.getByRole('button', { name: '✓ posted' })).toBeVisible();
    // The link must carry the URL the API returned, not just exist.
    await expect(share.locator('[data-act="view-posted-review"]'))
      .toHaveAttribute('href', 'https://github.com/x/discussions/1#c-1');

    // The form empties itself. Leaving the answers behind invites an accidental
    // second post of the same review, and reads as if it had not sent.
    await expect(share.getByLabel('review body')).toHaveValue('');
    await expect(share.getByLabel('Best part')).toHaveValue('');
    await expect(share.getByLabel('term taken')).toHaveValue('');
    // And the draft goes with them, or a reload brings the whole thing back.
    expect(await page.evaluate(
      () => localStorage.getItem('modsutd.review.drafts.v1'),
    )).not.toContain('would take again');

    expect(calls).toHaveLength(3);
    expect(calls[1].variables.title).toBe('mod-50.001');
    const posted = calls[2].variables.body as string;
    expect(posted).toMatch(/\*\*Term taken\*\*: T4, \d{4}/);
    expect(posted).toContain('**Best part**: the labs');
    expect(posted).toContain('would take again');
    // Untouched fields are absent, not present and blank - an empty label
    // reads as an answered question with nothing to say.
    for (const skipped of ['Results', 'Difficulty', 'Workload', 'Worst part', 'Tips']) {
      expect(posted).not.toContain(skipped);
    }

    // It went to GitHub, so leaving it on screen invites a second identical
    // post and reads as though nothing happened.
    await expect(share.getByLabel('review body')).toHaveValue('');
    await expect(share.getByLabel('Best part')).toHaveValue('');
  });
});

// A review typed into GitHub's discussion composer became the discussion BODY,
// and giscus renders comments only - so it never appeared on the mod page and
// the panel truthfully said "0 comments". One real review was lost that way, so
// the contract is pinned: nothing the student writes goes to the thread-opening
// call, and the answers reach them by clipboard for pasting as a comment.
test.describe('the unlinked path never sends the review to GitHub', () => {
  test('asks the server only for the thread, never for the answers', async ({ page, isMobile, context }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // Wait on the request, not on a status message - the copy for that has
    // been reworded three times and broke this test each time.
    let seen: string | null = null;
    let sawRequest: () => void;
    const requested = new Promise<void>((resolve) => { sawRequest = resolve; });
    await page.route('**/api/review-thread', async (route) => {
      seen = route.request().postData();
      await route.fulfill({
        json: { url: 'https://github.com/modsutd-community/modsutd/discussions/9', created: true },
      });
      sawRequest();
    });

    await page.goto('/mods/10.013');
    const words = 'ABSOLUTELY_UNIQUE_REVIEW_SENTINEL';
    await page.getByLabel('review body').fill(words);

    const popup = context.waitForEvent('page').catch(() => null);
    // Selected by a stable hook, not by its label - the copy gets reworded.
    await page.locator('[data-panel="mod"] [data-act="open-review-thread"]').click();
    await requested;

    expect(seen).toBeTruthy();
    const body = JSON.parse(seen!);
    expect(body.mod).toBe('10.013');
    expect(seen).not.toContain(words);

    // The opposite of the linked path on purpose: this review exists only on
    // the clipboard, so clearing it would destroy the one copy of a student
    // who never noticed the copy happened.
    await expect(page.locator('[data-panel="mod"]').getByLabel('review body')).toHaveValue(words);
    await popup;
  });

  test('an untouched form has nothing to send, so neither path offers to', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await page.goto('/mods/10.013');
    const mod = page.locator('[data-panel="mod"]');
    await expect(mod.locator('[data-act="open-review-thread"]')).toBeDisabled();

    await mod.getByLabel('review body').fill('something to say');
    await expect(mod.locator('[data-act="open-review-thread"]')).toBeEnabled();
  });

  test('keeps each mod its own draft', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await page.goto('/mods/10.013');
    const body = page.getByLabel('review body');
    await body.fill('WRITTEN_FOR_10_013');

    const cat = page.locator('[data-panel="cat"]');
    // Switching in place, not by navigating: a reload clears the form whatever
    // the code does, so a navigating version of this test passes against the
    // bug it is meant to catch.
    await cat.getByRole('button', { name: /10\.020/ }).click();
    await expect(page.locator('[data-panel="mod"]')).toContainText('10.020');
    await expect(body).toHaveValue('');

    await body.fill('WRITTEN_FOR_10_020');
    await cat.getByRole('button', { name: /10\.013/ }).click();
    await expect(page.locator('[data-panel="mod"]')).toContainText('10.013');
    // and back again: the first mod's draft is still there
    await expect(body).toHaveValue('WRITTEN_FOR_10_013');
  });
});

// The bookmarklet is an explicit "review this, with this text". A draft saved
// earlier used to win over it, so the bookmarklet silently appeared to do
// nothing - which is exactly how it was reported.
// The mod page renders the same form, but hands it an onPosted callback the
// share panel does not - and that callback rebuilds the giscus board below it.
// Worth its own test: a form that clears in one host and not the other is the
// kind of thing that only shows up where the extra prop is.
test.describe('mod page - posting clears the form', () => {
  test('the answers go, and the draft goes with them', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'the flow is identical in the mobile sheet');

    await page.route('https://api.github.com/graphql', async (route) => {
      const body = route.request().postDataJSON() as { query: string };
      if (body.query.includes('search(')) {
        await route.fulfill({ json: { data: { search: { nodes: [] } } } });
      } else if (body.query.includes('createDiscussion')) {
        await route.fulfill({ json: { data: { createDiscussion: { discussion: { id: 'D_1' } } } } });
      } else {
        await route.fulfill({ json: { data: { addDiscussionComment: { comment: { url: 'https://github.com/x/d/1#c-1' } } } } });
      }
    });
    await page.addInitScript(() => {
      localStorage.setItem('modsutd.gh.token.v1', 'gho_stub');
    });

    await page.goto('/mods/50.001');
    const ins = page.locator('[data-panel="mod"]');
    await ins.getByLabel('term taken').selectOption('T4');
    await ins.getByLabel('academic year').selectOption({ index: 2 });
    await ins.getByLabel('review body').fill('cleared after posting?');

    await ins.getByRole('button', { name: 'post review', exact: true }).click();
    await expect(ins.getByRole('button', { name: '✓ posted' })).toBeVisible();

    await expect(ins.getByLabel('review body')).toHaveValue('');
    await expect(ins.getByLabel('term taken')).toHaveValue('');
    expect(await page.evaluate(
      () => localStorage.getItem('modsutd.review.drafts.v1'),
    )).not.toContain('cleared after posting?');
  });
});

test.describe('bookmarklet prefill', () => {
  test('arriving text beats a draft already stored for that mod', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await page.goto('/mods/10.013');
    // Both panels carry a review body, and the mod panel stays open behind the
    // share one - scope, or the query matches two textareas.
    await page.locator('[data-panel="mod"]').getByLabel('review body').fill('AN OLDER DRAFT');

    // A fragment, not a query string: the payload never reaches a server log.
    await page.goto('/share#text=TEXT%20FROM%20THE%20BOOKMARKLET&mod=10.013');
    await expect(page.locator('[data-panel="share"]').getByLabel('review body'))
      .toHaveValue('TEXT FROM THE BOOKMARKLET');
  });

  test('still reads the older query-string form', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same component in the mobile sheet');
    await page.goto('/share?text=LEGACY%20QUERY%20FORM&mod=10.013');
    await expect(page.locator('[data-panel="share"]').getByLabel('review body'))
      .toHaveValue('LEGACY QUERY FORM');
  });
});

// The form used to carry a 520px cap, so on a phone it sat narrower than the
// text above it with a gutter down one side.
test.describe('review form width', () => {
  test('fills the sheet it sits in', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the complaint is the mobile sheet');
    // 700px, not the default 390: the old cap was 520px, so at phone width it
    // never bound and a test there would pass against the bug. Big phones in
    // landscape, foldables and tablets are exactly where it showed.
    await page.setViewportSize({ width: 700, height: 900 });
    await page.goto('/mods/10.013');
    const form = page.locator('[data-act="review-form"]').first();
    const box = await form.boundingBox();
    const width = page.viewportSize()!.width;
    // Within the panel's own padding, not hundreds of pixels short.
    expect(box!.width).toBeGreaterThan(width - 60);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  });
});
