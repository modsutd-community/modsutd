import type { BackupBundle, BundleSection } from './backup';
import { SECTIONS } from './backup';

// Which sections this browser has written, and when.
//
// Sync is newest-wins per section rather than per bundle. A phone that only
// ever edits a note must not push its empty timetable over the one the laptop
// pasted an hour ago, and a laptop must not pull back a note the phone just
// changed. Comparing whole bundles gets one of those wrong every time.
//
// Local stamps advance when this browser pushes, which the autosave does a few
// seconds after any change. So the window where a local edit could lose to a
// newer remote section is the length of that debounce, not the session.

// v2 on purpose. v1 was written by a version that stamped ALL FIVE sections
// with Date.now() on every push, whatever had actually changed, so a browser
// carries a timetable stamp from the last time it pushed ANYTHING. If that
// moment happens to sit after the other device's edit, this one refuses that
// edit forever - a cleared timetable that never clears, with no way for either
// side to break the tie.
//
// Those numbers cannot be repaired, only discarded. A browser with no stamps
// takes the gist on its first pull, which is the right default: the gist is
// what both devices agreed on last.
const KEY = 'modsutd.sync.stamps.v2';

export type Stamps = Partial<Record<BundleSection, number>>;

export function readStamps(): Stamps {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: Stamps = {};
    for (const s of SECTIONS) {
      const v = (raw as Record<string, unknown>)[s];
      if (typeof v === 'number' && Number.isFinite(v)) out[s] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Stamp only the sections that actually changed, and return the full set.
 *
 * Replaces a version that stamped ALL FIVE on every push. That made the
 * per-section design in the header a fiction: a note edited on the laptop
 * republished the laptop's whole state - stale timetable included - with a
 * fresh stamp on every section, so it beat anything the phone had written
 * since. There was no race to lose, because the laptop always won.
 */
export function stampChanged(changed: BundleSection[], at = Date.now()): Stamps {
  const next = readStamps();
  for (const s of changed) next[s] = at;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private window - sync degrades to push-only, which is the old behaviour */
  }
  return next;
}

export function stampSections(sections: BundleSection[], at = Date.now()): void {
  const cur = readStamps();
  for (const s of sections) cur[s] = at;
  try {
    localStorage.setItem(KEY, JSON.stringify(cur));
  } catch {
    /* as above */
  }
}

/**
 * The sections of `remote` that are newer than this browser's.
 *
 * A remote section with no stamp is treated as older than any local one: an
 * old bundle written before stamps existed should not win over something this
 * browser has since edited.
 *
 * An empty section is NOT refused. It used to be, as a guard against data
 * loss, and the cost was that clearing a timetable on the phone never reached
 * the laptop - deletion is an edit, and a rule that only propagates additions
 * is a rule that cannot delete anything. What protects against loss now is
 * that a section is stamped only when it actually changes, so an empty section
 * wins only when emptying it was the most recent thing anyone did.
 */
export function newerSections(remote: BackupBundle): BundleSection[] {
  const mine = readStamps();
  const theirs = remote.stamps ?? {};
  return SECTIONS.filter((s) => {
    if (remote[s] === undefined) return false;
    return (theirs[s] ?? 0) > (mine[s] ?? 0);
  });
}
