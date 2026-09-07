import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeatureCollection, Point, Polygon } from 'geojson';
import type * as LeafletNS from 'leaflet';

// The map, built rather than embedded.
//
// An iframe - OpenStreetMap's export page or OpenLevelUp - hands over the
// chrome with the picture: control placement, attribution wording, all of it
// theirs. OpenLevelUp also queries Overpass on every load, so the plan is blank
// whenever Overpass is unavailable. A room panel whose whole job is "where is
// this" cannot depend on a third party being up, so the survey ships as a file
// and we draw it.
//
// Leaflet is loaded on demand: nobody pays for it until a room detail opens.

export interface IndoorProps {
  lat: number;
  lng: number;
  /** OSM level, where ground is 0. Selected when the indoor layer appears. */
  osmLevel?: number;
  /** Highlighted, since "which one is mine" is the question being asked. */
  venueCode?: string;
  /** The surveyed shapes that ARE this venue - plate, or name where there is
   *  no plate. The hostel is two lobbies, so it is a list. */
  osmKeys?: string[];
  /** Which block to draw. Without it the plan is every room on that floor
   *  across the whole campus. */
  building?: string;
}

// The map opens showing the building in its surroundings, which is what
// answers "where on campus". One press of + crosses this line and the plan
// takes over. No arrow to press: getting closer is already the gesture for
// looking inside.
export const OUTDOOR_ZOOM = 18;
export const INDOOR_ZOOM = 19;

// OSM's raster tiles stop at 19. Past that they are upscaled rather than
// missing, which is what indoor zoom levels need.
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const MAX_NATIVE_ZOOM = 19;
const MAX_ZOOM = 22;

type RoomProps = { ref?: string; name?: string; level?: string; 'level:ref'?: string; kind?: string };
type Indoor = FeatureCollection<Polygon | Point, RoomProps>;

let cached: Promise<Indoor> | null = null;
function loadIndoor(): Promise<Indoor> {
  cached ??= fetch('/data/indoor.geojson').then((r) => {
    if (!r.ok) throw new Error(`indoor layer ${r.status}`);
    return r.json() as Promise<Indoor>;
  });
  return cached;
}

const levelOf = (f: { properties: RoomProps }) => Number(f.properties.level ?? NaN);

function centroid(f: { geometry: Polygon | Point }): { lat: number; lng: number } {
  if (f.geometry.type === 'Point') {
    const [lng, lat] = f.geometry.coordinates;
    return { lat, lng };
  }
  const ring = f.geometry.coordinates[0];
  let x = 0;
  let y = 0;
  for (const [lng, lat] of ring) { x += lng; y += lat; }
  return { lat: y / ring.length, lng: x / ring.length };
}

// A plate is "<building>.<level><room>", so the block is the part before the
// dot. OSM tags the room and never the block it sits in, so a lift and a
// corridor have to borrow the building of the nearest room that does carry a
// plate - the same rule sync-data.mjs uses to give a lift its building, so the
// landmark chip and the plan cannot disagree about which lobby is yours.
const REF_BUILDING = /^(\d{1,2})\./;

function buildingsFor(fc: Indoor): Map<Indoor['features'][number], string> {
  const plated: Array<{ b: string; lat: number; lng: number }> = [];
  for (const f of fc.features) {
    const m = REF_BUILDING.exec(f.properties.ref ?? '');
    if (m) plated.push({ b: m[1], ...centroid(f) });
  }
  const out = new Map<Indoor['features'][number], string>();
  for (const f of fc.features) {
    const m = REF_BUILDING.exec(f.properties.ref ?? '');
    if (m) { out.set(f, m[1]); continue; }
    const c = centroid(f);
    let best = '';
    let bestD = Infinity;
    for (const k of plated) {
      const d = Math.abs(k.lat - c.lat) + Math.abs(k.lng - c.lng);
      if (d < bestD) { bestD = d; best = k.b; }
    }
    if (best) out.set(f, best);
  }
  return out;
}

export interface MapState {
  /** The floor being drawn, in OSM numbering. */
  level: number | null;
  /**
   * What the door plates call that floor, copied from OSM's `level:ref` rather
   * than computed. Ground is level 0 and plate 1 almost everywhere, but the
   * basement is plate "B1", which no arithmetic on 0 and 1 produces.
   */
  plate: string | null;
  /** Whether there is a plan to show at all. Without one, zooming in must not
   *  pretend: an empty indoor view is worse than staying outdoors. */
  hasPlan: boolean;
  /** Shown briefly after a plain wheel: the map did not move, and silence
   *  reads as a broken map rather than as a deliberate choice. */
  needCtrl: boolean;
  /** True once zoomed in far enough for the plan to be showing. */
  indoor: boolean;
  failed: boolean;
}

// Rooms within this of the one being viewed get a name on the plan. Labelling
// the whole floor is unreadable at panel size and labelling only the target
// tells you nothing about what is around it, which is the thing a floor plan
// is for.
const LABEL_RADIUS_M = 30;
const DEG_M = 111_000;

// Neighbours stay unlabelled until there is room for the words. At the zoom
// where the plan first appears, a think tank is barely wider than its own
// name, so labelling its neighbours too just overprints all of them.
const NEIGHBOUR_LABEL_ZOOM = 20;

// The donor in brackets is part of what a room is called, so it stays - but
// "Think Tank 13 (Yangzheng Foundation)" is three times the width of the room
// it names, so only the first word of the donor survives.
const short = (name: string) => name.replace(
  /\s*\(([^)]*)\)\s*$/,
  (_, inner: string) => {
    const words = String(inner).trim().split(/\s+/);
    return words.length > 1 ? ` (${words[0]}…)` : ` (${words[0]})`;
  },
).trim() || name;

export function useIndoorMap(
  host: React.RefObject<HTMLDivElement>,
  { lat, lng, osmLevel, venueCode, osmKeys, building }: IndoorProps,
): MapState {
  const map = useRef<LeafletNS.Map | null>(null);
  const layer = useRef<LeafletNS.GeoJSON | null>(null);
  const pin = useRef<LeafletNS.CircleMarker | null>(null);
  const tiles = useRef<LeafletNS.TileLayer | null>(null);
  // State, not a ref, and so is `ready`. As refs, an arrival that lands after
  // the last zoom change never redraws anything: the layer effect has already
  // run against null and has no reason to run again. The plan is then there
  // when the fetch wins the race and missing when it loses, which reads as
  // flake rather than as a bug.
  const [data, setData] = useState<Indoor | null>(null);
  const [ready, setReady] = useState(false);
  const [level, setLevel] = useState<number | null>(osmLevel ?? null);
  const [zoomedIn, setZoomedIn] = useState(false);
  const [zoom, setZoom] = useState(OUTDOOR_ZOOM);
  const [needCtrl, setNeedCtrl] = useState(false);
  const [failed, setFailed] = useState(false);
  const keys = useMemo(() => new Set(osmKeys ?? []), [osmKeys]);

  // The panel does not remount between rooms - same component, new props - so
  // the initialiser above runs once for the whole session and the floor stayed
  // on whichever room was opened first. Harmless while the plan was every room
  // on that level campus-wide, because a stale floor still found shapes. Once
  // the plan was scoped to one building a stale floor had none: no plan at all,
  // under a badge naming a storey you were not on.
  useEffect(() => { setLevel(osmLevel ?? null); }, [osmLevel, venueCode]);

  useEffect(() => {
    let dead = false;
    let cleanup = () => {};

    void (async () => {
      const [L] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
      if (dead || !host.current) return;

      const m = L.map(host.current, {
        center: [lat, lng],
        zoom: OUTDOOR_ZOOM,
        maxZoom: MAX_ZOOM,
        zoomControl: false,
        attributionControl: false,
        // Plain wheel scrolls the panel, or the map swallows the page. Ctrl
        // (or Cmd) plus wheel zooms, which is what every other embedded map
        // does and what a reader will try first.
        scrollWheelZoom: false,
      });
      map.current = m;

      tiles.current = L.tileLayer(TILE_URL, {
        maxZoom: MAX_ZOOM,
        maxNativeZoom: MAX_NATIVE_ZOOM,
      }).addTo(m);

      // Ours, and short. Leaflet's own credit is not required on screen, but
      // OpenStreetMap's is - the data is ODbL, and here it is our own survey.
      L.control
        .attribution({ position: 'bottomright', prefix: false })
        .addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>')
        .addTo(m);
      L.control.zoom({ position: 'topleft' }).addTo(m);

      let hintTimer: ReturnType<typeof setTimeout> | undefined;
      const onWheel = (e: WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) {
          // The page scrolls past, which is right, but a map that ignores the
          // wheel looks broken unless it says why.
          setNeedCtrl(true);
          clearTimeout(hintTimer);
          hintTimer = setTimeout(() => setNeedCtrl(false), 1400);
          return;
        }
        setNeedCtrl(false);
        // Without this the browser zooms the whole page instead.
        e.preventDefault();
        const at = m.mouseEventToLatLng(e);
        m.setZoomAround(at, m.getZoom() + (e.deltaY < 0 ? 1 : -1));
      };
      host.current.addEventListener('wheel', onWheel, { passive: false });

      pin.current = L.circleMarker([lat, lng], {
        radius: 7, weight: 2, color: '#ffb000', fillColor: '#ffb000', fillOpacity: 0.55,
      }).addTo(m);

      if (!dead) setReady(true);

      try {
        const fc = await loadIndoor();
        if (dead) return;
        setData(fc);
        // A room with no level of its own is drawn on the lowest floor that
        // has anything near it, which beats drawing nothing.
        if (!dead && osmLevel === undefined) {
          const blk = buildingsFor(fc);
          const near = fc.features.filter((f) => {
            if (building && blk.get(f) !== building) return false;
            const c = centroid(f);
            return Math.abs(c.lat - lat) < 0.0012 && Math.abs(c.lng - lng) < 0.0012;
          });
          const found = [...new Set(near.map(levelOf).filter(Number.isFinite))].sort((a, b) => a - b);
          if (found.length) setLevel(found[0]);
        }
      } catch {
        if (!dead) setFailed(true);
      }

      const onZoom = () => {
        setZoomedIn(m.getZoom() >= INDOOR_ZOOM);
        setZoom(m.getZoom());
      };
      m.on('zoomend', onZoom);
      onZoom();

      const el = host.current;
      cleanup = () => {
        clearTimeout(hintTimer);
        el?.removeEventListener('wheel', onWheel);
        m.off('zoomend', onZoom);
        m.remove();
        map.current = null;
        setReady(false);
      };
    })();

    return () => { dead = true; cleanup(); };
    // Built once per room. lat/lng/code identify the room, and the panel
    // remounts when it changes.
  }, [host, lat, lng, osmLevel, venueCode, building]);

  // Tiles carry ground-floor shops and their labels at every zoom, so on a
  // fourth-floor plan a cafe downstairs sits on top of the rooms and reads as
  // if it were on this floor. Fading them once the plan takes over keeps the
  // street context without letting it claim a storey it is not on.
  // A plan needs this VENUE to have been surveyed, not merely something on
  // the same floor. Antique House gets its pin from the average of its
  // building, and the rooms near that average are other people's - going
  // indoors there would draw a confident plan of somewhere else.
  const blocks = useMemo(() => (data ? buildingsFor(data) : null), [data]);

  // Level alone is not a floor plan. Buildings 1, 2 and 3 sit about 60 m apart
  // and share every storey number, so filtering on level drew all three at
  // once: a building 3 room opened onto building 2's rooms and building 1's
  // lifts, and its own three surveyed shapes were lost among them.
  const onFloor = useMemo(() => {
    if (!data || level === null) return [];
    const mine = (f: Indoor['features'][number]) =>
      !building || !blocks || blocks.get(f) === building;
    const rooms = data.features.filter((f) => f.properties.kind !== 'lift'
      && levelOf(f) === level && mine(f));

    // A lift is a shaft, not a room: it is in the same place on every floor it
    // serves. The survey walked floors unevenly - Lift Lobby A was recorded on
    // plates 2, 5, 6 and 7 and nowhere else - so filtering lifts by level drew
    // a plan of building 1 level 4 with one of its two lobbies missing. Take
    // the building's lobbies wherever they were surveyed, one mark each.
    // One mark per named lobby. The extractor keeps unnamed elevator nodes -
    // they are on the map and the file should say so - but the plan will not
    // draw one: a bare arrow with no letter is a mark you cannot act on, and
    // the three on this campus sit where no lobby is.
    const seen = new Set<string>();
    const shafts = data.features.filter((f) => {
      if (f.properties.kind !== 'lift' || !mine(f)) return false;
      const name = f.properties.name;
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
    return [...rooms, ...shafts];
  }, [data, level, building, blocks]);
  const hasPlan = keys.size > 0 && onFloor.length > 0;
  const plate = useMemo(() => {
    const from = onFloor.find((f) => f.properties['level:ref']);
    return from?.properties['level:ref'] ?? (level === null ? null : String(level + 1));
  }, [onFloor, level]);
  const indoor = zoomedIn && hasPlan;

  useEffect(() => {
    tiles.current?.setOpacity(indoor ? 0.18 : 1);
  }, [indoor, ready]);

  // The plan itself: swapped when the level changes, dropped when zoomed out.
  useEffect(() => {
    let dead = false;
    void (async () => {
      const m = map.current;
      if (!m || !data) return;
      const fc = data;
      const L = await import('leaflet');
      if (dead || !map.current) return;

      if (layer.current) { layer.current.remove(); layer.current = null; }
      if (!indoor || level === null) { pin.current?.addTo(m); return; }
      // The plan answers the question the pin was standing in for.
      pin.current?.remove();

      // Anchor labelling on the room being viewed when it is on this floor,
      // and on the map's own centre when it is not - stepping to another floor
      // should still name what is under you, not what is on floor three.
      const isMine = (p: RoomProps) =>
        (!!p.ref && keys.has(p.ref)) || (!!p.name && keys.has(p.name)) || (!!venueCode && p.ref === venueCode);
      const target = onFloor.find((f) => isMine(f.properties));
      const anchor = target ? centroid(target) : { lat, lng };

      layer.current = L.geoJSON(
        { ...fc, features: onFloor } as Indoor,
        {
          // A lift is a point, not a room. It gets a mark of its own, because
          // "Lift Lobby A" is how every direction on this campus ends and a
          // plan that does not show the lifts cannot answer the question.
          pointToLayer: (f, latlng) => L.marker(latlng, {
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: 'wb-lift',
              html: `<span aria-hidden="true">⇅</span><b>${
                (f.properties.name ?? '').replace(/^Lift Lobby\s*/i, '')
              }</b>`,
              iconSize: [26, 16],
              iconAnchor: [13, 8],
            }),
          }),
          style: (f) => {
            const mine = !!venueCode && f?.properties?.ref === venueCode;
            // Nearly opaque: the faded basemap underneath is context, not
            // something to read the plan through. At half opacity the rooms
            // came out the same muddy grey as the tiles behind them.
            return {
              color: mine ? '#ffb000' : '#9aa6b6',
              weight: mine ? 2.5 : 1,
              fillColor: mine ? '#ffcf5c' : '#e9eef5',
              fillOpacity: mine ? 0.95 : 0.92,
            };
          },
          onEachFeature: (f, l) => {
            const p = f.properties as RoomProps;
            // The lift carries its letter in its own mark already.
            if (p.kind === 'lift') return;
            // The plate number is already the panel's heading, so the plan
            // carries the name - which is what tells one door from another.
            const label = p.name ? short(p.name) : p.ref;
            if (!label) return;
            const c = centroid(f as Indoor['features'][number]);
            const near = (Math.abs(c.lat - anchor.lat) + Math.abs(c.lng - anchor.lng)) * DEG_M
              <= LABEL_RADIUS_M;
            const mine = isMine(p);
            l.bindTooltip(label, {
              direction: 'center',
              // Permanent, or it only appears on hover - which on a floor plan
              // means the names are invisible until you go looking for them,
              // and invisible entirely on a touch screen.
              // The room being viewed is always named. Its neighbours wait
              // until the words fit, or they overprint each other and it.
              permanent: mine || (near && zoom >= NEIGHBOUR_LABEL_ZOOM),
              className: mine ? 'wb-room-label wb-room-mine' : 'wb-room-label',
            });
          },
        },
      ).addTo(m);
    })();
    return () => { dead = true; };
  }, [indoor, level, venueCode, keys, onFloor, data, ready, lat, lng, zoom]);

  return { level, plate, indoor, hasPlan, needCtrl, failed };
}
