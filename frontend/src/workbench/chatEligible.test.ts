import { describe, it, expect } from 'vitest';
import { chatEligible, teleState } from './teleState';
import type { Mod } from '@/types';

const mod = (over: Partial<Mod> = {}): Mod =>
  ({ code: '50.040', name: 'Natural Language Processing', term: '7',
     pillar: 'CSD', tags: [], schedules: [], ...over } as unknown as Mod);

describe('which mods can have a batch chat', () => {
  it('an elective from term 3 onwards can', () => {
    expect(chatEligible(mod({ term: '3' }))).toBe(true);
    expect(chatEligible(mod({ term: '7' }))).toBe(true);
  });

  // A freshmore cohort already shares a chat, a timetable and a year group.
  it('a freshmore subject cannot', () => {
    expect(chatEligible(mod({ term: '1' }))).toBe(false);
    expect(chatEligible(mod({ term: '2' }))).toBe(false);
  });

  // HASS is chosen rather than assigned, so the people in it have nothing else
  // in common, which is the whole point. Term does not gate it.
  it('HASS can, at any term', () => {
    expect(chatEligible(mod({ term: '1', pillar: 'HASS' }))).toBe(true);
    expect(chatEligible(mod({ term: '1', pillar: 'ASD', tags: ['HASS'] }))).toBe(true);
  });

  it('a mod the data excludes cannot, whatever else it is', () => {
    expect(chatEligible(mod({ noBatchChat: true }))).toBe(false);
    expect(chatEligible(mod({ term: '1', pillar: 'HASS', noBatchChat: true }))).toBe(false);
  });

  // The flag is the real list; the name is a fallback for a record SUTD names
  // a capstone before anyone marks it.
  it('a capstone or thesis cannot, even unflagged', () => {
    expect(chatEligible(mod({ name: 'Capstone 1' }))).toBe(false);
    expect(chatEligible(mod({ name: 'PhD Thesis Defence' }))).toBe(false);
  });

  // The catalogue column and the mod panel's button read the SAME function, so
  // a mod cannot be marked in the list and then offer nothing when opened.
  // This is the assertion that would break if either grew its own copy.
  it('a mod the column does not mark draws no button either', () => {
    const ineligible = mod({ term: '1' });
    expect(chatEligible(ineligible)).toBe(false);
    expect(teleState({
      chatMod: chatEligible(ineligible),
      entry: true, askedAt: Date.now(), termOk: true,
      committed: true, committing: true,
    })).toBe('none');
  });
});
