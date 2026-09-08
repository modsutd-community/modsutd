import { describe, it, expect } from 'vitest';
import { expandWeekToTerm, termFor } from './termCalendar';
import type { TermCalendar } from './termCalendar';
import type { TimetableEvent } from '@/types';
import CAL from '../../../data/term-calendar.json';

const cal = CAL as unknown as TermCalendar;

const ev = (day: TimetableEvent['day'], date: string): TimetableEvent => ({
  modCode: '01.400', modName: 'Capstone 1', type: 'Cohort', day,
  startTime: '08:30', endTime: '11:30', location: '1.411',
  instructors: [], startDate: date, endDate: date,
});

describe('expandWeekToTerm', () => {
  it('turns one pasted week into every teaching week', () => {
    // Tuesday of week 1. 13 teaching weeks, none of them a Tuesday holiday.
    const { events, weeks } = expandWeekToTerm([ev('Tuesday', '2026-09-15')], cal);
    expect(weeks).toBe(13);
    expect(events[0].occurrences).toHaveLength(13);
    expect(events[0].occurrences?.[0]).toBe('2026-09-15');
    expect(events[0].endDate).toBe('2026-12-15');
  });

  // Week 7 IS the recess week at SUTD, 25 Oct to 1 Nov 2026. A blind weekly
  // repeat puts a full week of classes on a calendar during a break.
  it('never places a class in recess week', () => {
    const { events } = expandWeekToTerm([ev('Tuesday', '2026-09-15')], cal);
    for (const d of events[0].occurrences ?? []) {
      expect(d < '2026-10-25' || d > '2026-11-01').toBe(true);
    }
    expect(events[0].occurrences).not.toContain('2026-10-27');
  });

  // Deepavali falls Sunday 8 Nov 2026, so Monday 9 Nov is the holiday in lieu,
  // and it lands inside teaching week 9.
  it('drops the Monday that is a public holiday, and only that Monday', () => {
    const { events, skipped } = expandWeekToTerm([ev('Monday', '2026-09-14')], cal);
    expect(events[0].occurrences).not.toContain('2026-11-09');
    expect(events[0].occurrences).toHaveLength(12);
    expect(skipped).toEqual(['2026-11-09']);
    // the rest of that week is unaffected
    const tue = expandWeekToTerm([ev('Tuesday', '2026-09-15')], cal);
    expect(tue.events[0].occurrences).toContain('2026-11-10');
  });

  it('leaves a week from an unknown term exactly as it was', () => {
    const one = ev('Tuesday', '2029-01-09');
    const { events, weeks } = expandWeekToTerm([one], cal);
    expect(events[0]).toEqual(one);
    expect(weeks).toBe(1);
  });

  it('leaves a week alone when there is no calendar at all', () => {
    const one = ev('Tuesday', '2026-09-15');
    expect(expandWeekToTerm([one], null).events[0]).toEqual(one);
  });

  it('finds the term a date sits in', () => {
    // One trimester hosts several terms at once - the September one runs
    // terms 1, 7 and 9 off the same Mondays - so the label names them all and
    // the numbers are the thing to assert on.
    const t = termFor('2026-09-15', cal);
    expect(t?.terms).toContain(1);
    expect(t?.label).toContain('AY2026/27');
    // The gap between the August trimester ending and the September one
    // starting belongs to no term.
    expect(termFor('2026-08-30', cal)).toBeNull();
  });

  // The file is generated from SUTD's page, so these are the invariants the
  // generator has to keep rather than facts about one particular term.
  it('is shaped the way a generated calendar has to be', () => {
    expect(cal.terms.length).toBeGreaterThan(3);
    for (const t of cal.terms) {
      expect(t.terms?.length).toBeGreaterThan(0);
      // Week 7 is the recess week at SUTD. A generator that emits it as a
      // teaching week puts a fortnight of classes inside the break.
      expect(t.teachingWeeks.map((w) => w.week)).not.toContain(7);
      for (const w of t.teachingWeeks) {
        const [y, m, d] = w.monday.split('-').map(Number);
        expect(new Date(Date.UTC(y, m - 1, d)).getUTCDay()).toBe(1);
      }
      expect(t.lastDay > t.weekOneMonday).toBe(true);
    }
  });
});

describe('an atypical week is called out, because the term is a copy of it', () => {
  // Paste the week of Mon 9 Nov and the Monday column is blank, because that is
  // Deepavali. Copy that week across the term and Monday classes are gone from
  // all of it - the worst kind of wrong, because nothing on screen looks missing.
  it('flags a pasted week that contains a public holiday', () => {
    const r = expandWeekToTerm([ev('Tuesday', '2026-11-10')], cal);
    expect(r.sourceWeek).toBe(9);
    expect(r.atypical?.reason).toBe('holiday');
    expect(r.atypical?.detail).toMatch(/Deepavali/);
  });

  it('flags week 1, which often carries a session that never repeats', () => {
    const r = expandWeekToTerm([ev('Tuesday', '2026-09-15')], cal);
    expect(r.sourceWeek).toBe(1);
    expect(r.atypical?.reason).toBe('first-week');
  });

  it('says nothing about an ordinary week', () => {
    const r = expandWeekToTerm([ev('Tuesday', '2026-11-17')], cal);
    expect(r.sourceWeek).toBe(10);
    expect(r.atypical).toBeNull();
  });
});
