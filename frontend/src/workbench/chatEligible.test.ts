import { describe, it, expect } from 'vitest';
import { chatEligible, chatOffered, teleState } from './teleState';
import type { Mod } from '@/types';

const mod = (over: Partial<Mod> = {}): Mod =>
  ({ code: '50.040', name: 'Natural Language Processing', term: '7',
     pillar: 'CSD', tags: [], schedules: [], ...over } as unknown as Mod);

// One slot is all "this runs this term" means: slots only reach /data from a
// contributed timetable or the enrolment import, both of which are this term.
const RUNNING = { schedules: [{ day: 'Monday' }] } as unknown as Partial<Mod>;
const TERM_END = '2099-12-19';
const TODAY = '2026-09-13';

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
});

describe('which mods the catalogue marks', () => {
  // Eligible and running this term: the button on its page would make a chat,
  // so the row is worth marking even though nobody has asked yet. This is the
  // case the registry alone misses.
  it('marks an eligible mod that runs this term with no chat yet', () => {
    expect(chatOffered(mod(RUNNING), undefined, TERM_END, TODAY)).toBe(true);
  });

  // 02.153 is the one that prompted this: HASS, so eligible forever, and not
  // offered this term, so no schedules and no chat anyone could make.
  it('does not mark an eligible mod that is not running', () => {
    expect(chatOffered(mod({ pillar: 'HASS' }), undefined, TERM_END, TODAY)).toBe(false);
  });

  it('marks a chat that already exists', () => {
    expect(chatOffered(mod(), { expires: TERM_END }, TERM_END, TODAY)).toBe(true);
  });

  // An entry outlives the term window in the data, so the expiry is what says
  // whether there is still anything to join.
  it('does not mark an expired chat', () => {
    expect(chatOffered(mod(), { expires: '2020-06-30' }, TERM_END, TODAY)).toBe(false);
  });

  // Between terms nothing can be created: telegram-group.yml answers
  // skip=no-live-term.
  it('does not mark anything between terms', () => {
    expect(chatOffered(mod(RUNNING), undefined, '2020-01-01', TODAY)).toBe(false);
    expect(chatOffered(mod(RUNNING), undefined, undefined, TODAY)).toBe(false);
  });

  // A live entry outranks the rest: a chat that exists is joinable whatever
  // the catalogue says about the course.
  it('marks a live chat even for a mod that could not get one now', () => {
    expect(chatOffered(mod({ noBatchChat: true }), { expires: TERM_END }, TERM_END, TODAY))
      .toBe(true);
  });

  it('does not mark a freshmore subject that runs this term', () => {
    expect(chatOffered(mod({ ...RUNNING, term: '1' }), undefined, TERM_END, TODAY)).toBe(false);
  });
});

describe('the button on a mod page', () => {
  // chatEligible decides whether the mod panel offers a button at all. The
  // catalogue's mark is a different question, answered by the registry: a HASS
  // course is eligible forever and only has a chat in the terms it runs.
  it('a mod this refuses draws no button either', () => {
    const ineligible = mod({ term: '1' });
    expect(chatEligible(ineligible)).toBe(false);
    expect(teleState({
      chatMod: chatEligible(ineligible),
      entry: true, askedAt: Date.now(), termOk: true,
      committed: true, committing: true,
    })).toBe('none');
  });
});
