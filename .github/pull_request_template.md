<!--
Title: prefix with where it lands - data: / frontend: / scraper: / docs: / chore:
One concern per PR. Link the issue or discussion if there is one.

Writing this with an AI agent? Point it at CONTRIBUTING.md and CLAUDE.md first,
then at this template. Both are in the repo; neither is long.

HOW TO WRITE THE BODY. These are enforced in review, and a body that breaks
them gets sent back before the code is read:

- No em dashes. Not one. Use a comma, a period, a colon or parentheses. The
  en dash is out too, outside a numeric range.
- No incident tallies. Never a count of how often something went wrong or how
  long it went unnoticed: "17 records had drifted", "nobody did", "the third
  time this shipped". Name the mechanism and the rule. A reader needs to know
  what breaks and why, not the project's history of breaking it.
- No "not X, it's Y", no "here's the thing", no "what most people miss", no
  colon reveals, no closing metaphor. State the thing.
- Numbers, paths and file:line over adjectives. "Cut the walk from 389 pages to
  one request" beats "much faster".
- A table for three or more parallel items. Never narrate a comparison.
- Say what you did NOT do, and what is still open. False completeness costs the
  reviewer more than a gap does.
-->

## Cause

<!-- What is actually wrong, and why. Not "the button was broken" but the
mechanism: which rule, which value, which assumption. If you measured
something, put the number here, it says more
than "too narrow". -->

## Fix

<!-- What you changed, and why this way rather than the obvious way. If you
rejected an alternative, one line on why. -->

## Migration

<!-- REQUIRED whenever this changes a stored shape: a localStorage key, a gist
section, an export file, a JSON field name, a URL, a saved layout.

modsutd.tech is live and has no backend, so every piece of user state lives in
a browser or a gist that this PR cannot reach. A rename that looks free in the
diff silently drops someone's plan.

Answer three things:
  1. What does a browser holding the OLD shape do on the first load after this
     merges? Name the file and function that decides.
  2. Is the old shape READ (migrated), or dropped? If dropped, say whose data
     goes and why that was the right call.
  3. How long does the migration stay? A one-way rename can be deleted later;
     write down what has to be true first.

If nothing stored changes, write "no stored shape changes" and move on. -->

## Test

<!-- How the next person knows it stays fixed.
Write the test so it can fail: after writing it, undo the fix and check it goes
red. A test that has never failed has not been tested.
Find elements by a data-act hook, never by copy that gets reworded. -->

## Checklist

- [ ] `npm run merge-ready` green in `frontend/` (lint, typecheck, test, build, e2e)
- [ ] UI change? Desktop **and** mobile checked in this PR
- [ ] Data change? Source cited below (URL / screenshot / syllabus page)
- [ ] Stored shape change? Migration section filled, and a test covers a
      browser holding the old shape
- [ ] No architecture-invariant changes - no backend, DB, analytics or new
      runtime dependency. Those are a Discussion, not a PR. See
      [CLAUDE.md](../CLAUDE.md)
- [ ] AI-assisted? Fine, and expected - confirm a human (you) read every
      changed line
