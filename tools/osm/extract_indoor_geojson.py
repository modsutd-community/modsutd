"""The indoor layer the site draws itself, as one GeoJSON file.

Reads live OpenStreetMap by default (see osm_source.py); name a directory of
.osm files to read the upload snapshot instead.

Why not query OSM from the browser: OpenLevelUp does exactly that, and comes
back blank whenever Overpass is unavailable. A room panel whose whole job is
"where is this" cannot depend on a third party being up. So the map ships as a
file, and this is the command that refreshes it.

    python tools/osm/extract_indoor_geojson.py [dir-of-osm-files]
      -> data/indoor.geojson

Coordinates are rounded to 6 decimals, about 11 cm, finer than a walked survey
and half the size of full precision.
"""

from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import osm_source  # noqa: E402

# What a person needs to read a floor: the rooms, the corridor between them,
# and the lifts. Stairs come through as room=* and are worth keeping - they are
# how you get to the floor in the first place.
#
# Plus anything else carrying a `level`. If it was drawn on a floor it belongs
# on that floor's plan, whether or not it is a room and whether or not it has a
# plate: the Open Plaza is neither and is still part of level 2.
KEEP = {"room", "corridor", "area"}
KEPT_TAGS = ("ref", "name", "level", "level:ref", "indoor", "room")

# The survey put a few hundred shapes on the map. Far below that and something
# is wrong with the query or the mirror, not with the campus.
MIN_SHAPES = 200


def main(where, out: pathlib.Path) -> int:
    elements = osm_source.load(where)
    seen: dict[tuple, dict] = {}

    for el in elements:
        t = el["tags"]
        if el.get("point"):
            if t.get("highway") != "elevator":
                continue
            # A lift with no name is still a lift. Three on this campus have
            # none, and dropping them left a floor plan with a way up that the
            # map knew about and the reader did not.
            feat = {
                "type": "Feature",
                "properties": {
                    "kind": "lift",
                    **{k: t[k] for k in ("name", "level", "level:ref") if k in t},
                },
                "geometry": {"type": "Point", "coordinates": list(el["point"])},
            }
            seen.setdefault(("lift", t.get("name"), t.get("level"), tuple(el["point"])), feat)
            continue

        ring = el.get("ring") or []
        if t.get("indoor") not in KEEP and "room" not in t and "level" not in t:
            continue
        if len(ring) < 4:
            continue
        # Overpass returns any way that intersects the bbox, so a road clipping
        # the corner arrives whole. Judge it by where its middle is.
        south, west, north, east = osm_source.BBOX
        mid_lat = sum(p[1] for p in ring) / len(ring)
        mid_lng = sum(p[0] for p in ring) / len(ring)
        if not (south <= mid_lat <= north and west <= mid_lng <= east):
            continue
        if ring[0] != ring[-1]:
            ring = [*ring, ring[0]]
        feat = {
            "type": "Feature",
            "properties": {k: t[k] for k in KEPT_TAGS if k in t},
            "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in ring]]},
        }
        seen.setdefault((t.get("ref"), t.get("name"), t.get("level"), tuple(ring[0])), feat)

    feats = sorted(
        seen.values(),
        key=lambda f: (f["properties"].get("level") or "", f["properties"].get("ref") or ""),
    )
    # Never wipe on empty, the rule scrape.py already follows: a thin answer
    # overwriting a good file is worse than no refresh at all.
    if len(feats) < MIN_SHAPES:
        print(f"refusing to write: only {len(feats)} shapes", file=sys.stderr)
        return 1

    out.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "_source": "openstreetmap.org, surveyed on foot 2026-08-22",
                "features": feats,
            },
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )

    levels: dict[str, int] = {}
    for f in feats:
        lv = f["properties"].get("level", "?")
        levels[lv] = levels.get(lv, 0) + 1
    lifts = sum(1 for f in feats if f["properties"].get("kind") == "lift")
    print(f"-> {len(feats)} shapes ({lifts} lifts), {out.stat().st_size // 1024} KB")
    print("   per level:", dict(sorted(
        levels.items(), key=lambda kv: int(kv[0]) if kv[0].lstrip('-').isdigit() else 99)))
    return 0


if __name__ == "__main__":
    arg = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
    root = pathlib.Path(__file__).resolve().parents[2]
    raise SystemExit(main(arg, root / "data/indoor.geojson"))
