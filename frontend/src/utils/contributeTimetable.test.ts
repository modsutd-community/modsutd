import { describe, expect, it } from 'vitest';
import { eventsToSlots, isSampleTimetable } from './contributeTimetable';
describe('eventsToSlots gate parity with the relay', () => {
  const base = {
    modName: 'x', day: 'Monday' as const, startTime: '09:00', endTime: '11:00',
    instructors: [], startDate: '2026-09-14', endDate: '2026-09-14',
  };

  it('drops a slot whose type the relay would reject', () => {
    const slots = eventsToSlots([
      { ...base, modCode: '30.111', type: 'CBL', location: '2.507' },
      { ...base, modCode: '30.111', type: 'Cohort', location: '2.507' },
    ]);
    expect(slots).toHaveLength(1);
    expect(slots[0].type).toBe('Cohort');
  });

  // A suffixed code is its OWN mod and must never be folded into the base one.
  // It used to be dropped here to guarantee that, which also threw away
  // 03.007A and 03.007B - one course SUTD split in two, both freshmore core.
  // What actually guarantees it is fold_slots.py, which writes only to a course
  // file that already exists: `if not path.exists(): skipped`. So an unknown
  // suffixed code costs nothing, and a known one finally arrives.
  it('keeps a suffixed course code as its own mod, never the base one', () => {
    const slots = eventsToSlots([
      { ...base, modCode: '03.007A', type: 'Lab', location: '1.611' },
      { ...base, modCode: '50.002X', type: 'Lab', location: '1.611' },
    ]);
    expect(slots.map((s) => s.mod)).toEqual(['03.007A', '50.002X']);
    expect(slots.map((s) => s.mod)).not.toContain('03.007');
    expect(slots.map((s) => s.mod)).not.toContain('50.002');
  });
});

describe('sample timetable guard', () => {
  it('recognises the shipped sample by its marker', async () => {
    const { SAMPLE_LIST_VIEW } = await import('./sampleTimetable');
    expect(isSampleTimetable(SAMPLE_LIST_VIEW)).toBe(true);
    expect(isSampleTimetable('30 .111 - Entrepreneurship')).toBe(false);
  });
});
