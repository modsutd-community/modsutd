import { describe, it, expect } from 'vitest';
import CAP1 from '../../../data/courses/01_400.json';
import STUDIO from '../../../data/courses/60_003.json';
import XFER from '../../../data/courses/02_XFER.json';
import NORMAL from '../../../data/courses/50_001.json';

// Which mods get no batch chat is data, not a regex on the name. "capstone|
// thesis" could not express 60.003 Product Design Studio or 02.XFER, and a
// rule nobody can see is a rule nobody can edit.
const flag = (m: unknown) => (m as { noBatchChat?: boolean }).noBatchChat;

describe('mods that get no batch chat', () => {
  it('covers the ones a name regex never could', () => {
    expect(flag(STUDIO)).toBe(true);
    expect(flag(XFER)).toBe(true);
  });

  it('still covers capstone', () => {
    expect(flag(CAP1)).toBe(true);
  });

  it('leaves an ordinary mod alone, so the flag means something', () => {
    expect(flag(NORMAL)).toBeUndefined();
  });

  // Capstone belongs to every pillar, not just EPD - it is filed under each so
  // a pillar filter does not hide a student's own capstone.
  it('files capstone under all five pillars', () => {
    const tags = (CAP1 as { tags?: string[] }).tags ?? [];
    for (const p of ['ASD', 'CSD', 'DAI', 'EPD', 'ESD']) expect(tags).toContain(p);
  });
});
