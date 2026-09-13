#!/usr/bin/env python3
"""Mark every core course as getting no batch chat.

    python tools/scraper/gather_cores.py            # refresh, then report
    python tools/scraper/gather_cores.py --dry-run  # report, write nothing

WHY A CORE GETS NO CHAT
A batch chat is for a course a cohort CHOOSES, where the people in it are the
people who picked the same elective and have nothing else in common. A core is
taken by everybody, who already share a cohort chat, a timetable and a year
group. A second group with the same membership is noise, which is the same
reason capstones and thesis mods are excluded.

There are two kinds, and they are found differently.

A PILLAR core is published per pillar and the lists move, so they are read off
each pillar's own filtered listing rather than typed.

A TAGGED core is already in our own data. SUTD's own page tags it, and
`gather_mods.py` copied the tag into the record, so this half needs no
network at all. `Freshmore Core` is 02.001, 02.003 and the 10.0xx subjects,
which every freshmore takes alongside the same 200 people; `Core` is a
programme's own: the 20.5xx, 30.5xx and 40.5xx graduate courses and six ASD
cores in the middle of the undergraduate degree.

`Core Elective` counts as a core. It reads like a choice and is not one in the
sense that matters: it is a slot every student on the programme has to fill from
a short published list, so the cohort shares it the way they share any core.
`Elective` and `Elective / Technical Elective` are the real choices and stay
out.

The reasons are the tags, lowercased. Naming them for what they seem to be goes
wrong: "graduate core" fits the 28 courses numbered 500 and up and is flatly
false for the six ASD cores at terms 4 to 8.

WHAT IT OWNS, AND WHAT IT LEAVES ALONE
Each half writes `noBatchChat: true` with its own `noBatchChatReason`, and each
removes only flags carrying one of its own: `pillar core` for the listing half,
`freshmore core` and `programme core` for the tag half. The two never share a
reason, or each would take the other's flags off on every run.

The listing half additionally refuses to remove more than MAX_REMOVALS in one
run, because a page that comes back half-parsed clears the per-pillar floor and
would then quietly unflag whatever it missed.

A record flagged for a reason neither half wrote - 01.400 Capstone 1, 02.XFER -
is left exactly as it is, because a flag with no reason was set by a person and
this script has no way to know what they knew.

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
# A tag that says "everybody on this programme takes this", and the reason each
# one writes. Own reasons, so this pass only ever removes what it wrote and a
# course that stops being a PILLAR core keeps a tag-driven flag, and the other
# way round.
#
# Each reason is the tag it came from, lowercased, and that is deliberate.
# Naming them for what they seem to BE goes wrong: "graduate core" would fit
# the 28 courses numbered 500 and up and be flatly false for the six ASD cores
# at terms 4 to 8 (20.213, 20.221, 20.222, 20.224, 20.318, 20.319). A reason
# copied off the tag cannot be wrong about the course, because the tag is what
# the page said.
#
# `Core Elective` is here too. It reads like a choice and is not one in the
# sense that matters: it is a slot every student on the programme must fill
# from a short published list, so a cohort shares it the way they share any
# core. `Elective` and `Elective / Technical Elective` are the real choices and
# stay out.
TAG_REASONS: dict[str, str] = {
    "Freshmore Core": "freshmore core",
    "Core Elective": "core elective",
    "Core": "core",
}
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


def reason_for(tags: list[str]) -> str | None:
    """The reason a course's own tags give for having no chat, or None.

    Pure, so it can be driven without touching /data. The distinction it has to
    get right is `Core` against `Core Elective`: one is taken by everyone on
    the programme and one is chosen, and choosing is the entire case for a
    batch chat.
    """
    for tag, reason in TAG_REASONS.items():
        if tag in tags:
            return reason
    return None


def core_tag_pass(dry_run: bool) -> tuple[list[str], list[str]]:
    """Flag every course whose own tags call it a core, and unflag what stops.

    Reads only /data, so it runs whether or not the listings are reachable and
    cannot be left half-applied by a bad minute on sutd.edu.sg. The tags are
    what `gather_mods.py` copied off the course's own page, so this is the
    page speaking, once removed.

    Two tags, for the two kinds the listing distinguishes. `Freshmore Core` is
    02.001 and 02.003 and the 10.0xx subjects: every freshmore takes them
    alongside the same 200 people. `Core` is a programme's own, which is most
    of the 20.5xx, 30.5xx and 40.5xx graduate courses and the ASD studios.

    It owns its reasons and touches nothing else, so a hand-set flag with no
    reason - 01.400 Capstone 1, 02.XFER - is never disturbed.
    """
    mine = set(TAG_REASONS.values())
    added, removed = [], []
    for f in sorted(COURSES.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        # 99.999 is the placeholder for a course SUTD has announced and not
        # numbered. There are several, they share the code, and none of them is
        # a course anyone can be in a chat about.
        if d.get("code") == PLACEHOLDER_CODE:
            continue
        reason = reason_for(d.get("tags") or [])
        current = d.get("noBatchChatReason")

        if reason and not d.get("noBatchChat"):
            d["noBatchChat"] = True
            d["noBatchChatReason"] = reason
            added.append(f"{d['code']} ({reason})")
        elif reason and current in mine and current != reason:
            # It was one kind of core and is now the other. Ours either way.
            d["noBatchChatReason"] = reason
            added.append(f"{d['code']} ({current} -> {reason})")
        elif not reason and current in mine:
            d.pop("noBatchChat", None)
            d.pop("noBatchChatReason", None)
            removed.append(d["code"])
        else:
            continue
        if not dry_run:
            f.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n",
                         encoding="utf-8")
    return added, removed


def self_check() -> int:
    """Drive the tag reader. No network, no /data.

    Getting this wrong is invisible from the outside: a course quietly stops
    offering a chat, or quietly starts, and the only sign is a button that is
    not there.
    """
    cases = [
        (["Freshmore Core", "HASS"], "freshmore core", "02.001 and 02.003"),
        (["SMT", "Freshmore Core"], "freshmore core", "the 10.0xx subjects"),
        (["ASD", "Core"], "core", "a programme's own core"),
        (["Core"], "core", "the tag on its own"),
        (["EPD", "Core Elective"], "core elective", "a slot every student fills"),
        # `Core` is a substring of `Core Elective`, so the mapping is ordered
        # longest-first and membership is exact. A core elective must not come
        # back as a plain core: each reason removes only its own flags, and two
        # passes disagreeing about which they own is how a flag gets stuck.
        (["Core Elective"], "core elective", "the longer tag wins outright"),
        (["Elective / Technical Elective", "HASS"], None, "a real choice"),
        (["Elective"], None, "the short form"),
        (["Freshmore Elective"], None, "chosen, even in freshmore"),
        (["Term 7", "CSD"], None, "no core tag at all"),
        ([], None, "no tags at all"),
    ]
    fails = []
    for tags, want, why in cases:
        got = reason_for(tags)
        if got != want:
            fails.append(f"{why}: {tags} gave {got!r}, want {want!r}")
    # The two halves must not share a reason, or each would remove the other's
    # flags on every run and the pair would never settle.
    if REASON in TAG_REASONS.values():
        fails.append(f"the tag pass and the listing pass share the reason {REASON!r}, "
                     f"so each would remove the other's flags")
    if fails:
        print(f"self-check: {len(fails)} failure(s)")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("self-check: the tag reader behaves")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="report, write nothing")
    args = ap.parse_args()

    # First, and unconditionally: it needs no network, so a listing that is
    # down must not take the freshmore half with it.
    tag_added, tag_removed = core_tag_pass(args.dry_run)
    if tag_added:
        print(f"a core by its own tags, flagged ({len(tag_added)}): "
              f"{', '.join(tag_added)}")
    if tag_removed:
        print(f"no longer a core by its tags, flag removed: {', '.join(tag_removed)}")

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
    if "--self-check" in sys.argv:
        raise SystemExit(self_check())
    raise SystemExit(main())
