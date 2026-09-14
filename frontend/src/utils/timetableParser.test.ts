import { describe, expect, it } from 'vitest';
import { parseTimetableText, kindLabel } from './timetableParser';
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
  it('carries a CI section off the group header', () => {
    const one = [
      '50 .040 - Natural Language Processing',
      'Class Nbr\tSection\tComponent\tDays & Times\tRoom\tInstructor\tStart/End Date',
      '1077\tCI03\tCBL\tTh 2:00PM - 3:00PM\tCohort Classroom 14 (2.507)\tProf A\t17/09/2026 - 17/09/2026',
    ].join('\n');
    expect(parseTimetableText(one)[0].section).toBe('CI03');
  });

  it('keeps nothing else, because nothing else names a group you sit with', () => {
    // The sample's sections are CP02, LE01, LA01 and TU01 - a lecture section
    // is everybody, and the rest name no room-sharing group either.
    const events = parseTimetableText(SAMPLE_LIST_VIEW);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.section === undefined)).toBe(true);
  });

  it('collapses two non-CI sections that share an hour and a room', () => {
    // Dropping the label means the collapse key no longer tells them apart,
    // which is the behaviour before any section was read: two rows with the
    // same type, day, hour and room describe one thing a reader walks to, and
    // a second copy of it carries nothing they can act on. Two CI sections
    // still stay apart, which is the case below.
    const twoLectures = [
      '10 .013 - Modelling and Analysis',
      'Class Nbr\tSection\tComponent\tDays & Times\tRoom\tInstructor\tStart/End Date',
      '2201\tLI01\tLEC\tMo 9:00AM - 11:00AM\tLecture Theatre 5 (1.510)\tProf A\t14/09/2026 - 14/09/2026',
      '2202\tLI02\tLEC\tMo 9:00AM - 11:00AM\tLecture Theatre 5 (1.510)\tProf A\t14/09/2026 - 14/09/2026',
    ].join('\n');
    const events = parseTimetableText(twoLectures);
    expect(events).toHaveLength(1);
    expect(events[0].section).toBeUndefined();
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

// A course can print a cohort group and then a team group. The section is
// recomputed from the nearest preceding header for every row, so the second
// group must not inherit the first one's.
describe('two groups under one course', () => {
  const mixed = [
    '01 .400 - Capstone 1',
    'Class Nbr\tSection\tComponent\tDays & Times\tRoom\tInstructor\tStart/End Date',
    '1001\tCI01\tCBL\tTu 2:00PM - 5:00PM\tThink Tank 9 (1.415)\tProf A\t15/09/2026 - 15/09/2026',
    '1207\tCC01\tCBL\tWe 10:30AM - 1:30PM\tCapstone 1 (1.411)\tProf B\t16/09/2026 - 16/09/2026',
  ].join('\n');

  it('a team group after a cohort group inherits nothing', () => {
    const events = parseTimetableText(mixed);
    const byDay = (d: string) => events.find((e) => e.day === d);
    expect(byDay('Tuesday')?.section).toBe('CI01');
    expect(byDay('Wednesday')?.section).toBeUndefined();
  });
});

// One home for the join, because the grid chip, its tooltip and the .ics
// summary all print it and a calendar naming a cohort the grid does not is
// worse than neither naming it.
describe('the kind label', () => {
  it('names the cohort after the type', () => {
    expect(kindLabel({ type: 'Cohort', section: 'CI03' })).toBe('Cohort CI03');
  });

  it('reads exactly as before when there is no cohort to name', () => {
    expect(kindLabel({ type: 'Cohort' })).toBe('Cohort');
    expect(kindLabel({ type: 'Lecture', section: undefined })).toBe('Lecture');
  });

  it('leaves no dangling space for a reminder, which has neither', () => {
    expect(kindLabel({})).toBe('');
  });
});
