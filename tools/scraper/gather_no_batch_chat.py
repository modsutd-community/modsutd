#!/usr/bin/env python3
"""Mark each pillar's own core courses as getting no batch chat.

    python tools/scraper/gather_no_batch_chat.py            # refresh, then report
    python tools/scraper/gather_no_batch_chat.py --dry-run  # report, write nothing

WHY A CORE GETS NO CHAT
A batch chat is for a course a cohort CHOOSES, where the people in it are the
people who picked the same elective and have nothing else in common. A core is
taken by everybody, who already share a cohort chat, a timetable and a year
group. A second group with the same membership is noise, which is the same
reason capstones and thesis mods are excluded.

There are two kinds, and they are found differently.

A PILLAR core is published per pillar and the lists move, so they are read off
each pillar's own filtered listing rather than typed.

A FRESHMORE core is already in our own data: SUTD tags it `Freshmore Core`, and
every freshmore takes it in term 1 or 2 alongside the same 200 people. 02.001
Global Humanities and 02.003 Social Science are the HASS ones, and they were
slipping through because the eligibility rule lets any HASS course past the
term gate - a rule that is right for the electives it was written for and wrong
for these. No network is needed for this half.

WHAT IT OWNS, AND WHAT IT LEAVES ALONE
It writes `noBatchChat: true` together with `noBatchChatReason: "pillar core"`,
and it only ever removes a flag carrying that same reason - and never more than
MAX_REMOVALS of them in one run, because a page that comes back half-parsed
clears the per-pillar floor and would then quietly unflag whatever it missed.
A record flagged for
another reason - 01.400 Capstone 1, 02.XFER - is left exactly as it is, because
this script has no opinion about those and no way to tell it made them.

THE FILTER IS THE `.general-listing-grid`, NOT THE PAGE
Reading course codes off the whole page returns 23 for DAI where the grid has 8:
the rest are navigation, related links and a footer. Scoped to the grid, the
`?course-type=` filter is honoured server-side and the answer is the core.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from sources import _http  # noqa: E402

from bs4 import BeautifulSoup  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
COURSES = ROOT / "data" / "courses"

REASON = "pillar core"
# Its own reason, so each half only ever removes what it wrote. A course that
# stops being a pillar core must not have a freshmore flag taken off with it.
FRESHMORE_REASON = "freshmore core"
FRESHMORE_TAG = "Freshmore Core"
PLACEHOLDER_CODE = "99.999"

# The course-type ids are SUTD's own, and each pillar numbers them differently.
# They came from the filtered URLs a maintainer arrived at by using the site.
SOURCES: dict[str, str] = {
    "DAI (AY2025 and earlier)":
        "https://www.sutd.edu.sg/dai/education/undergraduate/courses/ay2025-earlier/"
        "?course-type=124%2C1466",
    "DAI (AY2026 onwards)":
        "https://www.sutd.edu.sg/dai/education/undergraduate/courses/ay2026-onwards/"
        "?course-type=124%2C1466",
    "CSD/ISTD":
        "https://www.sutd.edu.sg/istd/education/undergraduate/courses/?course-type=204",
    "ESD":
        "https://www.sutd.edu.sg/esd/education/undergraduate/courses/?course-type=363",
    "EPD":
        "https://www.sutd.edu.sg/epd/education/undergraduate/courses/?course-type=423%2C424",
    "ASD":
        "https://www.sutd.edu.sg/asd/education/undergraduate/courses/?course-type=168%2C167",
}

CODE = re.compile(r"\b(\d{2})\.(\d{3})([A-Za-z]?)\b")
# The real undergraduate code space. A listing page also carries phone and
# reference numbers that match the shape.
PREFIXES = {"01", "02", "03", "10", "20", "30", "40", "50", "60"}

# A pillar that parses to nothing is a redesign or a bad minute, not a pillar
# that dropped its core. Refusing keeps the flags already on disk.
MIN_PER_PILLAR = 2

# The floor above only catches a page that returns almost nothing. A page that
# returns HALF its grid clears it, and then every core it failed to mention
# gets its flag taken off: a bad minute turned into a data change nobody asked
# for. A curriculum drops a core or two at a time, so more than that in one run
# is the page being wrong rather than the course list changing. Deliberately
# NOT a count of what each pillar should have, because the whole reason this
# reads the listing is that those numbers move.
MAX_REMOVALS = 2


def codes_in_grid(url: str) -> list[str] | None:
    """The codes inside the listing grid, or None when there is no grid."""
    soup = BeautifulSoup(_http.get(url, ttl_hours=72, delay=0.4), "html.parser")
    grid = soup.select_one(".general-listing-grid")
    if grid is None:
        return None
    text = " ".join(grid.get_text(" ", strip=True).split())
    return sorted({
        f"{m.group(1)}.{m.group(2)}{m.group(3)}"
        for m in CODE.finditer(text)
        if m.group(1) in PREFIXES
    })


def path_for(code: str) -> pathlib.Path:
    return COURSES / f"{code.replace('.', '_')}.json"


def freshmore_pass(dry_run: bool) -> tuple[list[str], list[str]]:
    """Flag every course SUTD tags `Freshmore Core`, and unflag what stops.

    Reads only /data, so it runs whether or not the listings are reachable and
    cannot be left half-applied by a bad minute on sutd.edu.sg. Owns its own
    reason, so it never touches a pillar-core flag or one a human set.
    """
    added, removed = [], []
    for f in sorted(COURSES.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        # 99.999 is the placeholder for a course SUTD has announced and not
        # numbered. There are several, they share the code, and none of them is
        # a course anyone can be in a chat about.
        if d.get("code") == PLACEHOLDER_CODE:
            continue
        tagged = FRESHMORE_TAG in (d.get("tags") or [])
        mine = d.get("noBatchChatReason") == FRESHMORE_REASON
        if tagged and not d.get("noBatchChat"):
            d["noBatchChat"] = True
            d["noBatchChatReason"] = FRESHMORE_REASON
            added.append(d["code"])
        elif mine and not tagged:
            d.pop("noBatchChat", None)
            d.pop("noBatchChatReason", None)
            removed.append(d["code"])
        else:
            continue
        if not dry_run:
            f.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n",
                         encoding="utf-8")
    return added, removed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="report, write nothing")
    args = ap.parse_args()

    # First, and unconditionally: it needs no network, so a listing that is
    # down must not take the freshmore half with it.
    fresh_added, fresh_removed = freshmore_pass(args.dry_run)
    if fresh_added:
        print(f"freshmore core, flagged: {', '.join(fresh_added)}")
    if fresh_removed:
        print(f"no longer a freshmore core, flag removed: {', '.join(fresh_removed)}")

    wanted: set[str] = set()
    failed: list[str] = []
    for name, url in SOURCES.items():
        try:
            found = codes_in_grid(url)
        except Exception as exc:  # noqa: BLE001
            found = None
            print(f"  {name:<24} UNREACHABLE {type(exc).__name__}", file=sys.stderr)
        if found is None:
            failed.append(name)
            print(f"  {name:<24} no listing grid", file=sys.stderr)
            continue
        if len(found) < MIN_PER_PILLAR:
            failed.append(name)
            print(f"  {name:<24} only {len(found)} code(s), floor is {MIN_PER_PILLAR}",
                  file=sys.stderr)
            continue
        print(f"  {name:<24} {len(found):>2}  {', '.join(found)}")
        wanted |= set(found)

    if failed:
        # Partial is worse than nothing here: a pillar that failed to parse would
        # look like a pillar with no core, and every one of its courses would
        # have its flag taken off.
        print(f"\nREFUSING TO WRITE: {len(failed)} source(s) did not parse "
              f"({', '.join(failed)}). The flags on disk stand.", file=sys.stderr)
        return 1

    # Worked out before anything is written, because a removal pass that turns
    # out to be too broad has to stop the additions with it: both came off the
    # same parse.
    stale = sorted(
        d["code"]
        for d in (json.loads(f.read_text(encoding="utf-8"))
                  for f in sorted(COURSES.glob("*.json")))
        if d.get("noBatchChatReason") == REASON and d["code"] not in wanted
    )
    if len(stale) > MAX_REMOVALS:
        print(f"REFUSING TO WRITE: {len(stale)} flag(s) would come off "
              f"({', '.join(stale)}), and the cap is {MAX_REMOVALS}. Either a "
              f"listing came back short, or the core really did change that "
              f"much. Check the pages above, then raise MAX_REMOVALS in the "
              f"same commit that records why.", file=sys.stderr)
        return 1

    added, removed, missing = [], [], []
    for code in sorted(wanted):
        p = path_for(code)
        if not p.exists():
            missing.append(code)
            continue
        d = json.loads(p.read_text(encoding="utf-8"))
        if d.get("noBatchChat") and d.get("noBatchChatReason") == REASON:
            continue
        if d.get("noBatchChat"):
            # Flagged by a human for a reason this script did not write. Left
            # alone, and not claimed.
            continue
        d["noBatchChat"] = True
        d["noBatchChatReason"] = REASON
        if not args.dry_run:
            p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        added.append(code)

    for code in stale:
        p = path_for(code)
        d = json.loads(p.read_text(encoding="utf-8"))
        d.pop("noBatchChat", None)
        d.pop("noBatchChatReason", None)
        if not args.dry_run:
            p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        removed.append(code)

    tag = "[dry-run] " if args.dry_run else ""
    print(f"\n{tag}{len(wanted)} core course(s) across {len(SOURCES)} listings")
    if added:
        print(f"{tag}flagged: {', '.join(added)}")
    if removed:
        print(f"{tag}no longer a core, flag removed: {', '.join(removed)}")
    if missing:
        print(f"listed by SUTD but no record here: {', '.join(missing)}. "
              f"The `mods` step creates those; this runs after it.")
    if not added and not removed:
        print(f"{tag}nothing to change")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
