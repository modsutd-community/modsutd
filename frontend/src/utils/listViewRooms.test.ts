import { describe, it, expect } from 'vitest';
import { parseTimetableText } from './timetableParser';

// The shape of a real MyPortal List View copy, with the names replaced. Two
// things here are load-bearing and neither was covered before:
//
//   1. The cells arrive NEWLINE-separated, not tab-separated. The parser split
//      on tabs only, so the lazy room capture took the first word - every room
//      came out as "Cohort", "Lecture" or "Capstone", the room finder built
//      heatmaps for rooms that do not exist, and the .ics said "at Lecture".
//   2. A class can list TWO instructors on two lines, which pushes the room
//      two cells further from the end. Counting back a fixed number of cells
//      made the location a person's name.
const PASTE = `
01 .400 - Capstone 1
Class Nbr\tSection\tComponent\tDays & Times\tRoom\tInstructor\tStart/End Date
1207
CC01
CBL
We 10:30AM - 1:30PM
Capstone 1 (1.411)
Prof Placeholder A
14/09/2026 - 23/10/2026

50 .040 - Natural Language Processing
Class Nbr\tSection\tComponent\tDays & Times\tRoom\tInstructor\tStart/End Date
1077
CI03
Lecture
Mo 1:00PM - 3:00PM
Lecture Theatre 2 (1.203)
Prof Placeholder B,
Prof Placeholder C
14/09/2026 - 14/09/2026
`;

describe('a List View copy with real cell boundaries', () => {
  const evs = parseTimetableText(PASTE);

  it('reads the bracketed room code, never the printed name', () => {
    expect(evs.map((e) => e.location)).toEqual(['1.411', '1.203']);
    // The failure mode this replaces: a room called "Capstone" or "Lecture".
    for (const e of evs) expect(e.location).toMatch(/^\d{1,2}\.\d{3}[A-Za-z]?$/);
  });

  it('survives a second instructor on its own line', () => {
    const nlp = evs.find((e) => e.modCode === '50.040')!;
    expect(nlp.location).toBe('1.203');
    expect(nlp.instructors.join(' ')).toContain('Placeholder B');
    expect(nlp.instructors.join(' ')).toContain('Placeholder C');
  });

  it('keeps the printed room name for the calendar export', () => {
    expect(evs.map((e) => e.venueName)).toEqual([
      'Capstone 1 (1.411)',
      'Lecture Theatre 2 (1.203)',
    ]);
  });

  // Some browsers copy the same table with CRLF line endings.
  it('reads the same table with windows line endings', () => {
    const crlf = parseTimetableText(PASTE.replace(/\n/g, '\r\n'));
    expect(crlf.map((e) => e.location)).toEqual(['1.411', '1.203']);
  });
});
