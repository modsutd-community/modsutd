import type { Pillar, Term } from '@/types';
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
 * A stored `freshmoreMode` from before the cohorts were all spelled `ay<year>`.
 *
 * Migrated on READ rather than by rewriting the store, because the same value
 * also arrives from a synced gist written by a browser that has not updated
 * yet. One place that knows the old name is enough.
 */
function migrateMode(m: unknown): FreshmoreMode | undefined {
  if (m === 'classic') return 'ay2024';
  return m as FreshmoreMode | undefined;
}

export function loadUi(): PersistedUi {
  try {
    const ui = (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as PersistedUi) ?? {};
    if (ui.freshmoreMode) ui.freshmoreMode = migrateMode(ui.freshmoreMode);
    return ui;
  } catch {
    return {};
  }
}
