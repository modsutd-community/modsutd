#!/usr/bin/env python3
"""Gather the official undergraduate mod listing from sutd.edu.sg.

Walks the Yoast sitemaps, keeps /course/<NN-NNN...> pages, and
merges what it finds into /data/mods/:

* existing mods  -> tags, sourceUrl and term follow the page (term only when
  the page names one), the description is filled ONLY when the repo's is
  empty, and grading/workload are replaced when the page publishes them.
  Schedules, credits and prerequisites are never touched.
* new mods       -> full JSON validated through schema.Mod before writing.

Mods that mention LKYCIC or NAMIC (as standalone tokens - "Dynamics"
must not match "NAMIC") are skipped.

Run with:  python gather_mods.py [--dry-run] [--limit N]
                                    [--delay 0.25] [--ttl-hours 168]
                                    [--review-out PATH] [--rename-cap N]

Raw HTML is cached under .cache/ (shared with sources/_http.py) so
re-runs are cheap and polite.
"""

from __future__ import annotations

import argparse
import json
import os
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
MODS_DIR = REPO_ROOT / "data" / "mods" if (REPO_ROOT / "data" / "mods").exists() else REPO_ROOT / "data" / "courses"

SITEMAPS = [
    "https://www.sutd.edu.sg/course-sitemap.xml",
    "https://www.sutd.edu.sg/course-sitemap2.xml",
]

# Slug starts with an undergrad mod code, e.g. 01-018-... or 02-131dh-...
SLUG_CODE_RE = re.compile(r"^(\d{2})-(\d{3})([a-z]{0,3})(?=-|/|$)")
DOTTED_CODE_RE = re.compile(r"\d{2}\.\d{3}[A-Za-z]?")
# Standalone tokens only: "NAMIC" must NOT match inside "Dynamics",
# "Thermodynamics", "Aerodynamics", ...
EXCLUDE_RE = re.compile(r"(?i)(?<![a-z])(lkycic|namic)(?![a-z])")
HEADING_TAGS = ("h2", "h3", "h4", "h5", "h6")
PREREQ_HEADING_RE = re.compile(r"(?i)^pre-?requisites?\b")
COREQ_HEADING_RE = re.compile(r"(?i)^co-?requisites?\b")
# Some pages (e.g. 60-001) put the intro under an explicit heading.
DESC_HEADING_RE = re.compile(r"(?i)^(?:course|mod) description\b")
CREDITS_RE = re.compile(r"Number of credits:\s*(\d+)")
TERM_TAG_RE = re.compile(r"(?i)^term\s+(\d+)$")

# Fallbacks for code prefixes with no precedent in /data/mods -
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
# /education/undergraduate/courses/ to its last page yields 219 mod links
# carrying exactly these nine prefixes. A sitemap slug outside them is a
# graduate catalogue (51.5xx is MSSD, 99.5xx the SMT PhD programme) or an orphan
# CMS record (41.5xx and 45.2xx: no programme lists them, their page body holds
# no prose at all, and two of them say "Non-credit mod").
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
# would silently move a real mod to another pillar.
#
# The third field is checked against the scraped description on every run,
# because the reason a code is admitted lives on a page SUTD can rewrite, and an
# UNDERGRADUATE_WHITELIST is the exception list and it holds one code: 99.504,
# which SUTD files under SMT as a graduate mod but whose syllabus explicitly
# admits term 6 and term 8 undergraduates.
#
# 99.504's page: "This is a mod intended for PhD students and for term 6 or
# term 8 undergraduate students."
UNDERGRADUATE_WHITELIST: dict[str, tuple[str, str, str]] = {
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
# work, then independent study, in hours per week (defined on the mod
# pages themselves). Published on a minority of pages; where present it
# replaces the hand-estimated placeholder.
WORKLOAD_RE = re.compile(r"(?i)Workload\s*:?\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})")

# Tag texts that name a pillar (a mod can carry several - 03.007A is
# ASD + EPD + SMT via its per-pillar suffix pages).
PILLAR_TAG_NAMES = {"smt", "hass", "istd", "epd", "esd", "asd", "dai"}

def fetch(url: str, *, delay: float, ttl_hours: float) -> str:
    """_http.get with a polite delay whenever the cache will miss.

    The staleness test that decides whether to sleep lives in `_http` beside
    the one that decides whether to fetch. Two copies of it drift, and the
    copy that drifts is the one that sleeps for every cache hit.
    """
    return _http.get(url, ttl_hours=ttl_hours, delay=delay)


def sitemap_mod_urls(*, delay: float, ttl_hours: float) -> list[str]:
    locs: list[str] = []
    for sm in SITEMAPS:
        xml = fetch(sm, delay=delay, ttl_hours=ttl_hours)
        locs.extend(re.findall(r"<loc>(.*?)</loc>", xml))
    return [u for u in locs if "/course/" in u]


def slug_of(url: str) -> str:
    return unquote(url).rstrip("/").rsplit("/course/", 1)[-1]


def undergrad_urls(
    mod_urls: list[str],
) -> tuple[dict[str, str], dict[str, list[str]], list[str], dict[str, list[str]]]:
    """Map dotted code -> URL. When several slugs share a code (03-007 /
    03-007a / 03-007b) prefer the plain, suffix-less slug; the other
    variants are kept so their pillar tags can be unioned in (each
    suffix page carries its own pillar's tags).

    A slug whose prefix is outside VALID_PREFIXES comes back in `off_space`,
    keyed by prefix, rather than being dropped where nobody sees it. Which
    codes SUTD publishes outside the undergraduate space is a decision, and a
    decision the run does not print is one the next maintainer has to
    re-derive from the sitemap by hand - which is how a real mod sat
    unlisted with nothing saying so.
    """
    by_code: dict[str, list[tuple[str, str]]] = {}
    off_space: dict[str, list[str]] = {}
    for url in mod_urls:
        m = SLUG_CODE_RE.match(slug_of(url))
        if not m:
            continue
        code = f"{m.group(1)}.{m.group(2)}"
        if m.group(1) not in VALID_PREFIXES and code not in UNDERGRADUATE_WHITELIST:
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


# The code at the front of an h1, letter suffix included. The suffix has to be
# glued to the digits and end on a word boundary: "02.184DH Minds" loses "DH"
# whole, where a single optional letter took the "D" and left "H Minds", and
# "02.153 A History of Nuclear Strategy" keeps its "A" because a space stands
# between it and the number.
TITLE_CODE_RE = re.compile(r"^\s*\d{2}[.\-]\s?\d{3}(?:[A-Za-z]{1,3}\b)?\s*")

# Some h1s carry the page's breadcrumb inside them, as SUTD's own markup: 02.138
# reads "... Cultures of Appraisal Home / Education / Undergraduate Subjects /".
# Left on, it is proposed as a re-title of a mod nobody renamed.
TITLE_BREADCRUMB_RE = re.compile(r"\s+Home\s*/(?:[^/]*/)*\s*$")


def name_from_title(title: str, slug_suffix: str = "") -> str:
    """slug_suffix only catches a suffix spaced off the code ("02.131 DH");
    a glued one ("02.184DH") is TITLE_CODE_RE's, so both are needed."""
    name = TITLE_BREADCRUMB_RE.sub("", TITLE_CODE_RE.sub("", title))
    if slug_suffix:  # e.g. 02-131dh -> h1 "02.131 DH Non-Fiction ..."
        name = re.sub(rf"(?i)^{re.escape(slug_suffix)}\b[\s:\u2013-]*", "", name)
    return name.strip(" -\u2013:")


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
    name = name_from_title(title, slug_suffix)
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
    """A mod name reduced to what two listings of it would share."""
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
    for path in sorted(MODS_DIR.glob("*.json")):
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


# Mods whose own page says they belong to a master's programme, with the
# words that say it and the term to file them under. Read off the page and not
# off the number: the 02.5xx block looks like one programme and nine of its
# eleven pages name no audience at all, so they keep the term they publish.
#
# 8 is where every other graduate mod in this catalogue already sits, having
# arrived there through the untermed-elective fallback. It is not a claim that
# these are eighth-term undergraduate mods; nothing in the schema can say
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
    """The term for a mod whose own page calls it a master's mod.

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
    """The words UNDERGRADUATE_WHITELIST was written on, when the page has lost them.

    Case-insensitive because the only thing being asked is whether the sentence
    that admitted this code is still on the page; SUTD capitalises headings and
    sentence starts differently across the catalogue.
    """
    admit = UNDERGRADUATE_WHITELIST.get(code)
    if not admit:
        return None
    marker = admit[2]
    return None if marker.lower() in description.lower() else marker


# Where a mod goes when its page publishes no "Term N" tag at all, which is
# most of the elective catalogue. 1 was wrong in a way that showed: it swept
# every elective and technical elective into the freshmore term, so the Term 1
# filter answered with mods no freshmore can take and the plan dropped every
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
# merged by raising it for one run: `--rename-cap N`, or the scrape workflow's
# rename_cap input, after reading the list the capped run put in its pull
# request (--review-out) and finding the titles real.
# 30 because a real term fits under it: SUTD re-titles a term's mods together,
# in the tens. A redesign that changes every h1 is the whole catalogue of 389
# pages, so it still writes nothing.
RENAME_CAP = 30

# What the scrape workflow sets from its rename_cap input. Read as the flag's
# default rather than passed as an argument, so mods_refresh.py does not grow a
# per-step argument channel for one number.
RENAME_CAP_ENV = "MODS_RENAME_CAP"


def rename_batch_ok(count: int, cap: int = RENAME_CAP) -> bool:
    """Whether a run's re-titles are written at all.

    All or none, deliberately: half a redesign applied is worse than none of
    it, because the half that landed looks reviewed.
    """
    return count <= cap


def default_rename_cap(env: dict[str, str]) -> int:
    raw = (env.get(RENAME_CAP_ENV) or "").strip()
    if raw and not raw.isdigit():
        # Loud rather than falling back: a typo in the workflow input that
        # quietly meant the default would cap the run it was typed to uncap.
        raise SystemExit(f"{RENAME_CAP_ENV} must be a whole number, got {raw!r}")
    return int(raw) if raw else RENAME_CAP


def renames_report(renames: list[tuple[str, str, str, str]], written: set[str],
                   cap: int) -> dict:
    """Every re-title found, and whether it landed.

    Built whether or not the batch was written, because the capped run is the one a
    reviewer most needs the list from: it is how they tell a real bulk rename
    from a parser that retitled the catalogue, before raising the cap.
    """
    return {
        "count": len(renames),
        "cap": cap,
        "written": bool(written),
        "renames": [
            {"code": code, "old": old, "new": new, "url": url,
             "written": code in written}
            for code, old, new, url in renames
        ],
    }


def renames_headline(report: dict, dry_run: bool) -> str:
    """The rename verdict, which has to stand alone.

    A reader of a truncated log sees this line or nothing, so it carries the
    count and the verdict together.
    """
    n, cap = report["count"], report["cap"]
    if dry_run:
        verdict = "dry run, none written"
    elif n > cap:
        verdict = f"over the cap of {cap}, NONE written (raise it with --rename-cap)"
    else:
        done = sum(r["written"] for r in report["renames"])
        verdict = f"{done} written, cap {cap}"
    return f"re-titled by their page    : {n} - {verdict}"


def run_tail(report: dict, term_dropped: list[tuple[str, str, str]],
             dry_run: bool) -> list[str]:
    """The end of the run's output, verdict on the very last line.

    mods_refresh.py shows only the last few lines of a step, so whatever a
    reviewer must not miss goes at the bottom, after the list it sums up
    rather than above it: with the headline first, any batch long enough to
    be over the cap pushed its own verdict out of that tail.
    """
    lines: list[str] = []
    for r in report["renames"]:
        lines.append(f"    {r['code']} {r['old']!r}")
        lines.append(f"        -> {r['new']!r}  {r['url']}")
    if term_dropped:
        lines.append("!! page stopped naming a term, filed untermed : "
                     f"{[f'{c} ({old} -> {new})' for c, old, new in term_dropped]}")
    if report["renames"]:
        lines.append(renames_headline(report, dry_run))
    return lines


def review_markdown(report: dict, term_moved: list[tuple[str, str, str]],
                    term_dropped: list[tuple[str, str, str]], dry_run: bool) -> str:
    """What a reviewer of the refresh pull request decides on, as markdown.

    The scrape workflow puts this file in the pull request body itself. The
    run's stdout is truncated there, and a list left on the runner is gone
    with it, so this is the only place the full re-title list and the term
    moves reach the person who merges. Empty when there is nothing to decide,
    so a quiet month adds nothing to the body.
    """
    out: list[str] = []
    if report["renames"]:
        out.append(f"### Re-titles: {renames_headline(report, dry_run).split(': ', 1)[1]}")
        out.append("")
        if report["count"] > report["cap"] and not dry_run:
            out.append("None of these were written. If they are SUTD's own titles, "
                       "dispatch the `scrape` workflow with `rename_cap` at least "
                       f"{report['count']}, then close this pull request: the rerun "
                       "opens a fresh one carrying the same data plus the names.")
            out.append("")
        for r in report["renames"]:
            mark = "" if r["written"] else " (not written)"
            out.append(f"- `{r['code']}` {r['old']} -> **{r['new']}**{mark} {r['url']}")
        out.append("")
    if term_moved or term_dropped:
        out.append("### Terms")
        out.append("")
        for code, old, new in term_moved:
            out.append(f"- `{code}` term {old} -> {new}")
        for code, old, new in term_dropped:
            out.append(f"- `{code}` term {old} -> {new}: its page stopped naming any "
                       "term, so it is filed as untermed, the same as a new record.")
        out.append("")
    return "\n".join(out)


def name_change(current: str, scraped: str) -> str | None:
    """The page's title for this mod, when it is really a different one.

    Whitespace is normalised on both sides before comparing, because the page
    is read out of HTML where a line break is a space and a run of spaces is
    one space, and neither is a re-title. A page that parsed to nothing, or to
    something too short to be a mod name, never wins: an empty h1 is a
    broken parse and this is the field a student searches by.
    """
    a, b = " ".join(current.split()), " ".join(scraped.split())
    if len(b) < 4 or a == b:
        return None
    return b


def term_from_tags(tags: list[str], default: str | None = None) -> str:
    """The term a mod page names, or where an untermed one belongs.

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


def has_term_tag(tags: list[str]) -> bool:
    return any(TERM_TAG_RE.match(t) for t in tags)


def term_tag_dropped(old_tags: list[str], new_tags: list[str]) -> bool:
    """Whether the page stopped naming a term this refresh.

    Keyed on the transition, not on "no tag": most electives have never
    published one and sit at a term a person chose, so naming every untagged
    record each month would bury the one whose page just changed. The run that
    sees the tag go is the one whose pull request a reviewer reads. An empty
    new tag list is a broken parse, not a page that dropped its term.
    """
    return bool(new_tags) and has_term_tag(old_tags) and not has_term_tag(new_tags)


def page_term(code: str, tags: list[str], description: str,
              current: str | None = None) -> str | None:
    """The term this page backs for this code, or None when it names none.

    The one term rule, shared by a new record and an existing one. A master's
    pin read off the page wins, then a Term tag, then an admitted code's pinned
    term, which is a fallback for a page that publishes no tag rather than an
    override of one that does.

    `current` is the record's own term. When the page lists several terms and
    that is one of them, it stands: data-format.md asks a person to pick the
    canonical offering, and 50.007 at 6 under "Term 5, Term 6, Term 8" is the
    page agreeing with that pick, not contradicting it. Only a term the page
    no longer lists moves.

    A pinned master's code answers from its pin or not at all. When the page
    loses the words the pin was read off, falling through to the Term tag
    would refile 02.522 under its programme's term 2, among the sophomores,
    on the strength of a copy-edit; None keeps the record where a person put
    it while the run reports the stale pin.

    None means the page said nothing, and the caller decides what that is
    worth: a new record still needs a term and takes the untermed fallback. An
    existing record keeps the one it has unless this is the run that saw the
    page drop its Term tag (refresh_existing): a term a person chose for a page
    that never published one is not contradicted by the page staying silent.
    """
    if code in GRADUATE_PAGE:
        return graduate_term(code, description)
    admit = UNDERGRADUATE_WHITELIST.get(code)
    if not has_term_tag(tags):
        return admit[1] if admit else None
    listed = {term_from_tags([t]) for t in tags if TERM_TAG_RE.match(t)}
    if current in listed:
        return current
    return term_from_tags(tags)


def prefix_precedents() -> dict[str, tuple[str, str]]:
    """prefix -> (pillar, department) by majority vote over existing files."""
    votes: dict[str, Counter] = {}
    for path in sorted(MODS_DIR.glob("*.json")):
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
    (official beats hand-curated placeholders). `parsed["term"]` replaces the
    record's term when it is set, and it is None for a page that names no
    term, which leaves the record's alone. Schedules, credits and prereqs are
    never touched.
    Returns unchanged|tags-updated.

    Known hazard: SUTD publishes 03.007, 03.007A and 03.007B as three separate
    mods, and a listing page that mentions only the base code must not have
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
    # The app files a mod by `term` - the catalogue filter, the T badge, where
    # the plan first puts it - and `tags` only feeds the track badges. A
    # refresh that moved the tags and left this would show "Term 4" in the tag
    # row of a mod the filter still finds under 7.
    new_term = parsed.get("term")
    term_changed = bool(new_term) and data.get("term") != new_term
    if ((same_tags or not parsed["tags"]) and not fill_desc and not grading_changed
            and not workload_changed and not term_changed):
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
    if term_changed:
        updated["term"] = new_term

    if dry_run:
        return "tags-updated"

    if ("tags" not in data and not fill_desc and not grading_changed
            and not workload_changed and not term_changed):
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


def new_mod(code: str, parsed: dict, pillar: str, department: str) -> Mod:
    """A record for a mod /data has never held, from its parsed page.

    Everything merge_existing would keep in step on a later run is set here
    too, sourceUrl and workload included, so a new file does not wait a month
    for its first refresh to be complete.
    """
    return Mod(
        code=code,
        name=parsed["name"],
        description=parsed["description"],
        credits=parsed["credits"],
        department=department,
        pillar=pillar,
        term=parsed.get("term") or term_from_tags(parsed["tags"]),
        prerequisites=parsed["prerequisites"],
        corequisites=parsed["corequisites"],
        schedules=[],
        grading=parsed.get("grading"),
        workload=parsed.get("workload"),
        tags=parsed["tags"],
        sourceUrl=parsed.get("sourceUrl"),
    )


def refresh_existing(path: Path, code: str, parsed: dict, dry_run: bool) -> dict:
    """One existing record brought in step with its page.

    Its own function so the self-check drives the same wiring main does: the
    term is decided HERE, against the record's current term, and a check that
    hands merge_existing a ready-made parsed["term"] would stay green with
    this step deleted.

    A page that stops naming a term is the page saying the mod no longer runs
    in one, so the record is filed where an untermed one goes (term_from_tags:
    8, or 1 for a Freshmore Core) rather than left at a term nothing backs. The
    app then shows it beside every other untermed elective. Only on the run
    that sees the tag go, and never for a master's pin, whose None means its
    words went stale and the run reports that instead.

    Returns status, the term move (code, old, new) or None, the dropped-term
    move (code, old, new) or None, and the page's re-title or None.
    """
    record = json.loads(path.read_text(encoding="utf-8"))
    before = record.get("name", "")
    old_term = record.get("term", "")
    parsed["term"] = page_term(code, parsed["tags"], parsed["description"],
                               current=old_term)
    moved = dropped = None
    if parsed["term"] and parsed["term"] != old_term:
        moved = (code, old_term, parsed["term"])
    elif (term_tag_dropped(record.get("tags", []), parsed["tags"])
          and code not in GRADUATE_PAGE):
        parsed["term"] = term_from_tags(parsed["tags"])
        if parsed["term"] != old_term:
            dropped = (code, old_term, parsed["term"])
    return {
        "status": merge_existing(path, parsed, dry_run),
        "moved": moved,
        "dropped": dropped,
        "retitle": name_change(before, parsed["name"]),
        "before": before,
    }


def write_new(path: Path, mod: Mod, dry_run: bool) -> None:
    payload = mod.model_dump(exclude_none=True)
    if not dry_run:
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="only first N mods")
    ap.add_argument("--delay", type=float, default=0.25)
    ap.add_argument("--ttl-hours", type=float, default=168.0)
    ap.add_argument("--review-out", default="",
                    help="write the re-titles and term moves a reviewer decides "
                         "on to this markdown file (removed when there are none)")
    ap.add_argument("--rename-cap", type=int,
                    default=default_rename_cap(dict(os.environ)),
                    help=f"write the re-titles only when there are at most "
                         f"this many (default {RENAME_CAP}, or ${RENAME_CAP_ENV})")
    args = ap.parse_args()
    if args.rename_cap < 0:
        ap.error("--rename-cap must be 0 or more")

    mod_urls = sitemap_mod_urls(delay=args.delay, ttl_hours=args.ttl_hours)
    chosen, extras, dropped_dups, off_space = undergrad_urls(mod_urls)
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
    # (code, the term in the repo, the term on the page)
    term_moved: list[tuple[str, str, str]] = []
    # Records whose page carried a Term tag last time and carries none now.
    # Their term is kept, and they are named so a person reads the page.
    term_dropped: list[tuple[str, str, str]] = []
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

        path = MODS_DIR / f"{code.replace('.', '_')}.json"

        # A base code must never be written when the repo has split it. SUTD
        # publishes 03.007, 03.007A and 03.007B as three mods; a listing row
        # or a slug that yields only "03.007" would otherwise land its tags and
        # description on the base file, quietly re-merging a split someone made
        # deliberately. Codes are matched exactly, letter included.
        siblings = sorted(
            q.name for q in MODS_DIR.glob(f"{code.replace('.', '_')}[A-Za-z].json")
        )
        if siblings and not path.exists():
            print(
                f"[!] {code} is split into {', '.join(siblings)} - refusing to recreate "
                f"the base file. Point the listing at the lettered code, or add the base "
                f"mod by hand if SUTD really publishes all of them.",
                file=sys.stderr,
            )
            failed.append(code)
            continue

        # Above the merge branch, so it runs for an admitted mod that is
        # already in /data. A page is rewritten long after its record is
        # written, and checking only on the way in would mean checking once.
        admit = UNDERGRADUATE_WHITELIST.get(code)
        # Same shape as the admission below: a pin read off a page is re-read
        # against that page every run, because the page is SUTD's to rewrite.
        if code in GRADUATE_PAGE and graduate_term(code, parsed["description"]) is None:
            print(f"[!] {code} is filed as a graduate mod because its page "
                  f"said {GRADUATE_PAGE[code][1]!r} and it no longer does",
                  file=sys.stderr)
            grad_stale.append(code)
        stale = stale_admission(code, parsed["description"])
        if stale:
            print(f"[!] {code} is admitted because its page said {stale!r} "
                  f"and it no longer does - check whether it is still an "
                  f"undergraduate mod", file=sys.stderr)
            admit_stale.append(code)

        if path.exists():
            res = refresh_existing(path, code, parsed, args.dry_run)
            (tag_updated if res["status"] == "tags-updated" else unchanged).append(code)
            if res["moved"]:
                term_moved.append(res["moved"])
            if res["dropped"]:
                term_dropped.append(res["dropped"])
            if res["retitle"]:
                renames.append((path, code, res["before"], res["retitle"],
                                parsed.get("sourceUrl") or ""))
            continue

        parsed["term"] = page_term(code, parsed["tags"], parsed["description"])

        # A mod already in /data keeps its record and its tag updates
        # whatever the page now says. One that has never been written is the
        # opposite case: nothing is dropped by refusing it, and writing it
        # would file a mod into the undergraduate catalogue on a sentence
        # that is not on its page any more.
        if stale:
            failed.append(code)
            continue

        # The allowlist wins. It is a person saying "this code is a real mod,
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
            mod = new_mod(code, parsed, pillar, department)
        except Exception as exc:  # noqa: BLE001
            print(f"[!] {code} schema validation failed: {exc}", file=sys.stderr)
            failed.append(code)
            continue
        write_new(path, mod, args.dry_run)
        new_written.append(code)

    # A re-title is PROPOSED and never merged quietly. The name is written into
    # the record so the pull request carries the before and the after as a diff
    # a person can read, and a reviewer accepts it by merging or takes it back
    # out. The scraper cannot tell SUTD renaming a mod from SUTD replacing
    # one, and the name is what a student searches by and what their plan shows,
    # so the decision is the reviewer's rather than this file's.
    applied = rename_batch_ok(len(renames), args.rename_cap)
    renamed: set[str] = set()
    if renames and applied and not args.dry_run:
        for path, code, before, after, _ in renames:
            data = json.loads(path.read_text(encoding="utf-8"))
            # The name is re-read and compared here, not taken on trust from
            # the loop above. merge_existing rewrites the same file in between
            # for tags and description, and a record whose name is no longer
            # the one this proposal was measured against is somebody else's
            # edit: proposing over it would hide a change rather than show one.
            if data.get("name") != before:
                print(f"[!] {path.name} was renamed while this ran, leaving it",
                      file=sys.stderr)
                continue
            data["name"] = after
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + chr(10),
                            encoding="utf-8")
            renamed.add(code)

    report = renames_report([(c, b, a, u) for _, c, b, a, u in renames],
                            renamed, args.rename_cap)
    if args.review_out:
        out = Path(args.review_out)
        review = review_markdown(report, term_moved, term_dropped, args.dry_run)
        if review:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(review, encoding="utf-8")
        else:
            # A file left by an earlier local run would otherwise be pasted
            # into a pull request it says nothing true about.
            out.unlink(missing_ok=True)

    print()
    print(f"sitemap /course/ URLs      : {len(mod_urls)}")
    print(f"undergrad mods kept         : {len(chosen)}"
          f" ({len(dropped_dups)} duplicate-code slugs dropped: "
          f"{[slug_of(u) for u in dropped_dups]})")
    off_total = sum(len(v) for v in off_space.values())
    print(f"outside the code space     : {off_total} "
          f"{ {p: len(v) for p, v in sorted(off_space.items())} }")
    # The admitted ones do not appear above, because they were not dropped -
    # which is exactly why they are named here. An exception nobody can see in
    # the run output is the same silence this change is about.
    admitted = sorted(c for c in UNDERGRADUATE_WHITELIST if c in chosen)
    print(f"undergraduate whitelist codes      : {len(admitted)} {admitted}")
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
    print(f"term moved by its page     : {len(term_moved)}")
    for code, old, new in term_moved:
        print(f"    {code} {old} -> {new}")
    print(f"existing mods unchanged    : {len(unchanged)}")
    print(f"failed to parse            : {len(failed)} {failed}")
    if args.dry_run:
        print("(dry run - nothing written)")
    tail = run_tail(report, term_dropped, args.dry_run)
    if tail:
        print()
        print("\n".join(tail))
    return 1 if failed else 0


def self_check() -> int:
    """Drive term_from_tags against the tag shapes the listing produces.

    No network. Where an untermed mod lands decides which term filter finds
    it, where the plan first puts it, and whether it can have a batch chat, and
    the wrong answer is invisible: a mod simply sits in a term nobody
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
    # The caller can still say where an untermed mod goes, which is what
    # keeps this usable from a script that knows better than the default.
    if term_from_tags([], default="3") != "3":
        fails.append("an explicit default is ignored")

    # A re-title, against literal strings rather than a record in /data: a case
    # built from a mod file starts passing the day somebody edits that file.
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

    # The cap, in literal numbers. A run at the cap writes; one past it writes
    # nothing at all, which is the branch a reader is most likely to undo by
    # "fixing" it to write the first ten.
    for count, want, why in [
        (0, True, "a run with no re-titles"),
        (1, True, "one re-title"),
        (30, True, "a run exactly at the cap"),
        (31, False, "a run past the cap writes none of them"),
        (390, False, "a redesign that re-titles the whole catalogue"),
    ]:
        if rename_batch_ok(count) is not want:
            fails.append(f"{why}: {count} gave {not want}, want {want}")



    # The (Elective) guard, against a fixed table rather than the repo: a check
    # that reads data/mods starts passing the day somebody deletes 01.117.
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

    # A master's mod, read off its page. Literal codes, terms and words
    # here: a case built from GRADUATE_PAGE passes whatever that is set to.
    for code, description, want, why in [
        ("02.563", "The final term is dedicated for students to complete a "
                   "Masters Research Project.", "8",
         "the page that files 02.563 as a graduate mod"),
        ("02.563", "The final term is dedicated to independent work.", None,
         "the page dropped the words, so the pin stops answering"),
        ("02.522", "...a strong foundation for the Master's Research Project.",
         "8", "02.522 says what it prepares you for"),
        ("02.501", "Humans have the innate desire to live well.", None,
         "a mod nobody pinned keeps its own tag"),
    ]:
        got = graduate_term(code, description)
        if got != want:
            fails.append(f"{why}: {code} gave {got!r}, want {want!r}")

    # The admission's own justification, checked on every run because the page
    # it was read off is SUTD's to rewrite. Literal marker text here: a case
    # that reads UNDERGRADUATE_WHITELIST[code][2] passes whatever that is set to.
    for code, description, want, why in [
        ("99.504",
         "This is a mod intended for PhD students and for term 6 or term 8 "
         "undergraduate students.",
         None, "the sentence the admission was written on"),
        ("99.504", "This is a mod intended for PhD students.",
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
    # Literals, not the constant: a case that reads UNDERGRADUATE_WHITELIST cannot
    # tell a policy change from a bug, and it crashes rather than failing
    # when the entry is removed.
    if UNDERGRADUATE_WHITELIST.get("99.504") != ("SMT", "6", "undergraduate students"):
        fails.append("99.504 is no longer admitted as SMT term 6")
    if term_from_tags(["Core", "SMT"], default="6") != "6":
        fails.append("the pinned term for an admitted off-space code is ignored")
    # And the pin is a fallback, not an override. It was written because the
    # page publishes no Term tag; the day SUTD publishes one, the page is a
    # better answer than a number typed into this file a year earlier.
    if term_from_tags(["Term 8", "SMT"], default="6") != "8":
        fails.append("a Term tag on an admitted page no longer wins over the pin")

    # The code off the front of an h1. Real titles from sutd.edu.sg, with the
    # name each one should leave.
    for title, suffix, want, why in [
        ("02.184DH Minds, Machines, and Design", "", "Minds, Machines, and Design",
         "a two-letter HASS suffix glued to the code goes whole"),
        ("03.007A Design Science", "", "Design Science",
         "a one-letter suffix glued to the code"),
        ("02.108dh Narratives of Health", "", "Narratives of Health",
         "a lower-case suffix"),
        ("02.153 A History of Nuclear Strategy", "",
         "A History of Nuclear Strategy",
         "a title starting with a one-letter word keeps it"),
        ("02.131 DH Non-Fiction Writing", "dh", "Non-Fiction Writing",
         "a spaced suffix is taken by the slug, as before"),
        ("40.008 \u2013 Operations Research", "", "Operations Research",
         "a dash between code and name is stripped"),
        ("50.001 Information Systems & Programming", "",
         "Information Systems & Programming", "a plain code"),
        ("02.138 On Genre and Judgement: Cultures of Appraisal Home / Education "
         "/ Undergraduate Subjects /", "",
         "On Genre and Judgement: Cultures of Appraisal",
         "a breadcrumb inside the h1 is not part of the name"),
        ("10.020 Data Driven World", "", "Data Driven World",
         "a title with no breadcrumb is left whole"),
    ]:
        got = name_from_title(title, suffix)
        if got != want:
            fails.append(f"title strip, {why}: {title!r} gave {got!r}, want {want!r}")

    # A new record carries the page it was read from, at the key position the
    # existing records use (straight after tags).
    url = "https://www.sutd.edu.sg/course/02-184dh-minds-machines-and-design/"
    fresh = new_mod("02.184", {
        "name": "Minds, Machines, and Design", "description": "", "credits": 12,
        "prerequisites": [], "corequisites": [], "tags": ["Term 5", "HASS"],
        "sourceUrl": url, "term": "5",
    }, "HASS", "Humanities, Arts and Social Sciences").model_dump(exclude_none=True)
    keys = list(fresh)
    if fresh.get("sourceUrl") != url:
        fails.append("a new record is written without its sourceUrl")
    elif keys.index("sourceUrl") != keys.index("tags") + 1:
        fails.append(f"sourceUrl is not straight after tags in a new record: {keys}")

    # The one term rule, for a new record and an existing one alike. Literal
    # codes, tags and terms.
    for code, tags, description, current, want, why in [
        ("02.208", ["Term 4", "Term 6", "Term 8", "HASS"], "", None, "4",
         "a new record on a page naming several terms takes the first"),
        ("02.208", ["Term 4", "Term 6", "Term 8", "HASS"], "", "7", "4",
         "a record at a term its page no longer lists moves"),
        ("50.007", ["Term 5", "Term 6", "Term 8", "AI Track"], "", "6", "6",
         "a record at one of the terms its page lists stays there"),
        ("02.146", ["Elective / Technical Elective", "HASS"], "", "7", None,
         "a page with no Term tag says nothing about the term"),
        ("02.001", ["Term 1", "Term 3", "Freshmore Core", "HASS"], "", None, "1",
         "a freshmore core keeps term 1"),
        ("10.001", ["Freshmore Core", "SMT"], "", None, None,
         "an untagged freshmore core says nothing either"),
        ("02.563", ["Term 3", "HASS"],
         "students complete a Masters Research Project.", "8", "8",
         "a master's pin beats the Term tag"),
        ("02.522", ["Term 2", "Core"], "a reworded description", "8", None,
         "a pinned master's page that lost its words does not fall to its tag"),
        ("99.504", ["Core", "SMT"], "", None, "6",
         "an admitted code with no tag takes its pinned term"),
        ("99.504", ["Term 8", "SMT"], "", "6", "8",
         "and a tag it starts publishing beats that pin"),
    ]:
        got = page_term(code, tags, description, current=current)
        if got != want:
            fails.append(f"page term, {why}: {code} {tags} at {current!r} "
                         f"gave {got!r}, want {want!r}")

    for old, new, want, why in [
        (["Term 7", "HASS"], ["Elective / Technical Elective", "HASS"], True,
         "the page stopped naming its term"),
        (["Elective / Technical Elective"], ["Elective / Technical Elective"], False,
         "a page that never named one is not news"),
        (["Term 7"], [], False, "an empty parse is not a dropped term"),
        (["Term 7"], ["Term 4"], False, "a moved term is not a dropped one"),
    ]:
        if term_tag_dropped(old, new) is not want:
            fails.append(f"dropped term, {why}: {old} -> {new} gave {not want}")

    # merge_existing on a real file, because the term is only kept in step if
    # that function writes it, and it used to write tags alone.
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        for term_on_page, tags, want, why in [
            ("4", ["Term 4", "Term 6", "Term 8", "HASS"], "4",
             "an existing record's term follows the page"),
            (None, ["Elective / Technical Elective", "HASS"], "7",
             "a page with no term leaves the record's alone"),
        ]:
            p = Path(tmp) / "02_208.json"
            p.write_text(json.dumps({
                "code": "02.208", "name": "X", "description": "d", "term": "7",
                "tags": ["Term 7", "HASS"],
            }), encoding="utf-8")
            merge_existing(p, {"description": "d", "tags": tags, "term": term_on_page,
                               "grading": None, "workload": None}, dry_run=False)
            got = json.loads(p.read_text(encoding="utf-8")).get("term")
            if got != want:
                fails.append(f"merge, {why}: term {got!r}, want {want!r}")
        # Tags already current, so the term is the only thing that differs:
        # the early "unchanged" return must not swallow it.
        p = Path(tmp) / "02_108.json"
        p.write_text(json.dumps({"code": "02.108", "name": "X", "description": "d",
                                 "term": "8", "tags": ["Term 7", "HASS"]}),
                     encoding="utf-8")
        merge_existing(p, {"description": "d", "tags": ["Term 7", "HASS"], "term": "7",
                           "grading": None, "workload": None}, dry_run=False)
        if json.loads(p.read_text(encoding="utf-8")).get("term") != "7":
            fails.append("merge: a term change with unchanged tags is not written")

        # The wiring main uses, with no ready-made term in `parsed`: the term
        # has to be decided inside refresh_existing for these to pass.
        for code, term, tags, want, moved, why in [
            ("02.208", "7", ["Term 4", "Term 6", "Term 8", "HASS"], "4", True,
             "a record whose page dropped its term moves to the page's"),
            ("50.007", "6", ["Term 5", "Term 6", "Term 8", "AI Track"], "6", False,
             "a record at a term its page still lists stays"),
        ]:
            p = Path(tmp) / f"{code.replace('.', '_')}.json"
            p.write_text(json.dumps({"code": code, "name": "X", "description": "d",
                                     "term": term, "tags": ["Term 7"]}),
                         encoding="utf-8")
            res = refresh_existing(p, code, {"name": "X", "description": "d",
                                             "tags": list(tags), "grading": None,
                                             "workload": None}, dry_run=False)
            got = json.loads(p.read_text(encoding="utf-8")).get("term")
            if got != want or bool(res["moved"]) is not moved:
                fails.append(f"refresh, {why}: term {got!r} moved {res['moved']}, "
                             f"want {want!r}")

        # A page that drops its Term tag files the record as untermed, on that
        # run only; a page that never had one leaves a hand-chosen term alone.
        for code, term, old_tags, tags, want, dropped, why in [
            ("02.146", "7", ["Term 7", "HASS"], ["Elective / Technical Elective", "HASS"],
             "8", True, "an elective whose page dropped its term goes to 8"),
            ("10.001", "2", ["Term 2", "Freshmore Core"], ["Freshmore Core", "SMT"],
             "1", True, "a freshmore core whose page dropped its term goes to 1"),
            ("02.153", "5", ["Elective / Technical Elective"],
             ["Elective / Technical Elective", "HASS"],
             "5", False, "a page that never named a term keeps the chosen one"),
            # At 6 rather than its pinned 8, so being refiled would show.
            ("02.522", "6", ["Term 2", "Core"], ["Core", "HASS"],
             "6", False, "a master's pin is never refiled by a dropped tag"),
        ]:
            p = Path(tmp) / f"{code.replace('.', '_')}.json"
            p.write_text(json.dumps({"code": code, "name": "X", "description": "d",
                                     "term": term, "tags": old_tags}),
                         encoding="utf-8")
            res = refresh_existing(p, code, {"name": "X", "description": "d",
                                             "tags": list(tags), "grading": None,
                                             "workload": None}, dry_run=False)
            got = json.loads(p.read_text(encoding="utf-8")).get("term")
            if got != want or bool(res["dropped"]) is not dropped:
                fails.append(f"refresh, {why}: term {got!r} dropped {res['dropped']}, "
                             f"want {want!r}")

    # A new record whose page names no term still gets one, from the fallback.
    untermed = new_mod("10.001", {
        "name": "Advanced Mathematics I", "description": "", "credits": 12,
        "prerequisites": [], "corequisites": [], "tags": ["Freshmore Core", "SMT"],
        "term": None,
    }, "SMT", "Science, Mathematics and Technology")
    if untermed.term != "1":
        fails.append(f"a new untagged freshmore core gets term {untermed.term!r}, want '1'")

    # The verdict has to survive mods_refresh.py's tail of the last 12 lines,
    # on a batch over the cap, which is the run that needs it most.
    eleven = [(f"40.{i:03d}", f"Old {i}", f"New {i}", f"https://x/{i}/")
              for i in range(11)]
    over = renames_report(eleven, set(), cap=10)
    tail = run_tail(over, [("02.146", "7", "8")], dry_run=False)[-12:]
    if "NONE written" not in tail[-1]:
        fails.append(f"the over-cap verdict is not the last line of the run: {tail[-1]!r}")
    if not any("02.146" in ln for ln in tail):
        fails.append("the dropped-term line falls outside the shown tail")
    review = review_markdown(over, [("02.208", "7", "4")], [("02.146", "7", "8")],
                             dry_run=False)
    missing = [c for c, _, _, _ in eleven if f"`{c}`" not in review]
    if missing or "None of these were written" not in review:
        fails.append(f"the review file drops re-titles {missing} or the verdict")
    if "`02.208` term 7 -> 4" not in review or "`02.146` term 7 -> 8" not in review:
        fails.append("the review file drops the term moves")
    if review_markdown(renames_report([], set(), 10), [], [], False):
        fails.append("a quiet run still writes a review file")

    # The cap, overridden for one run, and the list a capped run still hands over.
    if not rename_batch_ok(20, cap=25):
        fails.append("--rename-cap 25 still refuses a batch of 20")
    if rename_batch_ok(31):
        fails.append("the default cap no longer refuses 31")
    if default_rename_cap({}) != 30 or default_rename_cap({"MODS_RENAME_CAP": ""}) != 30:
        fails.append("an unset or empty MODS_RENAME_CAP does not mean the default")
    if default_rename_cap({"MODS_RENAME_CAP": "45"}) != 45:
        fails.append("MODS_RENAME_CAP is not read")
    try:
        default_rename_cap({"MODS_RENAME_CAP": "ten"})
        fails.append("a MODS_RENAME_CAP that is not a number is accepted")
    except SystemExit:
        pass
    found = [("50.001", "Information Systems & Programming",
              "Object-Oriented Software Design: Principles and Practice",
              "https://www.sutd.edu.sg/course/50-001/")]
    capped = renames_report(found, set(), cap=0)
    if capped["written"] or capped["renames"][0]["written"] or capped["count"] != 1:
        fails.append(f"a capped run's report claims a write: {capped}")
    if capped["renames"][0]["new"] != found[0][2]:
        fails.append("the report does not carry the new title")
    head = renames_headline(capped, dry_run=False)
    if not head.startswith("re-titled by their page    : 1 -") or "NONE written" not in head:
        fails.append(f"the capped headline does not say how many and that none landed: {head!r}")
    done = renames_report(found, {"50.001"}, cap=10)
    if not done["written"] or "1 written" not in renames_headline(done, dry_run=False):
        fails.append(f"a written batch does not say so: {done}")

    if fails:
        print(f"self-check: {len(fails)} failure(s)")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("self-check: term_from_tags, page_term, refresh_existing and the term "
          "merge, the title strip, new-record sourceUrl, the (Elective) guard, "
          "the prefix gate, the admission re-check, the rename report, the run "
          "tail and the review file behave")
    return 0


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        sys.exit(self_check())
    sys.exit(main())
