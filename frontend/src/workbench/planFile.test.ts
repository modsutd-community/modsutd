// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  buildPlanFile, readPlanFile, migratePlans, migrateCurriculum, hasContent,
  importableRecords, PLAN_FILE_KIND,
} from './planFile';
import type { PlanState, RecordsState } from '@/types';

const plan = (mods: string[]): PlanState => ({
  selectedMods: mods,
  planLevels: Object.fromEntries(mods.map((m) => [m, 4])),
});

const records = {
  '50.040': { notes: 'kept' },
  '99.999': { notes: 'dropped' },
} as unknown as RecordsState;

describe('the plan file is scoped to one matriculation year', () => {
  it('writes the tab it was exported from, not the whole browser', () => {
    const f = buildPlanFile('ay2025', plan(['50.040']), ['csd-ai'], records, []);
    expect(f.kind).toBe(PLAN_FILE_KIND);
    expect(f.curriculum).toBe('ay2025');
    expect(f.plan.selectedMods).toEqual(['50.040']);
    expect(f.declared).toEqual(['csd-ai']);
    // No timetable, no contributed slots, no other curriculum's plan.
    expect(f).not.toHaveProperty('timetable');
    expect(f).not.toHaveProperty('contributed');
    expect(f).not.toHaveProperty('plans');
  });

  it('carries records for the mods in the plan and no others', () => {
    const f = buildPlanFile('ay2025', plan(['50.040']), [], records, []);
    expect(Object.keys(f.records)).toEqual(['50.040']);
  });

  it('round-trips', () => {
    const f = buildPlanFile('ay2026', plan(['50.001', '50.002']), ['x'], records, []);
    const back = readPlanFile(JSON.parse(JSON.stringify(f)), 'ay2026')!;
    expect(back.curriculum).toBe('ay2026');
    expect(back.plan.selectedMods).toEqual(['50.001', '50.002']);
    expect(back.legacy).toBe(false);
  });
});

// People have the old whole-browser backups on disk right now. Refusing them
// would lose data a student is holding in their hand.
describe('files written before this format', () => {
  const oldBackup = {
    records,
    declared: ['csd-ai'],
    timetable: [{ modCode: '50.040' }],
    contributed: { '50.040': {} },
    plans: { ay2026: plan([]), ay2025: plan(['50.007']), classic: plan(['10.013']) },
  };

  it('reads a whole-browser backup into the tab you are on', () => {
    const read = readPlanFile(oldBackup, 'ay2025')!;
    expect(read.legacy).toBe(true);
    expect(read.curriculum).toBe('ay2025');
    expect(read.plan.selectedMods).toEqual(['50.007']);
  });

  // `classic` was renamed to `ay2024`. A plan stored under the old key has to
  // keep working, in a file and in a synced gist alike.
  it('finds a plan saved under the old `classic` key', () => {
    const read = readPlanFile(oldBackup, 'ay2024')!;
    expect(read.plan.selectedMods).toEqual(['10.013']);
  });

  it('renames the key without disturbing the others', () => {
    expect(migratePlans({ classic: 1, ay2025: 2 })).toEqual({ ay2024: 1, ay2025: 2 });
    expect(migratePlans({ ay2025: 2 })).toEqual({ ay2025: 2 });
    expect(migrateCurriculum('classic')).toBe('ay2024');
    expect(migrateCurriculum('ay2026')).toBe('ay2026');
  });

  it('refuses something that is not a plan at all', () => {
    expect(readPlanFile({ nope: true }, 'ay2025')).toBeNull();
    expect(readPlanFile(null, 'ay2025')).toBeNull();
  });
});

// The freshmore core is pinned into terms 1 to 3 from data/freshmore.json and is
// never in selectedMods, yet its chips carry the same record form as any other.
// Filtering the export on selectedMods alone threw those records away and the
// file still looked complete.
describe('records for the pinned freshmore core', () => {
  const withCore = {
    '50.040': { notes: 'planned mod' },
    '10.013': { notes: 'freshmore core, scored' },
    '99.999': { notes: 'neither' },
  } as unknown as RecordsState;

  it('keeps a record for a pinned mod that is not in selectedMods', () => {
    const f = buildPlanFile('ay2024', plan(['50.040']), [], withCore, ['10.013']);
    expect(Object.keys(f.records).sort()).toEqual(['10.013', '50.040']);
  });

  it('still drops a record for a mod that is neither planned nor pinned', () => {
    const f = buildPlanFile('ay2024', plan(['50.040']), [], withCore, ['10.013']);
    expect(f.records).not.toHaveProperty('99.999');
  });
});

// A whole-browser backup that has no plan for the tab you are on used to fall
// back to Object.values(migrated)[0], so whichever cohort happened to be first
// in the file was installed as yours.
describe('a backup with no plan for this tab', () => {
  const onlyAy2025 = {
    records,
    declared: [],
    plans: { ay2025: plan(['50.007']) },
  };

  it('imports empty rather than borrowing another cohort', () => {
    const read = readPlanFile(onlyAy2025, 'ay2026')!;
    expect(read.legacy).toBe(true);
    expect(read.curriculum).toBe('ay2026');
    expect(read.plan.selectedMods).toEqual([]);
  });

  it('still finds the plan when the tab does have one', () => {
    const read = readPlanFile(onlyAy2025, 'ay2025')!;
    expect(read.plan.selectedMods).toEqual(['50.007']);
  });
});

// The import handler needs to know which tab a file came from, so the mismatch
// it warns about has to survive readPlanFile.
describe('a plan file says which tab it was exported from', () => {
  it('keeps the exporting cohort when it differs from the tab you are on', () => {
    const f = buildPlanFile('ay2025', plan(['50.007']), [], records, []);
    const read = readPlanFile(JSON.parse(JSON.stringify(f)), 'ay2026')!;
    expect(read.curriculum).toBe('ay2025');
    expect(read.legacy).toBe(false);
  });

  it('a whole-browser backup names no cohort, so it takes the tab you are on', () => {
    const read = readPlanFile(onlyPlans, 'ay2026')!;
    expect(read.curriculum).toBe('ay2026');
    expect(read.legacy).toBe(true);
  });
});

const onlyPlans = { records, declared: [], plans: { ay2026: plan(['50.001']) } };

// The file decides which tab an import lands on, so a cohort key off a
// stranger's disk decides which tab the app switches to. An unknown one used to
// be cast straight through, reach setFreshmoreMode, and leave the panel reading
// plans[thatKey].selectedMods on every render - persisted, so a reload did not
// clear it.
describe('a cohort key this app does not have', () => {
  it('falls back to the tab you are on rather than being cast through', () => {
    const f = {
      kind: PLAN_FILE_KIND, version: 1, curriculum: 'ay2099',
      exportedAt: '', plan: plan(['50.001']), declared: [], records: {},
    };
    const read = readPlanFile(f, 'ay2026')!;
    expect(read.curriculum).toBe('ay2026');
    expect(read.plan.selectedMods).toEqual(['50.001']);
  });

  it('rejects it from migrateCurriculum directly, and keeps the real ones', () => {
    expect(migrateCurriculum('ay2099')).toBeUndefined();
    expect(migrateCurriculum('')).toBeUndefined();
    expect(migrateCurriculum(undefined)).toBeUndefined();
    expect(migrateCurriculum('classic')).toBe('ay2024');
    expect(migrateCurriculum('ay2026')).toBe('ay2026');
  });
});

// Opening a mod's card creates a record, and the freshmore core seeds its
// components from the catalogue, so most records are the shape the app made
// rather than anything the student wrote. Exporting those made the same plan
// produce a different file depending on which chips had been hovered.
describe('an export carries what was written, not what was looked at', () => {
  const touched = {
    '10.018': { notes: '', components: [] },
    '10.015': { notes: '', components: [{ name: 'Quiz 1', weight: 20, score: null }] },
    '10.014': { notes: 's', components: [] },
    '10.013': { notes: '  ', components: [{ name: 'Quiz 1', weight: 20, score: 18 }] },
  } as unknown as RecordsState;

  it('drops a record with no notes and no score', () => {
    expect(hasContent(touched['10.018'])).toBe(false);
    expect(hasContent(touched['10.015'])).toBe(false);
  });

  it('keeps notes, and keeps a score even when the notes are blank', () => {
    expect(hasContent(touched['10.014'])).toBe(true);
    expect(hasContent(touched['10.013'])).toBe(true);
  });

  it('exports only those two, however many chips were opened', () => {
    const core = ['10.013', '10.014', '10.015', '10.018'];
    const f = buildPlanFile('ay2024', plan([]), [], touched, core);
    expect(Object.keys(f.records).sort()).toEqual(['10.013', '10.014']);
  });
});

// The plan comes from the file. The freshmore core does not: it is read out of
// data/freshmore.json for the cohort, so a file may replace a core mod's record
// and nothing else about the core.
describe('an import may only bring records this cohort can hold', () => {
  const incoming = {
    '50.001': { notes: 'planned', components: [] },
    '10.013': { notes: 'core', components: [] },
    '99.123': { notes: 'not taking this', components: [] },
  } as unknown as RecordsState;

  it('keeps the planned mod and the core mod, drops the stranger', () => {
    const kept = importableRecords(incoming, ['50.001'], ['10.013']);
    expect(Object.keys(kept).sort()).toEqual(['10.013', '50.001']);
  });

  it('drops everything when the cohort core has not loaded and nothing is planned', () => {
    expect(Object.keys(importableRecords(incoming, [], []))).toEqual([]);
  });
});
