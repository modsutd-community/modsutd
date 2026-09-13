import type { TimetableEvent, Schedule, LessonType } from '@/types';

// SUTD SAMS "My Class Schedule" -> List View parser, fed by a select-all copy.
// The real table is one row per WEEK:
//
//   30 .111 - Entrepreneurship
//   Class Nbr  Section  Component  Days & Times      Room                         Instructor  Start/End Date
//   1111       CP02     CBL        Th 18:00 - 20:30  Cohort Classroom 14 (2.507)  Prof A      19/09/2026 - 19/09/2026
//                                  Th 18:00 - 20:30  Cohort Classroom 14 (2.507)  Prof A      26/09/2026 - 26/09/2026
//
// Three consequences drive everything below: the code carries a stray space
// ("30 .111"), Class Nbr/Section/Component print only on a group's first row,
// and a 13-week class arrives as 13 rows whose start and end date are equal.

const DAY_CODE: Record<string, Schedule['day']> = {
  Mo: 'Monday', Tu: 'Tuesday', We: 'Wednesday', Th: 'Thursday',
  Fr: 'Friday', Sa: 'Saturday', Su: 'Sunday',
};

// SAMS prints the component abbreviated. Both contribution validators accept
// only canonical LessonType values, so an unmapped label is dropped at
// eventsToSlots rather than silently rejected by the relay after the UI has
// already said thanks.
const TYPE_ALIASES: Record<string, LessonType> = {
  cbl: 'Cohort', cohort: 'Cohort', 'cohort class': 'Cohort',
  'cohort based learning': 'Cohort', 'cohort-based learning': 'Cohort',
  lec: 'Lecture', lect: 'Lecture', lecture: 'Lecture',
  lab: 'Lab', labo: 'Lab', laboratory: 'Lab',
  tut: 'Tutorial', tutorial: 'Tutorial',
  stu: 'Studio', studio: 'Studio',
  sem: 'Seminar', seminar: 'Seminar',
  rec: 'Recitation', recitation: 'Recitation',
};

export function normaliseType(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return TYPE_ALIASES[key] ?? raw.trim();
}

// "Cohort Classroom 14 (2.507)" -> "2.507". The bracketed code is what
// /data/venues is keyed on; the printed name drifts between terms.
const ROOM_CODE_RE = /\(\s*(\d{1,2}\s*\.\s*\d{3}\w*)\s*\)/;

function venueCode(raw: string): string {
  const m = raw.match(ROOM_CODE_RE);
  return m ? m[1].replace(/\s+/g, '') : raw.trim();
}

const TIME_RE = /\d{1,2}:\d{2}(?:\s?[AP]M)?/;
// The cell that carries the day and the time range, which is the one the room
// always follows. Anchored so a stray time inside a room name cannot match.
const DAY_TIME_CELL_RE = new RegExp(
  `^(?:Mo|Tu|We|Th|Fr|Sa|Su)\\b.*${TIME_RE.source}\\s*-\\s*${TIME_RE.source}`,
);
const DATE_RE = /\d{2}\/\d{2}\/\d{4}/;

const COURSE_RE = /(\d{2}\s*\.\s*\d{3}\w*)\s+-\s+([^\n]+)/g;
// The component sits between the section and the day code on the same row, so
// it is bounded by the day code rather than by the end of the line - a greedy
// [^\n]+ swallows the whole rest of a tab-separated row.
const TYPE_HEADER_RE =
  /\b\d{3,4}\s+[A-Z]{2}\d{2}\s+([A-Za-z][A-Za-z-]*(?: [A-Za-z-]+)*?)\s+(?=(?:Mo|Tu|We|Th|Fr|Sa|Su)\b)/g;
const CLASS_RE = new RegExp(
  `\\b(Mo|Tu|We|Th|Fr|Sa|Su)\\s+(${TIME_RE.source})\\s*-\\s*(${TIME_RE.source})` +
  `\\s+([^\\n]+?)\\s+([\\s\\S]*?)\\s+(${DATE_RE.source})\\s*-\\s*(${DATE_RE.source})`,
  'g',
);

function normaliseTime(raw: string): string {
  // Accepts "9:00", "09:00", "9:00 PM", "9:00PM" -> "HH:MM" 24h.
  const m = raw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return '00:00';
  let h = parseInt(m[1], 10);
  const min = m[2];
  const mer = m[3]?.toUpperCase();
  if (mer === 'PM' && h !== 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

function isoDate(raw: string): string {
  const [d, m, y] = raw.split('/');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// A weekly class arrives as ~13 rows that differ only by date. Collapsing them
// into one event with explicit occurrences keeps the grid from stacking 13
// lanes, and it carries recess week and public holidays for free: a week that
// does not meet simply has no row, so nothing has to know the term calendar.
function collapseWeeklyRows(rows: TimetableEvent[]): TimetableEvent[] {
  const groups = new Map<string, TimetableEvent[]>();
  for (const e of rows) {
    const key = [e.modCode, e.type, e.day, e.startTime, e.endTime, e.location].join('|');
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }

  const out: TimetableEvent[] = [];
  for (const g of groups.values()) {
    const singleDay = g.every((e) => e.startDate === e.endDate);
    const dates = [...new Set(g.map((e) => e.startDate))].sort();
    const instructors = [...new Set(g.flatMap((e) => e.instructors))];

    if (!singleDay || dates.length < 2) {
      out.push({ ...g[0], instructors });
      continue;
    }
    out.push({
      ...g[0],
      instructors,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      occurrences: dates,
    });
  }
  return out;
}

export function parseTimetableText(input: string): TimetableEvent[] {
  // PeopleSoft pads empty table cells with non-breaking spaces, which defeat
  // every \s-based boundary below.
  const text = input.replace(/\u00a0/g, ' ');
  const events: TimetableEvent[] = [];

  // Index every course-header so we can slice the text into per-course chunks.
  const headers: { code: string; name: string; index: number }[] = [];
  for (const m of text.matchAll(COURSE_RE)) {
    headers.push({
      code: m[1].replace(/\s+/g, ''),
      name: m[2].trim(),
      index: m.index!,
    });
  }
  if (!headers.length) return events;

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const end = i + 1 < headers.length ? headers[i + 1].index : text.length;
    const slice = text.slice(h.index, end);

    // Walk type headers and class rows in order; the most recent type label
    // applies to the rows that follow it.
    let currentType = 'Lecture';
    const types = [...slice.matchAll(TYPE_HEADER_RE)];
    const rows = [...slice.matchAll(CLASS_RE)];

    rows.forEach((row) => {
      const rowAt = row.index!;
      // Pick the closest preceding type header.
      const t = types.filter((tm) => tm.index! < rowAt).pop();
      if (t) currentType = t[1].trim();

      const day = DAY_CODE[row[1]] ?? 'Monday';
      const startTime = normaliseTime(row[2]);
      const endTime = normaliseTime(row[3]);

      // A copied table arrives with real cell boundaries - tabs in some
      // browsers, NEWLINES in others - and the room name contains spaces
      // ("Cohort Classroom 14 (2.507)"), so the lazy capture stops at the
      // first word and hands the rest to the instructor. That is how every
      // room came out as "Cohort", "Lecture" or "Capstone", and how the room
      // finder grew heatmaps for rooms that do not exist. Split on BOTH, then
      // count from the end: dates last, instructor before, room before that.
      const cells = row[0].split(/[\t\n]/).map((c) => c.trim()).filter(Boolean);
      // Not a fixed offset from the end: a class can list two instructors on
      // two lines, which pushed the room two cells further back and made the
      // location a person's name.
      //
      // The room is the cell AFTER the one carrying the day and time. That is
      // positional and always true, where the old rule - the cell carrying a
      // bracketed code - was only true for rooms that print one. A row reading
      // "Mo 10:30AM - 1:30PM | Studio 7 | Prof A | dates" has no bracket
      // anywhere, so it fell through to row[4], the lazy capture, which stops
      // at the first space and sent "Studio" as the location. "Albert" reached
      // /data exactly that way, from "Albert Hong Lecture Theatre 1".
      //
      // The bracketed cell is still preferred when there is one: it is the
      // stronger signal, and a timetable that prints the code is telling us
      // the code.
      const coded = cells.findIndex((c) => ROOM_CODE_RE.test(c));
      const timeAt = cells.findIndex((c) => DAY_TIME_CELL_RE.test(c));
      const roomAt = coded > 0 ? coded : timeAt >= 0 ? timeAt + 1 : -1;
      const enough = cells.length >= 4 && roomAt > 0 && roomAt < cells.length - 1;
      const rawRoom = enough ? cells[roomAt] : row[4];
      const rawInstructors = enough
        ? cells.slice(roomAt + 1, cells.length - 1).join(', ')
        : row[5];

      const location = venueCode(rawRoom);
      const instructors = rawInstructors
        .split(/[\n,\t]/)
        .map((s) => s.replace(/[,;]+$/, '').trim())
        .filter(Boolean);
      const startDate = isoDate(row[6]);
      const endDate = isoDate(row[7]);

      events.push({
        modCode: h.code,
        modName: h.name,
        type: normaliseType(currentType),
        day,
        startTime,
        endTime,
        location,
        venueName: rawRoom.trim() || undefined,
        instructors,
        startDate,
        endDate,
      });
    });
  }

  return collapseWeeklyRows(events);
}
