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
    timeout=10,
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

    # All of them, not a sample. One scene answering proves the host and the
    # path shape, but a tour is free to retire a single room, and a sample would
    # leave the 360 panel broken for that one with nothing said. It is one
    # request per scene, in a run that walks 389 course pages.
    bad: list[str] = []
    for scene in scenes:
        url = FACE_URL.format(scene=scene)
        why = check(url)
        if why is None:
            continue
        bad.append(f"`{scene}` -> {why}")
        print(f"DOWN {url} -> {why}", file=sys.stderr)

    print(f"{len(scenes) - len(bad)}/{len(scenes)} panorama tiles still served")
    if bad:
        print()
        print(f"The virtual tour is not serving {len(bad)} of the "
              f"{len(scenes)} tiles `panoScenes` names, so the 360 panel draws "
              f"nothing for those rooms. Nothing else in this run fetches that "
              f"host, so this is the only place it shows up:")
        for line in bad:
            print(f"- {line}")
    # Always 0. A host down for a minute is not a reason to fail a refresh.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
