---
name: course-data
description: How to add or fix course and venue JSON in modSUTD correctly - schema, naming, sourcing, placeholder rules, verification. Use for any edit under /data ("fix this mod's prereqs", "add course 50.XXX", "wrong room info").
---

# Editing /data correctly

> Adding a venue whose **type** is new, or one students will abbreviate?
> Read the `venue-search` skill too - there is one table to update so the
> abbreviation resolves.

`/data` is the database. Every edit ships to every visitor after PR review,
so the bar is: **sourced, schema-valid, honestly labelled**.

## Where things live

- One file per record: `data/courses/<code with . → _>.json` (e.g.
  `50.001` → `50_001.json`), `data/venues/<code>.json`.
- Schema contract: `frontend/src/types/index.ts` (`Mod`, `Venue`) and
  [docs/data-format.md](../../../docs/data-format.md).
- `frontend/public/data/` is **generated** by `frontend/scripts/sync-data.mjs`
  (predev/prebuild hook) - never edit it by hand.

## Rules that exist because of past history

1. **No real names on synthetic data.** Placeholder schedules carry
   `"instructors": []`. Real instructor names go in only when the schedule
   itself is real, with a source.
2. **No personal data in venue records.** Directions describe places, not
   people - a staff member's name + office number shipped to production once.
   Strip raw output before committing.
3. **Cite the source** in the PR body: URL, screenshot, or syllabus PDF.
   Uncited data PRs get kicked back per CONTRIBUTING.md.
4. **Placeholders stay labelled.** The site banner discloses that schedules
   are placeholders; if you add real schedules for a mod, that's great - but
   don't remove the disclosure while any placeholder remains visible.

## Dedup & naming rules (venues) - the site must never repeat itself

Duplicated info reads as unprofessional. Before committing a venue edit,
check every field against the others:

- Every field is defined once, in [docs/data-format.md](../../../docs/data-format.md).
  Read it rather than guessing from neighbouring records - `name`, `altNames`
  and `mapName` each have a rule that looks arbitrary until you know why.
- The three that agents get wrong most often, in one line each:
  `name` is the number then the donor in brackets and never the code;
  `altNames` is only a genuinely different name a sign carries, never a
  spelling variant (that is `utils/search.ts`); `landmarks` is derived by
  `sync-data.mjs` and never typed.
- **A prerequisite list cannot say "or".** SUTD writes "40.002 Optimisation or
  60.008 Systems Design Studio" and `gather_listing.py` keeps only the codes, so
  `prerequisites` reads as "all of" and the plan demands both. When the listing
  joins the CODES with "or", add a `prereqTree` beside it:
  `{"or": ["40.002", "60.008"]}`, or `{"and": ["50.003", {"or": [...]}]}` for a
  mixed one. The tree is what both the plan and the prerequisite diagram read.
  Careful with the near-misses: "20.201 and 20.202 **or speak with the
  professor**" and "50.001, 50.004; **or** a working knowledge of Python" both
  contain "or" and both still require every code. Read the sentence, not the
  word.
- **Reconcile against the source before touching a prereq**, rather than
  reasoning about what a course ought to need:

  ```bash
  python tools/scraper/audit_prereqs.py --csv /tmp/prereqs.csv
  ```

  It reads every record's own `sourceUrl` page and prints what the two
  disagree about in each direction, plus a row per course in the CSV: repo
  prerequisites and corequisites, the codes the page names, the gap, and the
  block verbatim. Nothing is written to `data/` - it reports, a human edits.
  Three buckets are not errors and the tool separates them: a page with a blank
  prerequisite section is no evidence at all (01.401 Capstone 2 prints nothing
  and plainly needs 01.400); a code the record holds as a corequisite is not
  missing; and a block can name codes it then disowns.
  Four differences are standing and correct - leave them:
  50.037 names 50.012, 50.020 and 50.043 and calls them "helpful but not
  required"; 20.224 opens with "None but preferably"; 10.022's block ends
  "Prior to AY2020, it was 10.007", which is its own former code and not a
  prerequisite; and 40.001 keeps 10.013 beside the 10.004 the page still names,
  because a student who took either has met it.
  The CSV is a generated VIEW, never a source - see the invariant in
  CLAUDE.md. Do not commit it and do not edit it expecting `/data` to follow.
- Data honesty everywhere: `workload`/`grading` exist ONLY when official
  (`source: "official"`), `schedules` ONLY from crowdsourced timetables.
  Never invent, never estimate.
- Facilities (`facility: true`): no capacity/heatmap expectations, grid
  cell shows the full `name`, excluded from the FREE filter.
- `panoScenes` mirrors data/\_meta/virtualtour_scenes.md - update BOTH when
  curating a new scene mapping.

## Workflow

1. Edit the JSON under `/data`. Keep the file's existing formatting style -
   don't reformat neighbouring fields (perl/sed the one field over
   re-serializing the whole file).
2. Validate + rebuild the bundle:
    ```bash
    python3 -c "import json,glob; [json.load(open(f)) for f in glob.glob('data/**/*.json', recursive=True)]"
    cd frontend && node scripts/sync-data.mjs
    ```
    The sync script refuses to write an empty catalogue - if it does, your
    paths are wrong, not the guard.
3. Run the verification gate (`lint`, `typecheck`, `test`, `build`, `e2e`
   from `frontend/`). e2e asserts on some data values; update the spec in
   the same PR when your data change legitimately moves one.
4. PR title `data: <what changed>`, one concern per PR.
