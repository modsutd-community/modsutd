"""Shared HTTP client. One persistent session, polite rate-limit, cache.

We keep responses on disk under .cache/ so iterating on selectors doesn't
hammer SUTD's servers.
"""

from __future__ import annotations

import hashlib
import os
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


_last_network_fetch = 0.0


def get(url: str, *, ttl_hours: float = 24.0, delay: float = 0.0) -> str:
    """The page, from disk if it is younger than `ttl_hours`.

    `delay` is the minimum gap between two requests that actually leave the
    machine. It has to be measured here rather than per call site, because a
    cache hit costs SUTD nothing and sleeping between them would turn a
    warm 389-page pass into six minutes of waiting for no reason.
    """
    global _last_network_fetch
    key = hashlib.sha1(url.encode()).hexdigest()
    cached = CACHE_DIR / f"{key}.html"
    # An empty file is a miss, not a hit. A mirror can answer 200 with nothing,
    # and caching that turns one bad minute into every run for the next three
    # days reporting the page as unparseable - which is what 01.102 did.
    if cached.exists() and cached.stat().st_size > 0:
        age_hours = (time.time() - cached.stat().st_mtime) / 3600
        if age_hours < ttl_hours:
            try:
                return cached.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                # Written before the cache was explicitly utf-8, on a machine
                # whose default was cp1252. Re-fetch rather than guess.
                pass

    if delay:
        wait = _last_network_fetch + delay - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_network_fetch = time.time()

    resp = _client.get(url)
    resp.raise_for_status()
    if resp.text:
        # Written to a temp file and renamed, because mods_refresh.py runs
        # several of these at once and they share this directory. A plain
        # write_text is not atomic: a reader can catch a half-written file, and
        # a truncated cache entry then poisons every run until its TTL expires.
        # os.replace is atomic on the same filesystem, on Windows too.
        tmp = cached.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(resp.text, encoding="utf-8")
        os.replace(tmp, cached)
    return resp.text
