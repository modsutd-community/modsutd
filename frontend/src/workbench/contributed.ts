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

const KEY = 'modsutd.contributed.v2';
// Long enough for a paste on a Friday night to survive the weekend, short
// enough that a mod whose slots were rejected stops promising a button.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Fires on this window whenever the store changes, so an open panel re-reads. */
export const CONTRIBUTED_EVENT = 'modsutd:contributed';

type Entry = { at: number; termEnd?: string };
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
        out[code] = typeof termEnd === 'string' ? { at, termEnd } : { at };
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
export function rememberContributed(codes: string[], termEnd?: string): void {
  const store = read();
  const now = Date.now();
  for (const c of codes) store[c] = termEnd ? { at: now, termEnd } : { at: now };
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
