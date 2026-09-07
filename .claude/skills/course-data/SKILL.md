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

- `name` is the full display name ("Multi Purpose Hall"); `code` is the
  room number, or for facilities the SHORT form ("MPH"). The detail header
  renders rooms as `code · name` and facilities as `name · code` (or just
  the name when they're equal) - so never bake one into the other.
- `name` puts the number first and the donor in brackets: "Think Tank 2
  (Wee Hur)", "Lecture Theatre 1 (Albert Hong)". The number is what a
  student types and what a timetable prints; the donor is what the plate
  says. Both belong, in that order.
- `altNames` is ONLY for genuinely different names - a name a plate carries
  that the `name` field does not ("Seminar Room 2A" on what is now Fablab
  Satellite 4, "Gym" for Fitness Centre, "Blk 55/57/59" for Hostel). Never
  an expansion or repeat of name/code - delete it if it just restates them.
- **A spelling variant is not an altName.** "Fab Lab" vs "Fablab", "Wood
  Store" vs "Woodstore", "ESD office" vs the spelt-out name: search already
  reaches all of these, and `altNames` is rendered on screen as an "aka"
  line, so a variant there is visual noise a reader cannot act on. If a
  variant does not resolve, fix `utils/search.ts` - not the data. The
  bracket-free form of `name` is indexed for you, so "Think Tank 2" reaches
  1.309 with no altName at all.
- **`landmarks` is not an authored field.** `sync-data.mjs` writes it, as
  `["Building 1, Level 5", "Lift Lobby C"]`, from the survey. The hand-written
  ones were deleted: "next to 1.502" is what the floor plan is for, and
  "Building 1 Level 5" was the location printed a second time. If a room is
  genuinely hard to find, the fix is a missing lift or shape in the survey.
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
