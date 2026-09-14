import type { Pillar, Term } from '@/types';
import { COHORTS } from './uiContext';
import type { SortKey, MobileTab, TtMode, FreshmoreMode, HomePillar } from './uiContext';

export interface PersistedUi {
  filter?: string;
  pillar?: Pillar | 'ALL';
  term?: Term | 'ALL';
  currentTerm?: number;
  currentPillar?: HomePillar | null;
  sortKey?: SortKey;
  sortDir?: 1 | -1;
  selected?: string | null;
  selectedRoom?: string | null;
  mobileTab?: MobileTab;
  ttMode?: TtMode;
  freshmoreMode?: FreshmoreMode;
  showRetired?: boolean;
  declared?: string[];
}

export const STORAGE_KEY = 'modsutd.workbench.ui.v1';


// Settings a student means on every device, as opposed to where they happen to
// be looking. Splitting them is the whole point: syncing `filter` or `selected`
// would make a phone jump to whatever the laptop had open.
/** Fired when a pull has written new settings into the store. */
export const PREFS_EVENT = 'modsutd:prefs-synced';

export const SYNCED_PREFS = [
  'currentTerm', 'currentPillar', 'sortKey', 'sortDir', 'freshmoreMode', 'showRetired',
] as const;

/** The synced settings out of the UI store, for the backup bundle. */
export function exportPrefs(): Record<string, unknown> {
  const ui = loadUi() as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of SYNCED_PREFS) if (ui[k] !== undefined) out[k] = ui[k];
  return out;
}

/**
 * Merge pulled settings into the UI store.
 *
 * Written straight to localStorage rather than through the setters: the
 * provider reads this key once on mount, so the value has to be there before
 * the reload that applies it. Returns true when something actually changed,
 * so the caller can decide whether a reload is worth it.
 */
export function importPrefs(prefs: unknown): boolean {
  if (!prefs || typeof prefs !== 'object') return false;
  const ui = loadUi() as Record<string, unknown>;
  let changed = false;
  for (const k of SYNCED_PREFS) {
    const v = (prefs as Record<string, unknown>)[k];
    if (v === undefined || JSON.stringify(ui[k]) === JSON.stringify(v)) continue;
    ui[k] = v;
    changed = true;
  }
  if (changed) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ui));
    } catch {
      /* private window */
    }
  }
  return changed;
}


/**
 * A stored `freshmoreMode`, or undefined when it names a cohort this app does
 * not have.
 *
 * This was the one-way rename of `classic` to `ay2024`, and deleting that left
 * a hole rather than nothing: `plans` has exactly three keys, so any other
 * string reaching `freshmoreMode` makes the next render read
 * `plans['classic'].selectedMods` and throw. `freshmoreMode` is persisted, so
 * the crash comes back on every reload and the panel stays dead - which is the
 * same failure `migrateCurriculum` in planFile.ts guards against, arriving
 * through the other door.
 *
 * So it validates instead of translating. A value it rejects is written back as
 * undefined and the context falls to its default, which is a cohort the reader
 * can change rather than a blank panel.
 */
export function migrateMode(m: unknown): FreshmoreMode | undefined {
  return COHORTS.some((c) => c.value === m) ? (m as FreshmoreMode) : undefined;
}

export function loadUi(): PersistedUi {
  try {
    const ui = (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as PersistedUi) ?? {};
    const mode = migrateMode(ui.freshmoreMode);
    if (ui.freshmoreMode && mode !== ui.freshmoreMode) {
      ui.freshmoreMode = mode;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(ui));
      } catch {
        // private window or quota: the read above already migrated this
        // session, so nothing is lost by failing to write
      }
    }
    return ui;
  } catch {
    return {};
  }
}
