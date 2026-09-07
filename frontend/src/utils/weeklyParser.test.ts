// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseWeeklyHtml, looksWeekly } from './weeklyParser';

// Shaped exactly like the live SAMS grid: <br> between the lines of a class
// cell, &nbsp; in empty ones, and - the point of the whole file - a class cell
// with rowspan so later rows carry FEWER <td> than the table has columns.
const cell = (lines: string[]) => `<span>${lines.join('<br>')}</span>`;
const empty = '<td>&nbsp;</td>';

const CAPSTONE = cell([
  '01 .400 - CC01', 'Capstone 1', 'Cohort Based Learning',
  '8:30AM - 11:30AM', 'ECC Building 1 1.411',
]);
const DESIGN = cell([
  '02 .155 - L01', 'Design Thinking', 'Lecture',
  '10:30AM - 12:00PM', 'Lecture Theatre 2 2.401',
]);

const GRID = `
<p>Week of 14/9/2026 - 20/9/2026</p>
<table id="WEEKLY_SCHED_HTMLAREA">
<tr>
  <th>Time</th><th>Monday<br> 14 Sep</th><th>Tuesday<br> 15 Sep</th>
  <th>Wednesday<br> 16 Sep</th><th>Thursday<br> 17 Sep</th><th>Friday<br> 18 Sep</th>
  <th>Saturday<br> 19 Sep</th><th>Sunday<br> 20 Sep</th>
</tr>
<tr>
  <td>8:00AM</td>${empty}${empty}${empty}${empty}
  <td rowspan="5">${CAPSTONE}</td>${empty}${empty}
</tr>
<tr><td>9:00AM</td>${empty}${empty}${empty}${empty}${empty}${empty}</tr>
<tr><td rowspan="2">10:00AM</td>${empty}${empty}${empty}${empty}${empty}${empty}</tr>
<tr>${empty}${empty}<td rowspan="4">${DESIGN}</td>${empty}${empty}${empty}</tr>
<tr><td>11:00AM</td>${empty}${empty}${empty}${empty}${empty}</tr>
</table>`;

describe('parseWeeklyHtml', () => {
  it('reads a class out of the weekly grid', () => {
    const { events } = parseWeeklyHtml(GRID);
    expect(events).toHaveLength(2);
    // sorted chronologically, so find it rather than index into it
    expect(events.find((e) => e.modCode === '01.400')).toMatchObject({
      modCode: '01.400',
      modName: 'Capstone 1',
      type: 'Cohort',
      day: 'Friday',
      startTime: '08:30',
      endTime: '11:30',
      location: '1.411',
      startDate: '2026-09-18',
      endDate: '2026-09-18',
    });
  });

  // The regression this parser exists for. Two columns of row 5 are spoken for
  // by rowspans from above, so counting <td> puts this class on Tuesday. It is
  // Wednesday. Delete the occupancy tracking in columnOf and this goes red.
  it('places a class by grid column, not by cell count', () => {
    const { events } = parseWeeklyHtml(GRID);
    const design = events.find((e) => e.modCode === '02.155');
    expect(design?.day).toBe('Wednesday');
    expect(design?.startDate).toBe('2026-09-16');
  });

  // The header prints "16 Sep" with no year, so a December paste would land in
  // the wrong one. Refuse rather than guess.
  it('refuses a grid with no "Week of" line', () => {
    const res = parseWeeklyHtml(GRID.replace(/<p>.*?<\/p>/, ''));
    expect(res.missingWeek).toBe(true);
    expect(res.events).toHaveLength(0);
  });

  it('takes the week line from the plain text when the copy lost it', () => {
    const res = parseWeeklyHtml(GRID.replace(/<p>.*?<\/p>/, ''), 'Week of 14/9/2026 - 20/9/2026');
    expect(res.events).toHaveLength(2);
  });

  // Without "Show Class Title" ticked the cell is four lines, not five.
  it('parses a cell with no title row', () => {
    const noTitle = GRID.replace('Capstone 1<br>', '');
    const ev = parseWeeklyHtml(noTitle).events.find((e) => e.modCode === '01.400');
    expect(ev?.modName).toBe('');
    expect(ev?.type).toBe('Cohort');
    expect(ev?.startTime).toBe('08:30');
  });

  it('keeps each class to its own dated day, inventing no term', () => {
    for (const e of parseWeeklyHtml(GRID).events) expect(e.startDate).toBe(e.endDate);
  });

  it('tells the weekly grid apart from anything else pasted', () => {
    expect(looksWeekly(GRID)).toBe(true);
    expect(looksWeekly('<p>hello</p>')).toBe(false);
  });
});
