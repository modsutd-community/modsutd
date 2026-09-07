"""Report every course whose listed prerequisites are an OR, not an AND.

gather_listing.py reads the prerequisite block and keeps only the course codes
in it, so "40.002 or 60.008" and "40.002 and 60.008" both come out as
["40.002", "60.008"] - which the plan then treats as "all of". This says which
ones the listing actually joins with "or".

    python tools/scraper/audit_prereqs.py            -> report to stdout
    python tools/scraper/audit_prereqs.py --json out.json
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / 'sources'))
import _http  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
COURSES = ROOT / "data" / "courses"

# The listing links each prerequisite, so the codes arrive as anchor text with
# the joining word as bare text between them.
ANCHOR = re.compile(r"<a[^>]*>(.*?)</a>", re.S | re.I)
CODE = re.compile(r"\b(\d{2}\.\d{3}[A-Za-z]?)\b")
TAG = re.compile(r"<[^>]+>")


SITEMAPS = (
    "https://www.sutd.edu.sg/course-sitemap.xml",
    "https://www.sutd.edu.sg/course-sitemap2.xml",
)


def url_by_code() -> dict[str, str]:
    """Course URLs straight from the sitemap, keyed by code.

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
                out.setdefault(f"{m.group(1)}.{m.group(2)}".upper().lower(), url)
    return out


def prereq_block(html: str) -> str:
    """The markup between the Prerequisite heading and the next heading."""
    m = re.search(r"Prerequisite[s]?\s*(?:\(s\))?\s*:?\s*</h\d>(.*?)<h\d", html, re.S | re.I)
    if not m:
        m = re.search(r"Prerequisite[s]?[^<]*</[^>]+>(.*?)<h\d", html, re.S | re.I)
    return m.group(1) if m else ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    todo = []
    for f in sorted(COURSES.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        if len(d.get("prerequisites") or []) >= 2:
            todo.append(d)
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(todo)} courses list two or more prerequisites", file=sys.stderr)

    urls = url_by_code()
    print(f"{len(urls)} course URLs in the sitemap", file=sys.stderr)

    ors, ands, unread = [], [], []
    for i, d in enumerate(todo, 1):
        url = urls.get(d["code"].lower())
        if not url:
            unread.append((d["code"], "not in the sitemap"))
            continue
        try:
            html = _http.get(url, ttl_hours=72)
        except Exception as exc:  # noqa: BLE001
            unread.append((d["code"], f"{type(exc).__name__}"))
            continue
        block = prereq_block(html)
        text = " ".join(TAG.sub(" ", block).split())
        codes = CODE.findall(text)
        joiner = None
        if re.search(r"\bor\b", text, re.I):
            joiner = "or"
        elif re.search(r"\band\b", text, re.I):
            joiner = "and"
        row = {"code": d["code"], "name": d["name"], "listed": text[:160], "codes": codes}
        if joiner == "or":
            ors.append(row)
        elif joiner == "and":
            ands.append(row)
        else:
            unread.append((d["code"], "no joining word found"))
        if i % 20 == 0:
            print(f"  {i}/{len(todo)}", file=sys.stderr)

    print(f"\nOR  ({len(ors)}):")
    for r in ors:
        print(f"  {r['code']}  {r['listed']}")
    print(f"\nAND ({len(ands)})")
    print(f"UNREAD ({len(unread)}): {unread}")

    if args.json:
        pathlib.Path(args.json).write_text(
            json.dumps({"or": ors, "and": ands, "unread": unread}, indent=1), encoding="utf-8"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
