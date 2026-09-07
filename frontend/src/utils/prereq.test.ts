import { describe, it, expect } from 'vitest';
import { unmet, treeOf } from './prereq';
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
});
