"""Reconcile every mod record's prerequisites against its SUTD page.

`gather_mods.py` reads the prerequisite block and keeps the mod codes in
it, so "40.002 or 60.008" and "40.002 and 60.008" both arrive as
["40.002", "60.008"] - which the plan then treats as "all of". This says which
ones the page joins with "or", and which ones the repo and the page disagree
about in either direction.

    python tools/scraper/audit_prereqs.py                  -> report to stdout
    python tools/scraper/audit_prereqs.py --json out.json  -> the same, machine-readable
    python tools/scraper/audit_prereqs.py --csv out.csv    -> one row per mod

It never writes to `data/`. Codes in the block are not always requirements:
50.037's page names 50.012, 50.020 and 50.043 and then says they "are helpful
but not required". Read the sentence before editing a record.
"""

from __future__ import annotations

import argparse
import csv
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / 'sources'))
import _http  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
MODS = ROOT / "data" / "mods" if (ROOT / "data" / "mods").exists() else ROOT / "data" / "courses"

CODE = re.compile(r"\b(\d{2}\.\d{3}[A-Za-z]?)\b")

# Starts each <li> of the block. 50.037 lists 50.004 and 50.005 as bullets of
# their own and ends a THIRD bullet with "are helpful but not required";
# joined with spaces the three read as one sentence disowning all five.
# propose_edits.py splits on this to scope a hedge to its own bullet.
BULLET = "\u2022"

SITEMAPS = (
    "https://www.sutd.edu.sg/course-sitemap.xml",
    "https://www.sutd.edu.sg/course-sitemap2.xml",
)


def url_by_code() -> dict[str, str]:
    """Mod URLs straight from the sitemap, keyed by code.

    Guessing the slug from the name gets most of them and 404s on the rest -
    the listing does not spell every title the way the record does.
    """
    out: dict[str, str] = {}
    for sm in SITEMAPS:
        try:
            xml = _http.get(sm, ttl_hours=72)
        except Exception:  # noqa: BLE001
            continue
        for url in re.findall(r"<loc>([^<]+/course/[^<]+)</loc>", xml):
            m = re.search(r"/course/(\d{2})-(\d{3}[a-z]?)-", url)
            if m:
                out.setdefault(f"{m.group(1)}.{m.group(2)}".lower(), url)
    return out


def prereq_block(html: str) -> str:
    """The prerequisite text, read the way gather_mods reads it.

    Hunting for a heading with a regex and slicing to the next one silently
    skips most pages: SUTD does not use one heading level consistently, and the
    block is sometimes a <ul> and sometimes prose. Walking the document with a
    state machine - the same shape gather_mods.py uses to produce the
    records this audits - reads them all.
    """
    soup = BeautifulSoup(html, "html.parser")
    main = soup.find("main") or soup
    out: list[str] = []
    state = "other"
    heads = ["h1", "h2", "h3", "h4", "h5", "h6"]
    for el in main.find_all([*heads, "p", "li"]):
        text = el.get_text(" ", strip=True)
        if el.name in heads:
            state = "prereq" if re.match(r"(?i)^\s*pre-?requisites?", text) else "other"
            continue
        if state == "prereq" and text:
            out.append(f"{BULLET} {text}" if el.name == "li" else text)
    return " ".join(" ".join(out).split())


def tree_codes(node: object) -> list[str]:
    """Every mod code a prereqTree names, at any depth."""
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        if "code" in node:
            return [str(node["code"])]
        for key in ("and", "or"):
            if key in node:
                return [c for sub in node[key] for c in tree_codes(sub)]
        if "nOf" in node:
            return [c for sub in node["nOf"][1] for c in tree_codes(sub)]
    return []


def repo_codes(d: dict) -> set[str]:
    """What the record claims is REQUIRED BEFORE the mod.

    Corequisites are deliberately left out. A page's prerequisite block does
    not list them, so folding them in reports every mod that has one as a
    disagreement: 60.005 carries 60.004 as a corequisite and the page says
    only 10.014.
    """
    return set(d.get("prerequisites") or []) | set(tree_codes(d.get("prereqTree")))


def says_nothing(text: str) -> bool:
    """A block of dashes and bullet marks only: SUTD's way of printing none."""
    return not re.sub(rf"[\s–—{BULLET}-]+", "", text)


# 50.037's block as SUTD serves it, trimmed.
SELF_CHECK_HTML = """<main><h5><strong>Prerequisite/ Co-requisite/ Mutually exclusive
subject(s)</strong></h5><p>The course assumes a basic familiarity with computer
programming.</p><ul><li><a>50.004 Algorithms</a></li>
<li><a>50.005 Computer System Engineering</a></li>
<li><a>50.012 Networks</a>, <a>50.020 Security</a>, and <a>50.043 Database
Systems</a> are helpful but not required.</li></ul>
<h5>Learning objectives</h5><ol><li>Understand blockchains</li></ol></main>"""


def self_check() -> int:
    text = prereq_block(SELF_CHECK_HTML)
    parts = [p.strip() for p in text.split(BULLET)]
    fails = []
    if parts[1:3] != ["50.004 Algorithms", "50.005 Computer System Engineering"]:
        fails.append(f"50.004 and 50.005 are not bullets of their own: {parts}")
    if "not required" not in parts[-1] or "Understand" in text:
        fails.append(f"the hedge left its bullet, or the block ran past its heading: {text!r}")
    dash = prereq_block("<main><h5>Prerequisite</h5><ul><li>\u2013</li></ul></main>")
    if not says_nothing(dash):
        fails.append(f"a bulleted dash no longer reads as none listed: {dash!r}")
    for f in fails:
        print("FAIL", f)
    print(f"{3 - len(fails)}/3 audit_prereqs cases ok")
    return 1 if fails else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-check", action="store_true")
    ap.add_argument("--json")
    ap.add_argument("--csv")
    ap.add_argument("--limit", type=int, default=0)
    # Zero, not two. A single listed prerequisite can be wrong on its own -
    # 10.022 carried a 10.007 that SUTD does not list at all - and a mod
    # listing none can be missing all of them. Anything above zero is a guess
    # at where a mistake is allowed to hide.
    ap.add_argument("--min-prereqs", type=int, default=0)
    args = ap.parse_args()
    if args.self_check:
        return self_check()

    todo = []
    for f in sorted(MODS.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        if len(d.get("prerequisites") or []) >= args.min_prereqs:
            todo.append(d)
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(todo)} mod records to check", file=sys.stderr)

    urls = url_by_code()
    print(f"{len(urls)} mod URLs in the sitemap", file=sys.stderr)

    rows: list[dict] = []
    for i, d in enumerate(todo, 1):
        url = urls.get(d["code"].lower())
        row = {
            "code": d["code"],
            "name": d["name"],
            "repo": sorted(repo_codes(d)),
            "prerequisites": d.get("prerequisites") or [],
            "corequisites": d.get("corequisites") or [],
            "tree": "yes" if d.get("prereqTree") else "",
            "url": url or "",
            "joiner": "",
            "listed": "",
            "page": [],
            "status": "",
        }
        if not url:
            row["status"] = "no page"
            rows.append(row)
            continue
        try:
            text = prereq_block(_http.get(url, ttl_hours=72))
        except Exception as exc:  # noqa: BLE001
            row["status"] = f"fetch failed: {type(exc).__name__}"
            rows.append(row)
            continue

        row["listed"] = text
        # Minus the mod's own code: 50.021's block ends in a footnote naming
        # 50.021, which would otherwise read as a mod requiring itself.
        row["page"] = [c for c in CODE.findall(text) if c != d["code"]]
        # The page HAS a Prerequisite heading and prints nothing under it but a
        # dash. That is SUTD saying "none", not a page that failed to load -
        # 01.018's page is 350 KB of description with "<h5>Prerequisite</h5> –".
        #
        # Which makes it evidence only when the record agrees. Where the record
        # names something the page omits, a human still has to decide: 01.401
        # Capstone 2 prints no prerequisite and plainly needs 01.400.
        if says_nothing(text):
            row["status"] = "none listed" if not row["repo"] else "record adds"
            rows.append(row)
            continue
        if re.search(r"\bor\b", text, re.I):
            row["joiner"] = "or"
        elif re.search(r"\band\b", text, re.I):
            row["joiner"] = "and"
        extra = sorted(set(row["repo"]) - set(row["page"]))
        gap = sorted(set(row["page"]) - set(row["repo"]))
        row["extra"] = extra
        row["gap"] = gap
        # A code the page lists and the record holds as a COREQUISITE is not a
        # gap. SUTD prints both under one heading and then adds a footnote -
        # 50.021's says 50.007 "is also recognised as a co-requisite" - so the
        # record puts it where the app should enforce it, which is not here.
        co = set(row["corequisites"])
        row["status"] = "differs" if (extra or (set(gap) - co)) else "agrees"
        rows.append(row)
        if i % 25 == 0:
            print(f"  {i}/{len(todo)}", file=sys.stderr)

    by = lambda s: [r for r in rows if r["status"] == s]  # noqa: E731
    differs = by("differs")
    adds = by("record adds")
    print(f"\nAGREES      {len(by('agrees'))}")
    print(f"NONE LISTED {len(by('none listed'))}  (page says none, record says none)")
    print(f"NO PAGE     {len(by('no page'))}: {[r['code'] for r in by('no page')]}")
    print(f"\nRECORD ADDS WHAT THE PAGE OMITS ({len(adds)}) - the page prints a")
    print("Prerequisite heading with nothing under it, and the record names one:")
    for r in adds:
        print(f"  {r['code']:<8} {r['repo']}")
    print(f"\nDIFFERS ({len(differs)}) - read the sentence, do not apply blindly:")
    for r in differs:
        print(f"\n  {r['code']}  {r['name']}  [{r['joiner'] or 'no joining word'}]")
        if r["gap"]:
            print(f"    page has, repo lacks : {r['gap']}")
        if r["extra"]:
            print(f"    repo has, page lacks : {r['extra']}")
        print(f"    {r['listed'][:200]}")

    ors = [r for r in rows if r["joiner"] == "or" and not r.get("tree")]
    print(f"\nOR ON THE PAGE, NO TREE IN THE RECORD ({len(ors)}):")
    for r in ors:
        print(f"  {r['code']}  {r['listed'][:120]}")

    if args.json:
        pathlib.Path(args.json).write_text(
            json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8"
        )
    if args.csv:
        cols = ["code", "name", "status", "joiner", "prerequisites", "corequisites",
                "tree", "page", "gap", "extra", "url", "listed"]
        with open(args.csv, "w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(cols)
            for r in rows:
                vals = [r.get(c, "") for c in cols]
                w.writerow([" ".join(v) if isinstance(v, list) else v for v in vals])
        print(f"\nwrote {args.csv}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
