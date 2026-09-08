import { describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import { buildICS, clockSequence, SIGNATURE } from './icsGenerator';
import { parseTimetableText } from './timetableParser';
import { buildTermReminderEvents } from './termReminders';
import { SAMPLE_LIST_VIEW } from './sampleTimetable';
import type { TimetableEvent } from '@/types';

// Everything else about the exporter checks our own output against our own
// expectations. This reads it back with somebody else's parser - ical.js, the
// one Thunderbird uses - so "well-formed" means well-formed to an
// implementation that has never seen this codebase.
//
// It cannot prove Google or Apple will accept the file. It can prove the file
// is not the reason if they don't.

const events = parseTimetableText(SAMPLE_LIST_VIEW);

function reparse(ics: string) {
  const comp = new ICAL.Component(ICAL.parse(ics));
  return comp.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v));
}

describe('an independent parser reads our export', () => {
  it('parses at all - a malformed file throws here', () => {
    expect(() => ICAL.parse(buildICS(events))).not.toThrow();
  });

  it('round-trips every class the parser found', () => {
    const expected = events.reduce((n, e) => n + (e.occurrences?.length || 1), 0);
    expect(reparse(buildICS(events))).toHaveLength(expected);
  });

  it('keeps the local wall-clock time and the Singapore zone', () => {
    const ent = events.find((e) => e.modCode === '30.111')!;
    const [first] = reparse(buildICS([ent]));
    expect(first.startDate.toString()).toContain('T18:00:00');
    expect(first.startDate.zone.tzid).toBe('Asia/Singapore');
    // Code first, name in brackets. A calendar's one-line preview truncates
    // from the RIGHT, so the half that has to survive is the code - it is what
    // a student walks to and what the door signs carry.
    expect(first.location).toBe('2.507 (Cohort Classroom 14)');
    // And the description does not say it again: the room has its own field,
    // and repeating it put the same string in every event twice.
    expect(first.description).not.toContain('Cohort Classroom 14');
  });

  it('leaves recess week out, because the source did', () => {
    const ent = events.find((e) => e.modCode === '30.111')!;
    const days = reparse(buildICS([ent])).map((v) => v.startDate.toString().slice(0, 10));
    expect(days).toContain('2026-10-22');
    expect(days).not.toContain('2026-10-29');
    expect(days).toContain('2026-11-05');
  });
});

describe('long lines survive folding', () => {
  // 75 octets is the limit, and a folded line that splits a multi-byte
  // character comes back corrupted rather than merely ugly.
  const long: TimetableEvent = {
    modCode: '50.001',
    modName: 'Introduction to Information Systems and Programming with a Deliberately Overlong Title',
    type: 'Cohort',
    day: 'Wednesday',
    startTime: '09:00',
    endTime: '11:00',
    location: 'Cohort Classroom 14 (2.507)',
    instructors: ['Prof Placeholder A', 'Prof Placeholder B'],
    startDate: '2026-09-02',
    endDate: '2026-09-02',
  };

  it('never emits a content line over 75 octets', () => {
    const enc = new TextEncoder();
    const over = buildICS([long])
      .split('\r\n')
      .filter((l) => enc.encode(l).length > 75);
    expect(over).toEqual([]);
  });

  it('gives the summary back byte-identical, separator included', () => {
    const [ev] = reparse(buildICS([long]));
    expect(ev.summary).toBe(`${long.modCode} ${long.modName} · ${long.type}`);
  });
});

describe('re-exporting updates instead of duplicating', () => {
  it('gives the same class the same UID every time', () => {
    const a = reparse(buildICS(events)).map((v) => v.uid).sort();
    const b = reparse(buildICS(events)).map((v) => v.uid).sort();
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length); // and no two classes collide
  });

  it('carries a SEQUENCE the calendar can compare', () => {
    const later = new ICAL.Component(ICAL.parse(buildICS(events, { sequence: 7 })))
      .getAllSubcomponents('vevent')[0];
    expect(later.getFirstPropertyValue('sequence')).toBe(7);
  });

  it('names the calendar, so a bad import is one deletion', () => {
    const comp = new ICAL.Component(ICAL.parse(buildICS(events, { calendarName: 'modSUTD T1' })));
    expect(comp.getFirstPropertyValue('x-wr-calname')).toBe('modSUTD T1');
  });
});

// The maintainer caught this: a per-browser counter is wrong for a file that
// gets SHARED. A friend's export, or a re-export after clearing site data,
// would carry a LOWER sequence than what the calendar already holds - so the
// update is ignored and the fix never lands. A clock cannot go backwards.
describe('sequence survives being shared between people', () => {
  it('rises with wall-clock time, not with how often one browser exported', () => {
    const t0 = Date.UTC(2026, 7, 13, 10, 0, 0);
    const later = clockSequence(t0 + 5 * 60_000);
    expect(later).toBeGreaterThan(clockSequence(t0));
  });

  it('gives two different devices the same answer at the same moment', () => {
    const now = Date.UTC(2026, 7, 13, 10, 0, 0);
    expect(clockSequence(now)).toBe(clockSequence(now));
  });

  it('never exceeds what the property allows', () => {
    // SEQUENCE is a non-negative integer; clients treat it as signed 32-bit.
    const inAThousandYears = Date.UTC(3026, 0, 1);
    expect(clockSequence(inAThousandYears)).toBeLessThan(2_147_483_647);
    expect(clockSequence(0)).toBeGreaterThanOrEqual(0); // pre-epoch clamps
  });
});

// Shipped broken once: location and endTime were part of the UID, so correcting
// a room gave the student a second copy of that class for the whole term.
describe('a corrected detail updates the class instead of cloning it', () => {
  const base: TimetableEvent = {
    modCode: '10.013', modName: 'Modelling and Analysis', type: 'Lecture',
    day: 'Monday', startTime: '09:00', endTime: '11:00', location: '2.101',
    instructors: [], startDate: '2026-09-14', endDate: '2026-09-14',
  };
  const uidOf = (e: TimetableEvent) => reparse(buildICS([e]))[0].uid;

  it('keeps the UID when the room is corrected', () => {
    expect(uidOf({ ...base, location: '2.102' })).toBe(uidOf(base));
  });

  it('keeps the UID when the end time is corrected', () => {
    expect(uidOf({ ...base, endTime: '12:00' })).toBe(uidOf(base));
  });

  it('keeps the UID when the mod is renamed or an instructor changes', () => {
    expect(uidOf({ ...base, modName: 'Renamed', instructors: ['X'] })).toBe(uidOf(base));
  });

  it('keeps the UID when the class is moved to a different time', () => {
    // A postponed class should update in place, not appear twice.
    expect(uidOf({ ...base, startTime: '14:00', endTime: '16:00' })).toBe(uidOf(base));
  });

  it('still separates two sessions of one mod that share a day', () => {
    // The only case the narrow key cannot express - overwriting one silently
    // would lose a class, so these fall back to including the start time.
    const both = reparse(buildICS([base, { ...base, startTime: '14:00', endTime: '16:00' }]));
    expect(both).toHaveLength(2);
    expect(both[0].uid).not.toBe(both[1].uid);
  });
});

// The export carries two review reminders that are NOT in the pasted timetable,
// and nothing pinned that - a refactor could have dropped them silently, and
// the .ics button promises them by name.
describe('review reminders ride along with the timetable', () => {
  const reminders = buildTermReminderEvents({
    termLabel: 'Term 1, AY2026/27',
    termStartISO: '2026-09-14',
    origin: 'https://modsutd.tech',
  });

  // No calendar passed here, so these are the fallback dates. Where the term IS
  // known the midterm moves off recess week - see termReminders.test.ts.
  it('adds exactly two: a Friday before recess and week 11 Monday', () => {
    expect(reminders.map((r) => r.startDate)).toEqual(['2026-10-30', '2026-11-23']);
  });

  it('survives into the exported file alongside the classes', () => {
    const out = reparse(buildICS([...events, ...reminders]));
    const summaries = out.map((v) => v.summary);
    // A reminder owns its whole SUMMARY: no mod code in front, no type behind.
    expect(summaries.filter((s) => s.startsWith('Reminder to do your'))).toHaveLength(2);
    expect(summaries.some((s) => /Mid-term eval/.test(s))).toBe(true);
    expect(summaries.some((s) => /Final eval/.test(s))).toBe(true);
    // and they must not displace any class
    expect(out.length).toBe(events.reduce((n, e) => n + (e.occurrences?.length || 1), 0) + 2);
  });

  it('points back at the share page so the reminder is actionable', () => {
    const [first] = reparse(buildICS([reminders[0]]));
    expect(first.location).toBe('https://modsutd.tech/share');
  });
});

// The recurring branch emits on the weekday-aligned date, not on startDate.
// A key map built from startDate alone would have no entry for the date
// actually written, which is only invisible while the two happen to coincide.
describe('recurring classes whose start date is not the class weekday', () => {
  const sundayStart: TimetableEvent = {
    modCode: '10.013', modName: 'Modelling and Analysis', type: 'Lecture',
    day: 'Wednesday', startTime: '09:00', endTime: '11:00', location: '1.510',
    instructors: [], startDate: '2026-09-13', endDate: '2026-12-09',
  };

  it('starts on the first matching weekday and still gets a real UID', () => {
    const ics = buildICS([sundayStart]);
    expect(ics).not.toContain('undefined');
    const [ev] = reparse(ics);
    expect(ev.startDate.toString()).toContain('2026-09-16');
    expect(ev.uid).toMatch(/^[0-9a-f]{16}@modsutd$/);
  });
});

// Android's importer writes only to the primary calendar and its app cannot
// delete a calendar, so "delete the whole calendar" is not available there. A
// marker in every event is the only thing the file itself can do to make an
// import findable and undoable.
describe('every event is findable by one search term', () => {
  it('signs every event with the same constant string', () => {
    const out = reparse(buildICS(events, { calendarName: "modSUTD T7 '26" }));
    expect(out.length).toBeGreaterThan(0);
    // Constant, not the calendar name: a student searching to undo an import
    // should not have to remember which term they imported.
    for (const ev of out) expect(ev.description).toContain(SIGNATURE);
  });

  it('keeps the instructors that were already there', () => {
    const [ev] = reparse(buildICS([{
      modCode: '10.013', modName: 'M&A', type: 'Lecture', day: 'Monday',
      startTime: '09:00', endTime: '11:00', location: '1.510',
      instructors: ['Prof Placeholder A'],
      startDate: '2026-09-14', endDate: '2026-09-14',
    }], { calendarName: 'modSUTD TEST' }));
    expect(ev.description).toContain('Prof Placeholder A');
    expect(ev.description).toContain(SIGNATURE);
  });
});

describe('reminders keep the link in one place', () => {
  const [midterm] = buildTermReminderEvents({
    termLabel: "T7 '26", termStartISO: '2026-09-14', origin: 'https://modsutd.tech',
  });

  it('puts the share link in LOCATION, where calendars make it tappable', () => {
    const [ev] = reparse(buildICS([midterm]));
    expect(ev.location).toBe('https://modsutd.tech/share');
  });

  it('does not repeat the url in the description', () => {
    const [ev] = reparse(buildICS([midterm]));
    expect(ev.description).not.toContain('http');
    expect(ev.description).toContain(SIGNATURE);
  });
});

// A calendar updates an event in place when the UID matches. The class UID
// keys on the date, which is right - each occurrence is its own entry. The two
// reminders must NOT: SUTD moves when an eval opens, and a date-keyed reminder
// would leave the old one in every calendar that already imported it while a
// second appeared beside it.
//
// Compared as UID SETS rather than by finding a block by its wording: a
// SUMMARY is folded at 75 octets, so a regex on the copy matches the wrong
// block as soon as the fold lands mid-phrase.
describe('a reminder that moves week stays one event', () => {
  const at = (start: string) =>
    buildTermReminderEvents({ termLabel: 'T7', termStartISO: start, origin: 'https://modsutd.tech' });
  const uidsOf = (ics: string) => (ics.match(/UID:(\S+)/g) ?? []).sort();

  it('keeps the same UIDs when only the date moves', () => {
    const before = at('2026-09-14');
    const moved = before.map((e) => ({ ...e, startDate: '2026-11-30', endDate: '2026-11-30' }));
    expect(uidsOf(buildICS(moved))).toEqual(uidsOf(buildICS(before)));
  });

  it('keeps the same UIDs when only the wording changes', () => {
    const before = at('2026-09-14');
    const reworded = before.map((e) => ({ ...e, modName: 'Totally different words' }));
    expect(uidsOf(buildICS(reworded))).toEqual(uidsOf(buildICS(before)));
  });

  it('still tells the two reminders apart', () => {
    expect(new Set(uidsOf(buildICS(at('2026-09-14')))).size).toBe(2);
  });

  // A different term is a different reminder, or next year's would silently
  // overwrite this year's in the same calendar.
  it('gives a different term its own events', () => {
    const a: string[] = uidsOf(buildICS(at('2026-09-14')));
    const b: string[] = uidsOf(buildICS(at('2027-01-25')));
    expect(a.some((u) => b.includes(u))).toBe(false);
  });

  // A class must keep its per-date UID, or a term of lectures collapses to one.
  it('leaves a repeating class with one UID per occurrence', () => {
    const uids = uidsOf(buildICS(events));
    expect(new Set(uids).size).toBe(uids.length);
  });
});
