import { describe, it, expect } from 'vitest';
import { REPEATABLE, planKeyFor, codeOfKey } from './logic';

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
