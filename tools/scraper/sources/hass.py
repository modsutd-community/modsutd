"""Scrapes the HASS undergraduate subjects pages.

URL shape: https://hass.sutd.edu.sg/education/undergraduate-subjects/<group>/

Each subject has its own detail page, e.g.
https://hass.sutd.edu.sg/education/undergraduate-subjects/freshmore/02001-world-texts-and-interpretations

"""

from __future__ import annotations

import re
from typing import Iterator

from bs4 import BeautifulSoup

from schema import Mod
from . import _http

LIST_URLS = {
    "freshmore": "https://hass.sutd.edu.sg/education/undergraduate-subjects/freshmore/",
    "elective":  "https://hass.sutd.edu.sg/education/undergraduate-subjects/electives/",
}

# 02.001 / 02-001 / 02001 - the canonical form is dotted.
CODE_RE = re.compile(r"\b(0[123])[._-]?(\d{3}[A-Za-z]?)\b")


def _normalise_code(raw: str) -> str | None:
    m = CODE_RE.search(raw)
    return f"{m.group(1)}.{m.group(2)}" if m else None


def _parse_subject_page(html: str, code: str) -> Mod | None:
    soup = BeautifulSoup(html, "lxml")

    title = soup.find("h1")
    name = title.get_text(strip=True) if title else None
    if name and ":" in name:
        name = name.split(":", 1)[1].strip()
    if not name:
        return None

    paragraphs = soup.select("article p, .subject-description p, main p")
    description = next(
        (p.get_text(strip=True) for p in paragraphs if len(p.get_text(strip=True)) > 60),
        "",
    )

    return Mod(
        code=code,
        name=name,
        description=description or "An undergraduate HASS subject offered at SUTD.",
        credits=12,
        department="Humanities, Arts and Social Sciences",
        pillar="HASS",
        term="1",  # placeholder; HASS terms vary by cohort, refine in PR review
    )


def scrape() -> Iterator[Mod]:
    for group, list_url in LIST_URLS.items():
        try:
            html = _http.get(list_url)
        except Exception:
            continue

        soup = BeautifulSoup(html, "lxml")
        for a in soup.select("a"):
            href = a.get("href") or ""
            code = _normalise_code(href)
            if not code:
                continue
            try:
                detail = _http.get(href if href.startswith("http") else f"https://hass.sutd.edu.sg{href}")
            except Exception:
                continue
            mod = _parse_subject_page(detail, code)
            if mod is not None:
                yield mod
