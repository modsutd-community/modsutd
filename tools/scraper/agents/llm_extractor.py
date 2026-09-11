"""LLM fallback extractor.

When the deterministic CSS selectors return nothing, because SUTD redesigned a
page, feed the cleaned HTML to a model and let it fill in the Mod fields. The
output is validated against the same pydantic schema the rest of the pipeline
uses, so nothing junk slips through.

Which providers exist, in what order, and how a reply is parsed all live in
`agents/llm.py`. This file is the prompt and the schema check.

The function NEVER raises on a bad page; it returns None and lets the caller
decide whether to skip or fall back to other heuristics.
"""

from __future__ import annotations

import textwrap
from typing import Optional

from bs4 import BeautifulSoup

from schema import Mod

from . import llm

REQUIRED = ("code", "name", "description", "credits", "department", "pillar", "term")
PILLARS = ("Freshmore", "EPD", "ESD", "CSD", "DAI", "ASD", "HASS")

SYSTEM = textwrap.dedent(f"""
    You read a single course page from SUTD's website and return one canonical
    SUTD module record as a JSON object, and nothing else. If the page is not a
    course page, return {{"error": "not a course page"}}.

    Required keys: {", ".join(REQUIRED)}.
    Optional keys: prerequisites, corequisites, both arrays of mod codes.
    code is two digits, a dot, then three digits, e.g. 02.137.
    term is "1" through "10". pillar is one of: {", ".join(PILLARS)}.
    credits is an integer.

    Do not invent a field you cannot find on the page. Omit it instead.
""").strip()


def _clean_html(html: str, max_chars: int = 20_000) -> str:
    """Strip nav/scripts/styles, keep title + body text only."""
    soup = BeautifulSoup(html, "lxml")
    for tag in soup.select("script, style, nav, footer, header, noscript, svg"):
        tag.decompose()
    return soup.get_text("\n", strip=True)[:max_chars]


def extract(html: str, source_url: str) -> Optional[Mod]:
    """Return a validated Mod, or None if every configured provider failed."""
    cleaned = _clean_html(html)
    prompt = f"Source URL: {source_url}" + "\n\n=== PAGE ===\n" + cleaned
    answer = llm.chat(SYSTEM, prompt)
    if answer is None:
        return None
    payload = answer[1]
    if any(k not in payload for k in REQUIRED):
        return None
    try:
        return Mod(**payload)
    except Exception:  # noqa: BLE001
        return None
