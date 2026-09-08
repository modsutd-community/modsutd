"""LLM fallback extractor.

When the deterministic CSS selectors return nothing, because SUTD redesigned a
page, feed the cleaned HTML to a model and let it fill in the Mod fields. The
output is validated against the same pydantic schema the rest of the pipeline
uses, so nothing junk slips through.

Three providers are tried in a fixed order - Gemini, then Groq, then OpenAI -
and the first one that returns a valid Mod wins. A provider with no token, or
no model, is skipped rather than failed, so configuring one of the three is
enough. All three speak the OpenAI chat-completions shape, which is why this
needs no SDK: httpx is already a scraper dependency.

Env vars: GEMINI_TOKEN, GROQ_TOKEN, OPENAI_TOKEN. The endpoint and the model
are fixed per provider below, so a token is the only thing to configure.
<PROVIDER>_MODEL overrides the model without a code change, which is what you
want the day one of these ids is retired.

The function NEVER raises on a bad page; it returns None and lets the caller
decide whether to skip or fall back to other heuristics.
"""

from __future__ import annotations

import json
import os
import re
import textwrap
from typing import Any, Optional

import httpx
from bs4 import BeautifulSoup

from schema import Mod

# In order. The first provider that answers with a valid Mod wins.
PROVIDERS = (
    ("GEMINI", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
     "gemini-3.8-flash"),
    ("GROQ", "https://api.groq.com/openai/v1/chat/completions",
     "openai/gpt-oss-20b"),
    ("OPENAI", "https://api.openai.com/v1/chat/completions",
     "gpt-5.4-mini"),
)

TIMEOUT_S = 60.0

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


def _first_json_object(s: str) -> Optional[dict[str, Any]]:
    """Pull the first balanced {...} out of a reply.

    Models wrap JSON in prose or a code fence often enough that asking for
    "JSON only" is not a guarantee, and json.loads on the whole reply throws.
    """
    s = re.sub(r"^\s*```(?:json)?|```\s*$", "", s.strip(), flags=re.M)
    depth = 0
    start = -1
    for i, ch in enumerate(s):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    return json.loads(s[start:i + 1])
                except ValueError:
                    return None
    return None


def _ask(provider: str, url: str, model: str, cleaned: str, source_url: str) -> Optional[Mod]:
    token = os.environ.get(f"{provider}_TOKEN")
    if not token:
        return None
    model = os.environ.get(f"{provider}_MODEL") or model

    body = {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Source URL: {source_url}\n\n=== PAGE ===\n{cleaned}"},
        ],
        "response_format": {"type": "json_object"},
    }
    try:
        r = httpx.post(url, json=body, timeout=TIMEOUT_S,
                       headers={"Authorization": f"Bearer {token}"})
        r.raise_for_status()
        text = r.json()["choices"][0]["message"]["content"]
    except Exception:
        # A provider that errors, times out or rate-limits is not fatal: the
        # caller gets the next provider, and the deterministic parse if none.
        return None

    payload = _first_json_object(text or "")
    if not payload or any(k not in payload for k in REQUIRED):
        return None
    try:
        return Mod(**payload)
    except Exception:
        return None


def extract(html: str, source_url: str) -> Optional[Mod]:
    """Return a validated Mod, or None if every configured provider failed."""
    cleaned = _clean_html(html)
    for provider, url, model in PROVIDERS:
        mod = _ask(provider, url, model, cleaned, source_url)
        if mod is not None:
            return mod
    return None


def fallback(deterministic_count: int, expected_min: int = 5) -> bool:
    """Heuristic for whether to try the LLM path.

    Today: trip when the deterministic parser returns suspiciously few mods
    (a SUTD redesign typically zeros it out). Tunable by the caller.
    """
    return deterministic_count < expected_min
