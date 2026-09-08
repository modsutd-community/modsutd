import { downloadICS } from './icsGenerator';
import { termFor } from './termCalendar';
import type { TermCalendar } from './termCalendar';
import type { TimetableEvent } from '@/types';

// Two opt-in calendar reminders pointing back at /share, timed to when SUTD's
// own evals open: the end of the last teaching week before recess, and the
// Monday of week 11.
//
// Week 11 is where the final eval actually opens, which is neither the last
// teaching week nor the last week of term - both of which this used to guess
// and both of which land after the window has closed.
//
// Counting weeks off the term start does not give the midterm either. SUTD
// numbers the recess week as week 7, so "week 7 Friday" is 30 Oct 2026, inside
// the break, when nobody is on campus. Read the teaching weeks out of the
// published calendar, and fall back to arithmetic only when there is none.

const SHARE_URL = (origin: string) => `${origin}/share`;

/** Where the final eval opens. Not the last teaching week - that is week 14. */
const FINAL_EVAL_WEEK = 11;

function addDays(iso: string, days: number): string {
  // No Date(iso) parse - it applies the user's local timezone, which
  // would shift the date mid-flight.
  const [y, m, d] = iso.split('-').map(Number);
  const epoch = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(epoch);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${z(dt.getUTCMonth() + 1)}-${z(dt.getUTCDate())}`;
}

interface ReminderInput {
  termLabel: string;       // e.g. "Term 1, AY2026/27"
  termStartISO: string;    // ISO date of Monday of week 1, e.g. "2026-09-14"
  origin?: string;         // window.location.origin in browser; default modsutd.tech
  cal?: TermCalendar | null;
}

/** Friday of the week that starts on this Monday. */
const fridayOf = (monday: string) => addDays(monday, 4);

export function reminderDates({ termStartISO, cal }: Pick<ReminderInput, 'termStartISO' | 'cal'>):
{ midterm: string; final: string } {
  const term = termFor(termStartISO, cal ?? null);
  const weeks = term?.teachingWeeks ?? [];
  if (weeks.length) {
    const firstBreak = term?.breaks?.[0]?.from;
    const beforeBreak = firstBreak ? weeks.filter((w) => w.monday < firstBreak) : weeks;
    const midWeek = beforeBreak[beforeBreak.length - 1] ?? weeks[0];
    // By number, not by position: recess is week 7 and is not a teaching week,
    // so week 11 is the tenth entry in this list, and counting from the end
    // gives a different week whenever a term runs long or short.
    const w11 = weeks.find((w) => w.week === FINAL_EVAL_WEEK);
    return {
      midterm: fridayOf(midWeek.monday),
      final: (w11 ?? weeks[weeks.length - 1]).monday,
    };
  }
  // No calendar. Week numbers are continuous across recess, so week 11's Monday
  // is ten weeks after week 1's even though only nine of them are taught.
  return {
    midterm: addDays(termStartISO, 6 * 7 + 4),
    final: addDays(termStartISO, (FINAL_EVAL_WEEK - 1) * 7),
  };
}

export function buildTermReminderEvents({ termStartISO, origin = 'https://modsutd.tech', cal = null }: ReminderInput): TimetableEvent[] {
  const url = SHARE_URL(origin);
  const { midterm, final } = reminderDates({ termStartISO, cal });

  // day/startTime describe a one-off dated event here, not a weekly slot: the
  // midterm lands on a Friday and the final on a Monday, so the two differ.
  const mk = (
    date: string,
    day: TimetableEvent['day'],
    which: 'Mid-term' | 'Final',
  ): TimetableEvent => ({
    // No code, so the reminder owns its whole title - the summary is built from
    // the non-empty parts.
    modCode: '',
    modName: `Reminder to do your ${which} eval (if any) with modSUTD!`,
    type: '',
    day,
    startTime: '17:00',
    endTime: '17:30',
    location: url,
    // Named in the body too. Two events a month apart whose descriptions read
    // identically are two events a reader cannot tell apart in a calendar,
    // where the title is often all that is shown until one is opened.
    instructors: [
      `${which} evals. Please check your mod for the actual deadline.`,
    ],
    startDate: date,
    endDate: date,
  });

  return [mk(midterm, 'Friday', 'Mid-term'), mk(final, 'Monday', 'Final')];
}

export function downloadTermReminders(input: ReminderInput) {
  const events = buildTermReminderEvents(input);
  const safe = input.termLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  downloadICS(events, `modsutd-${safe}-reminders`);
}
