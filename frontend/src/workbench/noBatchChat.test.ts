import { describe, it, expect } from 'vitest';
import CAP1 from '../../../data/courses/01_400.json';
import STUDIO from '../../../data/courses/60_003.json';
import XFER from '../../../data/courses/02_XFER.json';
// 50.040 is an elective a student chooses, which is the whole point of a
// batch chat. 50.001 used to stand here and stopped being ordinary the day
// the CSD core was read off SUTD's own listing.
import CORE from '../../../data/courses/50_001.json';
import NORMAL from '../../../data/courses/50_040.json';

// Which mods get no batch chat is data, not a regex on the name. "capstone|
// thesis" could not express 60.003 Product Design Studio or 02.XFER, and a
// rule nobody can see is a rule nobody can edit.
const flag = (m: unknown) => (m as { noBatchChat?: boolean }).noBatchChat;
const reason = (m: unknown) => (m as { noBatchChatReason?: string }).noBatchChatReason;

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

  // A pillar's core is taken by everybody in that pillar, who already share a
  // cohort chat. gather_no_batch_chat.py reads those lists off each pillar's
  // published listing and marks them, and marks WHY - so it can unmark its own
  // when a course leaves the core, and cannot touch a flag a human set.
  it('marks a pillar core, and says that is why', () => {
    expect(flag(CORE)).toBe(true);
    expect(reason(CORE)).toBe('pillar core');
  });

  it('leaves a hand-set flag unclaimed, so the script cannot remove it', () => {
    expect(flag(CAP1)).toBe(true);
    expect(reason(CAP1)).toBeUndefined();
  });

  // Capstone belongs to every pillar, not just EPD - it is filed under each so
  // a pillar filter does not hide a student's own capstone.
  it('files capstone under all five pillars', () => {
    const tags = (CAP1 as { tags?: string[] }).tags ?? [];
    for (const p of ['ASD', 'CSD', 'DAI', 'EPD', 'ESD']) expect(tags).toContain(p);
  });
});
