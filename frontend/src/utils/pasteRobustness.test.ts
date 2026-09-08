import { describe, it, expect } from 'vitest';
import { parseTimetableText, normaliseType } from './timetableParser';
import { SAMPLE_LIST_VIEW } from './sampleTimetable';

// Ctrl/Cmd A on MyPortal selects the whole page, not the schedule, so the
// paste arrives wrapped in portal chrome. The instructions say select-all
// because anything more precise is not reproducible across browsers - so
// extraction has to be indifferent to what surrounds the schedule.

// Verbatim from a real MyPortal select-all, minus the student's name.
const CHROME_BEFORE = [
  'go to ...', 'GO!', 'Andrew X Y Z', 'Search', 'Plan', 'Enroll', 'My Academics',
  '  My Class Schedule     |     Add     |     Drop     |     Swap     |     Term Information  ',
  'My Class Schedule', 'List View', 'Weekly Calendar View', 'Select Display Option',
].join('\n');

const CHROME_AFTER = [
  'Display Options Collapsible section Display Options ',
  'Show AM/PM', 'Monday', 'Thursday', 'Sunday', 'Show Class Title',
  'Tuesday', 'Friday', 'Show Instructors', 'Wednesday', 'Saturday',
  'Printer Friendly Page', 'Go to top iconGo to top',
].join('\n');

describe('a select-all paste parses the same as the schedule alone', () => {
  const bare = parseTimetableText(SAMPLE_LIST_VIEW);

  it('ignores the portal chrome around it', () => {
    const wrapped = parseTimetableText(`${CHROME_BEFORE}\n${SAMPLE_LIST_VIEW}\n${CHROME_AFTER}`);
    expect(wrapped).toEqual(bare);
  });

  it('is indifferent to leading and trailing blank lines', () => {
    expect(parseTimetableText(`\n\n\n${SAMPLE_LIST_VIEW}\n\n  \n`)).toEqual(bare);
  });

  // The chrome carries the words "List View" and "Weekly Calendar View", which
  // is exactly the text a looser detector would trip on.
  it('does not invent a class out of the chrome alone', () => {
    expect(parseTimetableText(`${CHROME_BEFORE}\n${CHROME_AFTER}`)).toEqual([]);
  });
});

// The two views print the component differently - List View abbreviates, the
// weekly grid spells it out - and the abbreviation is half of the .ics UID. If
// a canonical type is reachable from only one of the two spellings, the same
// class gets two identities and a later paste duplicates the term instead of
// updating it. Checking the pairs we happen to know is not enough, so this
// asserts the table is structurally complete for every type it supports.
describe('every lesson type is reachable from both spellings', () => {
  const SPELLINGS: Record<string, [string, string]> = {
    Cohort: ['cbl', 'cohort based learning'],
    Lecture: ['lec', 'lecture'],
    Lab: ['lab', 'laboratory'],
    Tutorial: ['tut', 'tutorial'],
    Studio: ['stu', 'studio'],
    Seminar: ['sem', 'seminar'],
    Recitation: ['rec', 'recitation'],
  };

  it.each(Object.entries(SPELLINGS))('%s maps from both', (canonical, [abbrev, full]) => {
    expect(normaliseType(abbrev)).toBe(canonical);
    expect(normaliseType(full)).toBe(canonical);
    expect(normaliseType(abbrev.toUpperCase())).toBe(canonical);
    // The weekly grid title-cases it: "Cohort Based Learning".
    expect(normaliseType(full.replace(/\b\w/g, (c) => c.toUpperCase()))).toBe(canonical);
  });

  // The residual risk, stated rather than hidden: a component SAMS invents that
  // is in neither spelling falls through to the raw text, and the two views
  // then disagree. There is no offline way to learn the pairing - the fix is
  // one line in TYPE_ALIASES - so this pins the shape of the failure so it is
  // recognisable when it happens rather than mysterious.
  it('an unmapped component falls through to raw text, differently per view', () => {
    expect(normaliseType('WKS')).toBe('WKS');
    expect(normaliseType('Workshop')).toBe('Workshop');
  });
});
