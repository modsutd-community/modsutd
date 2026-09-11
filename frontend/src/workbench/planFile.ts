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
  /** The tab this came from. An import lands here, not wherever you happen to be. */
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

export function migrateCurriculum(c: string | undefined): Curriculum {
  return (c === LEGACY_CURRICULUM ? CURRENT_FOR_LEGACY : c) as Curriculum;
}

/** Rename the `classic` key in a plans map, leaving everything else alone. */
export function migratePlans<T>(plans: Record<string, T>): Record<string, T> {
  if (!plans || !(LEGACY_CURRICULUM in plans)) return plans;
  const { [LEGACY_CURRICULUM]: legacy, ...rest } = plans;
  // A plan already under the new name wins: it is the one being edited.
  return { [CURRENT_FOR_LEGACY]: legacy, ...rest } as Record<string, T>;
}

function recordsFor(records: RecordsState, codes: string[]): RecordsState {
  const keep = new Set(codes);
  const out: RecordsState = {} as RecordsState;
  for (const [code, v] of Object.entries(records ?? {})) {
    if (keep.has(code)) (out as Record<string, unknown>)[code] = v;
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
    const plan = migrated[into] ?? Object.values(migrated)[0];
    if (!plan) return null;
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
