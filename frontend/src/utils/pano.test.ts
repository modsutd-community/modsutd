import { describe, it, expect } from 'vitest';
import { panoFor } from './pano';
import type { Venue } from '@/types';

const v = (code: string, type: string, scenes?: string[]): Venue =>
  ({
    code, name: code, type, building: code[0], floor: 1,
    ...(scenes ? { panoScenes: scenes.map((s) => ({ scene: s, title: s })) } : {}),
  }) as unknown as Venue;

// The tour photographed a sample, not all 225 rooms. 1.412 had a 360 and
// 1.407, 1.410A, 1.411 and 1.511 did not, for no reason a student could see.
const ALL = [
  v('1.407', 'Cohort Classroom'),
  v('1.411', 'Cohort Classroom'),
  v('1.412', 'Cohort Classroom', ['s1']),
  v('1.314', 'Cohort Classroom', ['s0']),
  v('2.101', 'Lecture Theatre', ['lt']),
  v('1.203', 'Lecture Theatre'),
  v('5.101-08', 'Lab', ['fab']),
  v('2.207', 'Lab'),
  v('61.101', 'Studio', ['dance']),
  v('1.504', 'Studio'),
  v('Library', 'Facility', ['lib']),
  v('Gym', 'Facility'),
];

describe('which 360 tour a room shows', () => {
  it('shows its own when it has one', () => {
    const p = panoFor(v('1.412', 'Cohort Classroom', ['s1']), ALL)!;
    expect(p.from).toBe('1.412');
  });

  it('borrows from the same type when it has none', () => {
    const p = panoFor(v('1.411', 'Cohort Classroom'), ALL)!;
    expect(p.from).toBe('1.314');
  });

  // A tour that changes identity between visits reads as a bug.
  it('always borrows from the same room, not whichever came first', () => {
    expect(panoFor(v('1.407', 'Cohort Classroom'), ALL)!.from).toBe('1.314');
    expect(panoFor(v('1.411', 'Cohort Classroom'), [...ALL].reverse())!.from).toBe('1.314');
  });

  it('never crosses a type', () => {
    expect(panoFor(v('9.999', 'Meeting Room'), ALL)).toBeNull();
  });

  // The Fab Lab is the only lab anyone photographed, and it is a maker space.
  // Lending it to the cleanroom or the furnace lab would describe a room
  // nobody has seen with pictures of a different one.
  it('keeps the Fab Lab tour to the Fab Lab', () => {
    expect(panoFor(v('5.101-08', 'Lab', ['fab']), ALL)!.from).toBe('5.101-08');
    expect(panoFor(v('2.207', 'Lab'), ALL)).toBeNull();
  });

  // Dance Studio 1 is not what an architecture studio looks like.
  it('does not lend the dance studio to the other studios', () => {
    expect(panoFor(v('1.504', 'Studio'), ALL)).toBeNull();
  });

  // The Auditorium is the largest room on campus.
  it('does not lend the auditorium to the lecture theatres', () => {
    expect(panoFor(v('1.203', 'Lecture Theatre'), ALL)).toBeNull();
  });

  // The library does not stand in for the gym: a facility is its own place,
  // not an instance of a repeated room type.
  it('never borrows for a facility', () => {
    expect(panoFor(v('Gym', 'Facility'), ALL)).toBeNull();
  });
});
