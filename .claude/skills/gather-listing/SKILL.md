---
name: gather-listing
description: Refresh modSUTD's catalogue from the official sutd.edu.sg course listing - new mods, tags, descriptions - via tools/scraper/gather_listing.py. Use when the freshness issue reports "listed mods missing from the repo", when a term brings new offerings, or on "refresh the catalogue/tags".
---

# Refreshing the catalogue from the official listing

The official source is the WordPress course post-type, enumerated by two
sitemaps (`course-sitemap.xml`, `course-sitemap2.xml`) - NOT the JS-rendered
listing page. `tools/scraper/gather_listing.py` is the reusable gatherer;

## Run it

```bash
tools/scraper/.venv/bin/python tools/scraper/gather_listing.py            # full run
#   --dry-run        report only, write nothing
#   --limit N        first N pages (debugging)
#   --delay 0.25     politeness delay on cache misses
#   --ttl-hours 168  on-disk HTML cache lifetime (tools/scraper/.cache/)
```

venv needs `httpx, beautifulsoup4, lxml, pydantic` (requirements.txt; note
Python ≥3.13 needs `pydantic>=2.13`, hence the relaxed pin).

## What it does - and the invariants to preserve if you edit it

- Keeps `/course/` slugs matching `^\d{2}-\d{3}[a-z]{0,3}`; percent-decodes
  sitemap URLs before matching (some slugs carry encoded unicode hyphens);
  collapses suffix variants (`03-007a/b` → `03.007`, plain slug wins).
- **LKYCIC/NAMIC exclusion** (user decision) matches standalone tokens only:
  `(?i)(?<![a-z])(lkycic|namic)(?![a-z])` - a substring check would
  false-positive on "Dy**namic**s"/"Thermody**namic**s".
- Page parse is a heading-driven state machine over `<main>` VISIBLE TEXT:
  h1 → description ¶s (some pages instead use a "Course Description"
  heading); "Prerequisite(s)" / "Co-requisite(s)" sections collect
  `\d{2}\.\d{3}` codes and MUST stop at the next heading or
  mutually-exclusive-subject codes leak in; credits from
  `Number of credits:\s*(\d+)` (absent on many pages → default 12); tags
  from `section.js-page-tags a`; term from the first `Term N` tag.
- **Merge policy - never degrade**: existing repo files get a surgical
  `tags` update (pillar tags are unioned in from suffix-variant pages like
  03-007a/b), description fill when the repo one is empty, and grading +
  workload replacement whenever the OFFICIAL page publishes them (an
  assessment table / a `Workload: a-b-c` line - official beats anything
  hand-written; workload exists ONLY in that official form).
  Schedules/credits/term/prerequisites are never touched.
  Empty scraped tags are never written. New mods get pillar/department from
  a majority-vote precedent map per 2-digit code prefix, are validated
  through `tools/scraper/schema.py` Mod, and written with 2-space indent.
- Exits non-zero if any page failed to parse; prints a full summary.

## After a run

1. `python3 -c "import json,glob; [json.load(open(f)) for f in glob.glob('data/courses/*.json')]"`
2. `cd frontend && node scripts/sync-data.mjs && npm test && npm run e2e`
   (some e2e fixtures pin mods - 10.013, 10.018, 02.101; update specs in the
   same PR if a pinned fixture legitimately changed).
3. Mods that vanish from the sitemap are RETIRED, not deleted - keep their
   files (history + reviews); the freshness report lists them as notes.
4. PR title `data: listing refresh <date>`, one concern per PR.


## Verify the harvest, do not trust it

`gather_listing.py` reads the listing and keeps the codes. It cannot read a
sentence, and SUTD writes prerequisites as prose that changes meaning:

- **Matriculation-year alternatives.** "10.014 Computational Thinking for
  Design (For AY2020 to AY2024) or 10.025 ... (For AY2025 and subsequent
  batches)" arrives as `["10.014","10.025"]`, which the plan reads as needing
  BOTH. Six courses were wrong this way at once.
- **A course named but not numbered.** "Algorithmic Thinking and Object-Based
  Abstraction (For AY2026 onwards)" has no code, so it was dropped entirely.
- **Near-misses that are still "all of".** "20.201 and 20.202 or speak with the
  professor" and "50.001, 50.004; or a working knowledge of Python" both
  contain "or" and both still require every code.

So after a harvest, verify the prerequisites in parallel rather than one page
at a time. `tools/scraper/audit_prereqs.py` lists every course whose listing
carries a joining word; for the cohort-gated shape, fan out over the affected
codes and read each page:

```
Workflow: one agent per course code, phase 'Fetch', schema
  { code, prerequisiteTextVerbatim, isCohortGated,
    alternatives: [{ code, title, cohort }], alwaysRequired, notes }
```

Ask each agent to quote the block VERBATIM, to report an uncoded course with
`code: ""` and its exact title, and to say in `notes` when a page has no
prerequisites block at all rather than reporting an empty one as a flat list.
Ten pages took under two minutes that way.

Turn a confirmed cohort split into a `prereqTree` with object leaves - see
`docs/data-format.md`. "For AY2025 and subsequent batches" is
`["ay2025","ay2026"]`, not `["ay2025"]`.


## When it breaks

SUTD redesign symptoms: 0 pages parsed (heading strings changed - check the
state-machine keys first), sitemap 404 (post type renamed), tags empty
(`js-page-tags` class renamed). The monthly freshness workflow
(.github/workflows/freshness.yml) detects the drift; this skill is the fix.
