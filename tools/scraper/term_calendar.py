"""Rebuild data/term-calendar.json from SUTD's published academic calendar.

The file used to be typed in by hand once a year. That works exactly once: the
first year nobody remembers, a weekly-view paste spreads classes across a term
that has moved, and the two eval reminders land in the wrong week. So this
reads the same page a human would.

Two sources, both public:

  SUTD         the academic-calendar page, which carries every trimester of
               2026-2030 in one document, week ranges and all.
  data.gov.sg  Singapore's public holidays, because a holiday inside a term is
               a day the weekly paste must not put a class on.

Follows scrape.py's rule: refuse to write when the answer is thin. A CDN can
answer 200 with a login wall, and overwriting a good calendar with that would
be silent and permanent.
"""

from __future__ import annotations

import argparse
import csv
import html as htmllib
import io
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "term-calendar.json"

SUTD_URL = (
    "https://www.sutd.edu.sg/education/undergraduate/academic-calendar/"
    "overview/ay2024-onwards/"
)
# data.gov.sg publishes one dataset per year, all inside collection 691. Read
# the collection rather than a list of ids, so a new year needs no code change -
# which is the whole point of this file existing.
HOLIDAY_COLLECTION = "https://api-production.data.gov.sg/v2/public/api/collections/691/metadata"
HOLIDAY_POLL = "https://api-open.data.gov.sg/v1/public/api/datasets/{}/poll-download"

UA = {"User-Agent": "modsutd/1.0 (+https://github.com/modsutd-community/modsutd)"}

MONTHS = {
    m: i + 1
    for i, m in enumerate(
        "january february march april may june july august september "
        "october november december".split()
    )
}

# A trimester hosts several terms at once - "Terms 1, 7 & 9" all start on the
# same Monday - which is why one entry covers them and the label names them all.
TRIMESTER = re.compile(r"Trimester\s*(\d)\s*\|+\s*Terms?\s*([0-9,&\s]+?)\s*\|", re.I)

# Refuse to write below this. Five years times three trimesters is fifteen; a
# redesigned page typically yields zero or one.
MIN_TERMS = 6


def flatten(html: str) -> str:
    """Tags become pipes, so a table row's label and value stay separable."""
    flat = htmllib.unescape(re.sub(r"<[^>]+>", "|", html))
    flat = flat.replace("–", "-").replace("—", "-")
    flat = re.sub(r"[^\S\n]+", " ", flat)
    return re.sub(r"(\s*\|\s*)+", "|", flat)


def row(chunk: str, label: str) -> str:
    """The value cell of the row whose label starts with `label`."""
    m = re.search(re.escape(label) + r"[^|]*\|([^|]+)\|", chunk, re.I)
    return m.group(1).strip() if m else ""


def one_date(part: str, year: int, month: int | None, in_year: int | None) -> date | None:
    m = re.match(r"(\d{1,2})\s*([A-Za-z]+)?\s*(\d{4})?$", part.strip())
    if not m:
        return None
    mon = MONTHS.get((m.group(2) or "").lower()) or month
    if not mon:
        return None
    return date(int(m.group(3) or in_year or year), mon, int(m.group(1)))


def span(value: str, year: int) -> tuple[date, date] | None:
    """Parse "26 January - 07 March", "16 - 18 December", "23 August 2026 - 03 January 2027"."""
    parts = [p.strip() for p in value.split("-")]
    if len(parts) != 2:
        return None
    end = one_date(parts[1], year, None, None)
    if not end:
        return None
    # A left side with no month of its own borrows the right side's.
    start = one_date(parts[0], year, end.month, end.year)
    if not start:
        return None
    # A term running into January ends in the next calendar year, and the page
    # spells that out only sometimes.
    if end < start:
        end = end.replace(year=end.year + 1)
    return start, end


def mondays(first: date, count: int) -> list[date]:
    monday = first - timedelta(days=first.weekday())
    return [monday + timedelta(days=7 * i) for i in range(count)]


def parse_terms(html: str) -> list[dict]:
    flat = flatten(html)
    # The year tabs come before the blocks, three blocks per year, in order.
    # Only the earliest is read: the tab markup does not surround every year
    # the same way, so counting from the first is steadier than matching all
    # five. Week 1 starting on a Monday is the check that this landed right.
    tabs = sorted({int(y) for y in re.findall(r"\|(20[2-9]\d)\s*\|", flat)})
    blocks = list(TRIMESTER.finditer(flat))
    if not tabs or not blocks:
        return []
    first_year = tabs[0]

    out: list[dict] = []
    for i, m in enumerate(blocks):
        year = first_year + i // 3
        trimester = int(m.group(1))
        terms = [int(t) for t in re.findall(r"\d+", m.group(2))]
        end = blocks[i + 1].start() if i + 1 < len(blocks) else len(flat)
        chunk = flat[m.end():end]

        early = span(row(chunk, "Week 1"), year)
        recess = span(row(chunk, "Week 7"), year)
        late = span(row(chunk, "Week 8"), year)
        if not (early and late and terms):
            continue
        # Every SUTD term starts on a Monday. A start that is not one means the
        # year came out wrong, and a term placed in the wrong year would spread
        # a pasted week across dates that do not exist.
        if early[0].weekday() != 0:
            print(
                f"[terms] {year} trimester {trimester}: week 1 starts "
                f"{early[0]} which is not a Monday - skipping",
                file=sys.stderr,
            )
            continue

        # SUTD numbers the recess as week 7, so the teaching weeks are 1-6 and
        # 8-14. Counting weeks off the start instead puts "week 7" in the break.
        weeks = [
            {"week": n, "monday": d.isoformat()}
            for n, d in zip(range(1, 7), mondays(early[0], 6))
        ] + [
            {"week": n, "monday": d.isoformat()}
            for n, d in zip(range(8, 15), mondays(late[0], 7))
        ]

        # The academic year rolls over in the September trimester, so January
        # and May belong to the one that started the previous September.
        ay = year if trimester == 3 else year - 1
        named = ", ".join(str(t) for t in terms[:-1])
        which = f"Terms {named} & {terms[-1]}" if len(terms) > 1 else f"Term {terms[0]}"

        out.append({
            "label": f"{which}, AY{ay}/{str(ay + 1)[2:]}",
            "terms": terms,
            "weekOneMonday": weeks[0]["monday"],
            "lastDay": late[1].isoformat(),
            "teachingWeeks": weeks,
            "breaks": (
                [{
                    "name": "Recess",
                    "week": 7,
                    "from": recess[0].isoformat(),
                    "to": recess[1].isoformat(),
                }]
                if recess
                else []
            ),
            "holidays": [],
        })
    return out


def fetch_holidays(client: httpx.Client) -> list[dict]:
    try:
        meta = client.get(HOLIDAY_COLLECTION, timeout=30).json()["data"]
        datasets = (meta.get("collectionMetadata") or meta).get("childDatasets") or []
    except Exception as exc:  # noqa: BLE001 - the terms are still worth writing
        print(f"[holidays] collection: {type(exc).__name__} {exc}", file=sys.stderr)
        return []

    found: list[dict] = []
    for dataset in datasets:
        try:
            poll = client.get(HOLIDAY_POLL.format(dataset), timeout=30).json()
            url = (poll.get("data") or {}).get("url")
            if not url:
                continue
            body = client.get(url, timeout=30).text
        except Exception as exc:  # noqa: BLE001 - one missing year is not fatal
            print(f"[holidays] {dataset}: {type(exc).__name__} {exc}", file=sys.stderr)
            continue
        # Columns are date,day,holiday - the middle one is the weekday, which
        # is not what a reader wants to see next to a skipped class.
        rows = list(csv.reader(io.StringIO(body)))
        if not rows:
            continue
        head = [c.strip().lower() for c in rows[0]]
        name_at = head.index("holiday") if "holiday" in head else len(head) - 1
        for cells in rows[1:]:
            if len(cells) > name_at and re.fullmatch(r"\d{4}-\d{2}-\d{2}", cells[0].strip()):
                found.append({"date": cells[0].strip(), "name": cells[name_at].strip()})
    return found


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with httpx.Client(headers=UA, follow_redirects=True) as client:
        page = client.get(SUTD_URL, timeout=60)
        page.raise_for_status()
        terms = parse_terms(page.text)
        holidays = fetch_holidays(client)

    if len(terms) < MIN_TERMS:
        print(
            f"only {len(terms)} terms parsed (need {MIN_TERMS}) - refusing to write. "
            "The page has probably been redesigned; fix the selectors.",
            file=sys.stderr,
        )
        return 1

    # A holiday matters only where it falls inside a term: that is the day the
    # weekly paste has to leave empty.
    for t in terms:
        t["holidays"] = sorted(
            (h for h in holidays if t["weekOneMonday"] <= h["date"] <= t["lastDay"]),
            key=lambda h: h["date"],
        )

    doc = {
        "_note": (
            "Generated by tools/scraper/term_calendar.py - do not hand-edit. "
            "A List View paste needs none of this: it prints one row per real "
            "meeting, so recess and holidays are already absent. The Weekly "
            "Calendar View prints one week and no term, so a paste of it can "
            "only reach the whole term through this file."
        ),
        "_source": SUTD_URL,
        "_holidaySource": "https://data.gov.sg public holidays",
        "terms": terms,
    }
    text = json.dumps(doc, indent=1, ensure_ascii=False) + "\n"
    total = sum(len(t["holidays"]) for t in terms)
    if args.dry_run:
        print(text)
        print(f"{len(terms)} terms, {total} in-term holidays", file=sys.stderr)
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(terms)} terms, {total} in-term holidays")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
