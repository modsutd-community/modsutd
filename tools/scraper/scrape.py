"""Walks hass.sutd.edu.sg, normalises, writes /data/*.json.

Run with: python scrape.py [--source hass] [--dry-run]

HASS ONLY, and the name of the step says so. This used to also ask
epd/esd/istd/asd.sutd.edu.sg through sources/pillar.py, whose selectors were a
best-effort guess that returned before yielding anything. Four hosts fetched
per run to produce nothing, under a step called `pillars` that did not scrape a
pillar. Anyone writing a real pillar parser is writing it against whatever HTML
SUTD serves that day, so a stub guessed against older HTML was not a head start.

Freshmore and elective HASS subjects come from the two listing pages in
sources/hass.py. Everything else about a mod, in every pillar, comes from the
`mods` step: sutd.edu.sg's own course sitemap covers all of them.

Default behaviour is to leave existing files alone unless the scrape returns
a strictly different mod. SUTD pages break parsers silently - better to skip
than to overwrite good data with empty placeholders.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Callable, Iterable

from sources import hass
from normalise import diff, normalise_mod
from schema import Mod

DATA_DIR     = Path(__file__).resolve().parents[2] / "data"
COURSES_DIR  = DATA_DIR / "courses"
VENUES_DIR   = DATA_DIR / "venues"

ScrapeFn = Callable[[], Iterable[Mod]]

SOURCES: dict[str, ScrapeFn] = {
    "hass": hass.scrape,
}


def write_mod(mod: Mod, dry_run: bool) -> str:
    """Returns one of {written, unchanged, would-write}."""
    path = COURSES_DIR / f"{mod.code.replace('.', '_')}.json"
    payload = mod.model_dump(exclude_none=True)

    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if not diff(existing, payload):
            return "unchanged"

    if dry_run:
        return "would-write"
    COURSES_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return "written"


def run(sources: list[str], dry_run: bool) -> int:
    failures = 0
    for name in sources:
        fn = SOURCES.get(name)
        if fn is None:
            print(f"[!] unknown source: {name}", file=sys.stderr)
            failures += 1
            continue
        try:
            mods = list(fn())
        except Exception as exc:  # noqa: BLE001 - scraper boundary
            print(f"[{name}] failed: {exc!r}", file=sys.stderr)
            failures += 1
            continue

        if not mods:
            print(f"[{name}] returned no mods - skipping (data left untouched)")
            continue

        counts = {"written": 0, "unchanged": 0, "would-write": 0}
        for raw in mods:
            try:
                norm = normalise_mod(raw)
            except Exception as exc:  # noqa: BLE001
                print(f"[{name}] skipping bad record {raw}: {exc!r}", file=sys.stderr)
                continue
            counts[write_mod(norm, dry_run)] += 1
        print(f"[{name}] {counts}")
    return failures


def main() -> int:
    p = argparse.ArgumentParser(description="scrape SUTD course data")
    p.add_argument("--source", action="append",
                   help="restrict to one or more sources; default = all")
    p.add_argument("--dry-run", action="store_true",
                   help="don't write files, just report what would change")
    args = p.parse_args()

    sources = args.source or list(SOURCES)
    return run(sources, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
