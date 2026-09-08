// Reads canonical data files from /data and bundles them into /frontend/public/data
// for the dev server and the build to serve at /data/*.json.
// Run via: npm run dev / npm run build (predev / prebuild hooks).

import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DATA  = join(REPO_ROOT, 'data');
const OUT_DIR   = join(__dirname, '..', 'public', 'data');

function readJSONDir(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}

function lastUpdated(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })) return null;
  let m = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    if (s.mtimeMs > m) m = s.mtimeMs;
  }
  return m ? new Date(m).toISOString() : null;
}

mkdirSync(OUT_DIR, { recursive: true });

const courses = readJSONDir(join(SRC_DATA, 'courses')).sort((a, b) => a.code.localeCompare(b.code));
const venues  = readJSONDir(join(SRC_DATA, 'venues')).sort((a, b) => a.code.localeCompare(b.code));

// A zero count means /data wasn't found (misconfigured root directory on the
// host, broken checkout) - shipping an empty catalogue is worse than failing.
if (courses.length === 0 || venues.length === 0) {
  console.error(
    `[sync-data] refusing to write an empty catalogue (courses=${courses.length}, venues=${venues.length}) - is ${SRC_DATA} present?`
  );
  process.exit(1);
}

// Room coordinates from the 2026-08-22 survey, as uploaded to OpenStreetMap.
// Attached here rather than stored in each venue file: a venue record is thin
// on purpose, and this is derived data with one generator
// (tools/osm/extract_room_coords.py), so a hand edit to a venue could only
// disagree with the survey.
//
// It matters most for the venues with no indoor-map label. Without a
// coordinate those can only point at the building, which in building 2 means
// a pin some 80 m from the room.
{
  const read = (f) => {
    const p = join(REPO_ROOT, 'data', '_meta', f);
    return statSync(p, { throwIfNoEntry: false }) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  };
  const coords = read('room-coords.json') ?? {};
  const shapes = coords.shapes ?? [];
  const lifts = coords.lifts ?? [];
  const aliases = read('venue-osm-aliases.json') ?? {};

  const squash = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  // "1.404B" and "55.223A-B" are the same room as 1.404 and 55.223; the letters
  // are halves of one space. "5.101-06" is NOT - those digits are the bay
  // number, so only a trailing LETTER is dropped.
  const loose = (ref) => (ref ?? '').replace(/[A-Za-z](-[A-Za-z])?$/, '');

  const byRef = new Map();
  const byLoose = new Map();
  const byName = new Map();
  for (const sh of shapes) {
    if (sh.ref) {
      if (!byRef.has(sh.ref)) byRef.set(sh.ref, []);
      byRef.get(sh.ref).push(sh);
      const l = loose(sh.ref);
      if (l && l !== sh.ref) {
        if (!byLoose.has(l)) byLoose.set(l, []);
        byLoose.get(l).push(sh);
      }
    }
    if (sh.name) {
      const k = squash(sh.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(sh);
    }
  }

  const mid = (list, k) => Number((list.reduce((a, x) => a + x[k], 0) / list.length).toFixed(6));
  let placed = 0;
  let ambiguous = 0;
  const plateClash = [];

  for (const v of venues) {
    const aliased = (aliases[v.code] ?? []).flatMap((n) => byName.get(squash(n)) ?? []);
    let hits = byRef.get(v.code) ?? byLoose.get(v.code) ?? [];
    if (!hits.length) hits = byName.get(squash(v.name)) ?? [];
    if (!hits.length) hits = aliased;
    if (!hits.length) continue;

    // Three plates cover two rooms each, so a plate alone is not an answer -
    // pick by name rather than land on the wrong one of the pair.
    if (hits.length > 1 && new Set(hits.map((h) => h.name)).size > 1) {
      const exact = hits.filter((h) => h.name && squash(h.name) === squash(v.name));
      if (exact.length) hits = exact;
      else if (!aliased.length) { ambiguous += 1; continue; }
    }

    v.lat = mid(hits, 'lat');
    v.lng = mid(hits, 'lng');
    const lvl = hits.map((h) => h.level).find((l) => l !== undefined && l !== null);
    if (lvl !== undefined && lvl !== null) v.osmLevel = Number(lvl);
    // What the map highlights. A venue can be more than one shape - the hostel
    // is two lobbies - so this is a list, and the map picks out every one.
    v.osmKeys = hits.map((h) => h.ref ?? h.name).filter(Boolean);
    // Matched on the name while the plates disagree. The coordinate is still
    // the right room - it is the name that found it - but one of the two
    // records has the wrong number, and silently preferring either would bury
    // that.
    const clash = hits.find((h) => h.ref && h.ref !== v.code && loose(h.ref) !== v.code);
    if (clash) plateClash.push(`${v.code} "${v.name}" is plate ${clash.ref} on the survey`);
    placed += 1;
  }

  // Counted before the fallback below, or it would report building pins as
  // rooms - the exact number of rooms rescued from a building-level link is
  // the whole point of the survey.
  const unmappedExact = venues.filter((v) => !v.mapName && v.lat !== undefined).length;

  // A room with no shape of its own still gets a map, centred on the mean of
  // the rooms that ARE placed in its building - and says so, because an
  // approximate pin presented as exact is how someone ends up on the wrong
  // floor of the right building looking for a room that is elsewhere.
  const byBuilding = new Map();
  for (const v of venues) {
    if (v.lat === undefined) continue;
    const g = byBuilding.get(v.building) ?? [];
    g.push(v);
    byBuilding.set(v.building, g);
  }
  let approx = 0;
  for (const v of venues) {
    if (v.lat !== undefined) continue;
    const g = byBuilding.get(v.building);
    if (!g?.length) continue;
    v.lat = mid(g, 'lat');
    v.lng = mid(g, 'lng');
    v.coordApprox = true;
    approx += 1;
  }

  // A room the survey never reached still knows its storey: the plate says so,
  // and OSM counts the ground floor as 0 where the plate counts it as 1. It
  // does not gain a plan from this - that still needs osmKeys, a shape of its
  // own - but the floor readout and the lift lobby below stop falling back to
  // whatever storey happens to be lowest nearby, which on this campus is a
  // basement.
  for (const v of venues) {
    if (v.osmLevel === undefined && v.floor !== undefined) v.osmLevel = v.floor - 1;
  }

  // The lift lobby is how directions are given on this campus - "Building 1,
  // Level 5, Lift Lobby E" beats any sentence about which room is next to
  // which. Derived, so it cannot go stale the way nine hand-written strings
  // did, and it covers every venue rather than the nine somebody got round to.
  // A lift has no building tag, so it takes the building of the nearest room
  // that does. Without this, building 5 was sent to a lift in building 2 -
  // near in metres, and across a courtyard in practice.
  const placedVenues = venues.filter((v) => v.lat !== undefined && !v.coordApprox);
  for (const l of lifts) {
    let best = null;
    let bestD = Infinity;
    for (const v of placedVenues) {
      const d = Math.abs(l.lat - v.lat) + Math.abs(l.lng - v.lng);
      if (d < bestD) { bestD = d; best = v; }
    }
    l.building = best?.building;
  }

  let lifted = 0;
  for (const v of venues) {
    if (v.lat === undefined) continue;
    // Same building always. That is the guard that matters - a lift 40 m away
    // across a courtyard is not the lift you would use - and it is what the
    // distance cutoff below was standing in for.
    const inBuilding = lifts.filter((l) => l.building === v.building);
    if (!inBuilding.length) continue;
    // On this floor if the survey reached it; otherwise the building's lobbies
    // whatever storey they were surveyed on. Building 3 has one lobby, so the
    // rooms above the surveyed floors still get the right answer rather than
    // none - which is what "no lift lobby" was really saying about them.
    const here = inBuilding.filter((l) => Number(l.level) === v.osmLevel);
    const from = here.length ? here : inBuilding;
    let best = null;
    let bestD = Infinity;
    for (const l of from) {
      const d = Math.abs(l.lat - v.lat) + Math.abs(l.lng - v.lng);
      if (d < bestD) { bestD = d; best = l; }
    }
    // A room pinned to its building's average is at most the building's own
    // width from any of its lobbies, so the cutoff only has to be wider than a
    // building. It still catches a stray lift the building match let through.
    if (best && bestD * 111_000 < 200) { v.liftLobby = best.name; lifted += 1; }
  }

  // The place used to be a caption under the map, which made the one line a
  // lost student wants legible only while the map was on screen. As chips it
  // sits with the room's own landmarks. Still derived here rather than typed
  // into 225 files: a copy in a venue record could only disagree with OSM.
  // Prepended, and a hand-written chip saying the same thing is dropped, so
  // "Building 1 Level 5" in the data does not print twice next to
  // "Building 1, Level 5".
  const chipKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const v of venues) {
    const derived = [
      v.floor === undefined ? `Building ${v.building}` : `Building ${v.building}, Level ${v.floor}`,
      v.liftLobby,
    ].filter(Boolean);
    const keys = new Set(derived.map(chipKey));
    const own = (v.landmarks ?? []).filter((l) => !keys.has(chipKey(l)));
    v.landmarks = [...derived, ...own];
  }

  // Fails the build, like the mapName check does. Both of these went wrong
  // silently and looked like a working map: a lift in another building reads
  // as a real direction, and a floor one storey out reads as a real floor.
  const wrong = [];
  const lobbyBuilding = new Map(lifts.map((l) => [l.name, l.building]));
  for (const v of venues) {
    if (v.liftLobby && lobbyBuilding.get(v.liftLobby) !== v.building) {
      wrong.push(`${v.code} is building ${v.building} but was given ${v.liftLobby},`
        + ` which serves building ${lobbyBuilding.get(v.liftLobby)}`);
    }
    // OSM counts the ground floor 0, the plates count it 1. Anything else means
    // the survey and the plate disagree about which storey a room is on - and a
    // MISSING level is the worse half of it, because the map then guesses from
    // the lowest shape near the pin, which on this campus is a basement lift
    // shaft. That is how a third-floor room opened on "L0".
    if (v.floor !== undefined && v.osmLevel !== v.floor - 1) {
      wrong.push(`${v.code} is plate floor ${v.floor} but osmLevel ${v.osmLevel}`);
    }
  }
  if (wrong.length) {
    console.error('[sync-data] lift lobby / floor disagreements:');
    for (const w of wrong) console.error(`  ${w}`);
    process.exit(1);
  }

  const none = venues.filter((v) => v.lat === undefined).length;
  console.log(
    `[sync-data] room coords: ${placed}/${venues.length} venues placed exactly`
    + ` (${unmappedExact} of them with no map label)`
    + `, ${approx} to their building, ${none} with nothing`
    + (ambiguous ? `, ${ambiguous} skipped as ambiguous` : ''),
  );
  console.log(`[sync-data] lift lobbies: ${lifted}/${venues.length} venues`);
  for (const c of plateClash) console.warn(`[sync-data] plate disagreement: ${c}`);
}

writeFileSync(join(OUT_DIR, 'courses.json'), JSON.stringify(courses, null, 2));
writeFileSync(join(OUT_DIR, 'venues.json'),  JSON.stringify(venues,  null, 2));

// Specialisation-track criteria for the plan badges, and the fixed
// Freshmore common core for the plan's first three terms.
for (const extra of ['specializations.json', 'freshmore.json', 'minors.json', 'telegram-groups.json', 'term-window.json', 'term-calendar.json', 'indoor.geojson']) {
  const src = join(SRC_DATA, extra);
  if (statSync(src, { throwIfNoEntry: false })) {
    copyFileSync(src, join(OUT_DIR, extra));
  }
}

const manifest = {
  scrapedAt: new Date().toISOString(),
  coursesUpdatedAt: lastUpdated(join(SRC_DATA, 'courses')),
  venuesUpdatedAt:  lastUpdated(join(SRC_DATA, 'venues')),
  counts: { courses: courses.length, venues: venues.length },
};
writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`[sync-data] wrote ${courses.length} courses, ${venues.length} venues to ${OUT_DIR}`);

// The indoor-map deep link resolves by EXACT label and falls back to the whole
// campus on anything else - no error, no distinguishable status - so a stale or
// mistyped label is invisible at runtime. Fail the build instead.
{
  // Membership, not shape. Checking that a label merely looked right let 122 of
  // 162 through with their " - <code>" tail cut off: every one resolved to the
  // campus view instead of the room, and nothing said so.
  const known = new Set(
    JSON.parse(readFileSync(join(REPO_ROOT, 'data', '_meta', 'map_labels.json'), 'utf8')),
  );
  const bad = [];
  let mapped = 0;
  for (const file of readdirSync(join(REPO_ROOT, 'data', 'venues'))) {
    if (!file.endsWith('.json')) continue;
    const v = JSON.parse(readFileSync(join(REPO_ROOT, 'data', 'venues', file), 'utf8'));
    if (!v.mapName) continue;
    mapped++;
    if (v.mapName !== v.mapName.trim()) bad.push(`${file}: mapName has stray whitespace`);
    else if (!known.has(v.mapName)) bad.push(`${file}: "${v.mapName}" is not a label the map has`);
  }
  if (bad.length) {
    console.error('map labels are wrong:\n  ' + bad.join('\n  '));
    process.exit(1);
  }
  console.log(`  map labels ok (${mapped} venues linked)`);
}
