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

  it('drops a suffixed course code rather than folding it into the base mod', () => {
    const slots = eventsToSlots([
      { ...base, modCode: '50.002X', type: 'Lab', location: '1.611' },
    ]);
    expect(slots).toEqual([]);
  });
});

describe('sample timetable guard', () => {
  it('recognises the shipped sample by its marker', async () => {
    const { SAMPLE_LIST_VIEW } = await import('./sampleTimetable');
    expect(isSampleTimetable(SAMPLE_LIST_VIEW)).toBe(true);
    expect(isSampleTimetable('30 .111 - Entrepreneurship')).toBe(false);
  });
});
