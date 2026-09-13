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

It asks for a TILE rather than the homepage, using a scene id out of
data/venues, because the failure worth catching is the tour reorganising while
its front page still answers 200.

Reports only, and never fails the run: a host being down for a minute is not a
reason to lose the catalogue refresh that ran beside it.

    python canaries.py
"""

from __future__ import annotations

import json
import pathlib
import sys

import httpx

VENUES = pathlib.Path(__file__).resolve().parents[2] / "data" / "venues"

# The exact URL Pano.tsx builds, so this asks the question the app asks. A tour
# whose shell still answers 200 while the tiles have moved is the failure this
# has to catch, and the homepage cannot see it.
FACE_URL = "https://virtualtour.sutd.edu.sg/panos/{scene}.tiles/pano_f.jpg"


def pano_scenes() -> list[str]:
    """Every scene id in data/venues, so the probe uses real ones."""
    out: list[str] = []
    for f in sorted(VENUES.glob("*.json")):
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - a bad venue file is sync-data's finding
            continue
        for entry in rec.get("panoScenes") or []:
            scene = str(entry.get("scene") or "")
            if scene and scene not in out:
                out.append(scene)
    return out

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
    scenes = pano_scenes()
    if not scenes:
        print("no panoScenes in data/venues - nothing to probe")
        return 0

    # Two, not all of them. One scene answering proves the host, the path shape
    # and the tile naming are all still what Pano.tsx assumes, and a second
    # catches the case where one scene was retired rather than the tour moving.
    # Probing every scene would be 32 requests to say the same thing.
    bad: list[str] = []
    for scene in scenes[:2]:
        url = FACE_URL.format(scene=scene)
        why = check(url)
        if why is None:
            print(f"ok   {url}")
            continue
        bad.append(f"`{scene}` -> {why}")
        print(f"DOWN {url} -> {why}", file=sys.stderr)

    if bad:
        print()
        print(f"The virtual tour is not serving the tiles `panoScenes` names, "
              f"so the 360 panel draws nothing for the "
              f"{len(scenes)} scene(s) in data/venues. Nothing else in this run "
              f"fetches that host, so this is the only place it shows up:")
        for line in bad:
            print(f"- {line}")
    # Always 0. A host down for a minute is not a reason to fail a refresh.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
