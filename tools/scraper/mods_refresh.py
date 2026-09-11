#!/usr/bin/env python3
"""Everything a mod record is made of, refreshed in one run.

    python tools/scraper/mods_refresh.py              # refresh, then report
    python tools/scraper/mods_refresh.py --dry-run    # report, write nothing
    python tools/scraper/mods_refresh.py --only listing,tracks

WHY THIS EXISTS
The pieces of a mod were refreshed by four scripts that nobody ran together.
The monthly job called two of them, so the catalogue walk that reads all 389
course pages - the one that finds new mods, tags, descriptions and source URLs
- was a command a maintainer had to remember. It was not run, and seventeen
records had drifted by the time anyone checked.

One entry point, so "refresh the mods" is one thing you can schedule and one
thing you can forget to do.

It ORCHESTRATES rather than merges: each parser stays in its own file, because
they break independently when SUTD redesigns one page and not another, and a
single 2000-line script would make that one failure look like five.

EVERY STEP IS ISOLATED. A pillar site going down must not stop the term
calendar being read, so a step that raises is recorded and the rest continue.
The exit code is 1 only if EVERY step failed, which means the network or the
environment rather than one page.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

# Order matters. The catalogue walk comes first because it is the one that adds
# NEW course files; everything after it wants those on disk. The prerequisite
# reconciliation comes last, because it reads what the others just wrote.
STEPS: list[tuple[str, list[str], str]] = [
    (
        "listing",
        ["gather_listing.py"],
        "the official course listing: new mods, tags, descriptions, source URLs, "
        "grading and workload",
    ),
    (
        "pillars",
        ["scrape.py"],
        "the HASS listing and the four pillar sites",
    ),
    (
        "tracks",
        ["gather_specialisations.py"],
        "specialisation-track criteria -> data/specializations.json",
    ),
    (
        "calendar",
        ["term_calendar.py"],
        "term dates -> data/term-calendar.json",
    ),
    (
        "prereqs",
        ["audit_prereqs.py"],
        "prerequisites against each mod's own page. REPORTS ONLY - a page can "
        "name a code and then disown it, so a human applies these",
    ),
]


def run(script: list[str], dry_run: bool) -> tuple[bool, str]:
    """Run one step. Returns (ok, last few lines of output)."""
    cmd = [sys.executable, *script]
    # Only the writers understand --dry-run; the audit never writes at all.
    if dry_run and script[0] in {"gather_listing.py", "scrape.py"}:
        cmd.append("--dry-run")
    try:
        p = subprocess.run(
            cmd, cwd=HERE, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=1800,
        )
    except subprocess.TimeoutExpired:
        return False, "timed out after 30 minutes"
    tail = "\n".join((p.stdout or p.stderr or "").strip().splitlines()[-12:])
    return p.returncode == 0, tail


def changed_files() -> list[str]:
    """What this run actually altered, so the summary is about data not logs."""
    p = subprocess.run(
        ["git", "status", "--porcelain", "--", "data"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    return [ln[3:] for ln in p.stdout.splitlines() if ln.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="write nothing")
    ap.add_argument(
        "--only",
        default="",
        help="comma-separated step names: " + ", ".join(n for n, _, _ in STEPS),
    )
    args = ap.parse_args()

    wanted = {s.strip() for s in args.only.split(",") if s.strip()}
    steps = [s for s in STEPS if not wanted or s[0] in wanted]
    if wanted - {n for n, _, _ in STEPS}:
        print(f"unknown step(s): {sorted(wanted - {n for n, _, _ in STEPS})}", file=sys.stderr)
        return 2

    print(f"# mods refresh{' (dry run)' if args.dry_run else ''}\n")
    results: list[tuple[str, bool, str, float]] = []
    for name, script, what in steps:
        print(f"## {name}\n{what}\n", flush=True)
        t0 = time.time()
        ok, tail = run(script, args.dry_run)
        results.append((name, ok, tail, time.time() - t0))
        print(tail or "(no output)")
        print(f"\n-> {'ok' if ok else 'FAILED'} in {time.time() - t0:.0f}s\n", flush=True)

    print("## summary\n")
    for name, ok, _, secs in results:
        print(f"  {'ok    ' if ok else 'FAILED'}  {name:<9} {secs:5.0f}s")

    touched = changed_files()
    print(f"\n{len(touched)} file(s) in /data changed")
    for f in touched[:25]:
        print(f"  {f}")
    if len(touched) > 25:
        print(f"  ... and {len(touched) - 25} more")

    failed = [n for n, ok, _, _ in results if not ok]
    if failed and len(failed) == len(results):
        print(f"\nEVERY step failed ({', '.join(failed)}) - this is the network "
              f"or the environment, not one page.", file=sys.stderr)
        return 1
    if failed:
        print(f"\n{len(failed)} step(s) failed: {', '.join(failed)}. The rest ran.",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
