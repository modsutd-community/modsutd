import { describe, it, expect } from 'vitest';
import { reminderDates, buildTermReminderEvents } from './termReminders';
import type { TermCalendar } from './termCalendar';
import CAL from '../../../data/term-calendar.json';

const cal = CAL as unknown as TermCalendar;
const TERM_START = '2026-09-14';

describe('review reminder dates', () => {
  // The mid-term evaluation opens Monday of week 4 and runs through Sunday
  // of week 5.
  it('spans the midterm reminder from Monday of week 4 to Sunday of week 5', () => {
    const dates = reminderDates({ termStartISO: TERM_START, cal });
    expect(dates.midtermStart).toBe('2026-10-05');
    expect(dates.midtermEnd).toBe('2026-10-18');
  });

  it('never lands a reminder inside recess week', () => {
    const { midtermStart, midtermEnd, final } = reminderDates({ termStartISO: TERM_START, cal });
    for (const d of [midtermStart, midtermEnd, final]) {
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

  // A term the calendar does not cover still gets reminders, from arithmetic,
  // rather than none at all.
  it('falls back to counting weeks when there is no calendar', () => {
    expect(reminderDates({ termStartISO: TERM_START, cal: null }))
      .toEqual({
        midterm: '2026-10-05',
        midtermStart: '2026-10-05',
        midtermEnd: '2026-10-18',
        final: '2026-11-23',
      });
  });

  it('carries the dates into the built events pointing location to /share', () => {
    const evs = buildTermReminderEvents({ termLabel: 'Term 1, AY2026/27', termStartISO: TERM_START, cal });
    expect(evs.map((e) => e.startDate)).toEqual(['2026-10-05', '2026-11-23']);
    expect(evs[0].endDate).toBe('2026-10-18');
    expect(evs[0].allDay).toBe(true);
    expect(evs[0].location).toBe('https://modsutd.tech/share');
    expect(evs[1].location).toBe('https://modsutd.tech/share');
  });

  it('says which eval it means, and where the real deadline lives', () => {
    const evs = buildTermReminderEvents({ termLabel: 'Term 1, AY2026/27', termStartISO: TERM_START, cal });
    expect(evs[0].modName).toBe('Reminder to do your Mid-term eval (if any) with modSUTD!');
    expect(evs[1].modName).toBe('Reminder to do your Final eval (if any) with modSUTD!');
    expect(evs[0].instructors[0]).toBe('Mid-term evals. Please check your mod / Outlook for the actual deadline.');
    expect(evs[1].instructors[0]).toBe('Final evals. Please check your mod / Outlook for the actual deadline.');
    for (const e of evs) {
      // No code and no type, so the title is not prefixed or suffixed with
      // anything in the exported SUMMARY.
      expect(e.modCode).toBe('');
      expect(e.type).toBe('');
    }
  });
});
