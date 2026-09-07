import type { TimetableEvent } from '@/types';
import { serverNow } from './serverTime';

// Build the local datetime string (YYYYMMDDTHHMMSS) directly from the event's
// declared SUTD-local clock time. Critically: no `new Date(...)` here -
// constructing a Date applies the browser's timezone offset, which silently
// shifts the event for anyone exporting from outside Singapore. We declare
// TZID=Asia/Singapore and let the calendar app interpret.
function localStamp(date: string, time: string): string {
  const [y, m, d] = date.split('-');
  const [h, min] = time.split(':');
  return `${y}${m.padStart(2, '0')}${d.padStart(2, '0')}T${h.padStart(2, '0')}${min.padStart(2, '0')}00`;
}

function utcNow(): string {
  const n = new Date(serverNow());
  const z = (x: number) => String(x).padStart(2, '0');
  return `${n.getUTCFullYear()}${z(n.getUTCMonth() + 1)}${z(n.getUTCDate())}T${z(n.getUTCHours())}${z(n.getUTCMinutes())}${z(n.getUTCSeconds())}Z`;
}

// A UID must identify the same class across exports, or re-exporting after we
// fix a room gives the student a second complete copy of their term instead of
// an update. Derived from what makes the meeting itself unique, so it is stable
// without storing anything.
//
// Also replaces crypto.randomUUID(), which is undefined outside a secure
// context - the whole export used to throw when testing over a plain http LAN
// address.
function stableUid(parts: readonly string[]): string {
  const key = parts.join('|');
  // Two FNV-1a passes with different offsets, for a wider value than one 32-bit
  // hash gives. Collisions only matter within one student's own calendar.
  const fnv = (offset: number) => {
    let h = offset;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return `${fnv(0x811c9dc5)}${fnv(0x7fffffff)}@modsutd`;
}

// RFC 5545 §3.1: content lines are limited to 75 OCTETS, and a long line is
// continued by CRLF followed by a single space. Counting characters instead
// would split the multi-byte separator in a SUMMARY and corrupt it.
function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  // The first line may use all 75; every continuation spends one on its space.
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = ch;
      bytes = n;
      limit = 74;
    } else {
      cur += ch;
      bytes += n;
    }
  }
  out.push(cur);
  return out.join('\r\n ');
}

// RFC 5545 §3.3.11: escape commas, semicolons, backslashes, newlines in TEXT fields.
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

const DAY_INDEX: Record<TimetableEvent['day'], number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

// Date-only arithmetic in UTC - whole-day shifts can't drift across timezones,
// so the "no new Date()" rule for clock times doesn't apply here.
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// First calendar date on/after `startDate` that falls on `day`.
function alignToWeekday(startDate: string, day: TimetableEvent['day']): string {
  const start = new Date(`${startDate}T00:00:00Z`);
  const offset = (DAY_INDEX[day] - start.getUTCDay() + 7) % 7;
  return shiftDate(startDate, offset);
}

// RFC 5545: when DTSTART carries a TZID, RRULE's UNTIL must be UTC.
// End-of-day SGT (UTC+8, no DST) is 15:59:59Z on the same calendar date.
function untilUTC(endDate: string): string {
  return `${endDate.replace(/-/g, '')}T155959Z`;
}

export const SIGNATURE = '[Sincerely, modSUTD]';

const ICS_DAY: Record<TimetableEvent['day'], string> = {
  Sunday: 'SU', Monday: 'MO', Tuesday: 'TU', Wednesday: 'WE',
  Thursday: 'TH', Friday: 'FR', Saturday: 'SA',
};

export interface ICSOptions {
  // Bumped on every export. Same UID plus a higher SEQUENCE is how a calendar
  // is told "this is the same class, updated" rather than "here is a new one".
  sequence?: number;
  // Named so an import that goes wrong can be undone by deleting one calendar
  // instead of hunting ~140 events by hand.
  calendarName?: string;
}

// What identifies one class meeting, as narrowly as it can be without ever
// naming two different meetings the same thing.
//
// Only mod, type and date: everything else about a meeting is a detail that
// might later be corrected, and anything in this key turns a correction into a
// duplicate. day was redundant (a date already implies it) and startTime went
// because a moved class should update in place, not appear twice.
//
// The one thing that key cannot express is two sessions of the same mod and
// type on the same day. There are none in any current data - checked across
// every schedule in /data - but if one ever appears, silently overwriting a
// class is worse than showing two, so those fall back to including the start
// time. Only the colliding pair is affected.
// The exact dates buildICS will emit for an event - must mirror its branching,
// or a key is missing for the date actually written out.
function emitDates(e: TimetableEvent): string[] {
  if (e.occurrences?.length) return e.occurrences;
  if (e.startDate === e.endDate) return [e.startDate];
  const first = alignToWeekday(e.startDate, e.day);
  return first > e.endDate ? [] : [first];
}

function occurrenceKeys(events: TimetableEvent[]): Map<TimetableEvent, Map<string, string>> {
  const counts = new Map<string, number>();
  const datesOf = emitDates;
  for (const e of events) {
    for (const d of datesOf(e)) {
      const k = `${e.modCode}|${e.type}|${d}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const out = new Map<TimetableEvent, Map<string, string>>();
  for (const e of events) {
    const per = new Map<string, string>();
    for (const d of datesOf(e)) {
      const base = `${e.modCode}|${e.type}|${d}`;
      per.set(d, (counts.get(base) ?? 0) > 1 ? `${base}|${e.startTime}` : base);
    }
    out.set(e, per);
  }
  return out;
}

export function buildICS(events: TimetableEvent[], opts: ICSOptions = {}): string {
  const dtstamp = utcNow();
  const sequence = opts.sequence ?? 0;
  const calendarName = opts.calendarName ?? 'modSUTD timetable';
  const keys = occurrenceKeys(events);
  const blocks = events.flatMap((e) => {
    const summary = escapeText(`${e.modCode} ${e.modName}${e.type ? ` · ${e.type}` : ''}`);
    // Every event signs itself, so one search finds the whole batch. On Android
    // that is the only recovery available: its importer writes to the primary
    // calendar and its app cannot delete a calendar, so there is nothing to
    // delete wholesale. Constant on purpose - a student searching mid-panic
    // should not have to remember which term they imported.
    const desc = escapeText(
      [e.instructors.join(', '), SIGNATURE].filter(Boolean).join('\n'),
    );

    const vevent = (date: string, rrule?: string) =>
      [
        'BEGIN:VEVENT',
        `DTSTAMP:${dtstamp}`,
        `UID:${stableUid([keys.get(e)!.get(date)!])}`,
        `SEQUENCE:${sequence}`,
        `DTSTART;TZID=Asia/Singapore:${localStamp(date, e.startTime)}`,
        `DTEND;TZID=Asia/Singapore:${localStamp(date, e.endTime)}`,
        ...(rrule ? [rrule] : []),
        `SUMMARY:${summary}`,
        `LOCATION:${escapeText(e.location)}`,
        `DESCRIPTION:${desc}`,
        'END:VEVENT',
      ].map(foldLine).join('\r\n');

    if (e.occurrences?.length) {
      return e.occurrences.map((date) => vevent(date));
    }
    if (e.startDate === e.endDate) {
      return [vevent(e.startDate)];
    }
    const first = alignToWeekday(e.startDate, e.day);
    if (first > e.endDate) {
      // The weekday never occurs inside the range - contradictory input.
      // Omitting beats exporting a confidently wrong calendar entry.
      return [];
    }
    return [vevent(first, `RRULE:FREQ=WEEKLY;BYDAY=${ICS_DAY[e.day]};UNTIL=${untilUTC(e.endDate)}`)];
  });

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//modsutd//calendar//EN',
    'CALSCALE:GREGORIAN',
    foldLine(`X-WR-CALNAME:${escapeText(calendarName)}`),
    'X-WR-TIMEZONE:Asia/Singapore',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Singapore',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:+08',
    'END:STANDARD',
    'END:VTIMEZONE',
    ...blocks,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

// SEQUENCE has to rise for a calendar to treat a re-import as an update rather
// than a second copy - and it has to rise for FILES, not for browsers.
//
// A per-browser counter fails three ways, all of them silent: a file shared
// between students carries the sender's count, which is unrelated to the
// receiver's; clearing site data restarts at 1, below what was already
// imported, so every later fix is ignored; and two devices drift apart
// immediately. The calendar just keeps the higher number it already has.
//
// A clock does not have that problem: any file built later outranks any file
// built earlier, whoever built it, with nothing stored anywhere. Minutes since
// 2020 stays a small integer for the next few thousand years, well inside the
// signed-32-bit ceiling the property allows.
//
// The clock itself comes from serverTime, not from the device - a device clock
// set forward poisons the ceiling so every later correct export is ignored, and
// one set back is ignored as stale. Both are silent, and neither is the
// student's fault.
const SEQ_EPOCH_MS = Date.UTC(2020, 0, 1);

export function clockSequence(now = serverNow()): number {
  return Math.max(0, Math.floor((now - SEQ_EPOCH_MS) / 60_000));
}

export function downloadICS(
  events: TimetableEvent[],
  filename = 'modsutd',
  opts: ICSOptions = {},
): void {
  const ics = buildICS(events, { sequence: clockSequence(), ...opts });
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Kept for backwards compat with existing imports.
export const generateICS = downloadICS;
