import type { Mod, Schedule } from '@/types';
// Which mods THIS browser contributed slots for, and has not seen deployed yet.
//
// A batch chat is offered when a mod has crowdsourced schedules, and those
// only reach the browser through the deployed bundle - `deploy.yml` batches
// them four times a day rather than building per paste. So between pasting and
// the next deploy, the mod that was just contributed looks exactly like a mod
// nobody is taking: no button, no explanation.
//
// This is the difference, and it is deliberately client-side. The person who
// needs telling is the one who pasted, this browser is the only thing that
// knows they did, and a server-side queue would be the backend this project
// does not have.
//
// It carries the term end from the paste for the same reason. The mod pages
// otherwise take the live term from `term-window.json`, which is written by the
// contribution workflow and read back through GitHub's raw CDN - a commit, then
// a cache, then a fetch. On the first paste of a term that file is still empty,
// so a waiting state gated on it cannot appear during exactly the window it
// exists to cover. The paste already named its own term end; use that.
//
// It cleans itself: an entry goes the moment the deployed data catches up, and
// anything that never arrives ages out rather than sitting there forever.

const KEY = 'modsutd.contributed.v3';
// Long enough for a paste on a Friday night to survive the weekend, short
// enough that a mod whose slots were rejected stops promising a button.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Fires on this window whenever the store changes, so an open panel re-reads. */
export const CONTRIBUTED_EVENT = 'modsutd:contributed';

type Entry = { at: number; termEnd?: string; schedules?: Schedule[] };
type Store = Record<string, Entry>;

function read(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: Store = {};
    for (const [code, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const { at, termEnd } = v as Entry;
      if (typeof at === 'number' && Date.now() - at < MAX_AGE_MS) {
        const e: Entry = { at };
        if (typeof termEnd === 'string') e.termEnd = termEnd;
        if (Array.isArray((v as Entry).schedules)) e.schedules = (v as Entry).schedules;
        out[code] = e;
      }
    }
    return out;
  } catch {
    return {}; // private window, cleared storage, or something else's key
  }
}

function write(store: Store): void {
  try {
    if (Object.keys(store).length) localStorage.setItem(KEY, JSON.stringify(store));
    else localStorage.removeItem(KEY);
    window.dispatchEvent(new Event(CONTRIBUTED_EVENT));
  } catch {
    /* storage refused - the button simply does not get its waiting state */
  }
}

/**
 * Record the mods a contribution just covered.
 *
 * `termEnd` is the last class date in the paste, which is what the batch chat's
 * own expiry will be built from. Only List View can name one.
 */
export function rememberContributed(
  byMod: Record<string, Schedule[]>,
  termEnd?: string,
): void {
  const store = read();
  const now = Date.now();
  for (const [code, schedules] of Object.entries(byMod)) {
    store[code] = { at: now, ...(termEnd ? { termEnd } : {}), schedules };
  }
  write(store);
}

/**
 * True when this browser contributed slots for the mod and the deployed data
 * still has none. `deployed` is that data, so the entry is dropped the moment
 * it disagrees - the state cannot outlive the thing it describes.
 *
 * An entry whose own term has ended is dropped too. Without that, a paste of a
 * timetable that turns out to be stale would promise a chat for a week.
 */
export function awaitingDeploy(code: string, deployed: boolean): boolean {
  const store = read();
  const entry = store[code];
  if (entry === undefined) return false;
  const expired =
    entry.termEnd !== undefined && new Date().toISOString().slice(0, 10) > entry.termEnd;
  if (deployed || expired) {
    delete store[code];
    write(store);
    return false;
  }
  return true;
}

/** True when any mod here is still waiting on a build. Drives the data poll. */
export function anyAwaiting(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return Object.values(read()).some(
    (e) => e.termEnd === undefined || today <= e.termEnd,
  );
}

/**
 * Show a contribution on this browser before the build that ships it.
 *
 * Applied where courses are loaded, so the mod pages and the venue heatmaps
 * both see it and neither needs its own copy of the rule. Pure on purpose: it
 * used to delete its own entry the moment a fetch came back with schedules,
 * and during a deploy the two concurrent fetches of courses.json can return
 * DIFFERENT bodies - so one would drop the entry while the other was still
 * rendering the empty file, and the contribution vanished on reload. Forgetting
 * is pruneContributed's job, once, off the settled store.
 *
 * Never overwrites deployed data. A mod that already has schedules is left
 * exactly as the build shipped it - the local copy is one browser's reading of
 * one timetable, and the folded file is everyone's.
 *
 * What it overlays is marked. A local schedule is enough to draw a heatmap,
 * and deliberately NOT enough to offer a batch chat: that button asks a
 * workflow to create a real Telegram group, so it waits for data everyone can
 * see.
 */
export function overlayLocal(courses: Mod[]): Mod[] {
  const store = read();
  if (!Object.keys(store).length) return courses;
  return courses.map((c) => {
    const entry = store[c.code];
    if (entry === undefined || c.schedules.length > 0) return c;
    if (!entry.schedules?.length) return c;
    return { ...c, schedules: entry.schedules, localSchedules: true };
  });
}

/**
 * Forget the mods the build has caught up on.
 *
 * Takes the settled catalogue, so "has schedules and none of them are ours" is
 * a fact about what shipped rather than about whichever fetch answered first.
 */
export function pruneContributed(mods: Mod[]): void {
  const store = read();
  if (!Object.keys(store).length) return;
  let changed = false;
  for (const m of mods) {
    if (store[m.code] && m.schedules.length > 0 && !m.localSchedules) {
      delete store[m.code];
      changed = true;
    }
  }
  if (changed) write(store);
}
