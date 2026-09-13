import { describe, it, expect } from 'vitest';
import { buildAvailability } from './loadData';
import type { Mod, Schedule } from '@/types';

const slot = (over: Partial<Schedule> = {}): Schedule => ({
  type: 'Cohort',
  day: 'Monday',
  startTime: '11:30',
  endTime: '13:00',
  location: '2.404',
  instructors: [],
  ...over,
});

const mod = (code: string, schedules: Schedule[]): Mod =>
  ({ code, name: `course ${code}`, schedules } as unknown as Mod);

describe('rolling schedules up into room availability', () => {
  // A room is busy once, however many classes are sitting in it. SUTD runs a
  // large CBL as two sections in one lecture theatre, each its own schedule
  // entry with its own cohort - and a room has no cohort, so the hour would
  // otherwise draw the same mod twice.
  it('counts one class once when two sections share the room', () => {
    const av = buildAvailability([
      mod('50.046', [slot({ cohort: 'CI01' }), slot({ cohort: 'CI02' })]),
    ]);
    expect(av['2.404'].schedule).toHaveLength(1);
    expect(av['2.404'].schedule[0].modCode).toBe('50.046');
  });

  it('keeps two different mods in the same room at the same hour', () => {
    const av = buildAvailability([
      mod('50.046', [slot()]),
      mod('02.143', [slot()]),
    ]);
    expect(av['2.404'].schedule.map((s) => s.modCode).sort())
      .toEqual(['02.143', '50.046']);
  });

  it('keeps the same mod at two different hours', () => {
    const av = buildAvailability([
      mod('50.046', [slot(), slot({ startTime: '14:00', endTime: '16:00' })]),
    ]);
    expect(av['2.404'].schedule).toHaveLength(2);
  });

  // A cohort split across two think tanks occupies both, so one schedule per
  // room is the shape the enrolment import writes.
  it('puts a class in every room it is given', () => {
    const av = buildAvailability([
      mod('50.006', [slot({ location: '1.415' }), slot({ location: '1.416' })]),
    ]);
    expect(Object.keys(av).sort()).toEqual(['1.415', '1.416']);
  });
});
