import { describe, it, expect } from 'vitest';
import { placeText, buildICS } from './icsGenerator';
import type { TimetableEvent } from '@/types';

// MyPortal prints "Lecture Theatre 2 (1.203)". A calendar's one-line preview
// truncates from the right, so the code - the half a student actually walks to
// and the half the door signs carry - has to come first.
describe('the LOCATION line', () => {
  it('puts the code first and the name in brackets', () => {
    expect(placeText('Lecture Theatre 2 (1.203)', '1.203')).toBe('1.203 (Lecture Theatre 2)');
    expect(placeText('Cohort Classroom 12 (2.406)', '2.406')).toBe('2.406 (Cohort Classroom 12)');
    expect(placeText('Capstone 1 (1.411)', '1.411')).toBe('1.411 (Capstone 1)');
  });

  // 5.101-08 is a real code and the hyphen must not end the match early.
  it('keeps a hyphenated code whole', () => {
    expect(placeText('Fab Lab (5.101-08)', '5.101-08')).toBe('5.101-08 (Fab Lab)');
  });

  it('falls back rather than inventing', () => {
    expect(placeText(undefined, '2.507')).toBe('2.507');
    expect(placeText('', '2.507')).toBe('2.507');
    // A name with no code in it: keep both, still code first.
    expect(placeText('Sports Hall', '61.105')).toBe('61.105 (Sports Hall)');
    expect(placeText('2.507', '2.507')).toBe('2.507');
  });
});

const ev = (over: Partial<TimetableEvent> = {}): TimetableEvent => ({
  modCode: '50.040',
  modName: 'Natural Language Processing',
  type: 'Lecture',
  day: 'Monday',
  startTime: '13:00',
  endTime: '15:00',
  startDate: '2026-09-14',
  endDate: '2026-09-14',
  location: '1.203',
  venueName: 'Lecture Theatre 2 (1.203)',
  instructors: ['Esther Zhao Ruochen', 'ZHang Wenxuan'],
  ...over,
}) as TimetableEvent;

describe('what the calendar event carries', () => {
  const ics = buildICS([ev()]);

  it('locates by code, named', () => {
    expect(ics).toContain('LOCATION:1.203 (Lecture Theatre 2)');
  });

  // The room has its own field. Printing it in the description too put the
  // same string in every event twice.
  it('describes the people, and does not repeat the room', () => {
    const desc = ics
      .split('\r\n')
      .find((l) => l.startsWith('DESCRIPTION:'))!;
    expect(desc).toContain('Esther Zhao Ruochen');
    expect(desc).toContain('ZHang Wenxuan');
    expect(desc).not.toContain('Lecture Theatre 2');
    expect(desc).not.toContain('|');
  });
});
