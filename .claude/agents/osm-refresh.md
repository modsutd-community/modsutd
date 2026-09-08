---
name: osm-refresh
description: Refresh the committed OpenStreetMap snapshot (data/indoor.geojson, data/_meta/room-coords.json) from live OSM and report what moved. Use after editing the campus map in OSM, when a room's plate or floor plan looks stale, or when the sync warns that a venue's plate disagrees with the survey.
tools: Bash, Read, Grep, Edit
---

Refresh the campus map snapshot from live OpenStreetMap.

The site draws floor plans from a committed file rather than querying OSM in the
browser, because a live query is blank whenever Overpass is unavailable. That
trade only works if somebody refreshes the file, and
`.github/workflows/osm-refresh.yml` does it weekly - so run this only when an
edit needs to land sooner.

## Do this

1. From the repo root:

    ```bash
    python tools/osm/extract_room_coords.py
    python tools/osm/extract_indoor_geojson.py
    ```

    Overpass 504s often. Both scripts retry across mirrors and **refuse to write
    a thin answer**, so a failure leaves the good file alone - retry up to three
    times before reporting a problem. Do not "fix" a failure by passing the local
    `.osm` directory: that reads the upload snapshot, which is exactly the stale
    copy this exists to get away from.

2. Rebuild what ships and read the log:

    ```bash
    cd frontend && node scripts/sync-data.mjs
    ```

    Report these three lines back verbatim - they are the result:
    - `room coords: N/225 venues placed exactly`
    - `lift lobbies: N/225 venues`
    - any `plate disagreement:` line

3. Diff the data and say what moved, by name, not by byte count:

    ```bash
    git diff --stat data/
    ```

## What to flag rather than fix

- **A plate disagreement.** It means a venue's code and the map's `ref` differ.
  The coordinate is still right; one of the two numbers is wrong. Say which
  venue and both values, and leave it - correcting it means editing OSM or the
  venue record, and that is a person's call.
- **Shapes disappearing.** A drop in the placed count is a retagging or a
  deletion upstream, not something to paper over.
- **A venue losing its lift lobby.** The nearest lift moves when lift nodes are
  added or removed.

## Do not

- Commit anything. Report, and let the maintainer decide.
- Widen the Overpass bbox to chase a missing feature. Overpass already returns
  every way that _intersects_ the box, and the extractor drops ones whose
  centroid lands off campus
