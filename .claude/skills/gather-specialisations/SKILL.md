---
name: gather-specialisations
description: Refresh data/specializations.json (specialisation-track criteria that power the plan badges) from sutd.edu.sg via tools/scraper/gather_specialisations.py. Use when the freshness issue reports track drift, a new AY restructures tracks, or on "update specialisations".
---

# Refreshing specialisation-track criteria

`data/specializations.json` drives the plan-view badges: each track's
`requirements` is a list of `{count, anyOf[], label}` groups that must ALL
be satisfied by the planned mod codes. Tracks whose criteria can't be
machine-checked carry `requirements: []` + verbatim `notes` and never badge
- **that is deliberate: never invent codes to make a track checkable.**

## Run it

```bash
tools/scraper/.venv/bin/python tools/scraper/gather_specialisations.py
#   --refresh    bypass the 24h HTML cache
#   --out PATH   write elsewhere (freshness uses this for drift checks)
```

The script self-validates (code format, `count ≤ len(anyOf)`, unique ids,
JSON round-trip) and exits 1 WITHOUT writing on failure - safe to cron.

## Source map (2026-07 reality - first things to re-check on a redesign)

| Pillar | Where the criteria live | Parse approach |
|---|---|---|
| CSD (ISTD) | per-track subpages under /istd/…/specialisation-tracks/ | headings "Track Requirement" / "Track Core Courses" / "Track Electives"; phrases "N out of M track core", "N track electives" |
| ESD | per-track subpages | "Required courses" section, stop at "For more information" |
| DAI | single page, numbered h5 headings + "Subjects include:" lists | subject NAMES only - resolved to codes via a two-tier name→code index (scraped page text beats repo files; within-tier conflicts dropped, never guessed). DAI tracks are discontinued from AY2026 (noted per track) |
| EPD | **PDF "Advising Track Matrix" only** | structured via `tools/scraper/epd_matrix_overlay.json` - HAND-extracted (2026-07) by rendering the PDF (`pdftoppm -r 200`), reading each track band, and verifying every code against `data/courses` names; the gatherer merges the overlay on every run. EPD's track dropdown is JS-rendered: subpage slugs are regexed from raw HTML |

## Refreshing the EPD overlay (when a NEW matrix PDF appears)

The current overlay encodes the Dec-24 matrix (self-titled "2020-2023 [new
calendar]" - it applies to those intakes). When EPD publishes a newer PDF:

1. Download it; render pages (`pdftoppm -png -r 200`); crop per track band
   (7 tracks: SD, ME, EE, RB on p1; CE, HED, BI4 on p2) and READ each band -
   automated text extraction scrambles the matrix and colour-samples
   misfire on cell titles; eyes are the reliable parser here.
2. Per track collect: RED cells = restricted track electives (all-of);
   CYAN T5 cells = restricted pillar elective (choose 1 when two shown);
   PURPLE T6 cells = pillar electives (count from the T6 header, 2 or 3);
   NAVY T7+T8 cells = advanced pillar electives (counts from headers, sum
   them); PINK cells = cross-pillar substitutions → notes (and into the
   advanced pool where the header counts them, e.g. CE/BI4).
3. Verify EVERY code against `data/courses/*.json` names before writing -
   this catches misreads (e.g. 30.105 vs 30.106).
4. Update `tools/scraper/epd_matrix_overlay.json` (keep `_provenance`
   accurate: source URL, method, caveat), re-run the gatherer, commit both.

## Hard-won rules

- Regex course codes out of **visible text only** (scripts/styles/SVG
  stripped) - raw HTML is full of `\d\d.\d\d\d` false positives from CSS
  `calc()` and SVG paths.
- ISTD OR-pairs ("50.007 or 40.319") put both codes in `anyOf` with a note -
  the schema deliberately can't nest alternatives.
- Never emit `count > len(anyOf)` (e.g. "4 electives" from an open JS-paginated
  pool) - fall back to notes or the track becomes unsatisfiable.
- Open-ended caveats ("capstone must be track-related") stay verbatim in
  `notes`; the frontend shows badges only for structured tracks.

## After a run

1. Diff `data/specializations.json` - requirement changes should correspond
   to a visible SUTD announcement; sanity-check one track against its page.
2. `cd frontend && node scripts/sync-data.mjs && npm run build` (the file is
   copied into `public/data/`).
3. PR title `data: specialisation tracks <date>`.

The monthly freshness workflow re-runs this gatherer with `--out` and diffs
track ids + requirements, filing an issue on drift; this skill is the fix
procedure it points to.
