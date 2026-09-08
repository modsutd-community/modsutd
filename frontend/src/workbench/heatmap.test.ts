import { describe, it, expect } from 'vitest';

// The rule the heatmap draws with, extracted so it can be tested without a DOM.
// Rounding a class out to whole hours said an 08:30 start occupies 08:00, and
// a second class in the same hour overwrote the first - so a free room read as
// busy, and two classes showed as one.
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

interface Slot { day: string; startTime: string; endTime: string; modCode?: string }

function segmentsFor(slots: Slot[], day: string, hour: number) {
  const out: { from: number; to: number; mod?: string }[] = [];
  for (const s of slots) {
    if (s.day !== day) continue;
    const s0 = toMin(s.startTime);
    const e0 = toMin(s.endTime);
    const from = Math.max(0, s0 - hour * 60);
    const to = Math.min(60, e0 - hour * 60);
    if (to > from) out.push({ from, to, mod: s.modCode });
  }
  return out;
}

const CLASS_A: Slot = { day: 'Monday', startTime: '08:30', endTime: '11:30', modCode: '01.400' };
const CLASS_B: Slot = { day: 'Monday', startTime: '11:30', endTime: '13:00', modCode: '50.040' };

describe('an hour is filled only for the minutes a class takes', () => {
  it('starts a half-past class halfway through its first hour', () => {
    expect(segmentsFor([CLASS_A], 'Monday', 8)).toEqual([{ from: 30, to: 60, mod: '01.400' }]);
  });

  it('fills the hours it spans completely', () => {
    expect(segmentsFor([CLASS_A], 'Monday', 9)).toEqual([{ from: 0, to: 60, mod: '01.400' }]);
    expect(segmentsFor([CLASS_A], 'Monday', 10)).toEqual([{ from: 0, to: 60, mod: '01.400' }]);
  });

  // The case that was silently wrong: two classes meeting in one hour.
  it('shows both classes that share an hour, each in its own half', () => {
    const segs = segmentsFor([CLASS_A, CLASS_B], 'Monday', 11);
    expect(segs).toEqual([
      { from: 0, to: 30, mod: '01.400' },
      { from: 30, to: 60, mod: '50.040' },
    ]);
  });

  it('leaves an hour nothing touches empty', () => {
    expect(segmentsFor([CLASS_A, CLASS_B], 'Monday', 13)).toEqual([]);
    expect(segmentsFor([CLASS_A], 'Tuesday', 9)).toEqual([]);
  });
});
