// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseTimetableText } from './timetableParser';
import { parseWeeklyHtml } from './weeklyParser';
import { expandWeekToTerm, termFor } from './termCalendar';
import type { TermCalendar } from './termCalendar';
import { buildICS } from './icsGenerator';
import CAL from '../../../data/term-calendar.json';

const cal = CAL as unknown as TermCalendar;

// List View is only available once enrolment is final, so a student will often
// paste the weekly view first and List View later. The two must agree on event
// identity or the second import duplicates the term instead of updating it.
// The UID is mod + type + date, and the two views print all three differently:
// "01 .400 - Capstone 1" against "01 .400 - CC01", "CBL" against "Cohort Based
// Learning". This pins that they still land on the same identity.

// The term the weekly fixture below is a week of. Not terms[0]: the calendar
// is generated and carries every trimester of five years, so which one is
// first moves with SUTD's page rather than with anything this test is about.
const term = termFor('2026-09-14', cal)!;
const fridays = term.teachingWeeks.map((w) => {
  const [y, m, d] = w.monday.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + 4 * 86_400_000);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${z(dt.getUTCMonth() + 1)}-${z(dt.getUTCDate())}`;
});
const ddmmyyyy = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

// One class, every teaching Friday, exactly as SAMS prints it once enrolment
// is final. No cancellations, which is the case under test.
const LIST_VIEW = [
  '01 .400 - Capstone 1',
  'Class Nbr\tSection\tComponent\tDays & Times\tRoom\tInstructor\tStart/End Date',
  ...fridays.map((f, i) =>
    (i === 0 ? '1111\tCC01\tCBL\t' : '\u00a0\t\u00a0\t\u00a0\t')
    + `Fr 8:30AM - 11:30AM\tCohort Classroom (1.411)\tProf Placeholder A\t${ddmmyyyy(f)} - ${ddmmyyyy(f)}`),
].join('\n');

const WEEKLY_HTML = `<p>Week of 14/9/2026 - 20/9/2026</p>
<table id="WEEKLY_SCHED_HTMLAREA">
<tr><th>Time</th><th>Monday<br> 14 Sep</th><th>Tuesday<br> 15 Sep</th><th>Wednesday<br> 16 Sep</th>
<th>Thursday<br> 17 Sep</th><th>Friday<br> 18 Sep</th><th>Saturday<br> 19 Sep</th><th>Sunday<br> 20 Sep</th></tr>
<tr><td>8:00AM</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
<td rowspan="5"><span>01 .400 - CC01<br>Capstone 1<br>Cohort Based Learning<br>8:30AM - 11:30AM<br>ECC Building 1 1.411</span></td>
<td>&nbsp;</td><td>&nbsp;</td></tr>
</table>`;

const uidsOf = (ics: string) => ics.split(/\r?\n/).filter((l) => l.startsWith('UID:')).sort();

describe('weekly view and list view agree on event identity', () => {
  const fromList = parseTimetableText(LIST_VIEW);
  const fromWeekly = expandWeekToTerm(parseWeeklyHtml(WEEKLY_HTML).events, cal).events;

  it('both read the same class', () => {
    expect(fromList).toHaveLength(1);
    expect(fromWeekly).toHaveLength(1);
    expect(fromWeekly[0].modCode).toBe(fromList[0].modCode);
    // "CBL" and "Cohort Based Learning" are the same component printed twice.
    expect(fromWeekly[0].type).toBe(fromList[0].type);
    expect(fromWeekly[0].occurrences).toEqual(fromList[0].occurrences);
  });

  // The guarantee: paste weekly now, list view later, and the second import
  // updates the first in place instead of duplicating the term.
  it('produce byte-identical UIDs with no cancellations', () => {
    expect(uidsOf(buildICS(fromWeekly))).toEqual(uidsOf(buildICS(fromList)));
    expect(uidsOf(buildICS(fromList))).toHaveLength(13);
  });

  // Room is deliberately outside the UID, so the later paste corrects the room
  // rather than orphaning the event. Pinning that the two views differing on
  // the printed room does not split identity.
  it('still agree when the two views print the room differently', () => {
    expect(fromWeekly[0].location).toBe(fromList[0].location);
    const moved = [{ ...fromWeekly[0], location: '2.401' }];
    expect(uidsOf(buildICS(moved))).toEqual(uidsOf(buildICS(fromList)));
  });
});
