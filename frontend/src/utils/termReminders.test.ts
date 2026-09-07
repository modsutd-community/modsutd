import { describe, it, expect } from 'vitest';
import { reminderDates, buildTermReminderEvents } from './termReminders';
import type { TermCalendar } from './termCalendar';
import CAL from '../../../data/term-calendar.json';

const cal = CAL as unknown as TermCalendar;
const TERM_START = '2026-09-14';

describe('review reminder dates', () => {
  // SUTD numbers the recess week as week 7, so counting six weeks off the term
  // start lands the midterm nudge on Fri 30 Oct 2026, inside the break. Both
  // reminders come off the published teaching weeks now.
  it('puts the midterm nudge at the end of the last teaching week before recess', () => {
    expect(reminderDates({ termStartISO: TERM_START, cal }).midterm).toBe('2026-10-23');
  });

  it('never lands a reminder inside recess week', () => {
    const { midterm, final } = reminderDates({ termStartISO: TERM_START, cal });
    for (const d of [midterm, final]) {
      expect(d < '2026-10-25' || d > '2026-11-01').toBe(true);
    }
  });

  it('puts the end-of-term nudge at the end of the last teaching week', () => {
    expect(reminderDates({ termStartISO: TERM_START, cal }).final).toBe('2026-12-18');
  });

  // A term the calendar does not cover still gets reminders, from the old
  // arithmetic, rather than none at all.
  it('falls back to counting weeks when there is no calendar', () => {
    expect(reminderDates({ termStartISO: TERM_START, cal: null }))
      .toEqual({ midterm: '2026-10-30', final: '2026-12-18' });
  });

  it('carries the dates into the built events', () => {
    const evs = buildTermReminderEvents({ termLabel: 'Term 1, AY2026/27', termStartISO: TERM_START, cal });
    expect(evs.map((e) => e.startDate)).toEqual(['2026-10-23', '2026-12-18']);
  });
});
