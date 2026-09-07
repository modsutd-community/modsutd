import { describe, it, expect } from 'vitest';
import COORDS from '../../../data/_meta/room-coords.json';

// The survey is uploaded to OpenStreetMap, and upload renames every element,
// so the local .osm ids are worthless afterwards. The geometry is not: this
// file is one centroid per surveyed shape, and it is what lets a room with no
// indoor-map label point at itself rather than at its building.

interface Shape {
  ref: string | null;
  name: string | null;
  lat: number;
  lng: number;
  level?: string | null;
}
const shapes = (COORDS as unknown as { shapes: Shape[] }).shapes;

// The surveyed campus spans 242 m north-south and 380 m east-west, from
// building 1 out to the hostels, the stadium and the pool. This box is that
// extent plus about 150 m of margin: wide enough not to argue with a survey
// correction, tight enough that a dropped decimal or a swapped lat/lng lands
// outside it, which is the error worth catching - it would put a student in
// the sea rather than nowhere.
const BOX = { latMin: 1.3385, latMax: 1.3435, lngMin: 103.9605, lngMax: 103.967 };

describe('surveyed shapes', () => {
  it('covers the campus', () => {
    expect(shapes.length).toBeGreaterThan(240);
  });

  it('every coordinate is on campus', () => {
    for (const s of shapes) {
      expect(s.lat, `${s.ref ?? s.name} lat`).toBeGreaterThan(BOX.latMin);
      expect(s.lat, `${s.ref ?? s.name} lat`).toBeLessThan(BOX.latMax);
      expect(s.lng, `${s.ref ?? s.name} lng`).toBeGreaterThan(BOX.lngMin);
      expect(s.lng, `${s.ref ?? s.name} lng`).toBeLessThan(BOX.lngMax);
    }
  });

  it('every shape has something to be found by', () => {
    for (const s of shapes) expect(!!(s.ref || s.name), JSON.stringify(s)).toBe(true);
  });

  // Requiring a door plate threw away 32 surveyed spaces that only carry a
  // name - Campus Centre and both hostel lobbies among them - and those are
  // exactly the venues that had no coordinate at all.
  it('keeps the named spaces that carry no door plate', () => {
    const named = shapes.filter((s) => s.name && !s.ref);
    expect(named.length).toBeGreaterThan(25);
    const names = named.map((s) => s.name);
    expect(names).toContain('Campus Centre');
    expect(names).toContain('Hostel Blk 55 Lobby');
  });

  // Three plates cover two rooms each. Collapsing them would put two rooms on
  // one pin, about 45 m from where one of them is, with nothing looking wrong.
  it('keeps both rooms where one plate covers two', () => {
    for (const ref of ['2.301', '5.101-0', '5.303']) {
      const both = shapes.filter((s) => s.ref === ref);
      expect(both, ref).toHaveLength(2);
      expect(new Set(both.map((s) => s.name)).size, `${ref} names`).toBe(2);
      const metres = (Math.abs(both[0].lat - both[1].lat) + Math.abs(both[0].lng - both[1].lng)) * 111_000;
      expect(metres, `${ref} separation`).toBeGreaterThan(5);
    }
  });
});
