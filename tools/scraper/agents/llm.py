"""One place that knows how to call a model.

Four providers in a fixed order, and the first one that answers wins. A
provider with no token is skipped rather than failed, so configuring any one of
them is enough.

The first is not a token at all. WEB2API is a local gemini-web2api serving
Gemini's web endpoint, which answers without a credential; a workflow that
starts one sets GEMINI_WEB2API_URL and this uses it ahead of everything else.
Nothing is set locally by default, so a run on a laptop behaves as it did.
That route exists because the free Gemini API tier is 5 requests a minute and
20 a day, which a refresh exhausts before it has read a page. All three speak the OpenAI
chat-completions shape, which is why this needs no SDK: httpx is already a
scraper dependency.

Env: GEMINI_TOKEN / GROQ_TOKEN / OPENAI_TOKEN, and <PROVIDER>_MODEL to override
a model id without a code change, which is what you want the day one of them is
retired. `.env.example` at the repo root says where each token goes.

This file exists because two callers needed the same four things - the provider
table, the token lookup, the fence-tolerant JSON reader, and the try-the-next-one
loop - and a second copy of a provider table is a table that will still name a
retired model after the first one is fixed.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import httpx

# Set by a workflow that started tools/ci/gemini_web2api.py beside this. It is
# a url rather than a flag so a run can point at a proxy on another port, and
# it is absent on a laptop, where the token providers below are what answer.
WEB2API_ENV = "GEMINI_WEB2API_URL"
WEB2API_MODEL = "gemini-3.7-flash"

# In order. The first provider that answers with parseable JSON wins.
PROVIDERS = (
    ("GEMINI", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
     "gemini-3.8-flash"),
    ("GROQ", "https://api.groq.com/openai/v1/chat/completions",
     "openai/gpt-oss-20b"),
    ("OPENAI", "https://api.openai.com/v1/chat/completions",
     "gpt-5.4-mini"),
)

TIMEOUT_S = 60.0

_ROOT = Path(__file__).resolve().parents[3]
_loaded = False


def load_local_env() -> None:
    """Read `.env.local` at the repo root, without overwriting the environment.

    CLAUDE.md makes that file the one env file for the relays and the python
    tools both. CI has no such file and passes secrets as real env vars, so an
    existing value always wins and a run in Actions reads nothing off disk.
    """
    global _loaded
    if _loaded:
        return
    _loaded = True
    path = _ROOT / ".env.local"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


def configured() -> list[tuple[str, str, str]]:
    """(provider, url, model) for every provider that has a token, in order."""
    load_local_env()
    out = []
    web2api = os.environ.get(WEB2API_ENV, "").strip()
    if web2api:
        out.append(("WEB2API", web2api,
                    os.environ.get("WEB2API_MODEL", "").strip() or WEB2API_MODEL))
    for provider, url, model in PROVIDERS:
        if os.environ.get(f"{provider}_TOKEN", "").strip():
            out.append((provider, url, os.environ.get(f"{provider}_MODEL", "").strip() or model))
    return out


def first_json_object(s: str) -> dict[str, Any] | None:
    """The first balanced {...} in a reply.

    Models wrap JSON in prose or a code fence often enough that asking for
    "JSON only" is not a guarantee, and json.loads on the whole reply throws.
    """
    s = re.sub(r"^\s*```(?:json)?|```\s*$", "", (s or "").strip(), flags=re.M)
    depth, start = 0, -1
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


def chat(
    system: str,
    user: str,
    *,
    timeout: float = TIMEOUT_S,
) -> tuple[str, dict[str, Any]] | None:
    """(provider, parsed JSON), or None when every configured provider failed.

    Never raises. A provider that errors, times out or rate-limits hands over to
    the next one, and a caller with no token configured gets None rather than an
    exception it would only have to catch.
    """
    for provider, url, model in configured():
        body = {
            "model": model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
        }
        try:
            # WEB2API has no token and the proxy accepts any bearer, so the
            # header is sent either way rather than branched on: a missing
            # Authorization is a shape some proxies refuse outright.
            token = os.environ.get(f"{provider}_TOKEN", "").strip() or "unused"
            r = httpx.post(
                url,
                json=body,
                timeout=timeout,
                headers={"Authorization": f"Bearer {token}"},
            )
            r.raise_for_status()
            text = r.json()["choices"][0]["message"]["content"]
        except Exception:  # noqa: BLE001
            continue
        parsed = first_json_object(text or "")
        if parsed is not None:
            return provider, parsed
    return None
