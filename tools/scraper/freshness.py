"""Data-freshness sentinel.

Run monthly by .github/workflows/freshness.yml (or by hand):

    python freshness.py            # prints a markdown report to stdout
    python freshness.py --out f.md # also writes it to a file

All checks are read-only and cheap: repo data counts, live HASS listing
vs repo, course sitemaps vs repo, specialisation-track drift, deployed
site manifest (skipped when SITE_URL is unset), and upstream URL
canaries.

Exit code is always 0 - the workflow decides what to do with the report
(the DRIFT: marker on the first line says whether anything needs a human).
Fixing findings is human/agent work: see .claude/skills/course-data and
.claude/skills/new-term.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA = REPO_ROOT / "data"

HASS_LIST_URLS = [
    "https://hass.sutd.edu.sg/education/undergraduate-subjects/freshmore/",
    "https://hass.sutd.edu.sg/education/undergraduate-subjects/electives/",
]

# The official course post-type sitemaps - the same enumeration
# gather_listing.py crawls. Cheap (2 fetches) and covers every pillar.
COURSE_SITEMAPS = [
    "https://www.sutd.edu.sg/course-sitemap.xml",
    "https://www.sutd.edu.sg/course-sitemap2.xml",
]

CANARY_URLS = [
    "https://hass.sutd.edu.sg/education/undergraduate-subjects/freshmore/",
    "https://www.sutd.edu.sg/",
    "https://www.sutd.edu.sg/education/undergraduate/specialisation-tracks/",
    "https://virtualtour.sutd.edu.sg/",
]

CLIENT = httpx.Client(
    timeout=20,
    follow_redirects=True,
    headers={"User-Agent": "modsutd-freshness/0.1 (+https://github.com/modsutd-community/modsutd)"},
)


def repo_counts() -> tuple[int, int]:
    courses = len(list((DATA / "courses").glob("*.json")))
    venues = len(list((DATA / "venues").glob("*.json")))
    return courses, venues


def repo_hass_codes() -> set[str]:
    out: set[str] = set()
    for f in (DATA / "courses").glob("0[123]_*.json"):
        if f.stem == "02_XFER":  # hand-authored HASS elective slot, no listing page
            continue
        out.add(f.stem.replace("_", "."))
    return out


def live_hass_codes() -> set[str] | None:
    # Same code shape the scraper uses (sources/hass.py CODE_RE).
    import re

    code_re = re.compile(r"\b(0[123])[._-]?(\d{3}[A-Za-z]?)\b")
    codes: set[str] = set()
    for url in HASS_LIST_URLS:
        try:
            html = CLIENT.get(url).raise_for_status().text
        except Exception:
            return None  # listing unreachable - reported by the canary check
        for m in code_re.finditer(html):
            codes.add(f"{m.group(1)}.{m.group(2)}")
    return codes or None


def site_manifest(site_url: str) -> dict | None:
    try:
        r = CLIENT.get(f"{site_url.rstrip('/')}/data/manifest.json")
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


def sitemap_codes() -> set[str] | None:
    # Undergrad slugs look like /course/50-043-database-systems/. Suffix
    # variants (03-007a) collapse to the plain code, matching
    # gather_listing.py's dedupe rule.
    import re
    from urllib.parse import unquote

    code_re = re.compile(r"/course/(\d{2})-(\d{3}[a-z]?)[a-z]{0,2}(?:-|/)")
    codes: set[str] = set()
    ok = False
    for url in COURSE_SITEMAPS:
        try:
            xml = CLIENT.get(url).raise_for_status().text
        except Exception:
            continue
        ok = True
        for m in code_re.finditer(unquote(xml)):
            codes.add(f"{m.group(1)}.{m.group(2)}")
    return codes if ok and codes else None


def repo_all_codes() -> set[str]:
    # 99_999_* (AY2026 uncoded placeholders) and 02_XFER (HASS break-term slot)
    # are hand-authored and have no listing page - never count them as drift.
    return {
        f.stem.replace("_", ".")
        for f in (DATA / "courses").glob("*.json")
        if not f.stem.startswith("99_999") and f.stem != "02_XFER"
    }


def specialisations_drift() -> list[str]:
    """Re-run the (cached, self-validating) specialisation gatherer into a
    temp file and diff track ids + requirement shapes against the repo."""
    import subprocess
    import tempfile

    repo_file = DATA / "specializations.json"
    if not repo_file.exists():
        return ["data/specializations.json missing - run tools/scraper/gather_specialisations.py"]
    gatherer = REPO_ROOT / "tools" / "scraper" / "gather_specialisations.py"
    if not gatherer.exists():
        return []
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        out_path = tmp.name
    proc = subprocess.run(
        [sys.executable, str(gatherer), "--refresh", "--out", out_path],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        return [
            "specialisation gatherer failed against the live site - SUTD likely "
            "restructured the track pages (see the gather-specialisations skill)."
        ]
    try:
        live = json.load(open(out_path, encoding="utf-8"))
        repo = json.load(open(repo_file, encoding="utf-8"))
    except Exception:
        return ["specialisation drift check could not compare outputs"]
    fp = lambda d: {t["id"]: t["requirements"] for t in d.get("tracks", [])}  # noqa: E731
    if fp(live) != fp(repo):
        live_ids, repo_ids = set(fp(live)), set(fp(repo))
        details = []
        if live_ids - repo_ids:
            details.append(f"new tracks: {', '.join(sorted(live_ids - repo_ids))}")
        if repo_ids - live_ids:
            details.append(f"removed tracks: {', '.join(sorted(repo_ids - live_ids))}")
        changed = [i for i in live_ids & repo_ids if fp(live)[i] != fp(repo)[i]]
        if changed:
            details.append(f"changed requirements: {', '.join(sorted(changed))}")
        return [f"specialisation tracks drifted ({'; '.join(details)}) - re-run gather_specialisations.py and commit"]
    return []


def check_canaries() -> list[str]:
    failures = []
    for url in CANARY_URLS:
        try:
            r = CLIENT.get(url)
            if r.status_code >= 400:
                failures.append(f"{url} → HTTP {r.status_code}")
        except Exception as e:
            failures.append(f"{url} → {type(e).__name__}")
    return failures


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    drift: list[str] = []
    notes: list[str] = []

    courses, venues = repo_counts()
    notes.append(f"repo data: **{courses} courses**, **{venues} venues**")

    live = live_hass_codes()
    if live is None:
        drift.append("HASS listing pages unreachable or empty - the weekly scraper is likely blind (check for a redesign).")
    else:
        repo = repo_hass_codes()
        new = sorted(live - repo)
        gone = sorted(repo - live)
        if new:
            drift.append(f"HASS mods live upstream but missing from the repo: {', '.join(new)}")
        if gone:
            drift.append(f"repo HASS mods no longer listed upstream (retired? renamed?): {', '.join(gone)}")
        if not new and not gone:
            notes.append(f"HASS catalogue in sync ({len(repo)} codes)")

    smap = sitemap_codes()
    if smap is None:
        drift.append("course sitemaps unreachable - the listing gatherer would be blind (check for a redesign).")
    else:
        repo_all = repo_all_codes()
        new_all = sorted(smap - repo_all)
        gone_all = sorted(repo_all - smap)
        if new_all:
            drift.append(
                f"{len(new_all)} listed mods missing from the repo (run the gather-listing skill): "
                + ", ".join(new_all[:15]) + ("…" if len(new_all) > 15 else "")
            )
        if gone_all:
            notes.append(
                f"{len(gone_all)} repo mods absent from the live sitemap (retired - kept for history): "
                + ", ".join(gone_all[:10]) + ("…" if len(gone_all) > 10 else "")
            )
        if not new_all:
            notes.append(f"full catalogue covers the live sitemap ({len(smap)} live codes / {len(repo_all)} repo files)")

    drift.extend(specialisations_drift())

    site_url = os.environ.get("SITE_URL", "").strip()
    if site_url:
        manifest = site_manifest(site_url)
        if manifest is None:
            drift.append(f"deployed site manifest unreachable at {site_url}/data/manifest.json")
        else:
            mc = (manifest.get("counts") or {}).get("courses")
            mv = (manifest.get("counts") or {}).get("venues")
            if mc != courses or mv != venues:
                drift.append(
                    f"deployed site serves {mc} courses / {mv} venues but the repo has {courses} / {venues} - a merge hasn't shipped."
                )
            updated = manifest.get("coursesUpdatedAt")
            if updated:
                try:
                    age = (datetime.now(timezone.utc) - datetime.fromisoformat(updated.replace("Z", "+00:00"))).days
                    if age > 120:
                        drift.append(f"deployed course data is {age} days old - a term has likely turned over (run the new-term skill).")
                    else:
                        notes.append(f"deployed course data age: {age} days")
                except ValueError:
                    pass
    else:
        notes.append("SITE_URL not set - deployed-site checks skipped")

    for f in check_canaries():
        drift.append(f"canary failed: {f}")

    today = datetime.now(timezone.utc).date().isoformat()
    lines = [f"DRIFT: {'yes' if drift else 'no'}", "", f"# data freshness report · {today}", ""]
    if drift:
        lines += ["## needs a human", ""] + [f"- [ ] {d}" for d in drift] + [
            "",
            "fix procedures: `.claude/skills/gather-listing` (catalogue/tags), "
            "`.claude/skills/gather-specialisations` (track criteria), "
            "`.claude/skills/course-data` (manual data edits), "
            "`.claude/skills/new-term` (term rollover).",
            "",
        ]
    lines += ["## status", ""] + [f"- {n}" for n in notes]
    report = "\n".join(lines) + "\n"

    sys.stdout.write(report)
    if args.out:
        args.out.write_text(report, encoding="utf-8")


if __name__ == "__main__":
    main()
