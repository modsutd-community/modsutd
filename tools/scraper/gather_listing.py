#!/usr/bin/env python3
"""Gather the official undergraduate course listing from sutd.edu.sg.

Walks the Yoast course sitemaps, keeps /course/<NN-NNN...> pages, and
merges what it finds into /data/courses/:

* existing mods  -> only the "tags" field is added/replaced (plus the
  description, but ONLY when the repo description is empty). Schedules,
  grading, workload, credits, term, prerequisites are never touched.
* new mods       -> full JSON validated through schema.Mod before writing.

Courses that mention LKYCIC or NAMIC (as standalone tokens - "Dynamics"
must not match "NAMIC") are skipped.

Run with:  python gather_listing.py [--dry-run] [--limit N]
                                    [--delay 0.25] [--ttl-hours 168]

Raw HTML is cached under .cache/ (shared with sources/_http.py) so
re-runs are cheap and polite.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import unquote

SCRAPER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRAPER_DIR))

from bs4 import BeautifulSoup  # noqa: E402

from schema import Mod  # noqa: E402
from sources import _http  # noqa: E402

REPO_ROOT = SCRAPER_DIR.parents[1]
COURSES_DIR = REPO_ROOT / "data" / "courses"

SITEMAPS = [
    "https://www.sutd.edu.sg/course-sitemap.xml",
    "https://www.sutd.edu.sg/course-sitemap2.xml",
]

# Slug starts with an undergrad course code, e.g. 01-018-... or 02-131dh-...
SLUG_CODE_RE = re.compile(r"^(\d{2})-(\d{3})([a-z]{0,3})(?=-|/|$)")
DOTTED_CODE_RE = re.compile(r"\d{2}\.\d{3}[A-Za-z]?")
# Standalone tokens only: "NAMIC" must NOT match inside "Dynamics",
# "Thermodynamics", "Aerodynamics", ...
EXCLUDE_RE = re.compile(r"(?i)(?<![a-z])(lkycic|namic)(?![a-z])")
HEADING_TAGS = ("h2", "h3", "h4", "h5", "h6")
PREREQ_HEADING_RE = re.compile(r"(?i)^pre-?requisites?\b")
COREQ_HEADING_RE = re.compile(r"(?i)^co-?requisites?\b")
# Some pages (e.g. 60-001) put the intro under an explicit heading.
DESC_HEADING_RE = re.compile(r"(?i)^course description\b")
CREDITS_RE = re.compile(r"Number of credits:\s*(\d+)")
TERM_TAG_RE = re.compile(r"(?i)^term\s+(\d+)$")

# Fallbacks for code prefixes with no precedent in /data/courses -
# derived from the official listing tags on the page. There is no
# "Freshmore" pillar: freshmore subjects belong to SMT (or HASS).
TAG_TO_PILLAR = {
    "freshmore core": "SMT",
    "freshmore elective": "SMT",
    "smt": "SMT",
    "hass": "HASS",
    "istd": "CSD",
    "epd": "EPD",
    "esd": "ESD",
    "asd": "ASD",
    "dai": "DAI",
}
PILLAR_DEPARTMENT = {
    "SMT": "Science, Mathematics and Technology",
    "HASS": "Humanities, Arts and Social Sciences",
    "CSD": "Information Systems Technology and Design",
    "EPD": "Engineering Product Development",
    "ESD": "Engineering Systems and Design",
    "ASD": "Architecture and Sustainable Design",
    "DAI": "Design and Artificial Intelligence",
}

# The real undergraduate code space. Anything else in the sitemap (e.g. the
# stale 99-502 duplicate of 01.117) is not a course we track.
VALID_PREFIXES = {"01", "02", "03", "10", "20", "30", "40", "50", "60"}

ASSESSMENT_HEADING_RE = re.compile(r"(?i)^learning assessment\b")

# "Workload: 5-0-7" - lecture/recitation/cohort, then lab/design/field
# work, then independent study, in hours per week (defined on the course
# pages themselves). Published on a minority of pages; where present it
# replaces the hand-estimated placeholder.
WORKLOAD_RE = re.compile(r"(?i)Workload\s*:?\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})")

# Tag texts that name a pillar (a course can carry several - 03.007A is
# ASD + EPD + SMT via its per-pillar suffix pages).
PILLAR_TAG_NAMES = {"smt", "hass", "istd", "epd", "esd", "asd", "dai"}

def fetch(url: str, *, delay: float, ttl_hours: float) -> str:
    """_http.get with a polite delay whenever the cache will miss.

    The freshness test that decides whether to sleep lives in `_http` beside
    the one that decides whether to fetch. Two copies of it drift, and the
    copy that drifts is the one that sleeps for every cache hit.
    """
    return _http.get(url, ttl_hours=ttl_hours, delay=delay)


def sitemap_course_urls(*, delay: float, ttl_hours: float) -> list[str]:
    locs: list[str] = []
    for sm in SITEMAPS:
        xml = fetch(sm, delay=delay, ttl_hours=ttl_hours)
        locs.extend(re.findall(r"<loc>(.*?)</loc>", xml))
    return [u for u in locs if "/course/" in u]


def slug_of(url: str) -> str:
    return unquote(url).rstrip("/").rsplit("/course/", 1)[-1]


def undergrad_urls(course_urls: list[str]) -> tuple[dict[str, str], dict[str, list[str]], list[str]]:
    """Map dotted code -> URL. When several slugs share a code (03-007 /
    03-007a / 03-007b) prefer the plain, suffix-less slug; the other
    variants are kept so their pillar tags can be unioned in (each
    suffix page carries its own pillar's tags)."""
    by_code: dict[str, list[tuple[str, str]]] = {}
    for url in course_urls:
        m = SLUG_CODE_RE.match(slug_of(url))
        if not m:
            continue
        if m.group(1) not in VALID_PREFIXES:
            continue
        code = f"{m.group(1)}.{m.group(2)}"
        by_code.setdefault(code, []).append((m.group(3), url))

    chosen: dict[str, str] = {}
    extras: dict[str, list[str]] = {}
    dropped: list[str] = []
    for code, variants in by_code.items():
        variants.sort(key=lambda v: (v[0] != "", v[0], v[1]))
        chosen[code] = variants[0][1]
        if len(variants) > 1:
            extras[code] = [u for _, u in variants[1:]]
        dropped.extend(u for _, u in variants[1:])
    return chosen, extras, dropped


def parse_page(html: str, code: str, slug_suffix: str) -> dict:
    """Extract name/description/prereqs/coreqs/credits/tags.

    Known page shape (verified on /course/01-018-.../ and 50-043):
    h1 title -> description <p>s -> h5 'Prerequisite(s)' -> (li items) ->
    optional 'Co-requisite' / 'Learning objectives' / ... sections ->
    'Number of credits:' -> section.js-page-tags with one <a> per tag,
    then the site-wide 'Useful information' footer (outside <main>).
    """
    soup = BeautifulSoup(html, "lxml")
    main = soup.find("main") or soup.body
    if main is None:
        raise ValueError("no <main>/<body>")

    h1 = main.find("h1")
    if h1 is None:
        raise ValueError("no <h1>")
    title = h1.get_text(" ", strip=True)
    name = re.sub(r"^\s*\d{2}[.\-]\s?\d{3}[A-Za-z]?\s*", "", title)
    if slug_suffix:  # e.g. 02-131dh -> h1 "02.131 DH Non-Fiction ..."
        name = re.sub(rf"(?i)^{re.escape(slug_suffix)}\b[\s:–-]*", "", name)
    name = name.strip(" -–-:")
    if not name:
        raise ValueError(f"could not derive name from h1 {title!r}")

    description_parts: list[str] = []
    prereq_texts: list[str] = []
    coreq_texts: list[str] = []
    state = "before-title"
    for el in main.find_all(["h1", *HEADING_TAGS, "p", "li"]):
        text = el.get_text(" ", strip=True)
        if el.name == "h1":
            state = "description"
            continue
        if el.name in HEADING_TAGS:
            if PREREQ_HEADING_RE.match(text):
                state = "prereq"
            elif COREQ_HEADING_RE.match(text):
                state = "coreq"
            elif DESC_HEADING_RE.match(text):
                state = "description"
            else:
                state = "other"
            continue
        if not text:
            continue
        if state == "description" and el.name == "p":
            description_parts.append(text)
        elif state == "prereq":
            prereq_texts.append(text)
        elif state == "coreq":
            coreq_texts.append(text)

    def codes_in(texts: list[str]) -> list[str]:
        found: list[str] = []
        for c in DOTTED_CODE_RE.findall(" ".join(texts)):
            if c != code and c not in found:
                found.append(c)
        return found

    m = CREDITS_RE.search(main.get_text("\n", strip=True))
    credits = int(m.group(1)) if m else 12

    tags = page_tags(soup)

    workload = None
    wm = WORKLOAD_RE.search(main.get_text("\n", strip=True))
    if wm:
        a, b, c = (int(g) for g in wm.groups())
        if 0 < a + b + c <= 40:
            workload = {
                "lecture": a,
                "tutorial": 0,
                "project": b,
                "preparation": c,
                "total": a + b + c,
                "source": "official",
            }

    # 'Learning assessment' table (verified on 01-101): leaf <tr>s are
    # (Component | Week | Percentage); group headers are <th colspan> rows
    # and the Total row is skipped. Official grading beats placeholders.
    grading = None
    for heading in main.find_all(HEADING_TAGS):
        if not ASSESSMENT_HEADING_RE.match(heading.get_text(" ", strip=True)):
            continue
        table = heading.find_next("table")
        if table is None:
            break
        components = []
        for tr in table.find_all("tr"):
            tds = tr.find_all("td")
            if len(tds) < 2:  # group headers (th colspan) and empty rows
                continue
            comp_name = tds[0].get_text(" ", strip=True)
            pct_text = tds[-1].get_text(" ", strip=True)
            if not comp_name or comp_name.lower() == "total":
                continue
            pm = re.fullmatch(r"(\d{1,3})(?:\.\d+)?\s*%?", pct_text)
            if not pm:
                continue
            pct = int(pm.group(1))
            if 0 < pct <= 100:
                components.append({"name": comp_name, "percentage": pct})
        total = sum(c["percentage"] for c in components)
        # Sanity: a real rubric lands near 100 once group headers are skipped.
        if components and 80 <= total <= 120:
            grading = {"components": components, "source": "official"}
        break

    return {
        "name": name,
        "description": " ".join(description_parts).strip(),
        "prerequisites": codes_in(prereq_texts),
        "corequisites": codes_in(coreq_texts),
        "credits": credits,
        "tags": tags,
        "grading": grading,
        "workload": workload,
    }


def page_tags(soup: BeautifulSoup) -> list[str]:
    tags: list[str] = []
    for a in soup.select("section.js-page-tags a"):
        t = a.get_text(" ", strip=True)
        if t and t not in tags:
            tags.append(t)
    return tags


def term_from_tags(tags: list[str], default: str = "1") -> str:
    for tag in tags:
        m = TERM_TAG_RE.match(tag)
        if m:
            return str(min(max(int(m.group(1)), 1), 10))
    return default


def prefix_precedents() -> dict[str, tuple[str, str]]:
    """prefix -> (pillar, department) by majority vote over existing files."""
    votes: dict[str, Counter] = {}
    for path in sorted(COURSES_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        code = data.get("code", "")
        if len(code) >= 2 and data.get("pillar"):
            votes.setdefault(code[:2], Counter())[
                (data["pillar"], data.get("department", ""))
            ] += 1
    return {p: c.most_common(1)[0][0] for p, c in votes.items()}


def pillar_department(
    code: str, tags: list[str], precedents: dict[str, tuple[str, str]]
) -> tuple[str, str] | None:
    hit = precedents.get(code[:2])
    if hit:
        return hit
    for tag in tags:
        pillar = TAG_TO_PILLAR.get(tag.strip().lower())
        if pillar:
            return pillar, PILLAR_DEPARTMENT[pillar]
    return None


def merge_existing(path: Path, parsed: dict, dry_run: bool) -> str:
    """Add/replace tags; fill description only when repo's is empty; and
    replace grading/workload whenever the OFFICIAL page publishes them
    (official beats hand-curated placeholders). Everything else
    (schedules/credits/term/prereqs) is never touched.
    Returns unchanged|tags-updated.

    Known hazard: SUTD publishes 03.007, 03.007A and 03.007B as three separate
    courses, and a listing page that mentions only the base code must not have
    its tags written onto the base file as though the split never happened.
    Codes are matched exactly, letter included, so the three stay distinct - do
    not "normalise" a suffixed code here to find a file.
    """
    original = path.read_text(encoding="utf-8")
    data = json.loads(original)

    # The page this record was read from. Refreshed every run: a slug SUTD
    # renames leaves a dead link, and a dead link is how a maintainer learns a
    # re-scrape is due - so it must never go stale silently.
    src_changed = parsed.get("sourceUrl") and data.get("sourceUrl") != parsed["sourceUrl"]
    if src_changed:
        data["sourceUrl"] = parsed["sourceUrl"]

    fill_desc = not data.get("description", "").strip() and parsed["description"]
    same_tags = data.get("tags") == parsed["tags"] and not src_changed
    page_grading = parsed.get("grading")
    grading_changed = bool(page_grading) and data.get("grading") != page_grading
    page_workload = parsed.get("workload")
    workload_changed = bool(page_workload) and data.get("workload") != page_workload
    if (same_tags or not parsed["tags"]) and not fill_desc and not grading_changed and not workload_changed:
        return "unchanged"

    updated = dict(data)
    if parsed["tags"] and not same_tags:
        updated["tags"] = parsed["tags"]
    if fill_desc:
        updated["description"] = parsed["description"]
    if grading_changed:
        updated["grading"] = page_grading
    if workload_changed:
        updated["workload"] = page_workload

    if dry_run:
        return "tags-updated"

    if "tags" not in data and not fill_desc and not grading_changed and not workload_changed:
        # Surgical append: preserve the file's original formatting.
        body = original.rstrip()
        assert body.endswith("}")
        head = body[:-1].rstrip().rstrip(",")
        new_text = (
            head
            + ',\n  "tags": '
            + json.dumps(parsed["tags"], ensure_ascii=False)
            + "\n}\n"
        )
        if json.loads(new_text) == updated:  # verify before trusting surgery
            path.write_text(new_text, encoding="utf-8")
            return "tags-updated"
    path.write_text(json.dumps(updated, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return "tags-updated"


def write_new(path: Path, mod: Mod, dry_run: bool) -> None:
    payload = mod.model_dump(exclude_none=True)
    if not dry_run:
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="only first N courses")
    ap.add_argument("--delay", type=float, default=0.25)
    ap.add_argument("--ttl-hours", type=float, default=168.0)
    args = ap.parse_args()

    course_urls = sitemap_course_urls(delay=args.delay, ttl_hours=args.ttl_hours)
    chosen, extras, dropped_dups = undergrad_urls(course_urls)
    precedents = prefix_precedents()

    items = sorted(chosen.items())
    if args.limit:
        items = items[: args.limit]

    skipped_excluded: list[str] = []
    new_written: list[str] = []
    tag_updated: list[str] = []
    unchanged: list[str] = []
    failed: list[str] = []

    for code, url in items:
        suffix = SLUG_CODE_RE.match(slug_of(url)).group(3)
        try:
            html = fetch(url, delay=args.delay, ttl_hours=args.ttl_hours)
        except Exception as exc:  # noqa: BLE001
            print(f"[!] {code} fetch failed: {exc}", file=sys.stderr)
            failed.append(code)
            continue

        if EXCLUDE_RE.search(html):
            skipped_excluded.append(code)
            continue

        try:
            parsed = parse_page(html, code, suffix)
            # The page this record was read from, so the app can link a reader
            # to the source and a maintainer can spot a dead link.
            parsed["sourceUrl"] = url if url.endswith("/") else url + "/"
        except Exception as exc:  # noqa: BLE001
            print(f"[!] {code} parse failed: {exc}", file=sys.stderr)
            failed.append(code)
            continue

        if EXCLUDE_RE.search(" ".join(parsed["tags"])):
            skipped_excluded.append(code)
            continue

        # Union pillar tags from the code's suffix-variant pages (03-007a
        # etc. each carry their own pillar's tag set). Only pillar names
        # are merged - term/track tags stay the canonical page's.
        for vurl in extras.get(code, []):
            try:
                vhtml = fetch(vurl, delay=args.delay, ttl_hours=args.ttl_hours)
            except Exception as exc:  # noqa: BLE001
                print(f"[!] {code} variant fetch failed ({vurl}): {exc}", file=sys.stderr)
                continue
            if EXCLUDE_RE.search(vhtml):
                continue
            for t in page_tags(BeautifulSoup(vhtml, "lxml")):
                if t.strip().lower() in PILLAR_TAG_NAMES and t not in parsed["tags"]:
                    parsed["tags"].append(t)

        path = COURSES_DIR / f"{code.replace('.', '_')}.json"

        # A base code must never be written when the repo has split it. SUTD
        # publishes 03.007, 03.007A and 03.007B as three courses; a listing row
        # or a slug that yields only "03.007" would otherwise land its tags and
        # description on the base file, quietly re-merging a split someone made
        # deliberately. Codes are matched exactly, letter included.
        siblings = sorted(
            q.name for q in COURSES_DIR.glob(f"{code.replace('.', '_')}[A-Za-z].json")
        )
        if siblings and not path.exists():
            print(
                f"[!] {code} is split into {', '.join(siblings)} - refusing to recreate "
                f"the base file. Point the listing at the lettered code, or add the base "
                f"course by hand if SUTD really publishes all of them.",
                file=sys.stderr,
            )
            failed.append(code)
            continue

        if path.exists():
            status = merge_existing(path, parsed, args.dry_run)
            (tag_updated if status == "tags-updated" else unchanged).append(code)
            continue

        pd = pillar_department(code, parsed["tags"], precedents)
        if pd is None:
            print(f"[!] {code} no pillar precedent and no pillar tag", file=sys.stderr)
            failed.append(code)
            continue
        pillar, department = pd
        try:
            mod = Mod(
                code=code,
                name=parsed["name"],
                description=parsed["description"],
                credits=parsed["credits"],
                department=department,
                pillar=pillar,
                term=term_from_tags(parsed["tags"]),
                prerequisites=parsed["prerequisites"],
                corequisites=parsed["corequisites"],
                schedules=[],
                grading=parsed.get("grading"),
                tags=parsed["tags"],
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[!] {code} schema validation failed: {exc}", file=sys.stderr)
            failed.append(code)
            continue
        write_new(path, mod, args.dry_run)
        new_written.append(code)

    print()
    print(f"sitemap /course/ URLs      : {len(course_urls)}")
    print(f"undergrad courses kept     : {len(chosen)}"
          f" ({len(dropped_dups)} duplicate-code slugs dropped: "
          f"{[slug_of(u) for u in dropped_dups]})")
    print(f"processed this run         : {len(items)}")
    print(f"skipped (LKYCIC/NAMIC)     : {len(skipped_excluded)} {skipped_excluded}")
    print(f"new mods written           : {len(new_written)}")
    print(f"existing mods tag-updated  : {len(tag_updated)}")
    print(f"existing mods unchanged    : {len(unchanged)}")
    print(f"failed to parse            : {len(failed)} {failed}")
    if args.dry_run:
        print("(dry run - nothing written)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
