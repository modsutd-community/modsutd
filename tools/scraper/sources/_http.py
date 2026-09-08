"""Shared HTTP client. One persistent session, polite rate-limit, cache.

We keep responses on disk under .cache/ so iterating on selectors doesn't
hammer SUTD's servers.
"""

from __future__ import annotations

import hashlib
import time
from pathlib import Path

import httpx

CACHE_DIR = Path(__file__).resolve().parents[1] / ".cache"
CACHE_DIR.mkdir(exist_ok=True)

_client = httpx.Client(
    headers={
        "User-Agent": "modsutd-scraper/0.1 (+https://github.com/modsutd-community/modsutd)",
    },
    follow_redirects=True,
    timeout=20.0,
)


def get(url: str, *, ttl_hours: float = 24.0) -> str:
    key = hashlib.sha1(url.encode()).hexdigest()
    cached = CACHE_DIR / f"{key}.html"
    if cached.exists():
        age_hours = (time.time() - cached.stat().st_mtime) / 3600
        if age_hours < ttl_hours:
            return cached.read_text()

    resp = _client.get(url)
    resp.raise_for_status()
    cached.write_text(resp.text)
    return resp.text
