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

Run with:  python gather_mods.py [--dry-run] [--limit N]
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

# The code space of SUTD's own undergraduate listing, and not a guess: walking
# /education/undergraduate/courses/ to its last page yields 219 course links
# carrying exactly these nine prefixes. A sitemap slug outside them is a
# graduate catalogue (51.5xx is MSSD, 99.5xx the SMT PhD programme) or an orphan
# CMS record (41.5xx and 45.2xx: no programme lists them, their page body holds
# no prose at all, and two of them say "Non-credit course").
#
# A second copy of this set lives in gather_minors.py for a different purpose -
# keeping phone and reference numbers out of a minor page's code extraction -
# and the two are meant to diverge.
VALID_PREFIXES = {"01", "02", "03", "10", "20", "30", "40", "50", "60"}

# The off-space codes whose own page says an undergraduate may take them:
# (pillar, term, the words on the page that justify the entry).
#
# The pillar and term are pinned rather than derived, and neither could be. The
# page publishes no Term tag, so term_from_tags would answer 8 - the untermed
# elective fallback, which is not what the page said. And prefix_precedents()
# has no honest vote for "99": its majority comes from the 99.999 placeholders,
# which exist only until SUTD publishes AY2026 codes, so a couple more of those
# would silently move a real course to another pillar.
#
# The third field is checked against the scraped description on every run,
# because the reason a code is admitted lives on a page SUTD can rewrite, and an
# allowlist keyed on a number alone would go on importing a course as a term-6
# undergraduate elective long after its page stopped saying so. A course already
# in the catalogue is reported and kept, because a copy-edit must not silently
# drop one; a code admitted here that has never been written is refused.
#
# 99.504's page: "This is a course intended for PhD students and for term 6 or
# term 8 undergraduate students."
OFF_SPACE_ADMIT: dict[str, tuple[str, str, str]] = {
    "99.504": ("SMT", "6", "undergraduate students"),
}

# SUTD re-lists three SMT electives in the PhD catalogue under a 99.5xx code
# with "(Elective)" appended: 99.502 is 01.117 with a different number on it.
# ONLY that exact suffix is stripped before comparing. The repo deliberately
# keeps pairs that share a bare name - 50.007 and 50.570 are both "Machine
# Learning", one undergraduate and one graduate - so a guard matching on the
# bare name would refuse to write half of them.
ELECTIVE_SUFFIX_RE = re.compile(r"(?i)\s*\(elective\)\s*$")

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

    The staleness test that decides whether to sleep lives in `_http` beside
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


def undergrad_urls(
    course_urls: list[str],
) -> tuple[dict[str, str], dict[str, list[str]], list[str], dict[str, list[str]]]:
    """Map dotted code -> URL. When several slugs share a code (03-007 /
    03-007a / 03-007b) prefer the plain, suffix-less slug; the other
    variants are kept so their pillar tags can be unioned in (each
    suffix page carries its own pillar's tags).

    A slug whose prefix is outside VALID_PREFIXES comes back in `off_space`,
    keyed by prefix, rather than being dropped where nobody sees it. Which
    codes SUTD publishes outside the undergraduate space is a decision, and a
    decision the run does not print is one the next maintainer has to
    re-derive from the sitemap by hand - which is how a real course sat
    unlisted with nothing saying so.
    """
    by_code: dict[str, list[tuple[str, str]]] = {}
    off_space: dict[str, list[str]] = {}
    for url in course_urls:
        m = SLUG_CODE_RE.match(slug_of(url))
        if not m:
            continue
        code = f"{m.group(1)}.{m.group(2)}"
        if m.group(1) not in VALID_PREFIXES and code not in OFF_SPACE_ADMIT:
            off_space.setdefault(m.group(1), []).append(url)
            continue
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
    return chosen, extras, dropped, off_space


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


def norm_title(name: str) -> str:
    """A course name reduced to what two listings of it would share."""
    s = name.lower().replace("&", " and ")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s).split())


def repo_names() -> dict[str, str]:
    """normalised name -> the code that already owns it.

    A name several records share is dropped rather than picked between: the
    repo keeps such pairs on purpose - 50.007 and 50.570 are both "Machine
    Learning" - and answering one of them would make the guard's verdict
    depend on the order the glob happened to return.
    """
    seen: dict[str, str] = {}
    clash: set[str] = set()
    for path in sorted(COURSES_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        code, name = data.get("code"), data.get("name")
        if not code or not name:
            continue
        key = norm_title(name)
        if key in seen and seen[key] != code:
            clash.add(key)
        seen.setdefault(key, code)
    for key in clash:
        seen.pop(key, None)
    return seen


def elective_duplicate(title: str, owners: dict[str, str]) -> str | None:
    """The code this "<name> (Elective)" title re-lists, or None.

    Returns None for a title that does not carry the suffix, so a name the repo
    keeps twice on purpose can never trip it.
    """
    stripped = ELECTIVE_SUFFIX_RE.sub("", title)
    if stripped == title:
        return None
    return owners.get(norm_title(stripped))


# Courses whose own page says they belong to a master's programme, with the
# words that say it and the term to file them under. Read off the page and not
# off the number: the 02.5xx block looks like one programme and nine of its
# eleven pages name no audience at all, so they keep the term they publish.
#
# 8 is where every other graduate course in this catalogue already sits, having
# arrived there through the untermed-elective fallback. It is not a claim that
# these are eighth-term undergraduate courses; nothing in the schema can say
# "not an undergraduate term", and inventing a value here would be a second
# reader's problem every time.
GRADUATE_PAGE: dict[str, tuple[str, str]] = {
    # "...providing a strong foundation for the Master's Research Project."
    # The apostrophe on that page is a curly one, so the marker stops short of
    # it: a straight-quote copy would silently stop matching.
    "02.522": ("8", "Research Project"),
    # "The final term is dedicated for students to complete a Masters Research
    # Project."
    "02.563": ("8", "Masters Research Project"),
}


def graduate_term(code: str, description: str) -> str | None:
    """The term for a course whose own page calls it a master's course.

    None when the code is not in the table, and also when it is but the page no
    longer carries the words: the entry is a reading of one sentence, and SUTD
    can rewrite the sentence. The caller reports that rather than guessing.
    """
    pin = GRADUATE_PAGE.get(code)
    if not pin:
        return None
    term, marker = pin
    return term if marker.lower() in description.lower() else None


def stale_admission(code: str, description: str) -> str | None:
    """The words OFF_SPACE_ADMIT was written on, when the page has lost them.

    Case-insensitive because the only thing being asked is whether the sentence
    that admitted this code is still on the page; SUTD capitalises headings and
    sentence starts differently across the catalogue.
    """
    admit = OFF_SPACE_ADMIT.get(code)
    if not admit:
        return None
    marker = admit[2]
    return None if marker.lower() in description.lower() else marker


# Where a course goes when its page publishes no "Term N" tag at all, which is
# most of the elective catalogue. 1 was wrong in a way that showed: it swept
# every elective and technical elective into the freshmore term, so the Term 1
# filter answered with courses no freshmore can take and the plan dropped every
# one of them into T8's first slot by way of term 1.
#
# 8 is the last undergraduate term, which is where an elective with no published
# term actually belongs and where defaultLevel() already clamps.
UNTERMED_ELECTIVE = "8"

# A freshmore subject is the one case where a missing term is not an elective.
# 10.001 Advanced Mathematics I and its four siblings publish no term tag and
# are tagged Freshmore Core instead, and they run in terms 1 to 3.
FRESHMORE_TAG = "Freshmore Core"
FRESHMORE_DEFAULT = "1"


# A page SUTD re-titles against a catalogue that cannot tell a rename from a
# replacement. Over this many in one run, none are written: a redesign that
# changes every h1 would otherwise rewrite the catalogue in a single pull
# request, and a reviewer cannot read 300 re-titles. A real bulk rename is
# merged by raising this deliberately, in a pull request that says why.
RENAME_CAP = 10


def name_change(current: str, scraped: str) -> str | None:
    """The page's title for this course, when it is really a different one.

    Whitespace is normalised on both sides before comparing, because the page
    is read out of HTML where a line break is a space and a run of spaces is
    one space, and neither is a re-title. A page that parsed to nothing, or to
    something too short to be a course name, never wins: an empty h1 is a
    broken parse and this is the field a student searches by.
    """
    a, b = " ".join(current.split()), " ".join(scraped.split())
    if len(b) < 4 or a == b:
        return None
    return b


def term_from_tags(tags: list[str], default: str | None = None) -> str:
    """The term a course page names, or where an untermed one belongs.

    The tag wins whenever there is one. Without it, a Freshmore Core is early
    and everything else is a late elective: those are the only two shapes the
    listing produces, and calling both of them term 1 made the freshmore term
    the dumping ground for the whole elective catalogue.
    """
    for tag in tags:
        m = TERM_TAG_RE.match(tag)
        if m:
            return str(min(max(int(m.group(1)), 1), 10))
    if default is not None:
        return default
    return FRESHMORE_DEFAULT if FRESHMORE_TAG in tags else UNTERMED_ELECTIVE


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
    chosen, extras, dropped_dups, off_space = undergrad_urls(course_urls)
    precedents = prefix_precedents()
    owners = repo_names()

    items = sorted(chosen.items())
    if args.limit:
        items = items[: args.limit]

    skipped_excluded: list[str] = []
    refused_dup: list[str] = []
    admit_stale: list[str] = []
    grad_stale: list[str] = []
    # (path, code, the name in the repo, the name on the page, the page url)
    renames: list[tuple[Path, str, str, str, str]] = []
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

        # Above the merge branch, so it runs for an admitted course that is
        # already in /data. A page is rewritten long after its record is
        # written, and checking only on the way in would mean checking once.
        admit = OFF_SPACE_ADMIT.get(code)
        # Same shape as the admission below: a pin read off a page is re-read
        # against that page every run, because the page is SUTD's to rewrite.
        if code in GRADUATE_PAGE and graduate_term(code, parsed["description"]) is None:
            print(f"[!] {code} is filed as a graduate course because its page "
                  f"said {GRADUATE_PAGE[code][1]!r} and it no longer does",
                  file=sys.stderr)
            grad_stale.append(code)
        stale = stale_admission(code, parsed["description"])
        if stale:
            print(f"[!] {code} is admitted because its page said {stale!r} "
                  f"and it no longer does - check whether it is still an "
                  f"undergraduate course", file=sys.stderr)
            admit_stale.append(code)

        if path.exists():
            before = json.loads(path.read_text(encoding="utf-8")).get("name", "")
            status = merge_existing(path, parsed, args.dry_run)
            (tag_updated if status == "tags-updated" else unchanged).append(code)
            retitle = name_change(before, parsed["name"])
            if retitle:
                renames.append((path, code, before, retitle,
                                parsed.get("sourceUrl") or ""))
            continue

        # A course already in /data keeps its record and its tag updates
        # whatever the page now says. One that has never been written is the
        # opposite case: nothing is dropped by refusing it, and writing it
        # would file a course into the undergraduate catalogue on a sentence
        # that is not on its page any more.
        if stale:
            failed.append(code)
            continue

        # The allowlist wins. It is a person saying "this code is a real course,
        # write it", and the guard below is a pattern match on a title - so if
        # the two ever disagreed, the heuristic would be overruling the decision
        # that exists to overrule it.
        dup = None if admit else elective_duplicate(parsed["name"], owners)
        if dup:
            print(f"[!] {code} {parsed['name']!r} is {dup} re-listed with "
                  f"'(Elective)' appended - not writing a second record",
                  file=sys.stderr)
            refused_dup.append(f"{code}->{dup}")
            continue

        if admit:
            pillar, department = admit[0], PILLAR_DEPARTMENT[admit[0]]
        else:
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
                term=graduate_term(code, parsed["description"])
                or term_from_tags(parsed["tags"],
                                  default=admit[1] if admit else None),
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

    # A re-title is PROPOSED and never merged quietly. The name is written into
    # the record so the pull request carries the before and the after as a diff
    # a person can read, and a reviewer accepts it by merging or takes it back
    # out. The scraper cannot tell SUTD renaming a course from SUTD replacing
    # one, and the name is what a student searches by and what their plan shows,
    # so the decision is the reviewer's rather than this file's.
    applied = len(renames) <= RENAME_CAP
    if renames and applied and not args.dry_run:
        for path, _, _, after, _ in renames:
            data = json.loads(path.read_text(encoding="utf-8"))
            data["name"] = after
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + chr(10),
                            encoding="utf-8")

    print()
    print(f"sitemap /course/ URLs      : {len(course_urls)}")
    print(f"undergrad courses kept     : {len(chosen)}"
          f" ({len(dropped_dups)} duplicate-code slugs dropped: "
          f"{[slug_of(u) for u in dropped_dups]})")
    off_total = sum(len(v) for v in off_space.values())
    print(f"outside the code space     : {off_total} "
          f"{ {p: len(v) for p, v in sorted(off_space.items())} }")
    # The admitted ones do not appear above, because they were not dropped -
    # which is exactly why they are named here. An exception nobody can see in
    # the run output is the same silence this change is about.
    admitted = sorted(c for c in OFF_SPACE_ADMIT if c in chosen)
    print(f"admitted off-space codes   : {len(admitted)} {admitted}")
    if admit_stale:
        print(f"    !! page no longer says why : {admit_stale}")
    if grad_stale:
        print(f"    !! no longer says master's : {grad_stale}")
    for prefix in sorted(off_space):
        print(f"    {prefix}.* : {[slug_of(u) for u in off_space[prefix]]}")
    print(f"processed this run         : {len(items)}")
    print(f"skipped (LKYCIC/NAMIC)     : {len(skipped_excluded)} {skipped_excluded}")
    print(f"refused as (Elective) dup  : {len(refused_dup)} {refused_dup}")
    print(f"new mods written           : {len(new_written)}")
    print(f"existing mods tag-updated  : {len(tag_updated)}")
    if renames:
        over = "" if applied else f" - over the cap of {RENAME_CAP}, none written"
        print(f"re-titled by their page    : {len(renames)}{over}")
        for _, code, before, after, url in renames:
            print(f"    {code} {before!r}")
            print(f"        -> {after!r}  {url}")
    print(f"existing mods unchanged    : {len(unchanged)}")
    print(f"failed to parse            : {len(failed)} {failed}")
    if args.dry_run:
        print("(dry run - nothing written)")
    return 1 if failed else 0


def self_check() -> int:
    """Drive term_from_tags against the tag shapes the listing produces.

    No network. Where an untermed course lands decides which term filter finds
    it, where the plan first puts it, and whether it can have a batch chat, and
    the wrong answer is invisible: a course simply sits in a term nobody
    expects it in.
    """
    # Literal terms on the right, never the constants the function reads: an
    # assertion written against UNTERMED_ELECTIVE moves with it and passes
    # whatever that is set to.
    cases = [
        # (tags, expected term, what it is)
        (["Term 5", "ESD"], "5", "a page that names its term"),
        (["Term 12"], "10", "a term past the tenth is clamped"),
        (["Term 0"], "1", "a term below the first is clamped"),
        (["Freshmore Core", "SMT"], "1",
         "10.001 and its siblings publish no term tag"),
        (["Term 2", "Freshmore Core"], "2", "a tag still wins over the fallback"),
        (["Elective / Technical Elective", "HASS"], "8",
         "the shape most of the elective catalogue has"),
        ([], "8", "no tags at all"),
        (["ASD", "Core"], "8", "a pillar core is not a freshmore core"),
    ]
    fails = []
    for tags, want, why in cases:
        got = term_from_tags(tags)
        if got != want:
            fails.append(f"{why}: tags {tags} gave {got!r}, want {want!r}")
    # The caller can still say where an untermed course goes, which is what
    # keeps this usable from a script that knows better than the default.
    if term_from_tags([], default="3") != "3":
        fails.append("an explicit default is ignored")

    # A re-title, against literal strings rather than a record in /data: a case
    # built from a course file starts passing the day somebody edits that file.
    for before, after, want, why in [
        ("Theory and Dynamics of Urban Social Processes",
         "Urban Theory I: Dynamics of Urban Systems and Social Change",
         "Urban Theory I: Dynamics of Urban Systems and Social Change",
         "a page SUTD re-titled"),
        ("Modelling and Analysis", "Modelling and Analysis", None,
         "the same name is not a change"),
        ("Modelling  and\n Analysis", "Modelling and Analysis", None,
         "HTML whitespace is not a re-title"),
        ("Machine Learning", "", None, "an empty h1 is a broken parse"),
        ("Machine Learning", "ML", None, "and so is a name too short to be one"),
    ]:
        got = name_change(before, after)
        if got != want:
            fails.append(f"{why}: {before!r} -> {after!r} gave {got!r}, want {want!r}")



    # The (Elective) guard, against a fixed table rather than the repo: a check
    # that reads data/courses starts passing the day somebody deletes 01.117.
    owners = {
        "brain inspired computing and its applications": "01.117",
        "machine learning": "50.007",
        "empathy an interdisciplinary concept": "02.165",
    }
    for title, want, why in [
        ("Brain-inspired Computing and its Applications (Elective)", "01.117",
         "the 99.5xx re-listing this guard exists for"),
        ("Science of Sound: Acoustics, Audio & Music (Elective)", None,
         "an (Elective) title whose base name the repo does not own"),
        ("Brain-inspired Computing and its Applications", None,
         "without the suffix it is a different record, not a duplicate"),
        ("Machine Learning", None,
         "50.007 and 50.570 share a name on purpose - a bare name never matches"),
        ("Machine Learning (elective)", "50.007",
         "the suffix is matched whatever its case"),
        ("Empathy: An interdisciplinary concept (Special Topics)", None,
         "only '(Elective)' is stripped, never any parenthetical"),
    ]:
        got = elective_duplicate(title, owners)
        if got != want:
            fails.append(f"{why}: {title!r} gave {got!r}, want {want!r}")

    # The prefix gate and its one admitted exception, off a fixed URL list so it
    # needs no network. Literal codes here, never the constants being tested.
    kept, _, _, off = undergrad_urls([
        "https://www.sutd.edu.sg/course/50-043-database-systems/",
        "https://www.sutd.edu.sg/course/99-504-high-performance-computing-in-science-and-engineering/",
        "https://www.sutd.edu.sg/course/99-580-research-project/",
        "https://www.sutd.edu.sg/course/51-505-foundations-of-cybersecurity/",
    ])
    if "99.504" not in kept:
        fails.append("the admitted off-space code 99.504 is no longer kept")
    if "99.580" in kept or "51.505" in kept:
        fails.append("a graduate code outside the admit list was kept")
    if sorted(off) != ["51", "99"] or len(off.get("99", [])) != 1:
        fails.append(f"off-space report wrong: { {k: len(v) for k, v in off.items()} }")

    # A master's course, read off its page. Literal codes, terms and words
    # here: a case built from GRADUATE_PAGE passes whatever that is set to.
    for code, description, want, why in [
        ("02.563", "The final term is dedicated for students to complete a "
                   "Masters Research Project.", "8",
         "the page that files 02.563 as a graduate course"),
        ("02.563", "The final term is dedicated to independent work.", None,
         "the page dropped the words, so the pin stops answering"),
        ("02.522", "...a strong foundation for the Master's Research Project.",
         "8", "02.522 says what it prepares you for"),
        ("02.501", "Humans have the innate desire to live well.", None,
         "a course nobody pinned keeps its own tag"),
    ]:
        got = graduate_term(code, description)
        if got != want:
            fails.append(f"{why}: {code} gave {got!r}, want {want!r}")

    # The admission's own justification, checked on every run because the page
    # it was read off is SUTD's to rewrite. Literal marker text here: a case
    # that reads OFF_SPACE_ADMIT[code][2] passes whatever that is set to.
    for code, description, want, why in [
        ("99.504",
         "This is a course intended for PhD students and for term 6 or term 8 "
         "undergraduate students.",
         None, "the sentence the admission was written on"),
        ("99.504", "This is a course intended for PhD students.",
         "undergraduate students", "the page dropped the words that admitted it"),
        ("99.504", "Open to UNDERGRADUATE STUDENTS in their final year.",
         None, "the marker is matched whatever its case"),
        ("50.043", "", None, "a code nobody admitted is never stale"),
    ]:
        got = stale_admission(code, description)
        if got != want:
            fails.append(f"{why}: {code} gave {got!r}, want {want!r}")

    # 99.504's page names term 6 and publishes no Term tag. Without the pin it
    # lands in 8, the untermed-elective fallback, which is not what it said.
    # Literals, not the constant: a case that reads OFF_SPACE_ADMIT cannot
    # tell a policy change from a bug, and it crashes rather than failing
    # when the entry is removed.
    if OFF_SPACE_ADMIT.get("99.504") != ("SMT", "6", "undergraduate students"):
        fails.append("99.504 is no longer admitted as SMT term 6")
    if term_from_tags(["Core", "SMT"], default="6") != "6":
        fails.append("the pinned term for an admitted off-space code is ignored")
    # And the pin is a fallback, not an override. It was written because the
    # page publishes no Term tag; the day SUTD publishes one, the page is a
    # better answer than a number typed into this file a year earlier.
    if term_from_tags(["Term 8", "SMT"], default="6") != "8":
        fails.append("a Term tag on an admitted page no longer wins over the pin")

    if fails:
        print(f"self-check: {len(fails)} failure(s)")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("self-check: term_from_tags, the (Elective) guard, the prefix gate "
          "and the admission re-check behave")
    return 0


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        sys.exit(self_check())
    sys.exit(main())
