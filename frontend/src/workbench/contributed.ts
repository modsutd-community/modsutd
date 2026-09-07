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
// It cleans itself: an entry goes the moment the deployed data catches up, and
// anything that never arrives ages out rather than sitting there forever.

const KEY = 'modsutd.contributed.v1';
// Long enough for a paste on a Friday night to survive the weekend, short
// enough that a mod whose slots were rejected stops promising a button.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Store = Record<string, number>;

function read(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: Store = {};
    for (const [code, at] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof at === 'number' && Date.now() - at < MAX_AGE_MS) out[code] = at;
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
  } catch {
    /* storage refused - the button simply does not get its waiting state */
  }
}

/** Record the mods a contribution just covered. */
export function rememberContributed(codes: string[]): void {
  const store = read();
  const now = Date.now();
  for (const c of codes) store[c] = now;
  write(store);
}

/**
 * True when this browser contributed slots for the mod and the deployed data
 * still has none. `deployed` is that data, so the entry is dropped the moment
 * it disagrees - the state cannot outlive the thing it describes.
 */
export function awaitingDeploy(code: string, deployed: boolean): boolean {
  const store = read();
  if (store[code] === undefined) return false;
  if (deployed) {
    delete store[code];
    write(store);
    return false;
  }
  return true;
}
