"""Fetch the SUTD hosts the rest of the refresh never touches.

Every other step in mods_refresh.py IS a canary for its own host: `mods` walks
www.sutd.edu.sg's course sitemaps, `hass` reads hass.sutd.edu.sg, `tracks` reads
the four pillar pages, `terms` reads the academic calendar and data.gov.sg. When
one of those goes away the step that needs it fails and says so, and a separate
check saying the same thing a second time is a second thing to keep true.

What is left over is a host this repo DEPENDS on and never fetches. Today that
is exactly one: virtualtour.sutd.edu.sg, whose scene ids sit in venue records
and drive the 360 panel. Nothing else would notice it moving, and a reader would
get an empty panorama with no error anywhere.

Reports only, and never fails the run: a host being down for a minute is not a
reason to lose the catalogue refresh that ran beside it.

    python canaries.py
"""

from __future__ import annotations

import sys

import httpx

# (url, what breaks here if it stops answering). Add a host when something in
# /data starts pointing at it AND no gatherer already fetches it. A host a step
# reads is not a canary, it is that step's own failure.
CANARIES: list[tuple[str, str]] = [
    (
        "https://virtualtour.sutd.edu.sg/",
        "the 360 panel: `panoScenes` in data/venues holds this tour's scene ids",
    ),
]

CLIENT = httpx.Client(
    timeout=20,
    follow_redirects=True,
    headers={"User-Agent": "modsutd-scraper/0.1 (+https://github.com/modsutd-community/modsutd)"},
)


def check(url: str) -> str | None:
    """None when the host answered, else why it did not."""
    try:
        r = CLIENT.get(url)
    except Exception as exc:  # noqa: BLE001 - any transport failure is the finding
        return type(exc).__name__
    return None if r.status_code < 400 else f"HTTP {r.status_code}"


def main() -> int:
    bad: list[str] = []
    for url, breaks in CANARIES:
        why = check(url)
        if why is None:
            print(f"ok   {url}")
            continue
        bad.append(f"**{url}** -> {why}. Breaks {breaks}")
        print(f"DOWN {url} -> {why}", file=sys.stderr)

    if bad:
        print()
        print("These hosts are in /data and nothing else in this run fetches "
              "them, so this is the only place their going away shows up:")
        for line in bad:
            print(f"- {line}")
    # Always 0. A host down for a minute is not a reason to fail a refresh.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
