#!/usr/bin/env python3
"""Gather SUTD undergraduate specialisation tracks -> data/specializations.json.

Walks the four pillar specialisation-track pages (ISTD/CSD, DAI, EPD, ESD),
follows per-track subpages, and emits one JSON file the frontend can use to
award plan badges:

    {
      "scrapedAt": "YYYY-MM-DD",
      "tracks": [
        {
          "id": "csd-artificial-intelligence",
          "name": "Artificial Intelligence",
          "pillar": "CSD",
          "url": "https://...",
          "requirements": [ {"count": N, "anyOf": ["50.021", ...], "label": "..."} ],
          "notes": "verbatim caveats that don't fit the structure"
        }, ...
      ]
    }

Semantics: ALL requirement groups must be satisfied. "Choose N from ..." is
{count: N, anyOf: [...]}; "all of these M" is {count: M, anyOf: [those M]}.

Ground rules baked in - keep them:
  * Course codes are ONLY extracted from *visible text* (script/style/svg
    stripped). Raw HTML is full of false \\d\\d.\\d\\d\\d matches from CSS
    calc() values and SVG path data.
  * Never invent a code. DAI lists subject *names* with no codes; names are
    resolved against (a) code+name pairs seen in this run's scraped text and
    (b) the repo's own data/courses/*.json. Exact match after normalisation
    only - unresolved names go into `notes`.
  * EPD publishes requirements only as a PDF / image "Advising Track Matrix"
    (linear text extraction is a column jumble) -> notes-only, with the
    matrix URL preserved.
  * Open-ended clauses ("any ISTD elective", "any 1 Elective offered by
    ESD") cannot be enumerated (the ISTD course list is JS-paginated) and
    are recorded verbatim in `notes`.

Run:  .venv/bin/python gather_specialisations.py [--refresh] [--out PATH]
Cache: tools/scraper/.cache/ (shared with the main scraper, sha1(url).html)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from datetime import date
from pathlib import Path
from urllib.parse import urljoin, urldefrag

import httpx
from bs4 import BeautifulSoup

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
CACHE_DIR = SCRIPT_DIR / ".cache"
COURSES_DIR = REPO_ROOT / "data" / "courses"
DEFAULT_OUT = REPO_ROOT / "data" / "specializations.json"

BASE = "https://www.sutd.edu.sg"
SOURCES = {
    "CSD": f"{BASE}/istd/education/undergraduate/specialisation-tracks/overview/",
    "DAI": f"{BASE}/dai/education/undergraduate/specialisation-tracks/",
    "EPD": f"{BASE}/epd/education/undergraduate/specialisation-tracks/",
    "ESD": f"{BASE}/esd/education/undergraduate/specialisation-tracks/",
}

CODE_RE = re.compile(r"\b\d{2}\.\d{3}[A-Za-z]?\b")
# a line that *starts* with a code followed by a course name
CODE_NAME_LINE_RE = re.compile(r"^(\d{2}\.\d{3}[A-Za-z]?)\s+(\S.*)$")

_client = httpx.Client(
    headers={"User-Agent": "modsutd-scraper/0.1 (+https://github.com/modsutd-community/modsutd)"},
    follow_redirects=True,
    timeout=30.0,
)


# --------------------------------------------------------------------------- fetch

def cached_get(url: str, *, ttl_hours: float = 24.0, refresh: bool = False) -> str:
    CACHE_DIR.mkdir(exist_ok=True)
    key = hashlib.sha1(url.encode()).hexdigest()
    cached = CACHE_DIR / f"{key}.html"
    if not refresh and cached.exists():
        age_hours = (time.time() - cached.stat().st_mtime) / 3600
        if age_hours < ttl_hours:
            return cached.read_text()
    resp = _client.get(url)
    resp.raise_for_status()
    cached.write_text(resp.text)
    return resp.text


# --------------------------------------------------------------------------- html helpers

def soup_main(html: str) -> BeautifulSoup:
    soup = BeautifulSoup(html, "lxml")
    for t in soup(["script", "style", "noscript", "header", "footer", "nav"]):
        t.decompose()
    return soup.find("main") or soup.body or soup


def text_lines(html: str) -> list[str]:
    """Visible text of the page's main content, one entry per rendered line.

    IMPORTANT: all code extraction must go through this - raw HTML contains
    false code-shaped matches (CSS calc(), SVG paths).
    """
    return [ln for ln in soup_main(html).get_text("\n", strip=True).split("\n") if ln]


def page_title(html: str) -> str:
    m = re.search(r'property="og:title" content="([^"]+)"', html)
    if not m:
        m = re.search(r"<title>([^<]+)</title>", html)
    if not m:
        return ""
    title = BeautifulSoup(m.group(1), "lxml").get_text()
    return title.split(" - ")[0].strip()  # "AI - Information Systems ... | SUTD"


def kebab(name: str) -> str:
    s = name.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9.]+", "-", s).strip("-")
    return re.sub(r"\.(?=-|$)", "", s).replace(".", "-") or "track"


def norm_name(s: str) -> str:
    """Normalise a course name for exact-match resolution."""
    s = s.lower().replace("&", " and ")
    s = re.sub(r"\(.*?\)", " ", s)          # drop parentheticals e.g. (for ESD students only)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def group(count: int, any_of: list[str], label: str) -> dict:
    return {"count": count, "anyOf": any_of, "label": label}


# --------------------------------------------------------------------------- name -> code index

def build_name_index(corpus_lines: list[list[str]]) -> dict[str, str]:
    """Map normalised course name -> code.

    Two tiers, in order of trust:
      1. code+name pairs seen in this run's scraped SUTD page text
      2. the repo's data/courses/*.json
    A name that maps to two different codes *within the same tier* is
    ambiguous and dropped from that tier. A lower tier never overrides an
    upper one (e.g. repo file 99.502 "X (Elective)" must not shadow the
    01.117 "X" that SUTD's own pages state).
    """

    def build_tier(pairs) -> dict[str, str]:
        tier: dict[str, str] = {}
        ambiguous: set[str] = set()
        for name, code in pairs:
            key = norm_name(name)
            if not key:
                continue
            if key in tier and tier[key] != code:
                ambiguous.add(key)
                continue
            tier[key] = code
        for key in ambiguous:
            tier.pop(key, None)
        return tier

    scraped_pairs = []
    for lines in corpus_lines:
        for ln in lines:
            m = CODE_NAME_LINE_RE.match(ln)
            if m:
                scraped_pairs.append((m.group(2).rstrip("# ").strip(), m.group(1)))

    repo_pairs = []
    if COURSES_DIR.is_dir():
        for f in sorted(COURSES_DIR.glob("*.json")):
            try:
                d = json.loads(f.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            code, name = d.get("code"), d.get("name")
            if code and name and CODE_RE.fullmatch(code):
                repo_pairs.append((name, code))

    index = build_tier(repo_pairs)
    index.update(build_tier(scraped_pairs))  # scraped text wins
    return index


# --------------------------------------------------------------------------- ISTD / CSD

ISTD_SLUG_RE = re.compile(r"/istd/education/undergraduate/specialisation-tracks/([a-z0-9-]+)/?$")


def istd_track_urls(overview_html: str, overview_url: str) -> list[str]:
    urls: list[str] = []
    for a in soup_main(overview_html).find_all("a", href=True):
        href = urldefrag(urljoin(overview_url, a["href"]))[0].rstrip("/") + "/"
        m = ISTD_SLUG_RE.search(href[:-1])  # match without the trailing slash
        if m and m.group(1) != "overview" and href not in urls:
            urls.append(href)
    return urls


def parse_istd_track(url: str, html: str) -> dict:
    name = page_title(html) or url.rstrip("/").rsplit("/", 1)[-1].replace("-", " ").title()
    lines = text_lines(html)
    requirements: list[dict] = []
    notes: list[str] = []

    def find_line(pred, start=0):
        for i in range(start, len(lines)):
            if pred(lines[i]):
                return i
        return -1

    # -- mandatory ISTD core: "50.001, 50.002, ... are mandatory."
    i_mand = find_line(lambda l: "are mandatory" in l and len(CODE_RE.findall(l)) >= 2)
    if i_mand >= 0:
        codes = CODE_RE.findall(lines[i_mand])
        requirements.append(group(len(codes), codes, "ISTD core (all mandatory)"))

    # -- "2 out of the 3 track core subjects" / "4 track electives"
    core_count = elec_count = None
    for ln in lines:
        m = re.search(r"(\d+)\s+out of (?:the )?(\d+) track core", ln)
        if m:
            core_count = int(m.group(1))
        m = re.search(r"(\d+)\s+track electives", ln)
        if m:
            elec_count = int(m.group(1))

    i_core = find_line(lambda l: l.strip().lower() == "track core courses")
    i_elec = find_line(lambda l: l.strip().lower() == "track electives")
    i_end = find_line(lambda l: l.startswith(("Core courses are not recognised",
                                              "A student who intends")),
                      start=max(i_elec, 0))
    if i_end < 0:
        i_end = len(lines)

    def collect(codes_from: int, codes_to: int) -> list[str]:
        seen: list[str] = []
        for ln in lines[codes_from:codes_to]:
            for c in CODE_RE.findall(ln):
                if c not in seen:
                    seen.append(c)
        return seen

    if i_core >= 0 and i_elec > i_core:
        core_codes = collect(i_core + 1, i_elec)
        # OR-pairs inside the core list: "50.007 ... / or / 40.319 ..."
        for j in range(i_core + 1, i_elec):
            if re.fullmatch(r"or|OR|Or", lines[j].strip().strip(".")):
                prev = CODE_RE.findall(" ".join(lines[i_core + 1:j]))
                nxt = CODE_RE.findall(" ".join(lines[j + 1:i_elec]))
                if prev and nxt:
                    notes.append(
                        f"Track cores {prev[-1]} and {nxt[0]} are alternatives - "
                        "only one of the pair counts toward the core requirement."
                    )
        if core_codes and core_count:
            requirements.append(group(core_count, core_codes,
                                      f"track core courses (choose {core_count})"))
        elif core_codes:
            requirements.append(group(len(core_codes), core_codes, "track core courses"))

    if i_elec >= 0:
        elec_codes = collect(i_elec + 1, i_end)
        if elec_codes and elec_count and elec_count <= len(elec_codes):
            requirements.append(group(elec_count, elec_codes,
                                      f"track electives (choose {elec_count})"))
        elif elec_codes and elec_count:
            # fewer named electives than the required count - the real pool is
            # the open-ended "any ISTD elective" list, so a {count, anyOf}
            # group would be unsatisfiable. Record what we know in notes.
            notes.append(
                f"{elec_count} track electives required, but only "
                f"{len(elec_codes)} are named on the page "
                f"({', '.join(elec_codes)}) - the remaining pool is open-ended."
            )
        if any("Any ISTD electives listed" in ln for ln in lines[i_elec:i_end + 2]):
            notes.append(
                "Any ISTD elective also counts as a track elective (open-ended list, "
                f"see {BASE}/istd/education/undergraduate/courses/ - not enumerated here)."
            )

    for ln in lines:
        if ln.startswith("Core courses are not recognised"):
            notes.append(ln)
            break

    if not requirements:  # e.g. Custom Track - no fixed course list
        for marker in ("A custom track must consist of",
                       "list of 2 track core subjects and 4 track electives"):
            for ln in lines:
                if marker in ln:
                    notes.append(ln)
                    break
        notes.append("No fixed course list - requirements are proposed by the student "
                     "and approved by the ISTD undergraduate committee.")

    return {
        "id": f"csd-{kebab(name)}",
        "name": name,
        "pillar": "CSD",
        "url": url,
        "requirements": requirements,
        "notes": "\n".join(dict.fromkeys(notes)),
    }


# --------------------------------------------------------------------------- ESD

ESD_SLUG_RE = re.compile(r"/esd/education/undergraduate/specialisation-tracks/([a-z0-9-]+)")


def esd_track_urls(overview_html: str, overview_url: str) -> list[str]:
    urls: list[str] = []
    for a in soup_main(overview_html).find_all("a", href=True):
        href = urldefrag(urljoin(overview_url, a["href"]))[0].rstrip("/") + "/"
        m = ESD_SLUG_RE.search(href)
        if m and m.group(1) not in ("overview",) and href not in urls:
            if href.rstrip("/") != overview_url.rstrip("/"):
                urls.append(href)
    return urls


ESD_STOP = ("For more information", "Awards", "What's next", "Explore our resources")


def parse_esd_track(url: str, html: str) -> dict:
    name = page_title(html) or url.rstrip("/").rsplit("/", 1)[-1].replace("-", " ").title()
    lines = text_lines(html)
    requirements: list[dict] = []
    notes: list[str] = []

    try:
        i_req = next(i for i, l in enumerate(lines) if l.strip().lower() == "required courses")
    except StopIteration:
        i_req = -1

    if i_req >= 0:
        codes: list[str] = []
        for ln in lines[i_req + 1:]:
            if ln.startswith(ESD_STOP):
                break
            found = CODE_RE.findall(ln)
            if found:
                codes.extend(c for c in found if c not in codes)
                if "(for ESD students only)" in ln:
                    notes.append(ln)
            elif re.search(r"select any \d+ elective", ln, re.I):
                notes.append(ln)
            elif ln.startswith("#") or "half term" in ln.lower():
                half = [c for c in codes if any(
                    c in l2 and l2.rstrip().endswith("#") for l2 in lines[i_req + 1:])]
                notes.append(f"{ln} - applies to: {', '.join(half)}" if half else ln)
            elif re.search(r"need to take \d+ courses", ln, re.I):
                notes.append(ln)
        if codes:
            requirements.append(group(len(codes), codes, "required courses (all)"))

    if not requirements:
        notes.append("No machine-readable course list found on the page.")

    return {
        "id": f"esd-{kebab(name)}",
        "name": name,
        "pillar": "ESD",
        "url": url,
        "requirements": requirements,
        "notes": "\n".join(dict.fromkeys(notes)),
    }


# --------------------------------------------------------------------------- EPD

EPD_SLUG_RE = re.compile(r"/epd/education/undergraduate/specialisation-tracks/([a-z0-9-]+)")


def epd_track_urls(overview_html: str) -> list[str]:
    # The track dropdown is JS-rendered - slugs only exist in raw HTML/JS,
    # not as <a> tags. Regex over the raw document is deliberate here.
    slugs: list[str] = []
    for m in EPD_SLUG_RE.finditer(overview_html):
        s = m.group(1)
        if s not in slugs:
            slugs.append(s)
    return [f"{BASE}/epd/education/undergraduate/specialisation-tracks/{s}/" for s in slugs]


def parse_epd_track(url: str, html: str) -> dict:
    name = page_title(html) or url.rstrip("/").rsplit("/", 1)[-1].replace("-", " ").title()
    lines = text_lines(html)
    requirements: list[dict] = []
    notes: list[str] = []

    # EPD pages carry no course codes in text; requirements live in the
    # "Advising Track Matrix" PDF / images, which are not machine-readable
    # (linear PDF text extraction scrambles the matrix columns).
    codes: list[str] = []
    for ln in lines:
        for c in CODE_RE.findall(ln):
            if c not in codes:
                codes.append(c)
    if codes:
        # Future-proofing: if EPD ever publishes codes in text, surface them
        # but keep them notes-only until a human confirms the intended shape.
        notes.append("Course codes found on page (structure unverified): " + ", ".join(codes))

    pdf_url = None
    for a in soup_main(html).find_all("a", href=True):
        if a["href"].lower().endswith(".pdf") and "matrix" in a.get_text(" ", strip=True).lower():
            pdf_url = urljoin(url, a["href"])
            break
    notes.append(
        "Requirements are published only in the EPD Advising Track Matrix "
        "(PDF/image, not machine-readable)" + (f": {pdf_url}" if pdf_url else ".")
    )

    for i, ln in enumerate(lines):
        if ln.strip() == "Track Lead:" and i + 1 < len(lines):
            notes.append(f"Track Lead: {lines[i + 1]}")
            break

    return {
        "id": f"epd-{kebab(name)}",
        "name": name,
        "pillar": "EPD",
        "url": url,
        "requirements": requirements,
        "notes": "\n".join(dict.fromkeys(notes)),
    }


# --------------------------------------------------------------------------- DAI

def parse_dai(url: str, html: str, name_index: dict[str, str]) -> list[dict]:
    main = soup_main(html)
    lines = text_lines(html)

    # how many electives make a track: "... composed of 2 elective courses ..."
    count = 2
    for ln in lines:
        m = re.search(r"composed of (\d+|two|three) elective courses", ln, re.I)
        if m:
            count = {"two": 2, "three": 3}.get(m.group(1).lower()) or int(m.group(1))
            break

    page_notes: list[str] = []
    for ln in lines:
        if "no longer offered from AY2026" in ln:
            page_notes.append(ln.lstrip("*").strip())
        if "track-related internship" in ln:
            page_notes.append("Students are also required to fulfill a track-related internship.")

    tracks: list[dict] = []
    heading_re = re.compile(r"^\d+\.\s+(.+)$")
    for el in main.find_all(["h3", "h4", "h5"]):
        m = heading_re.match(el.get_text(" ", strip=True))
        if not m:
            continue
        name = m.group(1).strip()
        marker = el.find_next(string=re.compile(r"Subjects include", re.I))
        if not marker:
            continue
        ul = marker.find_parent().find_next("ul")
        if not ul:
            continue
        subjects = [li.get_text(" ", strip=True) for li in ul.find_all("li")]

        resolved: list[str] = []
        unresolved: list[str] = []
        for s in subjects:
            code = name_index.get(norm_name(s))
            (resolved.append(code) if code else unresolved.append(s))

        notes = [f"Track consists of {count} elective courses from the subject list."]
        notes += page_notes
        if unresolved:
            notes.append(
                "Subjects with no resolvable course code (count toward the track but "
                "are not machine-checkable): " + "; ".join(unresolved)
            )

        requirements = [group(count, resolved, f"track electives (choose {count})")] if resolved else []
        tracks.append({
            "id": f"dai-{kebab(name)}",
            "name": name,
            "pillar": "DAI",
            "url": url,
            "requirements": requirements,
            "notes": "\n".join(dict.fromkeys(notes)),
        })
    return tracks


# --------------------------------------------------------------------------- main

def validate(tracks: list[dict]) -> list[str]:
    problems = []
    for t in tracks:
        for k in ("id", "name", "pillar", "url", "requirements", "notes"):
            if k not in t:
                problems.append(f"{t.get('id', '?')}: missing key {k}")
        for g in t["requirements"]:
            if not (isinstance(g["count"], int) and 1 <= g["count"] <= len(g["anyOf"])):
                problems.append(f"{t['id']}: bad count {g['count']} for {len(g['anyOf'])} options")
            for c in g["anyOf"]:
                if not CODE_RE.fullmatch(c):
                    problems.append(f"{t['id']}: bad course code {c!r}")
    ids = [t["id"] for t in tracks]
    for dup in {i for i in ids if ids.count(i) > 1}:
        problems.append(f"duplicate id: {dup}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--refresh", action="store_true", help="bypass the on-disk cache")
    ap.add_argument("--ttl-hours", type=float, default=24.0)
    args = ap.parse_args()

    def fetch(url: str) -> str:
        print(f"  fetch {url}")
        return cached_get(url, ttl_hours=args.ttl_hours, refresh=args.refresh)

    tracks: list[dict] = []
    corpus: list[list[str]] = []

    print("[CSD] ISTD specialisation tracks")
    istd_overview = fetch(SOURCES["CSD"])
    corpus.append(text_lines(istd_overview))
    for url in istd_track_urls(istd_overview, SOURCES["CSD"]):
        html = fetch(url)
        corpus.append(text_lines(html))
        tracks.append(parse_istd_track(url, html))

    print("[ESD] specialisation tracks")
    esd_overview = fetch(SOURCES["ESD"])
    corpus.append(text_lines(esd_overview))
    for url in esd_track_urls(esd_overview, SOURCES["ESD"]):
        html = fetch(url)
        corpus.append(text_lines(html))
        tracks.append(parse_esd_track(url, html))

    print("[EPD] specialisation tracks")
    epd_overview = fetch(SOURCES["EPD"])
    for url in epd_track_urls(epd_overview):
        html = fetch(url)
        corpus.append(text_lines(html))
        tracks.append(parse_epd_track(url, html))

    print("[DAI] specialisation tracks")
    dai_html = fetch(SOURCES["DAI"])
    corpus.append(text_lines(dai_html))
    name_index = build_name_index(corpus)
    tracks.extend(parse_dai(SOURCES["DAI"], dai_html, name_index))

    # EPD publishes its criteria only as the Advising Track Matrix (PDF) -
    # not parseable from HTML. epd_matrix_overlay.json carries the
    # hand-extracted, name-verified requirements (with provenance); merge it
    # so re-runs never regress EPD to notes-only. If EPD ever publishes a
    # NEWER matrix (different URL), the overlay must be re-extracted - the
    # gather-specialisations skill documents the procedure.
    overlay_path = Path(__file__).resolve().parent / "epd_matrix_overlay.json"
    if overlay_path.exists():
        overlay = json.loads(overlay_path.read_text())
        merged = 0
        for t in tracks:
            o = overlay.get("tracks", {}).get(t["id"])
            if not o:
                continue
            t["requirements"] = o["requirements"]
            extra = o.get("notes", "")
            prov = overlay.get("_provenance", {})
            t["notes"] = " ".join(
                s for s in [
                    extra,
                    f"Requirements hand-extracted from the EPD Advising Track Matrix ({prov.get('source', 'PDF')}); {prov.get('caveat', '')}",
                ] if s
            ).strip()
            merged += 1
        print(f"[EPD] merged matrix overlay into {merged} tracks")

    pillar_order = {"CSD": 0, "DAI": 1, "EPD": 2, "ESD": 3}
    tracks.sort(key=lambda t: (pillar_order.get(t["pillar"], 9), t["name"]))

    problems = validate(tracks)
    if problems:
        print("VALIDATION PROBLEMS:")
        for p in problems:
            print("  !", p)
        return 1

    out = {"scrapedAt": date.today().isoformat(), "tracks": tracks}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    json.loads(args.out.read_text())  # paranoia: confirm it round-trips

    # ------------------------------------------------------------------ summary
    print(f"\nWrote {args.out}  ({len(tracks)} tracks)")
    print(f"{'pillar':<8}{'tracks':<8}structured  notes-only")
    for pillar in ("CSD", "DAI", "EPD", "ESD"):
        sub = [t for t in tracks if t["pillar"] == pillar]
        structured = [t for t in sub if t["requirements"]]
        print(f"{pillar:<8}{len(sub):<8}{len(structured):<12}{len(sub) - len(structured)}")
    structured = [t for t in tracks if t["requirements"]]
    print(f"{'TOTAL':<8}{len(tracks):<8}{len(structured):<12}{len(tracks) - len(structured)}")
    caveats = [t["id"] for t in tracks
               if t["requirements"] and ("open-ended" in t["notes"]
                                         or "not machine-checkable" in t["notes"]
                                         or "elective offered by" in t["notes"].lower())]
    if caveats:
        print("structured but with open-ended/unresolved caveats in notes: "
              + ", ".join(caveats))
    return 0


if __name__ == "__main__":
    sys.exit(main())
