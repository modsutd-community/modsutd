import type { Curriculum, PlanState, RecordsState } from '@/types';

// Everything the plan knows, in one exportable blob: records, both
// curricula's plans, and declared tracks. Old exports were bare
// RecordsState - importers accept both shapes.
export interface BackupBundle {
  records: RecordsState;
  plans: Record<Curriculum, PlanState>;
  declared: string[];
}

export function isBundle(x: unknown): x is BackupBundle {
  return !!x && typeof x === 'object' && 'records' in (x as Record<string, unknown>)
    && 'plans' in (x as Record<string, unknown>);
}
