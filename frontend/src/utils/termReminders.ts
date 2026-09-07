import { downloadICS } from './icsGenerator';
import { termFor } from './termCalendar';
import type { TermCalendar } from './termCalendar';
import type { TimetableEvent } from '@/types';

// Two opt-in calendar reminders pointing back at /share, timed to when
// SUTD's own evals nudge students anyway: the end of the last teaching week
// before recess, and the end of the last teaching week of the term.
//
// Counting weeks off the term start does not give either. SUTD numbers the
// recess week as week 7, so "week 7 Friday" is 30 Oct 2026 - inside the
// break, when nobody is on campus and no eval is open. Read the teaching
// weeks out of the published calendar instead, and fall back to the old
// arithmetic only when there is no calendar for the term.

const SHARE_URL = (origin: string) => `${origin}/share`;

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
    return { midterm: fridayOf(midWeek.monday), final: fridayOf(weeks[weeks.length - 1].monday) };
  }
  return {
    midterm: addDays(termStartISO, 6 * 7 + 4),
    final: addDays(termStartISO, 13 * 7 + 4),
  };
}

export function buildTermReminderEvents({ termLabel, termStartISO, origin = 'https://modsutd.tech', cal = null }: ReminderInput): TimetableEvent[] {
  const url = SHARE_URL(origin);
  const { midterm, final } = reminderDates({ termStartISO, cal });

  const mk = (date: string, name: string, body: string): TimetableEvent => ({
    modCode: 'modSUTD',
    modName: name,
    type: 'Reminder',
    day: 'Friday',
    startTime: '17:00',
    endTime: '17:30',
    location: url,
    instructors: [body],
    startDate: date,
    endDate: date,
  });

  return [
    mk(
      midterm,
      `${termLabel} - share a midterm review`,
      `Midterm evals likely open this week. Once submitted, please copy it over to modSUTD, your contribution is greatly appreciated!`,
    ),
    mk(
      final,
      `${termLabel} - share an end-of-term review`,
      `Term-end evals likely open this week. Once submitted, please copy it over to modSUTD, your contribution is greatly appreciated!`,
    ),
  ];
}

export function downloadTermReminders(input: ReminderInput) {
  const events = buildTermReminderEvents(input);
  const safe = input.termLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  downloadICS(events, `modsutd-${safe}-reminders`);
}
