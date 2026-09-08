"""One coordinate per surveyed shape, plus every lift lobby.

Reads live OpenStreetMap by default (see osm_source.py) and falls back to the
local .osm files when a directory is named. Live is the point: the survey was
uploaded, so OSM is the copy that gets corrected, and a generator reading the
upload payload would never see those corrections.

Output is a flat list rather than a map keyed by plate, because a plate is not
a reliable key. Three cover two different rooms each (2.301, 5.101-0, 5.303 -
adjacent spaces sharing a code), and 32 surveyed shapes carry a name and no
plate at all, Campus Centre and both hostel lobbies among them. Matching a
venue to a shape is sync-data.mjs's job; this only records what is on the
ground.

Lifts come out separately. They are nodes, not ways, so a way-only reader loses
all of them - and the lobby letter is how directions on this campus are given.

    python tools/osm/extract_room_coords.py [dir-of-osm-files]
      -> data/_meta/room-coords.json
"""

from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import osm_source  # noqa: E402

# Below this, two entries for one ref are the same room seen twice and differing
# only in float noise. Above it, they are genuinely two rooms.
SAME_ROOM_M = 5.0
DEG_M = 111_000.0


def on_campus(lat: float, lng: float) -> bool:
    """Overpass returns any way that INTERSECTS the bbox, so a road clipping
    the corner arrives whole and its centroid can be half a kilometre away.
    Judge the centroid, not the intersection."""
    south, west, north, east = osm_source.BBOX
    return south <= lat <= north and west <= lng <= east


def centroid(ring):
    lat = sum(p[1] for p in ring) / len(ring)
    lng = sum(p[0] for p in ring) / len(ring)
    return round(lat, 6), round(lng, 6)


def main(where, out: pathlib.Path) -> int:
    elements = osm_source.load(where)

    shapes: list[dict] = []
    lifts: list[dict] = []
    for el in elements:
        t = el["tags"]
        if el.get("point") and t.get("highway") == "elevator" and t.get("name"):
            lng, lat = el["point"]
            item, bucket = {
                "name": t["name"], "lat": lat, "lng": lng,
                "level": t.get("level"), "levelRef": t.get("level:ref"),
            }, lifts
        elif el.get("ring") and len(el["ring"]) >= 4 and (t.get("ref") or t.get("name")):
            lat, lng = centroid(el["ring"])
            if not on_campus(lat, lng):
                continue
            item, bucket = {
                "ref": t.get("ref"), "name": t.get("name"), "lat": lat, "lng": lng,
                "level": t.get("level"), "levelRef": t.get("level:ref"),
            }, shapes
        else:
            continue

        same = next(
            (
                x for x in bucket
                if x.get("ref") == item.get("ref") and x.get("name") == item.get("name")
                and x.get("level") == item.get("level")
                and (abs(x["lat"] - item["lat"]) + abs(x["lng"] - item["lng"])) * DEG_M < SAME_ROOM_M
            ),
            None,
        )
        if same is None:
            bucket.append(item)

    # Never wipe on empty, the same rule scrape.py follows: a thin answer
    # overwriting a good file is worse than no refresh at all.
    if len(shapes) < 200 or len(lifts) < 20:
        print(
            f"refusing to write: {len(shapes)} shapes and {len(lifts)} lifts is too few",
            file=sys.stderr,
        )
        return 1

    shapes.sort(key=lambda s: (s["ref"] or "~", s["name"] or ""))
    lifts.sort(key=lambda l: (l["name"], l["level"] or ""))

    out.write_text(
        json.dumps(
            {
                "_note": (
                    "One coordinate per surveyed shape, the centroid of its way. A flat "
                    "list, not a map: a door plate is not a unique key, and some shapes "
                    "have a name and no plate."
                ),
                "_source": "openstreetmap.org, surveyed on foot 2026-08-22",
                "shapes": shapes,
                "lifts": lifts,
            },
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )

    named = sum(1 for s in shapes if s["name"] and not s["ref"])
    lobbies = sorted({l["name"] for l in lifts})
    print(f"-> {len(shapes)} shapes ({named} named with no plate), {len(lifts)} lift stops")
    print("   lobbies:", ", ".join(lobbies))
    return 0


if __name__ == "__main__":
    arg = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
    root = pathlib.Path(__file__).resolve().parents[2]
    raise SystemExit(main(arg, root / "data/_meta/room-coords.json"))
