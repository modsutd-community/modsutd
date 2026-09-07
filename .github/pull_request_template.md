<!--
Title: prefix with where it lands - data: / frontend: / scraper: / docs: / chore:
One concern per PR. Link the issue or discussion if there is one.

Writing this with an AI agent? Point it at CONTRIBUTING.md and CLAUDE.md first,
then at this template. Both are in the repo; neither is long.
-->

## Cause

<!-- What is actually wrong, and why. Not "the button was broken" but the
mechanism: which rule, which value, which assumption. If you measured
something, put the number here - "64.8px inside a 92.6px column" says more
than "too narrow". -->

## Fix

<!-- What you changed, and why this way rather than the obvious way. If you
rejected an alternative, one line on why. -->

## Test

<!-- How the next person knows it stays fixed.
Write the test so it can fail: after writing it, undo the fix and check it goes
red. A test that has never failed has not been tested.
Find elements by a data-act hook, never by copy that gets reworded. -->

## Checklist

- [ ] `npm run merge-ready` green in `frontend/` (lint, typecheck, test, build, e2e)
- [ ] UI change? Desktop **and** mobile checked in this PR
- [ ] Data change? Source cited below (URL / screenshot / syllabus page)
- [ ] No architecture-invariant changes - no backend, DB, analytics or new
      runtime dependency. Those are a Discussion, not a PR. See
      [CLAUDE.md](../CLAUDE.md)
- [ ] AI-assisted? Fine, and expected - confirm a human (you) read every
      changed line
