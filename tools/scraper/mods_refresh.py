#!/usr/bin/env python3
"""Everything a mod record is made of, refreshed in one run.

    python tools/scraper/mods_refresh.py              # refresh, then report
    python tools/scraper/mods_refresh.py --dry-run    # report, write nothing
    python tools/scraper/mods_refresh.py --only catalogue,tracks

WHY THIS EXISTS
The pieces of a mod are refreshed by separate scripts, and the monthly job
called two of them. The catalogue walk over all 389 course pages, the one that
finds new mods, tags, descriptions and source URLs, was a command a maintainer
had to remember, and a scheduled job is the only thing here that gets
remembered. One entry point, so "refresh the mods" is one thing to schedule.

It ORCHESTRATES rather than merges: each parser stays in its own file, because
they break independently when SUTD redesigns one page and not another, and a
single 2000-line script would make that one failure look like five.

EVERY STEP IS ISOLATED. A pillar site going down must not stop the term
calendar being read, so a step that raises is recorded and the rest continue.
The exit code is 1 only if EVERY step failed, which means the network or the
environment rather than one page.

WAVES, NOT A QUEUE. Most of the wall clock is waiting on sutd.edu.sg, so steps
that touch different files run together. What forces an order is only ever a
shared file:
  wave 1  catalogue, tracks, minors, calendar - four different outputs
  wave 2  hass                                - writes data/courses too, so
                                                it must not race the catalogue
  wave 3  prereqs                             - reads what the two above wrote

STEP NAMES SAY WHICH SITE. `catalogue` is sutd.edu.sg's own course sitemap,
which is every undergraduate mod in every pillar. `hass` is hass.sutd.edu.sg,
a different site with its own layout. They were called `listing` and `pillars`,
which read as though the first were a subset and the second the four pillar
sites. It is the other way round: the four pillar adapters in
sources/pillar.py are stubs that yield nothing.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

# Machine-readable step output, gitignored. The reports write here so the
# proposal step can read them without either one parsing the other's prose.
SCRATCH = HERE / ".reports"

# The one tracked artefact. Written only when a report has something to act on
# and deleted when it does not, so its own diff is what opens the monthly pull
# request: a month with the same drift as the last produces no file change and
# no PR, which is the honest signal. A timestamp in here would open one every
# month and teach the reviewer to skim.
DRIFT = ROOT / "tools" / "scraper" / "reports" / "drift.md"

# (name, argv, what it does). This list is not the order - WAVES is.
STEPS: list[tuple[str, list[str], str]] = [
    (
        "catalogue",
        ["gather_listing.py"],
        "every mod on sutd.edu.sg, walked from the course sitemap: new mods, "
        "tags, descriptions, source URLs, grading and workload",
    ),
    (
        "hass",
        ["scrape.py"],
        "hass.sutd.edu.sg's own subject pages. It also asks the four pillar "
        "sites, whose adapters are stubs and yield nothing",
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
        "minors",
        ["gather_minors.py", "--json", str(SCRATCH / "minors.json")],
        "each minor against its own page. REPORTS ONLY - the requirements are "
        "prose, and the repo expands 'any HASS elective' into a real list",
    ),
    (
        "prereqs",
        ["audit_prereqs.py", "--json", str(SCRATCH / "prereqs.json")],
        "prerequisites against each mod's own page. Reports; `propose` is what "
        "acts on it",
    ),
    (
        "propose",
        [
            "propose_edits.py",
            "--prereqs", str(SCRATCH / "prereqs.json"),
            "--minors", str(SCRATCH / "minors.json"),
            "--report-out", str(SCRATCH / "proposed.md"),
        ],
        "reads the two reports with a model and edits data/courses where the "
        "page supports it. Every proposal is validated against the quoted page "
        "text before it is written",
    ),
]

# Steps in the same wave run together; a wave finishes before the next starts.
WAVES: list[list[str]] = [
    ["catalogue", "tracks", "minors", "calendar"],
    ["hass"],
    ["prereqs"],
    ["propose"],
]


def run(script: list[str], dry_run: bool) -> tuple[bool, str]:
    """Run one step. Returns (ok, last few lines of output)."""
    cmd = [sys.executable, *script]
    # Only the writers understand --dry-run; the audit never writes at all.
    if dry_run and script[0] in {"gather_listing.py", "scrape.py", "propose_edits.py"}:
        cmd.append("--dry-run")
    try:
        p = subprocess.run(
            cmd, cwd=HERE, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=1800,
        )
    except subprocess.TimeoutExpired:
        return False, "timed out after 30 minutes"
    out = (p.stdout or p.stderr or "").strip()
    return p.returncode == 0, out


def timed(script: list[str], dry_run: bool) -> tuple[bool, str, float]:
    t0 = time.time()
    ok, tail = run(script, dry_run)
    return ok, tail, time.time() - t0


# Steps whose only product is prose. A change in what they say is the thing
# worth a human reading, and nothing else in the run records it.
REPORTING = ("minors", "prereqs", "propose")


def write_drift(results: list[tuple[str, bool, str, float]], by_name: dict) -> None:
    """The tracked report, or nothing.

    A run that changes no file opens no pull request, and the prereq and
    minor reports change no file by design. Writing what they said into a
    tracked path gives them a diff of their own, so a finding reaches a
    reviewer instead of sitting on a run summary nobody opens.
    """
    order = {n: i for i, n in enumerate(REPORTING)}
    parts: list[str] = []
    for name, ok, out, _ in sorted(results, key=lambda r: order.get(r[0], 99)):
        if name not in order or not ok or not out.strip():
            continue
        parts += [f"## {name}", "", by_name[name][1], "", "```", out.strip(), "```", ""]

    DRIFT.parent.mkdir(parents=True, exist_ok=True)
    if not parts:
        DRIFT.unlink(missing_ok=True)
        return
    head = [
        "# drift",
        "",
        "Written by `tools/scraper/mods_refresh.py`. Do not edit it by hand: the",
        "next refresh overwrites it, and deletes it when there is nothing to say.",
        "It carries no timestamp on purpose, so a month that finds the same drift",
        "as the last changes no file and opens no pull request.",
        "",
    ]
    DRIFT.write_text("\n".join(head + parts), encoding="utf-8")


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
        "--status-out",
        default="",
        help="append `failed=a,b` here. Point it at $GITHUB_OUTPUT and the job can say so on the PR, because a partial refresh still writes files and still opens one.",
    )
    ap.add_argument(
        "--only",
        default="",
        help="comma-separated step names: " + ", ".join(n for n, _, _ in STEPS),
    )
    args = ap.parse_args()

    # The steps write their machine-readable output here and `propose`
    # reads it, so it has to exist before the first wave, not on demand
    # inside four scripts that would each have to remember.
    SCRATCH.mkdir(parents=True, exist_ok=True)

    wanted = {s.strip() for s in args.only.split(",") if s.strip()}
    steps = [s for s in STEPS if not wanted or s[0] in wanted]
    if wanted - {n for n, _, _ in STEPS}:
        print(f"unknown step(s): {sorted(wanted - {n for n, _, _ in STEPS})}", file=sys.stderr)
        return 2

    by_name = {n: (argv, what) for n, argv, what in steps}
    print(f"# mods refresh{' (dry run)' if args.dry_run else ''}\n")

    results: list[tuple[str, bool, str, float]] = []
    started = time.time()
    for wave in WAVES:
        todo = [n for n in wave if n in by_name]
        if not todo:
            continue
        # Threads rather than processes: each one only waits on a subprocess,
        # so the GIL is never what holds them up.
        with ThreadPoolExecutor(max_workers=len(todo)) as pool:
            futures = {pool.submit(timed, by_name[n][0], args.dry_run): n for n in todo}
            for fut in as_completed(futures):
                name = futures[fut]
                ok, tail, secs = fut.result()
                results.append((name, ok, tail, secs))
                print(f"## {name}\n{by_name[name][1]}\n")
                # The summary shows a tail; the whole thing goes into the
                # drift file, where a reviewer can read the sentence that
                # decided a proposal.
                print("\n".join(tail.splitlines()[-12:]) or "(no output)")
                print(f"\n-> {'ok' if ok else 'FAILED'} in {secs:.0f}s\n", flush=True)

    write_drift(results, by_name)

    wall = time.time() - started
    print("## summary\n")
    for name, ok, _, secs in sorted(results, key=lambda r: -r[3]):
        print(f"  {'ok    ' if ok else 'FAILED'}  {name:<9} {secs:5.0f}s")
    print(f"\n  wall {wall:.0f}s, against {sum(r[3] for r in results):.0f}s one after another")


    touched = changed_files()
    print(f"\n{len(touched)} file(s) in /data changed")
    for f in touched[:25]:
        print(f"  {f}")
    if len(touched) > 25:
        print(f"  ... and {len(touched) - 25} more")

    failed = [n for n, ok, _, _ in results if not ok]
    # Appended, because $GITHUB_OUTPUT is a shared file the job writes to.
    if args.status_out:
        with open(args.status_out, "a", encoding="utf-8") as fh:
            print("failed=" + ",".join(failed), file=fh)

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
