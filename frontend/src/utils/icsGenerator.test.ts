import { describe, expect, it } from 'vitest';
import { buildICS } from './icsGenerator';
import type { TimetableEvent } from '@/types';

const event: TimetableEvent = {
  modCode: '10.013',
  modName: 'Modelling and Analysis',
  type: 'Lecture',
  day: 'Monday',
  startTime: '09:00',
  endTime: '11:00',
  location: '2.101',
  instructors: ['Prof. Wong Ee Hou'],
  startDate: '2026-09-01',
  endDate: '2026-09-01',
};

describe('buildICS', () => {
  const ics = buildICS([event]);

  it('emits the canonical VCALENDAR envelope', () => {
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
  });

  it('declares the Asia/Singapore timezone', () => {
    expect(ics).toContain('TZID:Asia/Singapore');
    expect(ics).toContain('TZOFFSETFROM:+0800');
    expect(ics).toContain('TZOFFSETTO:+0800');
  });

  it('uses local datetime stamps tagged with the SG TZ - no Date() drift', () => {
    expect(ics).toContain('DTSTART;TZID=Asia/Singapore:20260901T090000');
    expect(ics).toContain('DTEND;TZID=Asia/Singapore:20260901T110000');
    expect(ics).not.toContain('20260901T090000Z'); // never UTC for class times
  });

  it('escapes commas, semicolons and newlines in TEXT fields per RFC 5545', () => {
    const tricky: TimetableEvent = {
      ...event,
      modName: 'Comma, semicolon; and \n newlines',
    };
    const out = buildICS([tricky]);
    expect(out).toContain('SUMMARY:10.013 Comma\\, semicolon\\; and \\n newlines · Lecture');
  });

  it('emits one VEVENT per input event', () => {
    const many = [event, { ...event, modCode: '50.001' }];
    const out = buildICS(many);
    const opens = out.match(/BEGIN:VEVENT/g)?.length ?? 0;
    const closes = out.match(/END:VEVENT/g)?.length ?? 0;
    expect(opens).toBe(2);
    expect(closes).toBe(2);
  });

  it('does not emit an RRULE for a single-date event', () => {
    expect(ics).not.toContain('RRULE');
  });
});

describe('buildICS · weekly recurrence over a term', () => {
  // Term runs Tue 2026-09-01 → Sun 2026-12-13; the class meets Wednesdays.
  const weekly: TimetableEvent = {
    modCode: '10.013',
    modName: 'Modelling and Analysis',
    type: 'Lecture',
    day: 'Wednesday',
    startTime: '09:00',
    endTime: '11:00',
    location: '2.101',
    instructors: [],
    startDate: '2026-09-01',
    endDate: '2026-12-13',
  };
  const ics = buildICS([weekly]);

  it('aligns DTSTART to the first occurrence of the weekday on/after startDate', () => {
    expect(ics).toContain('DTSTART;TZID=Asia/Singapore:20260902T090000');
  });

  it('ends the VEVENT on the same day as it starts - never at term end', () => {
    expect(ics).toContain('DTEND;TZID=Asia/Singapore:20260902T110000');
    expect(ics).not.toContain('DTEND;TZID=Asia/Singapore:20261213');
  });

  it('recurs weekly until the term end, with UNTIL in UTC per RFC 5545', () => {
    // 2026-12-13 23:59:59 SGT == 2026-12-13 15:59:59 UTC
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261213T155959Z');
  });

  it('keeps DTSTART on startDate when startDate already falls on the weekday', () => {
    const mondayClass = { ...weekly, day: 'Monday' as const, startDate: '2026-09-07' };
    const out = buildICS([mondayClass]);
    expect(out).toContain('DTSTART;TZID=Asia/Singapore:20260907T090000');
  });

  it('skips an event whose weekday never occurs inside its date range', () => {
    // Contradictory input: a "Thursday" class in a Fri→Tue window. Emitting
    // it on the wrong weekday would be confidently wrong - omit instead.
    const impossible = { ...weekly, day: 'Thursday' as const, startDate: '2026-09-04', endDate: '2026-09-08' };
    const out = buildICS([impossible]);
    expect(out).not.toContain('BEGIN:VEVENT');
  });
});

describe('buildICS · explicit per-week occurrences', () => {
  // DOM-captured timetables know the exact dates (holidays, reschedules) -
  // one VEVENT per date, no recurrence rule.
  const captured: TimetableEvent = {
    modCode: '50.001',
    modName: 'Information Systems',
    type: 'Cohort',
    day: 'Wednesday',
    startTime: '13:00',
    endTime: '15:00',
    location: '1.502',
    instructors: [],
    startDate: '2026-09-01',
    endDate: '2026-12-13',
    occurrences: ['2026-09-02', '2026-09-09', '2026-09-23'],
  };
  const ics = buildICS([captured]);

  it('emits one VEVENT per occurrence date', () => {
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(3);
    expect(ics).toContain('DTSTART;TZID=Asia/Singapore:20260902T130000');
    expect(ics).toContain('DTSTART;TZID=Asia/Singapore:20260909T130000');
    expect(ics).toContain('DTSTART;TZID=Asia/Singapore:20260923T130000');
  });

  it('ends each occurrence the same day and emits no RRULE', () => {
    expect(ics).toContain('DTEND;TZID=Asia/Singapore:20260923T150000');
    expect(ics).not.toContain('RRULE');
  });
});
