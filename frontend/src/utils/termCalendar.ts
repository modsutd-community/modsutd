import type { TimetableEvent } from '@/types';

// Turns one pasted week into the whole term.
//
// The List View paste never needs this: it prints one row per real meeting, so
// recess week and public holidays are already missing and nothing has to know
// the term calendar. The Weekly Calendar View prints one week and no term at
// all, so a single paste of it is one week of classes - true, and close to
// useless for an export.
//
// Bridging that gap means repeating the week across the term, which is only
// safe against a published calendar. SUTD's Term 1 AY2026/27 runs weeks 1-6,
// then week 7 IS the recess week (25 Oct - 1 Nov), then weeks 8-14. Repeating
// blindly would put a fortnight of classes on a student's calendar during a
// break they are not on campus for, and one on Deepavali.
//
// What it still cannot see is a week that breaks the pattern, and there are two
// kinds. A one-off ROOM change is harmless: the ICS UID is mod + type + date
// with the room deliberately left out, so a later List View paste corrects the
// room in place. A one-off CANCELLATION is not, and it is the reason List View
// stays the accurate source:
//
//   derived export puts 02.155 on Tue 10 Nov, because every other Tue meets
//   SAMS cancels 10 Nov, so List View prints no row for it
//   the later export names UIDs only for dates that DO meet
//   -> nothing ever names 10 Nov again, and it stays in the calendar for good
//
// A derived date that turns out to be wrong outlives its own correction. So the
// expanded week is labelled as derived rather than read, and the UI points at
// List View once enrolment is final.
//
// It also assumes the pasted week is a NORMAL one. Week 1 often is not - an
// introductory session that never repeats, or a public holiday inside it -
// which is why the note names the week the student pasted from.

export interface TeachingWeek { week: number; monday: string }
export interface TermSpan {
  /** "Terms 1, 7 & 9, AY2026/27". A trimester hosts several terms at once. */
  label: string;
  /** The term numbers sharing this trimester's dates. */
  terms?: number[];
  weekOneMonday: string;
  lastDay: string;
  teachingWeeks: TeachingWeek[];
  breaks: { name: string; week: number; from: string; to: string }[];
  holidays: { date: string; name: string }[];
}
export interface TermCalendar { terms: TermSpan[] }

// No Date(iso) parse - it applies the user's local timezone, which would shift
// the date mid-flight. Same reason as termReminders.
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${z(dt.getUTCMonth() + 1)}-${z(dt.getUTCDate())}`;
}

function daysBetween(a: string, b: string): number {
  const p = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86_400_000);
}

/** The term whose published span contains this date, or null. */
export function termFor(date: string, cal: TermCalendar | null): TermSpan | null {
  if (!cal?.terms?.length) return null;
  return cal.terms.find((t) => date >= t.weekOneMonday && date <= t.lastDay) ?? null;
}

/**
 * What to call the term a date falls in. The calendar is regenerated from
 * SUTD's own page, so this needs no edit at rollover; the constant is only
 * what to say when the fetch has not landed or the date is between terms.
 */
export function labelFor(date: string, cal: TermCalendar | null, fallback: string): string {
  const now = termFor(date, cal);
  if (now) return now.label;
  // Between terms - the vacation belongs to the term about to start, which is
  // the one a student pasting a timetable in that gap is looking at.
  const next = cal?.terms
    ?.filter((t) => t.weekOneMonday > date)
    .sort((a, b) => a.weekOneMonday.localeCompare(b.weekOneMonday))[0];
  return next?.label ?? fallback;
}

export interface ExpandResult {
  events: TimetableEvent[];
  /** Weeks each class was placed in, for the UI to state plainly. */
  weeks: number;
  /** Dates skipped because the calendar says nothing meets, for the same reason. */
  skipped: string[];
  /** Teaching week the paste came from, so the UI can say which one it trusted. */
  sourceWeek: number | null;
  /**
   * Set when the pasted week is a poor template for the rest of the term. The
   * whole term is a copy of this one week, so a week that is not typical
   * propagates. Two cases bite: week 1 often carries an introductory session
   * that never repeats, and a week containing a public holiday is missing that
   * weekday entirely - paste the week of Mon 9 Nov 2026 and Monday classes
   * vanish from the term, silently, because there was no Monday to copy.
   */
  atypical: null | { reason: 'first-week' | 'holiday'; detail: string };
}

/**
 * Repeat a single pasted week across every teaching week of its term.
 * Returns the input untouched when the week belongs to no known term, so an
 * unrecognised paste degrades to the one honest week rather than to guesses.
 */
export function expandWeekToTerm(events: TimetableEvent[], cal: TermCalendar | null): ExpandResult {
  const anchor = events.find((e) => e.startDate)?.startDate;
  const term = anchor ? termFor(anchor, cal) : null;
  if (!term) return { events, weeks: 1, skipped: [], sourceWeek: null, atypical: null };

  const holidays = new Map(term.holidays.map((h) => [h.date, h.name]));
  const skipped = new Set<string>();

  const weekOf = (date: string) => term.teachingWeeks.find((w) => {
    const off = daysBetween(w.monday, date);
    return off >= 0 && off <= 6;
  });
  const source = anchor ? weekOf(anchor) ?? null : null;

  // A holiday inside the pasted week means that weekday was blank on screen, so
  // it is absent from every week we derive rather than from one.
  const holidayInSource = source
    ? term.holidays.find((h) => {
      const off = daysBetween(source.monday, h.date);
      return off >= 0 && off <= 6;
    })
    : undefined;

  const out = events.map((e) => {
    // Offset of this class from the Monday of the week it was pasted from, so
    // a Thursday class stays a Thursday class in every other week.
    const own = weekOf(e.startDate);
    // A class pasted from recess week has no teaching week to anchor to.
    const offset = own ? daysBetween(own.monday, e.startDate) : null;
    if (offset === null) return e;

    const dates: string[] = [];
    for (const w of term.teachingWeeks) {
      const d = addDays(w.monday, offset);
      if (d > term.lastDay) continue;
      if (holidays.has(d)) { skipped.add(d); continue; }
      dates.push(d);
    }
    if (dates.length < 2) return e;
    return { ...e, startDate: dates[0], endDate: dates[dates.length - 1], occurrences: dates };
  });

  const weeks = Math.max(...out.map((e) => e.occurrences?.length ?? 1));
  const atypical: ExpandResult['atypical'] = holidayInSource
    ? { reason: 'holiday', detail: `${holidayInSource.name} falls in it, so that weekday was blank` }
    : source && source.week === term.teachingWeeks[0].week
      ? { reason: 'first-week', detail: 'week 1 often carries a session that never repeats' }
      : null;
  return { events: out, weeks, skipped: [...skipped].sort(), sourceWeek: source?.week ?? null, atypical };
}
