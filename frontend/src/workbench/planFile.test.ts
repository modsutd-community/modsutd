// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  buildPlanFile, readPlanFile, migratePlans, migrateCurriculum, PLAN_FILE_KIND,
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
