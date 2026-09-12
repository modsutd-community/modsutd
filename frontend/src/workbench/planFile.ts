import type { Curriculum, PlanState, RecordsState } from '@/types';

// What the plan panel's "download .json" actually produces.
//
// It used to hand over the whole browser: every curriculum's plan, the parsed
// timetable, and the contributed-but-undeployed slots. The button sits on one
// matriculation year's tab, so that is what it exports now - and importing it
// affects that tab and nothing else.

export const PLAN_FILE_KIND = 'modsutd-plan';
export const PLAN_FILE_VERSION = 1;

export interface PlanFile {
  kind: typeof PLAN_FILE_KIND;
  version: number;
  /**
   * The matriculation year this was exported from, and the year an import
   * writes back to. A plan is that year's plan wherever the reader happens to
   * be standing, so the file decides the tab rather than the other way round.
   */
  curriculum: Curriculum;
  exportedAt: string;
  plan: PlanState;
  declared: string[];
  /**
   * Only the mods in this plan, which includes the pinned freshmore core:
   * a record for a mod you are not taking is noise, but the core IS taken.
   */
  records: RecordsState;
}

/**
 * `classic` was the name for AY2024 and earlier before the cohorts were all
 * spelled `ay<year>`.
 *
 * READ ONLY, and one-way. Nothing writes this name any more: a browser that
 * loads the app rewrites its storage and its gist under `ay2024` on the way in,
 * so the old spelling leaves as people arrive rather than being carried
 * forever. What still has to be read is what is already out there: a plan in a
 * gist last written before the rename, and a `.json` a student exported and
 * kept.
 *
 * Deletable when neither of those can exist, which is a judgement about how
 * long an unopened gist and a file on disk stay interesting, not a release
 * date. Everything that reads it is named here and in `migrateMode`.
 */
export const LEGACY_CURRICULUM = 'classic';
export const CURRENT_FOR_LEGACY: Curriculum = 'ay2024';

/**
 * Every cohort key the app knows. Kept here beside the migration rather than
 * imported from `uiContext`, because this module is what decides whether a
 * string off a stranger's disk is allowed to become one.
 */
const KNOWN: readonly string[] = ['ay2024', 'ay2025', 'ay2026'];

/**
 * A cohort key, or undefined when the file names one this app does not have.
 *
 * This used to be a bare `as Curriculum` cast, which is fine while the caller
 * only ever writes into the tab you are already on. It stopped being fine when
 * the file started deciding the tab: a hand-edited `"curriculum": "ay2099"`
 * reached `setFreshmoreMode`, `importPlans` dropped the key it did not
 * recognise, and the next render read `plans['ay2099'].selectedMods` and threw.
 * `freshmoreMode` is persisted, so the crash came back on reload and the panel
 * stayed dead.
 */
export function migrateCurriculum(c: string | undefined): Curriculum | undefined {
  if (c === LEGACY_CURRICULUM) return CURRENT_FOR_LEGACY;
  return c !== undefined && KNOWN.includes(c) ? (c as Curriculum) : undefined;
}

/** Rename the `classic` key in a plans map, leaving everything else alone. */
export function migratePlans<T>(plans: Record<string, T>): Record<string, T> {
  if (!plans || !(LEGACY_CURRICULUM in plans)) return plans;
  const { [LEGACY_CURRICULUM]: legacy, ...rest } = plans;
  // A plan already under the new name wins: it is the one being edited.
  return { [CURRENT_FOR_LEGACY]: legacy, ...rest } as Record<string, T>;
}

/**
 * Whether a record holds anything a reader would miss.
 *
 * A record is created by opening a mod's card, and the freshmore core seeds its
 * components from the catalogue's grading table, so most records are the shape
 * the app made rather than anything the student wrote. Notes, or a score
 * somebody typed, is the whole of what is theirs.
 */
export function hasContent(v: unknown): boolean {
  const r = v as { notes?: string; components?: Array<{ score?: number | null }> } | undefined;
  if (typeof r?.notes === 'string' && r.notes.trim()) return true;
  return (r?.components ?? []).some((c) => c && c.score !== null && c.score !== undefined);
}

/**
 * Records for `codes`, and only the ones carrying something.
 *
 * Both halves matter. Without the code filter an export is the whole browser;
 * without the content filter it is every chip the reader hovered, which made
 * exporting the same plan twice produce different files.
 */
export function recordsFor(records: RecordsState, codes: string[]): RecordsState {
  const keep = new Set(codes);
  const out: RecordsState = {} as RecordsState;
  for (const [code, v] of Object.entries(records ?? {})) {
    if (keep.has(code) && hasContent(v)) (out as Record<string, unknown>)[code] = v;
  }
  return out;
}

/**
 * `pinned` is the freshmore core for this cohort.
 *
 * Required, and not optional with a default, because forgetting it loses data
 * silently: the core is pinned into terms 1 to 3 from `data/freshmore.json` and
 * is never in `plan.selectedMods`, yet its chips carry the same record form as
 * any other. Filtering the export on `selectedMods` alone dropped every score
 * and note a student had written against 10.013, and the file still looked
 * complete.
 */
export function buildPlanFile(
  curriculum: Curriculum,
  plan: PlanState,
  declared: string[],
  records: RecordsState,
  pinned: string[],
): PlanFile {
  return {
    kind: PLAN_FILE_KIND,
    version: PLAN_FILE_VERSION,
    curriculum,
    exportedAt: new Date().toISOString(),
    plan,
    declared,
    records: recordsFor(records, [...(plan?.selectedMods ?? []), ...pinned]),
  };
}

/**
 * The records in `read` that this cohort is allowed to receive.
 *
 * A file can name any course code it likes. The planned mods come from the file
 * and are the student's own, but the freshmore core does NOT: it is read out of
 * `data/freshmore.json` for the cohort, so a file cannot add to it, reorder it
 * or swap a course out of it. The only thing an import may do to a core mod is
 * replace the editable part, which is the record.
 *
 * So an incoming record is kept when its code is in the imported plan or in
 * this cohort's core, and dropped otherwise. Records for anything else were
 * being merged into the store wholesale.
 */
export function importableRecords(
  incoming: RecordsState,
  planned: string[],
  core: string[],
): RecordsState {
  return recordsFor(incoming, [...planned, ...core]);
}

export interface ReadPlan {
  curriculum: Curriculum;
  plan: PlanState;
  declared: string[];
  records: RecordsState;
  /** True when the file was a whole-browser backup from before this format. */
  legacy: boolean;
}

/**
 * Read either shape.
 *
 * The old button wrote a full backup and people have those files. Refusing
 * them would make the app lose data a student is holding in their hand, so a
 * full backup is read as "the plan for the tab I am on" - `into` - and the
 * rest of it is left alone.
 */
export function readPlanFile(raw: unknown, into: Curriculum): ReadPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  if (o.kind === PLAN_FILE_KIND && o.plan) {
    return {
      curriculum: migrateCurriculum(o.curriculum as string) ?? into,
      plan: o.plan as PlanState,
      declared: Array.isArray(o.declared) ? (o.declared as string[]) : [],
      records: (o.records ?? {}) as RecordsState,
      legacy: false,
    };
  }

  // The old full backup: { records, plans: { ay2026, ay2025, classic }, ... }
  const plans = o.plans as Record<string, PlanState> | undefined;
  if (plans && typeof plans === 'object') {
    const migrated = migratePlans(plans);
    // EMPTY, never another cohort's. `Object.values(migrated)[0]` was here, so
    // a backup holding only an AY2025 plan, imported on the AY2026 tab, quietly
    // installed the AY2025 plan as though it were yours. Whichever key happened
    // to be first in the file decided it. A cohort you have no plan for
    // imports as no plan.
    const plan = migrated[into] ?? { selectedMods: [], planLevels: {} };
    return {
      curriculum: into,
      plan,
      declared: Array.isArray(o.declared) ? (o.declared as string[]) : [],
      records: (o.records ?? {}) as RecordsState,
      legacy: true,
    };
  }
  return null;
}
