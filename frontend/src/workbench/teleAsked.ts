// When this student asked for a mod's batch chat.
//
// Previously a React `useState` inside the mod panel, which made "creating"
// three kinds of wrong at once: it vanished on reload, so the button went back
// to pressable and a second press fired a second dispatch; it leaked to the
// next mod, because the panel swaps its contents rather than remounting, so
// opening another mod showed a spinner for a group nobody had asked for; and a
// second tab never saw it at all.
//
// A dated row per mod fixes all three, and joins the sync bundle so the other
// browser can show it too.

const KEY = 'modsutd.tele.asked.v1';

/**
 * How long a request stays "creating" before the button becomes pressable
 * again.
 *
 * Ten minutes is telegram-group.yml's own `timeout-minutes: 10` and nothing
 * more, and the job's clock starts when the JOB starts, not when the dispatch
 * lands - `concurrency: telegram-groups` serialises creations, so a queued run
 * can outlive this. Erring short is right: READY is pressable and the registry
 * poll promotes it to LIVE whenever the group appears, whereas erring long
 * leaves a spinner that lies.
 */
export const CREATING_TTL_MS = 10 * 60_000;

export const TELE_ASKED_EVENT = 'modsutd:tele-asked';

export type AskedStore = Record<string, number>;

function read(): AskedStore {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: AskedStore = {};
    for (const [code, at] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[code] = at;
    }
    return out;
  } catch {
    return {}; // private window, cleared storage, or someone else's key
  }
}

function write(store: AskedStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* private window: the state degrades to per-render, which is the old behaviour */
  }
  // localStorage fires no event in the tab that wrote it, so the panel that
  // just clicked would otherwise be a render behind its own action.
  window.dispatchEvent(new Event(TELE_ASKED_EVENT));
}

/** When this browser asked for `code`, or null if it never did or the TTL passed. */
export function askedAt(code: string, now = Date.now()): number | null {
  const at = read()[code];
  return at !== undefined && now - at < CREATING_TTL_MS ? at : null;
}

export function markAsked(code: string, at = Date.now()): void {
  const store = read();
  store[code] = at;
  write(store);
}

/** Drop the row once the group exists, so LIVE never re-enters CREATING. */
export function clearAsked(code: string): void {
  const store = read();
  if (store[code] === undefined) return;
  delete store[code];
  write(store);
}

/**
 * Is anything still being created?
 *
 * Drives the poll cadence: fast while something is pending, slow otherwise.
 * Shaped after `contributed.ts` anyAwaiting for the same reason.
 */
export function anyAsked(now = Date.now()): boolean {
  return Object.values(read()).some((at) => now - at < CREATING_TTL_MS);
}

/** The whole store, for the sync bundle. */
export function exportAsked(): AskedStore {
  return read();
}

/**
 * Merge a synced store in, newest wins per mod.
 *
 * Merged rather than replaced: the two browsers may each have asked for a
 * different mod, and a replace would drop whichever one arrived second.
 */
export function importAsked(remote: unknown): void {
  if (!remote || typeof remote !== 'object') return;
  const store = read();
  let changed = false;
  for (const [code, at] of Object.entries(remote as Record<string, unknown>)) {
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    if ((store[code] ?? 0) >= at) continue;
    store[code] = at;
    changed = true;
  }
  if (changed) write(store);
}
