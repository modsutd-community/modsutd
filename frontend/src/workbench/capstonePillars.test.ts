import { describe, it, expect } from 'vitest';
import { modPillars } from './pillars';
import type { Mod } from '@/types';

// A capstone is open to every pillar, and the data says so in `tags`. The tag
// map only knew SUTD's spelling (ISTD) and not the app's own (CSD), so the tag
// was read and silently discarded: Capstone 1 and 2 offered four of five.
describe('a capstone spans every pillar', () => {
  const capstone = (over: Partial<Mod> = {}): Mod => ({
    code: '01.400',
    name: 'Capstone 1',
    pillar: 'EPD',
    tags: ['ASD', 'CSD', 'Capstone', 'DAI', 'EPD', 'ESD'],
    ...over,
  }) as Mod;

  it('reads CSD as well as ISTD', () => {
    expect(modPillars(capstone())).toEqual(
      expect.arrayContaining(['ASD', 'CSD', 'DAI', 'EPD', 'ESD']),
    );
    expect(modPillars(capstone({ tags: ['ISTD'] }))).toContain('CSD');
  });

  it('names each pillar once, however it was spelled', () => {
    const out = modPillars(capstone({ tags: ['CSD', 'ISTD', 'istd'] }));
    expect(out.filter((p) => p === 'CSD')).toHaveLength(1);
  });
});
