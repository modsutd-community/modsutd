---
name: parse-subject-enrolment-pdfs
description: Fill a whole term's schedules and rooms from SUTD's six subject-enrolment PDFs, instead of waiting for students to paste timetables one at a time. Use when the enrolment PDFs for a term arrive, on "parse the enrolment PDFs", "batch import the timetable", or when a term starts and the heatmaps and batch-chat buttons are empty.
---

# Reading a term's subject-enrolment PDFs

Schedules otherwise arrive one browser at a time, from students who paste their
own timetable, so a mod nobody has pasted has no rooms, no heatmap and no batch
chat. These six PDFs are the registry's export of the same timetable for every
mod at once.

## What you need

One folder holding **exactly six** PDFs, one per pillar. Each filename has to
carry its pillar: `ASD`, `DAI`, `EPD`, `ESD`, `ISTD` (or `CSD`), and `HASS`
(or `HASS & TE`). The tool refuses a folder missing one, because a pillar read
as empty looks exactly like a pillar with no classes.

Never write the folder's path into the repo. It is a local path and the repo
has no home for one; pass it on the command line.

## Run it

```bash
pip install -r tools/enrolment/requirements.txt      # pdfplumber, once
python tools/enrolment/parse_enrolment_pdfs.py "<folder>" --dry-run
python tools/enrolment/parse_enrolment_pdfs.py "<folder>" --report report.md
python tools/enrolment/parse_enrolment_pdfs.py --self-check   # no PDF needed
```

It exits non-zero when a mod in a legend produced no block, or when a code has
no catalogue record. Both mean read the report before committing anything.

## How it reads a PDF, and what breaks if you change it

There is no OCR. These PDFs carry a full text layer, and every class is a
filled rounded rectangle drawn as a `curve` with its text inside its own
bounds - so the block IS the record.

- **Crop to the block, then extract.** `page.extract_words()` over the whole
  page interleaves two classes that sit side by side in the same hour, which
  comes out as `3 0 .1 1 9 , C P 0 1`. No tolerance fixes that; cropping does.
- **A block prints its own start and end time**, so nothing converts pixels to
  hours and a half-hour start cannot be rounded wrong.
- **The record starts at the first mod code, not at line 2.** The weeks line
  wraps on the narrow HASS columns, and its tail (`43, 45, 47- 50`) lands on
  the record's line where it would read as four rooms.
- **A line that wraps mid-token joins with no space**, or `DS-01` becomes
  `DS- 01` and matches no room.
- **A block has to fit inside the day column it lands nearest**, not merely be
  near its header. The columns are measured from the header spacing, because
  the pillar files are A4 with 150pt columns and the HASS file is A3 with
  220pt ones, and classes run up to six abreast there - so a legitimate block
  sits as far as (column minus its own width) / 2 off centre and distance from
  the centre cannot tell it from a block straddling a boundary. One that fits
  no column is dropped and reported: a class put on the wrong day reads as a
  real class nobody can find.

A block says:

```
11x w38-43, 45, 47-50                 <- repeats, then the teaching weeks
50.006, CI01, CBL, Think Tank 10, Think Tank 9, 1.416, 1.415, CHOO Tsu Wei Kenny
  code   sect  kind  <---- venues, named then coded ---->  <- instructors
```

The names and the codes are the same rooms listed twice, so the codes win. A
block with no code (the HASS lectures, `Lecture Theatre 4,`) resolves through
`data/venues`, which is why the index also holds each name with its bracketed
donor stripped: the record says "Lecture Theatre 4 (Hokkien Foundation)" and
the registry prints "Lecture Theatre 4".

**A divisible classroom is printed as its halves and the catalogue holds the
room.** Cohort Classroom 14 comes through as `2.507A, 2.507B` and there is one
venue, `2.507`. A `location` naming a code no venue has is a slot the room page
and the heatmap can never show, so a half resolves to the room it is half of,
and both halves collapse to one slot: one room, busy once. A suffix that IS its
own room survives, because the exact code is looked for first: the design
studios are `2.313A` and `2.313B`, two records, two doors. Any room that still
has no venue record after that is reported, and the run exits non-zero.

There is no separator in a record marking where the venues stop and the
instructors start, so a tail field is a venue exactly when it resolves to one.
A name that resolves to nothing is reported by code, day and time rather than
dropped, and a run with any such note exits non-zero: a class written with
fewer rooms than the registry printed is not a clean import. One venue name
carries a comma of its own, so a field that fails is retried joined to the one
after it.

`CBL` is a Cohort and `LEC` a Lecture; the section id agrees (`CI01` / `LI01`).
The section is stored as `cohort`, and the teaching weeks as `weeks` - that is
what tells 50.046 CI01 from CI02 in the same lecture theatre at the same hour,
and 40.302 from 40.305 in the same room across half a term each.

## The legend is the tally

Every file prints its colour key along the bottom, one swatch per mod. That is
the list the run checks itself against: a mod in the legend with no block
parsed is a parse failure, not an empty week. `HASS` appears in five of the six
as a placeholder colour and is not a course.

The registry suffixes a HASS code with its track - `02.143HT` is `02.143` on
the Humanities track. The catalogue holds one record per course, and the app's
code pattern allows one trailing letter and not two, so the suffix is dropped
and the mapping is printed in the report.

## Then open a pull request

Never commit straight to main, and never auto-commit: a term's import rewrites
dozens of course files at once.

```bash
git switch -c data/term-<n>-enrolment
python tools/enrolment/parse_enrolment_pdfs.py "<folder>" --report /tmp/enrol.md
cd frontend && npm run merge-ready
gh pr create --body-file .github/pull_request_template.md    # then fill it in
```

The PR body carries the report: one section per file, headed by the pillar
alone (`ISTD (9):`, `HASS & TE (11):`), each mod's meetings in day order, then
that file's `Expected (n)` list, then the overall `Total` and `Expected`. Cite
the PDFs as the source - by their filenames, never by a path on anyone's
machine.

## Batch chats come after the merge, not with it

`telegram-group.yml` checks out **main** and refuses a mod with no schedules,
so no chat can be created until this PR is merged. After it is:

- only mods with `noBatchChat` unset get one, which in practice is the HASS
  courses and the electives. A pillar core is flagged by
  `tools/scraper/gather_cores.py` and gets none.
- the workflow's own gate is **six chats a day**
  (`createdDay == today >= 6 -> skip=daily-cap`), so a term's worth takes
  several days. Do not read a skipped dispatch as a failure; check
  `data/telegram-groups.json` on main.
- a mod's page is `https://modsutd.tech/mods/<code>`, and the join button is on
  it. There is no separate link endpoint: every mod has had a real page since
  the prerender step, so a redirect for one would be a second address for the
  same thing.

## Related

- `.claude/skills/new-term` - everything else a new term needs.
- `.claude/skills/course-data` - the shape of a course record.
- `docs/data-format.md` - what each schedule field means.
