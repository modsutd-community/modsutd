import { describe, it, expect } from 'vitest';
import { REPEATABLE, planKeyFor, codeOfKey, modOfKey } from './logic';
import type { Mod } from '@/types';

// 02.XFER is the summer or winter HASS transfer: a real course each time, and a
// student may take several across a degree. `selectedMods` is a string[] behind
// an `includes` guard, so a second one needed a key of its own, and the term is
// what distinguishes them.
describe('a mod that can sit in more than one term', () => {
  it('keys a repeatable by the term it lands in', () => {
    expect(planKeyFor('02.XFER', 3)).toBe('02.XFER|T3');
    expect(planKeyFor('02.XFER', 7)).toBe('02.XFER|T7');
  });

  it('leaves every other mod keyed by its code', () => {
    expect(planKeyFor('50.001', 4)).toBe('50.001');
    expect(REPEATABLE.has('50.001')).toBe(false);
  });

  it('two terms are two keys, the same term is one', () => {
    const a = planKeyFor('02.XFER', 3);
    const b = planKeyFor('02.XFER', 5);
    expect(a).not.toBe(b);
    expect(planKeyFor('02.XFER', 3)).toBe(a);
  });

  it('finds the catalogue code behind a plan key', () => {
    expect(codeOfKey('02.XFER|T3')).toBe('02.XFER');
    expect(codeOfKey('50.001')).toBe('50.001');
  });

  // The AY2026 placeholders really are keyed 'code|name' in the store, so
  // stripping a suffix must not be how the code is found for them.
  it('leaves a 99.999 placeholder key resolvable as itself', () => {
    expect(codeOfKey('99.999|Calculus')).toBe('99.999');
    expect(planKeyFor('99.999|Calculus', 1)).toBe('99.999|Calculus');
  });
});

// The plan hands a KEY to anything that draws a mod, and two readers used to
// resolve one: the plan tree's own, and the inspector panel, which did not and
// told a reader that 02.XFER is not in the catalogue.
describe('the mod behind a plan key', () => {
  const mods = {
    '50.001': { code: '50.001', name: 'Information Systems' },
    '02.XFER': { code: '02.XFER', name: 'HASS Elective (Summer/Winter)' },
    '99.999|Calculus': { code: '99.999', name: 'Calculus' },
  } as unknown as Record<string, Mod>;

  it('finds a plain code', () => {
    expect(modOfKey(mods, '50.001')?.name).toBe('Information Systems');
  });

  it("finds a repeatable mod behind the term carried in its key", () => {
    expect(modOfKey(mods, '02.XFER|T7')?.name).toBe('HASS Elective (Summer/Winter)');
    expect(modOfKey(mods, '02.XFER|T3')?.name).toBe('HASS Elective (Summer/Winter)');
  });

  it('takes a composite store key whole, before stripping anything', () => {
    // 99.999|Calculus IS a store key. Stripping first would resolve every
    // AY2026 placeholder to whichever one happened to be stored under 99.999.
    expect(modOfKey(mods, '99.999|Calculus')?.name).toBe('Calculus');
  });

  it('finds nothing for a code the catalogue really does not have', () => {
    expect(modOfKey(mods, '77.777|T2')).toBeUndefined();
  });
});
