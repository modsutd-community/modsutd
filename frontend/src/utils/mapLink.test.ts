import { describe, expect, it } from 'vitest';
import { mapLink } from './mapLink';

// The stored labels are checked at build time in scripts/sync-data.mjs, which
// can read /data. These cover the URL shape only.
describe('mapLink', () => {
  it('builds a location link', () => {
    expect(mapLink('Root Cove - 2.311A'))
      .toBe('https://app.mappedin.com/map/6608dfd37c0c4fe5b4cc47fa?location=Root%20Cove%20-%202.311A');
  });

  it('builds a directions link when a starting point is known', () => {
    const u = mapLink('Studio 5 - 2.619', 'Auditorium');
    expect(u).toContain('/directions?location=Studio%205%20-%202.619');
    expect(u).toContain('&departure=Auditorium');
  });

  it('ignores an empty starting point rather than sending departure=', () => {
    expect(mapLink('Library', '')).not.toContain('departure');
  });

  it('escapes the ampersand in a label rather than splitting the query', () => {
    expect(mapLink('Dance Studio 1 & 2 (DS1/2)')).toContain('Dance%20Studio%201%20%26%202');
  });
});
