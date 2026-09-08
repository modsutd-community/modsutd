import { describe, expect, it } from 'vitest';
import { trackSatisfied, earliestAchieved, normaliseHHMM, defaultLevel, meetsOn, SpecTrack } from './logic';
import type { TimetableEvent } from '@/types';
import type { Mod } from '@/types';

describe('track satisfaction', () => {
  const track: SpecTrack = {
    id: 'csd-ai',
    name: 'Artificial Intelligence',
    pillar: 'CSD',
    requirements: [
      { count: 2, anyOf: ['50.001', '50.002', '50.003'] },
      { count: 1, anyOf: ['50.021', '50.035'] },
    ],
  };

  it('satisfied when every group is met', () => {
    expect(trackSatisfied(track, new Set(['50.001', '50.002', '50.021']))).toBe(true);
  });

  it('not satisfied when any group falls short', () => {
    expect(trackSatisfied(track, new Set(['50.001', '50.002']))).toBe(false);
  });

  it('earliestAchieved finds the first cumulative level that completes it', () => {
    const cumulative = [
      new Set(['50.001']),
      new Set(['50.001', '50.003']),
      new Set(['50.001', '50.003', '50.035']),
      new Set(['50.001', '50.003', '50.035']),
    ];
    expect(earliestAchieved(track, cumulative)).toBe(3);
    expect(earliestAchieved(track, cumulative.slice(0, 2))).toBe(null);
  });

  it('notes-only tracks (no structured requirements) never badge', () => {
    const fuzzy: SpecTrack = { id: 'epd-x', name: 'X', pillar: 'EPD', requirements: [] };
    expect(trackSatisfied(fuzzy, new Set(['50.001']))).toBe(false);
  });
});

describe('normaliseHHMM', () => {
  it('accepts and zero-pads valid times', () => {
    expect(normaliseHHMM('9:30')).toBe('09:30');
    expect(normaliseHHMM(' 23:59 ')).toBe('23:59');
  });
  it('rejects out-of-range and malformed input', () => {
    expect(normaliseHHMM('24:00')).toBeNull();
    expect(normaliseHHMM('9:5')).toBeNull();
    expect(normaliseHHMM('lunch')).toBeNull();
  });
});

describe('defaultLevel', () => {
  it('clamps the catalogue term into 1–8', () => {
    expect(defaultLevel({ term: '5' } as Mod)).toBe(5);
    expect(defaultLevel({ term: '10' } as Mod)).toBe(8);
    expect(defaultLevel(undefined)).toBe(1);
  });
});

describe('meetsOn', () => {
  const ev = (occurrences?: string[]): TimetableEvent => ({
    modCode: '30.111', modName: 'Entrepreneurship', type: 'Cohort',
    day: 'Thursday', startTime: '18:00', endTime: '20:30',
    location: '2.507', instructors: [],
    startDate: '2026-09-17', endDate: '2026-12-10', occurrences,
  });

  it('keeps a week the class actually meets', () => {
    expect(meetsOn(ev(['2026-10-29', '2026-11-12']), '2026-10-29')).toBe(true);
  });

  it('drops recess week even though the weekday matches', () => {
    expect(meetsOn(ev(['2026-10-29', '2026-11-12']), '2026-11-05')).toBe(false);
  });

  it('falls back to the date range when occurrences are unknown', () => {
    expect(meetsOn(ev(), '2026-11-05')).toBe(true);
    expect(meetsOn(ev(), '2027-01-05')).toBe(false);
  });
});
