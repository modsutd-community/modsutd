"""Scrapes the four pillar sites: epd / esd / istd / asd.

Each pillar has its own URL and slightly different page layout - that's what
the per-pillar adapters live for. Today they're stubs that return [] when
SUTD's HTML doesn't match the selectors we know.

When SUTD redesigns, this is where you'll fix things.
"""

from __future__ import annotations

from typing import Iterator

from bs4 import BeautifulSoup

from schema import Mod
from . import _http

PILLARS = {
    "epd":  ("EPD",  "Engineering Product Development",   "https://epd.sutd.edu.sg/"),
    "esd":  ("ESD",  "Engineering Systems and Design",    "https://esd.sutd.edu.sg/"),
    "istd": ("CSD",  "Information Systems Tech and Design","https://istd.sutd.edu.sg/"),
    "asd":  ("ASD",  "Architecture and Sustainable Design","https://asd.sutd.edu.sg/"),
}


def scrape(slug: str) -> Iterator[Mod]:
    if slug not in PILLARS:
        return
    pillar, dept, url = PILLARS[slug]

    try:
        html = _http.get(url)
    except Exception:
        return

    soup = BeautifulSoup(html, "lxml")

    # Pillar pages typically have a "subjects" or "curriculum" section that
    # links to per-subject pages. The selector below is a best-effort guess
    # - when SUTD redesigns, narrow it for the new structure.
    for a in soup.select("a[href*='subject'], a[href*='module']"):
        href = a.get("href") or ""
        text = a.get_text(strip=True)
        if not text:
            continue
        # We only yield from real pillar pages where we can extract a code+title.
        # Until the selectors are tightened, we deliberately yield nothing.
        # Fill in this branch when SUTD's pillar pages stabilise.
        _ = href, text, pillar, dept
        return

    # The stub finds nothing today, but this function still has to BE a
    # generator. scrape.py calls list(fn()); a plain function returning None
    # raises "TypeError: 'NoneType' object is not iterable" there, which is
    # counted as a failed source and exits the whole job non-zero.
    yield from ()
