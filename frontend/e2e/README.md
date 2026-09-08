# e2e selector rules

A spec must not break when someone rewords a sentence, and must break when the
behaviour changes. That split decides the selector.

It is worth being strict about, because the failure is expensive in both
directions: a copy edit that reddens CI teaches people to distrust the suite,
and a test that passes whatever the button says stopped testing anything.

## use a `data-act` hook

When the element is a means to an end - a click target, a scope for later
queries, something measured. Name it kebab-case after the job, not the label:

```tsx
<button data-act="open-review-thread" …>Post it yourself in the thread →</button>
```

```ts
await page.locator('[data-act="open-review-thread"]').click();
```

One hook per element, shared by every spec that needs it. `data-panel`,
`data-code`, `data-level`, `data-card` and `data-tip` already do this job for
their elements - reuse them rather than adding a second handle.

## a text selector is correct when the text IS the thing under test

- assertions on user-facing copy: `expect(err).toContainText(/enter a valid 24h time/)`
- negative assertions: no hook can express "this wording appears nowhere"
- accessible names via `getByRole` / `getByLabel` / `getByPlaceholder`. These
  look like copy but they are the a11y contract - changing one changes what a
  screen reader announces, and a test *should* fail. Never replace these with a
  hook.
- mod codes and names, which come from `/data`. Those change when the catalogue
  changes, which is exactly when the test should fail.

Keep an assertion narrow: match the shortest distinctive phrase, not a
paragraph.

## never select by CSS-module class

`[class*="thanks"]` is a build artefact. The hash moves when the bundler feels
like it and the name moves on any refactor.

## never assert absence by copy

`expect(x.getByText(/unmet prereqs/)).toHaveCount(0)` is the worst case in this
file, because it fails silently in the direction you cannot see. Reword the
banner and the assertion passes - not because the warning went away, but
because nothing on the page says that any more. The test keeps reporting green
while checking nothing. Six of these were live at once, each one guarding the
payload of its own test.

Find the element by hook, then assert the hook is gone:

```ts
await expect(tt.locator('[data-act="plan-issues"]')).toHaveCount(0);
```

The exception is when the *absent wording itself* is the claim - "no UI anywhere
offers to revoke consent". No hook can express that. Mark it and say why:

```ts
// copy-assert: the absent thing IS the wording - no hook can express that.
await expect(page.getByText(/change consent|private mode/i)).toHaveCount(0);
```

## scope to the panel

Panels stay open behind one another, so the same control can legitimately exist
twice - two review bodies, two search inputs, two giscus widgets. A page-wide
`page.getByLabel('review body')` then matches both and Playwright fails on
strict mode, but only when both happen to be mounted. That is a test that
passes on your machine and fails in CI.

Start from the panel, not the page:

```ts
await page.locator('[data-panel="share"]').getByLabel('review body').fill('…');
```

`[data-panel="mod"|"share"|"tt"|"cat"]` and the mobile `scope(page, isMobile)`
helper exist for this. Reach for `page.` only when the thing really is
page-wide - the rail, the topbar, a route-level assertion.

## the guard

`npm run e2e` runs `scripts/check-selectors.mjs` first. It fails on three
things: a CSS-module class selector; a `getByText` / `hasText` / `name:` using
28+ characters of copy to find an element; and any negative assertion
(`toHaveCount(0)`, `not.toBeVisible`, `toBeHidden`) reached through
`getByText`, unless the statement carries a `copy-assert` note. Mod codes are
exempt from that last rule - `50.001` is `/data`'s primary key, not a sentence.
`getByLabel` and `getByPlaceholder` are never inspected.

If it fires on a legitimate line, the fix is usually that the assertion and the
lookup are on one line - split them.

**It is a floor, not a ceiling.** It catches the mechanical shapes. It cannot
tell whether a short string is the subject of the test or a stand-in for
something else: `getByText('WEEK AT A GLANCE')` passed the guard for weeks while
standing in for "the heatmap rendered". That judgement is still yours. Ask what
the test is *about*, and select on that.

## waiting

Prefer waiting on the thing that actually happened over waiting on a message
about it. A status line gets reworded; the request does not:

```ts
const requested = new Promise<void>((r) => { done = r; });
await page.route('**/api/review-thread', async (route) => { …; done(); });
await page.locator('[data-act="open-review-thread"]').click();
await requested;
```

## The server these run against

`npm run e2e` builds the app and serves `dist/` with `vite preview` on **port
3100**, and never reuses an already-running server.

Both halves matter. Testing the dev server meant Vite compiled each module the
first time a test asked for it, so the cost landed inside whichever test touched
a route first, which is enough to push that test past its budget. And a reused
preview server keeps serving the bundle it booted with, which would test the
previous build after any source change, silently, with no HMR to cover for it.

The separate port means `npm run dev` can stay up on 3000 while the suite runs.

## Hover-intent cards

The plan tree opens its card on a 300ms timer and cancels it on pointerleave, so
a bare `hover()` is a coin flip: anything that re-renders under a stationary
cursor inside those 300ms cancels the pending open, and pointerenter never fires
again because the mouse has not moved.

Use `hoverUntil(target, appears)` from `e2e/support/hoverCard.ts`, which retries
the hover with the assertion. It still goes red if the card genuinely never
opens.
