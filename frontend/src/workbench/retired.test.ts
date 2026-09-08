import { describe, it, expect } from 'vitest';
import M10009 from '../../../data/courses/10_009.json';
import M40014 from '../../../data/courses/40_014.json';
import M50001 from '../../../data/courses/50_001.json';
import M50006 from '../../../data/courses/50_006.json';

// A retired mod stays in the data. A student on an older cohort took it, their
// plan still names it, and its review thread is the only record of what taking
// it was like - deleting the file takes all three. The catalogue hides it
// instead, until a reader ticks "retired".
const flag = (m: unknown) => (m as { retired?: boolean }).retired;

describe('retired mods', () => {
  // 10.009 The Digital World is in neither course sitemap and the academics
  // subdomain that used to carry it no longer resolves. 40.014's page 404s and
  // 40.018 replaced it.
  it('are marked, not deleted', () => {
    expect(flag(M10009)).toBe(true);
    expect(flag(M40014)).toBe(true);
  });

  it('leaves a live mod unmarked, so the flag means something', () => {
    expect(flag(M50001)).toBeUndefined();
  });

  // The reason deleting was wrong: 50.006 still offers 10.009 to the AY2019
  // cohort, so the file has to exist for that branch to resolve.
  it('is still reachable as a prerequisite', () => {
    expect((M50006 as { prerequisites: string[] }).prerequisites).toContain('10.009');
  });
});
