# Scraper

`tools/scraper/mods_refresh.py` is the entry point, and the monthly GitHub
Actions job runs that one command. It orchestrates six steps and opens the
result as a PR for human review. `scrape.py` is one of those steps.

| step | reads | writes |
|---|---|---|
| `mods` | `www.sutd.edu.sg` sitemaps, ~389 mod pages | `data/mods/*.json` |
| `hass` | `hass.sutd.edu.sg` freshmore and elective listings | `data/mods/*.json` |
| `tracks` | four specialisation-track sections on `www.sutd.edu.sg` | `data/specializations.json` |
| `terms` | SUTD's academic calendar, plus `data.gov.sg` public holidays | `data/term-calendar.json` |
| `minors` | SUTD's minors index, then each minor page | nothing, reports |
| `cores` | each pillar's core listing on `www.sutd.edu.sg` | `data/mods/*.json` |
| `prereqs` | the same mod pages as `mods` | nothing, reports |
| `propose` | the last two reports, through a model | `data/mods`, `data/minors.json` |

Five of them read `www.sutd.edu.sg`, so the names say what each produces
rather than where it went. `hass` is the exception because it is the one on
another host.

## Sources

`scrape.py` wires up one module in `tools/scraper/sources/`:

- `hass.py` - HASS undergraduate subjects. Starts from the freshmore and electives listings under `https://hass.sutd.edu.sg/education/undergraduate-subjects/`, then follows one detail page per subject. Source name: `hass`.

There used to be a `pillar.py` asking the four pillar sites. Its selectors
were a best-effort guess and it returned before yielding anything, so it cost
four requests a run and produced nothing, under a step then called `pillars`.
A real pillar parser is written against whatever HTML SUTD serves that day,
so it was not a head start. Everything about a mod in every pillar comes from
the `mods` step anyway: the mod sitemap covers all of them.

`_http.py` in that folder is not a source: it is the shared cached HTTP client.

`gather_terms.py` sits beside `scrape.py` rather than under `sources/`, because
it writes a different file for a different reason. It rebuilds
`data/term-calendar.json` from SUTD's academic-calendar page - which carries
every trimester of 2026-2030 in one document - and merges Singapore's public
holidays from data.gov.sg. Run it the same way:

```bash
python gather_terms.py --dry-run   # print, don't write
python gather_terms.py
```

It refuses to write below six parsed trimesters, so a redesigned page fails
loudly rather than replacing a good calendar with an empty one. Nothing about a
new term needs a human: that file used to be typed in by hand, which works
exactly once.

When SUTD redesigns a page (it happens), the scraper for that source needs updating. The fix is usually 5-20 lines of CSS-selector tweaks.

## Run locally

```bash
cd tools/scraper
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# scrape everything (uses cached HTTP responses if available)
python scrape.py

# scrape a single source - hass | epd | esd | istd | asd
python scrape.py --source hass   # hass is the only source


# dry-run - print what would change but don't write
python scrape.py --dry-run
```

`_http.py` keeps every response under `tools/scraper/.cache/` for 24 hours. That is what makes selector work cheap: a re-run reads the cached page instead of hitting SUTD again.

## LLM fallback - written, not wired

`tools/scraper/agents/llm_extractor.py` exists and works on its own, but
nothing imports it. `scrape.py` has no LLM branch, so a source that returns
zero mods prints a line and leaves the data alone.

A model IS wired in elsewhere: `propose_edits.py` reads the prereq and minor
drift reports and proposes edits, validating every one against the page text
it quotes before a file is touched. Which providers exist and in what order
is `agents/llm.py`, and the tokens are in `.env.example` at the repo root.

## How it fails

| Symptom                          | Likely cause                                         | Fix                                                           |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `0 mods scraped` from a source   | SUTD changed the page layout                         | Update the CSS selectors in `tools/scraper/sources/<name>.py` |
| `403 Forbidden` from a corp page | IP blocked or login wall                             | Wait and retry off-peak; the scraper never wipes on empty     |
| Some fields empty                | New field on the SUTD page that we don't extract yet | Add a parser branch + matching field in `frontend/src/types`  |
| PR is huge                       | Multiple sources changed at once                     | Bisect - run `mods_refresh.py --only <one step>` at a time    |

## CI

The workflow lives at `.github/workflows/scrape.yml`, on the repo's usual monthly schedule (first Saturday, 00:00 Singapore - the shape is in [CLAUDE.md](../CLAUDE.md)). SUTD data changes about once a term, so monthly is plenty. `workflow_dispatch` is on and skips the first-Saturday check, so you can run it from the Actions tab without waiting. Its one input, `rename_cap`, is for a real bulk rename: the gather-mods skill says when to use it.

The job installs `tools/scraper/requirements.txt` on Python 3.12 and runs
`python tools/scraper/mods_refresh.py`. It opens a PR titled
`data: monthly mods refresh` against `main`, from a
`chore/mods-refresh-<run id>` branch, labelled `data` and `automated`.

`secrets.MODSUTD_BOT_TOKEN` is REQUIRED, and the job's first step fails
without it. There is no `GITHUB_TOKEN` fallback: main's ruleset only lets the
admin role bypass, so the default token cannot open that PR, and the old
fallback meant finding that out after 389 pages had been read and thrown
away. It is a fine-grained PAT with `contents: write` and
`pull-requests: write`.

The report-only steps have a tracked artefact of their own,
`tools/scraper/reports/drift.md`, because a run that changes no file opens no
PR. Each run rewrites only the sections of the steps it ran, and drops any
section no step owns.

### The PR body

`mods_refresh.py --body-out` writes it and the workflow only passes it on, so
its order and its size are in `build_body()` and pinned by
`mods_refresh.py --self-check`. Top to bottom, in the order a reviewer acts:

1. a PARTIAL REFRESH banner naming the steps that failed, when any did;
2. **What changed in /data**: `what_changed.py`'s table, one row per record
   with its name, the change and the record's own page link. A new mod, a tag
   or term edit, a re-title and a track note are each a row, and a batch-chat
   flag flip sorts first under a warning. Never folded. If `what_changed.py`
   fails, this lists the changed files instead, and never says nothing
   changed;
3. **Needs your decision**: the re-titles and term moves `gather_mods.py`
   reports, pasted from its `--review-out` markdown, or failing that a table
   from its `--renames-out` JSON, each re-title marked written or not
   (accepting a capped batch is in the gather-mods skill); edits a model made
   with the quote they rest on; proposals the validator dropped; minors whose
   page names a code the record lacks, minors SUTD lists and the repo does
   not, and records SUTD no longer lists; every prerequisite gap no model
   answered for, which includes rows too short to send and rows no provider
   answered; and the `[!]` and `!!` lines a step printed, the first 30 per
   step. Each `gather_mods.py` flag is passed only when its `--help` lists it;
4. **Checked and fine**: one line per step, taken from a summary line that
   step prints itself. A step whose line is reworded falls back to "ok in Ns"
   rather than breaking the body;
5. folded, the model's verdicts that changed nothing, once each, checked
   against the records it was actually sent: an id it was never sent is shown
   as such, and a record it never answered is listed as "no verdict";
6. folded, every step's whole output, stdout and stderr.

GitHub refuses a body over 65536 characters, and a refused body loses the
month's data along with it. When one would pass that, the full output is cut
first and says so, then the verdicts, then rows from the end of the change
table, and last the head itself, each with a note. The whole output is always
in the run's step summary. A body that fails to build at all is replaced by a
short one naming the changed files, so the pull request still opens.
