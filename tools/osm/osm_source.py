"""Where the survey is read from: OpenStreetMap itself, or the local files.

The .osm files on disk were the upload payload. They are a snapshot of what was
sent, with placeholder negative ids, and they stop being the truth the moment
anybody edits the map - including us. Reading them means a correction made in
OSM never reaches the site, which is the wrong way round for data we have
deliberately given away.

So Overpass is the default source and the files are the fallback. Overpass is
not reliable enough to sit in a page load, but this runs at a maintainer's
keyboard and its output is committed, so a retry costs nothing.

    python tools/osm/extract_indoor_geojson.py            # live OSM
    python tools/osm/extract_indoor_geojson.py <dir>      # the old files
"""

from __future__ import annotations

import json
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request

# The campus, with enough margin for the hostel blocks and the stadium.
BBOX = (1.3385, 103.9605, 1.3435, 103.9670)

# The survey put a few hundred shapes on the map. Anything far below that is a
# mirror having a bad day, not the campus having been demolished.
MIN_ELEMENTS = 200

# Anything on campus carrying a name or a plate, plus the indoor fabric and the
# lifts. Asking only for indoor=* missed the things that are not rooms but are
# still venues - Campus Centre, the link bridges, the plaza - because those are
# tagged as buildings or areas. The bbox is small enough that "named way" is a
# reasonable net.
QUERY = """
[out:json][timeout:180];
(
  way["indoor"]({bbox});
  way["room"]({bbox});
  way["name"]({bbox});
  way["ref"]({bbox});
  node["highway"="elevator"]({bbox});
);
out tags geom;
"""

ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)


def _tls():
    """Python's bundled roots on this machine have expired, so verification
    fails against a certificate every browser accepts. certifi ships a current
    bundle; falling back to the default keeps this working where it does not."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001
        return ssl.create_default_context()

NODE_RE = re.compile(r"<node id='(-?\d+)'[^>]*lat='([-\d.]+)' lon='([-\d.]+)'")
NODE_TAGGED_RE = re.compile(
    r"<node id='(-?\d+)'[^>]*lat='([-\d.]+)' lon='([-\d.]+)'[^>]*>(.*?)</node>", re.S
)
WAY_RE = re.compile(r"<way id='(-?\d+)'[^>]*>(.*?)</way>", re.S)
TAG_RE = re.compile(r"<tag k='([^']+)' v='([^']*)' */>")
ND_RE = re.compile(r"<nd ref='(-?\d+)' */>")


def _fetch(url: str, body: bytes) -> dict:
    req = urllib.request.Request(
        url, data=body, headers={"User-Agent": "modsutd-osm-extract/1.0"}
    )
    with urllib.request.urlopen(req, timeout=200, context=_tls()) as r:
        return json.load(r)


def from_overpass() -> list[dict]:
    """Every indoor shape and lift on campus, as {tags, ring} / {tags, point}."""
    q = QUERY.format(bbox=",".join(str(x) for x in BBOX))
    body = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for attempt, url in enumerate((*ENDPOINTS, *ENDPOINTS), start=1):
        try:
            data = _fetch(url, body)
            n = len(data.get("elements", []))
            # A mirror can answer 200 with almost nothing - one did, and the
            # generator wrote an empty data file over a good one. Too few is a
            # failed attempt, not an answer.
            if n < MIN_ELEMENTS:
                raise RuntimeError(f"only {n} elements, expected at least {MIN_ELEMENTS}")
            break
        except Exception as exc:  # noqa: BLE001 - any failure is worth one retry
            last = exc
            print(f"  overpass attempt {attempt} failed ({exc}); retrying", file=sys.stderr)
            time.sleep(3)
    else:
        raise SystemExit(f"overpass gave nothing usable: {last}")

    out: list[dict] = []
    for el in data.get("elements", []):
        tags = el.get("tags") or {}
        if el["type"] == "node":
            out.append({"tags": tags, "point": (round(el["lon"], 6), round(el["lat"], 6))})
        elif el.get("geometry"):
            ring = [(round(p["lon"], 6), round(p["lat"], 6)) for p in el["geometry"]]
            out.append({"tags": tags, "ring": ring})
    return out


def from_files(paths) -> list[dict]:
    out: list[dict] = []
    for f in paths:
        text = f.read_text(encoding="utf-8")
        nodes = {m[0]: (round(float(m[2]), 6), round(float(m[1]), 6)) for m in NODE_RE.findall(text)}
        for _, lat, lon, body in NODE_TAGGED_RE.findall(text):
            tags = dict(TAG_RE.findall(body))
            if tags:
                out.append({"tags": tags, "point": (round(float(lon), 6), round(float(lat), 6))})
        for _, body in WAY_RE.findall(text):
            tags = dict(TAG_RE.findall(body))
            ring = [nodes[n] for n in ND_RE.findall(body) if n in nodes]
            if tags and ring:
                out.append({"tags": tags, "ring": ring})
    return out


def load(where=None) -> list[dict]:
    """Live OSM unless a directory of .osm files is named."""
    if where is None:
        print("reading live OpenStreetMap via Overpass")
        return from_overpass()
    files = sorted(where.glob("*.osm"))
    if not files:
        raise SystemExit(f"no .osm files in {where}")
    print(f"reading {len(files)} local .osm files (a snapshot, not the live map)")
    return from_files(files)
