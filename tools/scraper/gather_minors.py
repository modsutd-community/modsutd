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

So it flags the things that really do mean stale:
  - SUTD lists a minor the repo does not carry, or the repo carries one SUTD no
    longer links
  - the page is unreachable, or 404s
  - the page names NO course codes at all, which is what a redesign looks like
  - the page names a code this minor does not list, which is a new or changed
    requirement rather than an expansion the repo already made

IT DISCOVERS, IT DOES NOT ONLY RE-CHECK. Walking only the URLs already in
data/minors.json can never find a minor SUTD adds, which is the failure that
matters most: a student reads a catalogue that silently lacks a programme. The
seed is SUTD's own index at /education/undergraduate/minors/, the one page from
which every minor is reachable, and it is server-rendered so a plain GET is
enough.

Four traps in that filter, all live today:
  - EPD says `minor-programmes`, every other pillar says `minors`
  - SMT has one minor and gave it the section root, so its URL has no slug
  - the ISTD index links DAI with no trailing slash
  - asd and dai have no minors area at all and 404
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from urllib.parse import urldefrag, urljoin

from bs4 import BeautifulSoup

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "sources"))
import _http  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
MINORS = ROOT / "data" / "minors.json"

# The only page every minor is reachable from. A pillar section root is not a
# substitute: HASS's nav lists no siblings at all, and EPD's resolves to an
# "affiliated minors" index that is not itself a minor.
INDEX = "https://www.sutd.edu.sg/education/undergraduate/minors/"

# The optional third group is what keeps SMT's slug-less page. Requiring a slug
# silently drops Sustainability by Design and returns eleven of twelve.
MINOR_URL = re.compile(
    r"^https://www\.sutd\.edu\.sg"
    r"/(asd|dai|epd|esd|hass|istd|smt)"
    r"/education/undergraduate/(minors|minor-programmes)(/[a-z0-9-]+)?$"
)

CODE = re.compile(r"\b(\d{2})\.(\d{3})([A-Za-z]?)\b")
# The real undergraduate code space. A minor page also carries phone numbers and
# reference numbers that match the shape - 12.071, 16.471 - and counting those
# as missing mods would make every minor look broken.
VALID_PREFIXES = {"01", "02", "03", "10", "20", "30", "40", "50", "60"}


def norm_url(u: str) -> str:
    """Comparable form: no fragment, no trailing slash.

    SUTD links the same page both ways - the ISTD index has DAI without a
    trailing slash - so comparing raw hrefs reports a minor as both missing and
    unknown at once.
    """
    return urldefrag(u)[0].rstrip("/")


def published() -> dict[str, str]:
    """Every minor page SUTD links from its own index, url -> the link text."""
    html = _http.get(INDEX, ttl_hours=72, delay=0.4)
    soup = BeautifulSoup(html, "html.parser")
    main = soup.find("main") or soup
    out: dict[str, str] = {}
    seed = norm_url(INDEX)
    for a in main.find_all("a", href=True):
        url = norm_url(urljoin(INDEX, a["href"]))
        if url != seed and MINOR_URL.match(url):
            out.setdefault(url, a.get_text(" ", strip=True))
    return out


def visible_text(html: str) -> str:
    """The page as a reader sees it, for a model to quote from.

    Capped: the whole page is 300-400 KB of template, and the requirements sit
    in the first screens of real content. Sending the rest costs tokens and
    gives a model more places to find a code that means nothing.
    """
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.select("script, style, svg, noscript, header, footer, nav"):
        tag.decompose()
    main = soup.find("main") or soup
    return " ".join(main.get_text(" ", strip=True).split())[:6000]


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

    # Discovery first, because a minor SUTD added and the repo never heard of
    # is the failure that matters most: a student reads a catalogue missing a
    # programme, and no amount of re-checking the ten we already have finds it.
    known = {norm_url(m.get("source") or m.get("url") or ""): m.get("id") for m in minors}
    try:
        pub = published()
    except Exception as exc:  # noqa: BLE001
        pub = {}
        drift += 1
        print(f"  INDEX UNREACHABLE  {INDEX}  ({type(exc).__name__})")
        print("  Cannot tell whether SUTD added or dropped a minor this run.")

    if pub:
        unknown = {u: t for u, t in pub.items() if u not in known}
        unlinked = [(u, i) for u, i in known.items() if u and u not in pub]
        print(f"SUTD lists {len(pub)} minor pages; the repo carries {len(minors)}.")
        for url, title in sorted(unknown.items()):
            drift += 1
            print(f"  NOT IN THE REPO   {title or '(no link text)'}")
            print(f"                    {url}")
        for url, mid in sorted(unlinked):
            drift += 1
            print(f"  NOT ON THE INDEX  {mid}")
            print(f"                    {url}")
        if not unknown and not unlinked:
            print("  every published page has a record, and every record is published")
        print("")

    rows.append({
        "id": "_index",
        "url": INDEX,
        "status": "index",
        "published": len(pub),
        "unknown": [{"url": u, "title": t} for u, t in sorted(pub.items()) if u not in known],
        "unlinked": [i for u, i in sorted(known.items()) if u and u not in pub],
    })
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
        # Kept so propose_edits.py can make a model quote the page before it
        # is allowed to change a requirement. Without evidence to check a
        # proposal against, this report can only ever be read by a human.
        row["page_text"] = visible_text(html)
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

    print(f"\n{drift} thing(s) need a look, across {len(minors)} records "
          f"and {len(pub)} published pages.")
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
