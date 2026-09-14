import { describe, expect, it } from 'vitest';
import { parseTimetableText } from './timetableParser';
import { SAMPLE_LIST_VIEW } from './sampleTimetable';

const SAMPLE = `
01.106 - Engineering Management
1010 LE01 Lecture
   Mo 09:00 - 11:00 2.101
       Prof. John Doe
   01/09/2026 - 13/12/2026
1010 CO01 Cohort Based Learning
   We 14:00 - 16:00 1.609
       Prof. Jane Smith
   01/09/2026 - 13/12/2026

10.013 - Modelling and Analysis
1010 LE01 Lecture
   Tu 10:00 - 12:00 1.310
       Prof. Wong Ee Hou
   01/09/2026 - 13/12/2026
`;

describe('parseTimetableText', () => {
  it('extracts mod codes and types from MyPortal-style text', () => {
    const events = parseTimetableText(SAMPLE);
    expect(events.length).toBeGreaterThanOrEqual(3);
    const codes = events.map((e) => e.modCode);
    expect(codes).toContain('01.106');
    expect(codes).toContain('10.013');
  });

  it('preserves the canonical mod code format', () => {
    const events = parseTimetableText('01.106 - Engineering Management\n' + SAMPLE);
    for (const e of events) expect(e.modCode).toMatch(/^\d{2}\.\d{3}/);
  });

  it('returns ISO dates and 24h times', () => {
    const events = parseTimetableText(SAMPLE);
    const e = events[0];
    expect(e.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(e.startTime).toMatch(/^\d{2}:\d{2}$/);
  });

  it('returns empty list for non-matching input', () => {
    expect(parseTimetableText('hello world')).toEqual([]);
  });

  it('maps day codes to full names', () => {
    const events = parseTimetableText(SAMPLE);
    const days = new Set(events.map((e) => e.day));
    expect(days).toContain('Monday');
    expect(days).toContain('Wednesday');
    expect(days).toContain('Tuesday');
  });
});

// The fixture above predates any sight of real SAMS output. These cover the
// shape a select-all copy actually produces.
describe('parseTimetableText on SAMS List View shape', () => {
  it('collapses one-row-per-week into a single event with occurrences', () => {
    const events = parseTimetableText(SAMPLE_LIST_VIEW);
    const ent = events.filter((e) => e.modCode === '30.111');
    expect(ent).toHaveLength(1);
    expect(ent[0].occurrences).toHaveLength(13);
    expect(ent[0].startDate).toBe('2026-09-17');
    expect(ent[0].endDate).toBe('2026-12-17');
  });

  // Week 7 IS the recess week at SUTD, 25 Oct to 1 Nov 2026, so 29/10 is the
  // Thursday that does not meet and 05/11 is the one that does.
  it('leaves recess week out of the occurrences instead of inventing it', () => {
    const [ent] = parseTimetableText(SAMPLE_LIST_VIEW).filter((e) => e.modCode === '30.111');
    expect(ent.occurrences).toContain('2026-10-22');
    expect(ent.occurrences).not.toContain('2026-10-29');
    expect(ent.occurrences).toContain('2026-11-05');
  });

  // Deepavali falls Sunday 8 Nov 2026, so Monday 9 Nov is the holiday in lieu
  // and the Monday lecture has one fewer meeting than the Thursday class.
  it('leaves the public holiday out too', () => {
    const [lec] = parseTimetableText(SAMPLE_LIST_VIEW).filter((e) => e.modCode === '10.013');
    expect(lec.occurrences).not.toContain('2026-11-09');
    expect(lec.occurrences).toHaveLength(12);
  });

  it('normalises the component abbreviation to a canonical lesson type', () => {
    const events = parseTimetableText(SAMPLE_LIST_VIEW);
    expect(events.find((e) => e.modCode === '30.111')?.type).toBe('Cohort');
    expect(events.find((e) => e.modCode === '10.013')?.type).toBe('Lecture');
  });

  it('takes the room code out of the printed room name', () => {
    const events = parseTimetableText(SAMPLE_LIST_VIEW);
    expect(events.find((e) => e.modCode === '30.111')?.location).toBe('2.507');
    expect(events.find((e) => e.modCode === '10.013')?.location).toBe('1.510');
  });

  it('reads the stray space in the course code and 12-hour times', () => {
    const events = parseTimetableText(SAMPLE_LIST_VIEW);
    const mna = events.find((e) => e.modCode === '10.013');
    expect(mna).toBeDefined();
    expect(mna?.startTime).toBe('09:00');
    expect(mna?.endTime).toBe('11:00');
  });

  it('drops a waitlisted row that carries no day or time', () => {
    const events = parseTimetableText(SAMPLE_LIST_VIEW);
    expect(events.some((e) => e.modCode === '40.012')).toBe(false);
  });
});

// The Section column. MyPortal prints it once per group beside the Class Nbr
// and the Component, and it was matched and discarded - so a reader with two
// cohorts of one course in a week had nothing telling them which was which.
describe('which cohort the reader is in', () => {
  it('carries the section off the group header', () => {
    const events = parseTimetableText(SAMPLE_LIST_VIEW);
    const byCode = (c: string) => events.find((e) => e.modCode === c);
    expect(byCode('30.111')?.section).toBe('CP02');
    expect(byCode('10.013')?.section).toBe('LE01');
    expect(byCode('50.002X')?.section).toBe('LA01');
  });

  it('drops a capstone project team, which is not a cohort', () => {
    const capstone = [
      '01 .400 - Capstone 1',
      'Class Nbr\tSection\tComponent\tDays & Times\tRoom\tInstructor\tStart/End Date',
      '1207\tCC01\tCBL\tWe 10:30AM - 1:30PM\tCapstone 1 (1.411)\tProf A\t16/09/2026 - 16/09/2026',
    ].join('\n');
    const events = parseTimetableText(capstone);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('Cohort');
    expect(events[0].section).toBeUndefined();
  });

  it('keeps two sections of one course apart when they share a room and an hour', () => {
    // Without the section in the collapse key these merge into whichever came
    // first, and one of the two disappears from the week.
    const twoSections = [
      '50 .057 - Analysis and Design of Algorithms',
      'Class Nbr\tSection\tComponent\tDays & Times\tRoom\tInstructor\tStart/End Date',
      '1001\tCI01\tCBL\tTh 4:00PM - 7:00PM\tThink Tank 9 (1.415)\tProf A\t17/09/2026 - 17/09/2026',
      '1002\tCI02\tCBL\tTh 4:00PM - 7:00PM\tThink Tank 9 (1.415)\tProf B\t17/09/2026 - 17/09/2026',
    ].join('\n');
    const events = parseTimetableText(twoSections);
    expect(events.map((e) => e.section).sort()).toEqual(['CI01', 'CI02']);
  });
});
