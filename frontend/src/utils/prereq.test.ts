import { describe, it, expect } from 'vitest';
import { unmet, requirements, requirementsOf, treeOf } from './prereq';
import M057 from '../../../data/courses/50_057.json';
import M007 from '../../../data/courses/50_007.json';
import COURSE_40321 from '../../../data/courses/40_321.json';
import type { PrereqTree } from '@/types';

// The bug this exists for: SUTD lists 40.321 as "40.002 Optimisation OR 60.008
// Systems Design Studio", the gatherer keeps only the codes, and the flat list
// then reads as "all of" - so the plan demanded both.
describe('an "or" prerequisite is satisfied by either branch', () => {
  const has = (...done: string[]) => (c: string) => done.includes(c);

  it('is the shape 40.321 actually ships', () => {
    expect(COURSE_40321.prereqTree).toEqual({ or: ['40.002', '60.008'] });
  });

  it('takes either one, and asks for the shorter path when neither is done', () => {
    const t = COURSE_40321.prereqTree as PrereqTree;
    expect(unmet(t, has('40.002'))).toEqual([]);
    expect(unmet(t, has('60.008'))).toEqual([]);
    expect(unmet(t, has())).toHaveLength(1);
  });

  it('still demands every branch of an "and"', () => {
    const t: PrereqTree = { and: ['10.013', '10.014'] };
    expect(unmet(t, has('10.013'))).toEqual(['10.014']);
    expect(unmet(t, has('10.013', '10.014'))).toEqual([]);
  });

  // 50.057: one named course AND one of two others.
  it('handles an and wrapped around an or', () => {
    const t: PrereqTree = { and: ['50.003', { or: ['10.014', '10.025'] }] };
    expect(unmet(t, has('50.003', '10.025'))).toEqual([]);
    expect(unmet(t, has('10.025'))).toEqual(['50.003']);
    expect(unmet(t, has('50.003'))).toHaveLength(1);
  });

  it('reads a flat list as "all of", which is what it has always meant', () => {
    expect(treeOf(undefined, ['10.013', '10.014'])).toEqual({ and: ['10.013', '10.014'] });
    expect(treeOf(undefined, ['10.013'])).toBe('10.013');
    expect(treeOf(undefined, [])).toBeUndefined();
    // An explicit tree always wins over the flat list.
    expect(treeOf({ or: ['a', 'b'] }, ['a', 'b'])).toEqual({ or: ['a', 'b'] });
  });

  it('counts an nOf', () => {
    const t: PrereqTree = { nOf: [2, ['a', 'b', 'c']] };
    expect(unmet(t, has('a', 'b'))).toEqual([]);
    expect(unmet(t, has('a'))).toHaveLength(1);
    expect(unmet(t, has())).toHaveLength(2);
  });

// SUTD names a course before it numbers one, and gates prerequisites on the
// year a student matriculated. 50.057 is both at once: 50.003 AND one of
// 10.014 (AY2024 and earlier), 10.025 (AY2025), or "Algorithmic Thinking and
// Object-Based Abstraction" (AY2026 onwards, no code yet).
describe('a requirement SUTD named but did not number', () => {
  const TREE = {
    and: [
      '50.003',
      { or: [
        { code: '10.014', name: 'Computational Thinking for Design', cohort: ['classic'] },
        { code: '10.025', name: 'Computational Thinking for Design', cohort: ['ay2025'] },
        { name: 'Algorithmic Thinking and Object-Based Abstraction', cohort: ['ay2026'] },
      ] },
    ],
  } as const;
  const tree = TREE as unknown as Parameters<typeof unmet>[0];
  const has = (...codes: string[]) => (c: string) => codes.includes(c);

  it('asks an AY2024 student for 10.014 and never 10.025', () => {
    expect(unmet(tree, has('50.003'), 'classic')).toEqual(['10.014']);
  });

  it('asks an AY2025 student for 10.025 instead', () => {
    expect(unmet(tree, has('50.003'), 'ay2025')).toEqual(['10.025']);
  });

  // The AY2026 branch has nothing to place, so it cannot be the thing standing
  // between a student and the mod - it would lock 50.057 for that whole cohort.
  it('does not block an AY2026 student on a course with no code', () => {
    expect(unmet(tree, has('50.003'), 'ay2026')).toEqual([]);
  });

  it('still blocks that student on the coded half', () => {
    expect(unmet(tree, has(), 'ay2026')).toEqual(['50.003']);
  });

  // Not blocking is not the same as not existing. Without this the unnumbered
  // requirement would be invisible everywhere, which is the bug that started it.
  it('still reports the unnumbered requirement for display', () => {
    expect(requirements(tree, 'ay2026'))
      .toEqual(['50.003', 'Algorithmic Thinking and Object-Based Abstraction']);
    expect(requirements(tree, 'classic'))
      .toEqual(['50.003', '10.014 Computational Thinking for Design']);
  });

  // With no cohort chosen, every branch is on the table and the shortest wins -
  // the pre-existing behaviour for trees that carry no cohort at all.
  it('falls back to all branches when no cohort is given', () => {
    expect(unmet(tree, has('50.003'))).toEqual([]);
    expect(requirements(tree)).toHaveLength(4);
  });
});

// Driven from the SHIPPED data rather than a hand-copy, and through the same
// call the plan makes. A hand-copied tree stays green when the file changes,
// and the two-argument call is what let 50.057 read as reachable with neither
// 10.014 nor 10.025 anywhere in a plan.
describe('50.057 as it actually ships', () => {
  const tree = (M057 as { prereqTree: Parameters<typeof unmet>[0] }).prereqTree;
  const has = (...codes: string[]) => (c: string) => codes.includes(c);

  it('still demands the coded half from the cohorts that have one', () => {
    expect(unmet(tree, has('50.003'), 'classic')).toEqual(['10.014']);
    expect(unmet(tree, has('50.003'), 'ay2025')).toEqual(['10.025']);
  });

  it('is satisfied once that cohort has taken it', () => {
    expect(unmet(tree, has('50.003', '10.014'), 'classic')).toEqual([]);
    expect(unmet(tree, has('50.003', '10.025'), 'ay2025')).toEqual([]);
  });

  it("never accepts another cohort's course", () => {
    expect(unmet(tree, has('50.003', '10.025'), 'classic')).toEqual(['10.014']);
    expect(unmet(tree, has('50.003', '10.014'), 'ay2025')).toEqual(['10.025']);
  });
});

// The chip used to read the FLAT prerequisites array, which cannot say
// "either" - so 50.057 listed 10.014 and 10.025 as two separate demands and
// stayed red after one of them was placed.
describe('what a chip should show', () => {
  const tree = (M057 as { prereqTree: Parameters<typeof unmet>[0] }).prereqTree;
  const has = (...codes: string[]) => (c: string) => codes.includes(c);

  it('groups an unanswered "or" into one pick, not two demands', () => {
    const reqs = requirementsOf(tree, has('50.003'), 'classic');
    expect(reqs.filter((r) => r.kind === 'oneOf')).toHaveLength(1);
    const pick = reqs.find((r) => r.kind === 'oneOf')!;
    expect(pick.met).toBe(false);
    expect(pick.options.map((o) => o.code)).toEqual(['10.014']);
  });

  it('offers every alternative the cohort actually has', () => {
    const pick = requirementsOf(tree, has(), undefined)
      .find((r) => r.kind === 'oneOf')!;
    expect(pick.options.map((o) => o.code ?? o.name)).toEqual([
      '10.014', '10.025', 'Algorithmic Thinking and Object-Based Abstraction',
    ]);
  });

  // The bug the picker exists to fix: one option placed answers the group.
  it('says the group is answered, and by which one', () => {
    const pick = requirementsOf(tree, has('50.003', '10.014'), 'classic')
      .find((r) => r.kind === 'oneOf')!;
    expect(pick.met).toBe(true);
    expect(pick.metBy).toBe('10.014');
  });

  it('reopens the pick when that mod is taken back out', () => {
    const pick = requirementsOf(tree, has('50.003'), 'classic')
      .find((r) => r.kind === 'oneOf')!;
    expect(pick.met).toBe(false);
  });

  // An uncoded requirement has nothing to place, so it is stated and never
  // demanded - otherwise it would lock the mod for that whole cohort.
  it('never marks an uncoded requirement as missing', () => {
    const reqs = requirementsOf({ name: 'Algorithmic Thinking' }, has(), 'ay2026');
    expect(reqs).toEqual([{ kind: 'need', code: undefined, name: 'Algorithmic Thinking', met: true }]);
  });

  it('still reports a plain code as met or not', () => {
    expect(requirementsOf('50.003', has('50.003'))).toEqual([{ kind: 'need', code: '50.003', met: true }]);
    expect(requirementsOf('50.003', has())).toEqual([{ kind: 'need', code: '50.003', met: false }]);
  });
});

// SUTD's 50.007 page lists 50.001, but DAI on AY2024 and earlier does not take
// it. A cohort alone cannot say that - the same year is right for four pillars
// and wrong for the fifth.
describe('a prerequisite that one pillar does not have', () => {
  const tree = (M007 as { prereqTree: Parameters<typeof unmet>[0] }).prereqTree;
  const has = (...c: string[]) => (x: string) => c.includes(x);

  it('still asks every other pillar for it', () => {
    expect(unmet(tree, has('50.004'), 'classic', 'CSD')).toEqual(['50.001']);
    expect(unmet(tree, has('50.004'), 'classic', 'EPD')).toEqual(['50.001']);
  });

  it('does not ask DAI on that cohort', () => {
    expect(unmet(tree, has('50.004'), 'classic', 'DAI')).toEqual([]);
  });

  it('leaves the rest of the tree alone', () => {
    expect(unmet(tree, has(), 'classic', 'DAI')).toEqual(['50.004']);
  });
});
});
