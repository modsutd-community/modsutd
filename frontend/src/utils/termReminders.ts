import { downloadICS } from './icsGenerator';
import { termFor } from './termCalendar';
import type { TermCalendar } from './termCalendar';
import type { TimetableEvent } from '@/types';

// Two opt-in calendar reminders pointing back at the eval portal and /share,
// timed to when SUTD's own evals open.
// Midterm eval runs from start of week 4 (Monday) to end of week 5 (Sunday).
// Week 11 is where the final eval opens.

const MIDTERM_EVAL_START_WEEK = 4;
const MIDTERM_EVAL_END_WEEK = 5;
const FINAL_EVAL_WEEK = 11;

function addDays(iso: string, days: number): string {
  // No Date(iso) parse: it applies the user's local timezone, which
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

export function reminderDates({ termStartISO, cal }: Pick<ReminderInput, 'termStartISO' | 'cal'>): {
  midterm: string;
  midtermStart: string;
  midtermEnd: string;
  final: string;
} {
  const term = termFor(termStartISO, cal ?? null);
  const weeks = term?.teachingWeeks ?? [];
  if (weeks.length) {
    const w4 = weeks.find((w) => w.week === MIDTERM_EVAL_START_WEEK);
    const w5 = weeks.find((w) => w.week === MIDTERM_EVAL_END_WEEK);
    const w11 = weeks.find((w) => w.week === FINAL_EVAL_WEEK);
    const mStart = (w4 ?? weeks[0]).monday;
    const mEnd = addDays((w5 ?? w4 ?? weeks[0]).monday, 6);
    return {
      midterm: mStart,
      midtermStart: mStart,
      midtermEnd: mEnd,
      final: (w11 ?? weeks[weeks.length - 1]).monday,
    };
  }
  const mStart = addDays(termStartISO, (MIDTERM_EVAL_START_WEEK - 1) * 7);
  const mEnd = addDays(termStartISO, (MIDTERM_EVAL_END_WEEK - 1) * 7 + 6);
  return {
    midterm: mStart,
    midtermStart: mStart,
    midtermEnd: mEnd,
    final: addDays(termStartISO, (FINAL_EVAL_WEEK - 1) * 7),
  };
}

const SHARE_URL = (origin: string) => `${origin}/share`;

export function buildTermReminderEvents({
  termStartISO,
  origin = 'https://modsutd.tech',
  cal = null,
}: ReminderInput): TimetableEvent[] {
  const url = SHARE_URL(origin);
  const { midtermStart, midtermEnd, final } = reminderDates({ termStartISO, cal });

  // Reminder events keep the modSUTD /share link in location so students can easily
  // jump straight into sharing/reading reviews from their calendar.
  const midtermEvent: TimetableEvent = {
    modCode: '',
    modName: 'Reminder to do your Mid-term eval (if any) with modSUTD!',
    type: '',
    uidKey: `modsutd-reminder|mid-term|${termStartISO}`,
    day: 'Monday',
    startTime: '00:00',
    endTime: '23:59',
    allDay: true,
    location: url,
    instructors: [
      'Mid-term evals. Please check your mod / Outlook for the actual deadline.',
    ],
    startDate: midtermStart,
    endDate: midtermEnd,
  };

  const finalEvent: TimetableEvent = {
    modCode: '',
    modName: 'Reminder to do your Final eval (if any) with modSUTD!',
    type: '',
    uidKey: `modsutd-reminder|final|${termStartISO}`,
    day: 'Monday',
    startTime: '17:00',
    endTime: '17:30',
    location: url,
    instructors: [
      'Final evals. Please check your mod / Outlook for the actual deadline.',
    ],
    startDate: final,
    endDate: final,
  };

  return [midtermEvent, finalEvent];
}

export function downloadTermReminders(input: ReminderInput) {
  const events = buildTermReminderEvents(input);
  const safe = input.termLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  downloadICS(events, `modsutd-${safe}-reminders`);
}
