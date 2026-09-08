# Scraper

`tools/scraper/scrape.py` walks SUTD's public course pages monthly and writes `/data/courses/*.json`. GitHub Actions runs it; the result is opened as a PR for human review.

## Sources

`scrape.py` wires up two of the modules in `tools/scraper/sources/`:

- `hass.py` - HASS undergraduate subjects. Starts from the freshmore and electives listings under `https://hass.sutd.edu.sg/education/undergraduate-subjects/`, then follows one detail page per subject. Source name: `hass`.
- `pillar.py` - the four pillar sites `https://epd.sutd.edu.sg/`, `https://esd.sutd.edu.sg/`, `https://istd.sutd.edu.sg/`, `https://asd.sutd.edu.sg/`. Source names: `epd`, `esd`, `istd`, `asd`. These adapters deliberately yield nothing today: they are stubs awaiting a stable source, not a bug to fix in passing.

`_http.py` in that folder is not a source: it is the shared cached HTTP client.

`term_calendar.py` sits beside `scrape.py` rather than under `sources/`, because
it writes a different file for a different reason. It rebuilds
`data/term-calendar.json` from SUTD's academic-calendar page - which carries
every trimester of 2026-2030 in one document - and merges Singapore's public
holidays from data.gov.sg. Run it the same way:

```bash
python term_calendar.py --dry-run   # print, don't write
python term_calendar.py
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
python scrape.py --source hass

# --source is repeatable, so a subset is a list rather than a pattern
python scrape.py --source istd --source asd

# dry-run - print what would change but don't write
python scrape.py --dry-run
```

`_http.py` keeps every response under `tools/scraper/.cache/` for 24 hours. That is what makes selector work cheap: a re-run reads the cached page instead of hitting SUTD again.

## LLM fallback - written, not wired

`tools/scraper/agents/llm_extractor.py` exists and works on its own, but nothing imports it. `scrape.py` has no LLM branch, so provider keys change nothing about a scrape today: a source that returns zero mods prints a line and leaves the data alone.

Wiring it in means calling it from the orchestrator yourself - `fallback(count)` decides whether the deterministic result is suspiciously thin, then `extract(html, source_url)` returns a validated `Mod` or `None`. The provider chain it reads is `.env.example` at the repo root.

## How it fails

| Symptom                          | Likely cause                                         | Fix                                                           |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `0 mods scraped` from a source   | SUTD changed the page layout                         | Update the CSS selectors in `tools/scraper/sources/<name>.py` |
| `403 Forbidden` from a corp page | IP blocked or login wall                             | Wait and retry off-peak; the scraper never wipes on empty     |
| Some fields empty                | New field on the SUTD page that we don't extract yet | Add a parser branch + matching field in `frontend/src/types`  |
| PR is huge                       | Multiple sources changed at once                     | Bisect - run `--source <one>` at a time                       |

## CI

The workflow lives at `.github/workflows/scrape.yml`, on the repo's usual monthly schedule (first Saturday, 00:00 Singapore - the shape is in [CLAUDE.md](../CLAUDE.md)). SUTD data changes about once a term, so monthly is plenty. `workflow_dispatch` is on, so you can run it from the Actions tab without waiting.

The job installs `tools/scraper/requirements.txt` on Python 3.12 and runs `python scrape.py` from `tools/scraper`. On a non-empty diff it opens a PR titled `data: monthly scrape` against `main`, from a `chore/scrape-<run id>` branch, labelled `data` and `automated`.

It authenticates with `secrets.MODSUTD_BOT_TOKEN` if set, falling back to `secrets.GITHUB_TOKEN`. The bot token is optional - set it only when you want a separate bot identity, as a fine-grained PAT with `contents: write` and `pull-requests: write`.
