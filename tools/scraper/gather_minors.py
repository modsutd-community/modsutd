#!/usr/bin/env python3
"""Check data/minors.json against each minor's own SUTD page.

    python tools/scraper/gather_minors.py            # report to stdout
    python tools/scraper/gather_minors.py --json out.json

REPORTS, NEVER WRITES. The ten minor pages are each laid out differently and
state their requirements in prose, so a parser that rewrote the file would be
guessing at counts and groupings. It also cannot tell a requirement from an
example: the pages carry numbers that look like course codes and are not, which
is why only the real prefixes below are read at all.

What it can say honestly is narrower than it first looks. "The repo requires a
code the page does not name" sounds like drift and is not: most of these pages
say "any HASS elective" or "any 50.xxx", and the repo expands that into the
actual list - data/minors.json says so in its own `note`. Flagging that marks
nearly every minor as drifting when nothing has changed.

So it flags the three things that really do mean stale:
  - the page is unreachable, or 404s
  - the page names NO course codes at all, which is what a redesign looks like
  - the page names a code this minor does not list, which is a new or changed
    requirement rather than an expansion the repo already made
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "sources"))
import _http  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
MINORS = ROOT / "data" / "minors.json"

CODE = re.compile(r"\b(\d{2})\.(\d{3})([A-Za-z]?)\b")
# The real undergraduate code space. A minor page also carries phone numbers and
# reference numbers that match the shape - 12.071, 16.471 - and counting those
# as missing mods would make every minor look broken.
VALID_PREFIXES = {"01", "02", "03", "10", "20", "30", "40", "50", "60"}


def codes_on(html: str) -> set[str]:
    return {
        f"{m.group(1)}.{m.group(2)}"
        for m in CODE.finditer(html)
        if m.group(1) in VALID_PREFIXES
    }


def required(minor: dict) -> set[str]:
    """Every code the repo says this minor can be built from."""
    out: set[str] = set()
    for req in minor.get("requirements") or []:
        for c in req.get("anyOf") or []:
            out.add(str(c).split("|")[0])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json")
    args = ap.parse_args()

    data = json.loads(MINORS.read_text(encoding="utf-8"))
    minors = data.get("minors") or []
    print(f"{len(minors)} minors in the repo, gathered {data.get('gathered')}\n")

    rows: list[dict] = []
    drift = 0
    for m in minors:
        url = m.get("source") or m.get("url")
        row = {"id": m.get("id"), "name": m.get("name"), "url": url,
               "status": "", "gone": [], "extra": []}
        if not url:
            row["status"] = "no source url"
            rows.append(row)
            drift += 1
            print(f"  {m.get('id'):<14} NO SOURCE URL")
            continue
        try:
            html = _http.get(url, ttl_hours=72, delay=0.4)
        except Exception as exc:  # noqa: BLE001
            row["status"] = f"unreachable: {type(exc).__name__}"
            rows.append(row)
            drift += 1
            print(f"  {m.get('id'):<14} UNREACHABLE  {url}")
            continue

        page = codes_on(html)
        want = required(m)
        # Recorded, not flagged - see the module docstring.
        row["gone"] = sorted(want - page)
        row["extra"] = sorted(page - want)
        if not page:
            row["status"] = "no codes on the page"
            drift += 1
        elif row["extra"]:
            row["status"] = "new codes"
            drift += 1
        else:
            row["status"] = "ok"
        rows.append(row)
        line = f"  {m.get('id'):<14} {row['status']:<20} page names {len(page):>3} codes"
        if row["extra"]:
            line += f"  | page names, repo does not: {', '.join(row['extra'][:12])}"
            if len(row["extra"]) > 12:
                line += f" (+{len(row['extra']) - 12})"
        # Printed, deliberately not counted as drift. On most of these pages
        # this list IS the expansion of "any HASS elective" the repo made on
        # purpose, so counting it marks nearly every minor as drifting. A human
        # reading an unusually long one is how a dropped requirement surfaces.
        if row["gone"]:
            gone = ", ".join(row["gone"][:12])
            if len(row["gone"]) > 12:
                gone += f" (+{len(row['gone']) - 12})"
            line += "\n" + " " * 36 + "repo requires, page does not name: " + gone
        print(line)

    print(f"\n{drift} of {len(minors)} need a look.")
    if drift:
        print("Read the page before editing data/minors.json. The requirements "
              "are prose, and a code appearing on a page is not always a "
              "requirement - it can be an example, or a prerequisite of one.")
    if args.json:
        pathlib.Path(args.json).write_text(
            json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
