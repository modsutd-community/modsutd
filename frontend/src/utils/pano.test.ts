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
  v('Library', 'Facility', ['lib']),
  v('Gym', 'Facility'),
];

describe('which 360 tour a room shows', () => {
  it('shows its own when it has one', () => {
    const p = panoFor(v('1.412', 'Cohort Classroom', ['s1']), ALL)!;
    expect(p.from).toBe('1.412');
    expect(p.representative).toBe(false);
  });

  it('borrows from the same type when it has none', () => {
    const p = panoFor(v('1.411', 'Cohort Classroom'), ALL)!;
    expect(p.representative).toBe(true);
    expect(p.from).toBe('1.314');
  });

  // A tour that changes identity between visits reads as a bug.
  it('always borrows from the same room, not whichever came first', () => {
    expect(panoFor(v('1.407', 'Cohort Classroom'), ALL)!.from).toBe('1.314');
    expect(panoFor(v('1.411', 'Cohort Classroom'), [...ALL].reverse())!.from).toBe('1.314');
  });

  it('never crosses a type', () => {
    expect(panoFor(v('9.999', 'Studio'), ALL)).toBeNull();
  });

  // The library does not stand in for the gym: a facility is its own place,
  // not an instance of a repeated room type.
  it('never borrows for a facility', () => {
    expect(panoFor(v('Gym', 'Facility'), ALL)).toBeNull();
  });
});
