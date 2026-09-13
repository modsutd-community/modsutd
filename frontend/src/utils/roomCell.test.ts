import { describe, it, expect } from 'vitest';
import { parseTimetableText } from './timetableParser';
import { eventsToSlots } from './contributeTimetable';

// Where "Albert" came from, reproduced.
//
// SUTD prints a room as a NAME when it has no code to print, and the room cell
// used to be found by looking for a bracketed code. A row with none fell
// through to the whole-match capture, which is lazy and stops at the first
// space, so "Albert Hong Lecture Theatre 1" was sent as "Albert" and
// "Studio 7" as "Studio". Both then reached /data as room codes, with the room
// finder drawing heatmaps for rooms that do not exist.
//
// The room is the cell AFTER the day-and-time cell, which is true whether or
// not it prints a code.

const row = (room: string, instructor = 'Prof Placeholder A') =>
  ['1207', 'CC01', 'CBL', 'Mo 10:30AM - 1:30PM', room, instructor,
   '14/09/2026 - 23/10/2026'].join('\t');

const paste = (...rows: string[]) =>
  ['50 .001 - Information Systems & Programming',
   'Class Nbr\tSection\tComponent\tDays & Times\tRoom\tInstructor\tStart/End Date',
   ...rows].join('\n');

const locations = (text: string) => parseTimetableText(text).map((e) => e.location);

describe('finding the room cell', () => {
  it('keeps a room name whole when it prints no code', () => {
    expect(locations(paste(row('Albert Hong Lecture Theatre 1'))))
      .toEqual(['Albert Hong Lecture Theatre 1']);
    expect(locations(paste(row('Studio 7')))).toEqual(['Studio 7']);
    expect(locations(paste(row('Cohort Classroom 14')))).toEqual(['Cohort Classroom 14']);
  });

  it('still prefers a bracketed code when the row prints one', () => {
    expect(locations(paste(row('Cohort Classroom 14 (2.507)')))).toEqual(['2.507']);
    expect(locations(paste(row('Lecture Theatre 1 (1.102)')))).toEqual(['1.102']);
  });

  // The case the old rule was written for, which has to keep working: a class
  // listing two instructors pushes the dates further back, and a fixed offset
  // from the end made the location a person's name.
  it('is not confused by two instructors', () => {
    const two = ['1207', 'CC01', 'CBL', 'Mo 10:30AM - 1:30PM', 'Studio 7',
                 'Prof A', 'Prof B', '14/09/2026 - 23/10/2026'].join('\t');
    const events = parseTimetableText(paste(two));
    expect(events.map((e) => e.location)).toEqual(['Studio 7']);
    expect(events[0].instructors).toEqual(['Prof A', 'Prof B']);
  });

  it('does not send the room as the instructor, or the reverse', () => {
    const events = parseTimetableText(paste(row('Albert Hong Lecture Theatre 1', 'Wee Kim')));
    expect(events[0].instructors).toEqual(['Wee Kim']);
    expect(events[0].location).not.toContain('Wee');
  });

  // What actually leaves the browser. The room name travels whole, so
  // tools/venue_resolve.py gets the string it can resolve rather than a
  // fragment it has to guess from.
  it('sends the whole name to the contribution', () => {
    const slots = eventsToSlots(parseTimetableText(paste(row('Albert Hong Lecture Theatre 1'))));
    expect(slots.map((s) => s.venue)).toEqual(['Albert Hong Lecture Theatre 1']);
  });
});
