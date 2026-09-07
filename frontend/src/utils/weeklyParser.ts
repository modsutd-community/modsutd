import type { TimetableEvent } from '@/types';
import { normaliseType } from './timetableParser';

// SAMS "My Class Schedule" -> Weekly Calendar View, parsed from the HTML the
// clipboard carries alongside the plain text.
//
// This exists because List View is not always available: SAMS answers "You do
// not have access to the class schedule at this time" until enrolment is final,
// while the weekly grid keeps rendering. That is the window in which a student
// most wants their timetable.
//
// It reads text/html rather than the plain text on purpose. A copy of this grid
// is a table whose columns are days, and a class cell spans several half-hour
// rows. In the plain text those rowspans are gone, so a row carries fewer tabs
// than it has columns and every class after the first is attributed to the
// wrong day. The HTML keeps the rowspans, so the column is exact.
//
// What it cannot do: the grid holds one week and no term end, so each class
// comes back as a single dated occurrence, exactly like one List View row.
// Paste each week and they merge. Nothing here invents a term.

const DAY_NAMES: Record<string, TimetableEvent['day']> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday',
  friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "Week of 14/9/2026 - 20/9/2026". The header cells print "Monday 14 Sep" with
// no year, so without this line a December paste would land in the wrong one.
const WEEK_OF_RE = /Week\s+of\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i;

// "ECC Building 1 1.411" -> "1.411". The weekly grid prints the room without
// the brackets List View uses, so ROOM_CODE_RE cannot be reused here.
const ROOM_CODE_RE = /(\d{1,2}\.\d{3}[A-Za-z]?)\s*$/;

// "01 .400 - CC01" - the stray space is SAMS's, in both views.
const CODE_LINE_RE = /^(\d{2}\s*\.\s*\d{3}\w*)\s*-\s*(\S+)/;
const TIME_RANGE_RE = /^(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*-\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)$/i;

function to24h(raw: string): string {
  const m = raw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return '00:00';
  let h = parseInt(m[1], 10);
  const mer = m[3]?.toUpperCase();
  if (mer === 'PM' && h !== 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

// A table cell occupies more than one grid position, so the nth <td> of a row is
// not the nth column. Walk the rows keeping a count of how many further rows
// each column is still spoken for, which is what a browser does to lay this out.
function columnOf(spans: number[], occupied: number[], width: number): number[] {
  const cols: number[] = [];
  let c = 0;
  for (const span of spans) {
    while (c < width && occupied[c] > 0) c += 1;
    cols.push(c);
    c += span;
  }
  return cols;
}

function isoDate(year: number, day: number, monIdx: number): string {
  return `${year}-${String(monIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface WeeklyParseResult {
  events: TimetableEvent[];
  /** Set when the grid was found but the "Week of" line was not. */
  missingWeek?: boolean;
}

export function parseWeeklyHtml(html: string, alsoSearch = ''): WeeklyParseResult {
  if (typeof DOMParser === 'undefined') return { events: [] };
  // SAMS separates the five lines of a class cell with <br>, so textContent
  // alone returns them run together as one string with nothing to split on.
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n'), 'text/html');

  const tables = [...doc.querySelectorAll('table')] as HTMLTableElement[];
  const table = (doc.querySelector('table#WEEKLY_SCHED_HTMLAREA') as HTMLTableElement | null)
    ?? tables.find((t) => /^\s*Time\b/.test(t.rows[0]?.cells[0]?.textContent ?? ''));
  if (!table || table.rows.length < 2) return { events: [] };

  const weekM = (html.match(WEEK_OF_RE) ?? alsoSearch.match(WEEK_OF_RE));
  if (!weekM) return { events: [], missingWeek: true };
  const year = Number(weekM[3]);

  // Header: column index -> { day, date }. "Monday 14 Sep", year from above.
  const head = [...table.rows[0].cells];
  const width = head.reduce((n, c) => n + c.colSpan, 0);
  const columns = new Map<number, { day: TimetableEvent['day']; date: string }>();
  let col = 0;
  for (const c of head) {
    const txt = (c.textContent ?? '').replace(/\s+/g, ' ').trim();
    const m = txt.match(/^([A-Za-z]+)\s+(\d{1,2})\s+([A-Za-z]{3})/);
    if (m && DAY_NAMES[m[1].toLowerCase()]) {
      const mon = MONTHS.indexOf(m[3].slice(0, 3).toLowerCase());
      if (mon >= 0) columns.set(col, { day: DAY_NAMES[m[1].toLowerCase()], date: isoDate(year, Number(m[2]), mon) });
    }
    col += c.colSpan;
  }
  if (!columns.size) return { events: [] };

  const occupied = new Array(width).fill(0);
  const out: TimetableEvent[] = [];
  const seen = new Set<string>();

  for (let r = 1; r < table.rows.length; r += 1) {
    const cells = [...table.rows[r].cells];
    const cols = columnOf(cells.map((c) => c.colSpan), occupied, width);
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      const at = cols[i];
      const lines = (cell.textContent ?? '')
        .replace(/\u00a0/g, ' ')
        .split('\n').map((ln: string) => ln.trim()).filter(Boolean);
      // A class cell is: code - section / [title] / component / time / room.
      // The title only appears when "Show Class Title" is ticked, so anchor on
      // the ends rather than counting from the top.
      if (lines.length >= 4) {
        const codeM = lines[0].match(CODE_LINE_RE);
        const timeM = lines[lines.length - 2].match(TIME_RANGE_RE);
        const where = columns.get(at);
        if (codeM && timeM && where) {
          const room = lines[lines.length - 1];
          const ev: TimetableEvent = {
            modCode: codeM[1].replace(/\s+/g, ''),
            modName: lines.length >= 5 ? lines[1] : '',
            type: normaliseType(lines[lines.length - 3]),
            day: where.day,
            startTime: to24h(timeM[1]),
            endTime: to24h(timeM[2]),
            location: room.match(ROOM_CODE_RE)?.[1] ?? room,
            instructors: [],
            startDate: where.date,
            endDate: where.date,
          };
          const k = `${ev.modCode}|${ev.type}|${ev.startDate}|${ev.startTime}`;
          if (!seen.has(k)) { seen.add(k); out.push(ev); }
        }
      }
      // claim this column for however many further rows the cell spans
      for (let s = 0; s < cell.colSpan; s += 1) occupied[at + s] = cell.rowSpan;
    }
    for (let c2 = 0; c2 < width; c2 += 1) if (occupied[c2] > 0) occupied[c2] -= 1;
  }

  out.sort((a, b) => (a.startDate + a.startTime).localeCompare(b.startDate + b.startTime));
  return { events: out };
}

/**
 * True when the PLAIN TEXT of a paste is the weekly grid.
 *
 * Used only to tell a bad clipboard apart from a bad page. The grid needs
 * text/html to be parsed at all, so when that flavour is missing the reader
 * has to be told to re-copy rather than sent to List View, which may well be
 * the view they cannot open.
 *
 * Keyed on the "Week of" line and the day headers, never on the words
 * "Weekly Calendar View": those are a tab label that a List View copy of the
 * same page carries too.
 */
export function looksWeeklyText(text: string): boolean {
  if (WEEK_OF_RE.test(text)) return true;
  const days = text.match(/\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\s+\d{1,2}\s+[A-Z][a-z]{2}/g);
  // Three of them, so one stray date in a List View row cannot pass for a week.
  return (days?.length ?? 0) >= 3;
}

/** True when a pasted HTML fragment looks like the weekly grid rather than anything else. */
export function looksWeekly(html: string): boolean {
  if (/WEEKLY_SCHED_HTMLAREA/.test(html)) return true;
  if (!/<t(able|d)\b/i.test(html)) return false;
  // Match the day headers on the TEXT, not the markup. SAMS writes them as
  // "Monday<br> 14 Sep", so a regex run over the raw HTML never finds the day
  // name next to its date, and this fallback only ever fired on the table id.
  // A copy that loses the id, a selection of the grid alone or a browser that
  // drops it, then read as "not weekly" and the paste was refused.
  const text = html.replace(/<[^>]+>/g, " ");
  return /\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\s+\d{1,2}\s+[A-Z][a-z]{2}/.test(text);
}
