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

  // The final eval opens in week 11, not at the end of term. Aiming at the last
  // teaching week (18 Dec) put the nudge weeks after the window had closed.
  it('puts the end-of-term nudge on the Monday of week 11', () => {
    expect(reminderDates({ termStartISO: TERM_START, cal }).final).toBe('2026-11-23');
  });

  // Recess is week 7 and carries no teaching week, so week 11 is the TENTH
  // entry in the list. Picking by position would drift a week.
  it('picks week 11 by its number, not by counting entries', () => {
    const w11 = cal.terms
      .find((t) => t.weekOneMonday === TERM_START)!
      .teachingWeeks.find((w) => w.week === 11)!;
    expect(reminderDates({ termStartISO: TERM_START, cal }).final).toBe(w11.monday);
  });

  // A term the calendar does not cover still gets reminders, from the old
  // arithmetic, rather than none at all.
  it('falls back to counting weeks when there is no calendar', () => {
    expect(reminderDates({ termStartISO: TERM_START, cal: null }))
      .toEqual({ midterm: '2026-10-30', final: '2026-11-23' });
  });

  it('carries the dates into the built events', () => {
    const evs = buildTermReminderEvents({ termLabel: 'Term 1, AY2026/27', termStartISO: TERM_START, cal });
    expect(evs.map((e) => e.startDate)).toEqual(['2026-10-23', '2026-11-23']);
    // One is a Friday and the other a Monday, so the day cannot be a constant.
    expect(evs.map((e) => e.day)).toEqual(['Friday', 'Monday']);
  });

  it('says which eval it means, and where the real deadline lives', () => {
    const evs = buildTermReminderEvents({ termLabel: 'Term 1, AY2026/27', termStartISO: TERM_START, cal });
    expect(evs[0].modName).toBe('Reminder to do your Mid-term eval (if any) with modSUTD!');
    expect(evs[1].modName).toBe('Reminder to do your Final eval (if any) with modSUTD!');
    // The body names the eval too: in a calendar the description is often all
    // you see once an event is open, and two identical ones are unreadable.
    expect(evs[0].instructors[0]).toBe('Mid-term evals. Please check your mod for the actual deadline.');
    expect(evs[1].instructors[0]).toBe('Final evals. Please check your mod for the actual deadline.');
    expect(evs[0].instructors[0]).not.toBe(evs[1].instructors[0]);
    for (const e of evs) {
      // No code and no type, so the title is not prefixed or suffixed with
      // anything in the exported SUMMARY.
      expect(e.modCode).toBe('');
      expect(e.type).toBe('');
    }
  });
});
