import { describe, expect, it } from 'vitest';
import { minAccountAgeDays } from './telegram-link.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('minAccountAgeDays', () => {
  it('always lands inside the advertised range', () => {
    for (let id = 1; id <= 500; id++) {
      const n = minAccountAgeDays(id, KEY);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(7);
    }
  });

  it('is stable per account - retrying must never redraw', () => {
    for (const id of [1, 42, 999_999]) {
      const first = minAccountAgeDays(id, KEY);
      for (let i = 0; i < 20; i++) expect(minAccountAgeDays(id, KEY)).toBe(first);
    }
  });

  it('differs across accounts, so one draw tells you nothing about another', () => {
    const seen = new Set();
    for (let id = 1; id <= 200; id++) seen.add(minAccountAgeDays(id, KEY));
    expect(seen.size).toBe(7);
  });

  it('is unguessable without the key - a different key redraws everyone', () => {
    const other = Buffer.alloc(32, 9).toString('base64');
    let differs = 0;
    for (let id = 1; id <= 200; id++) {
      if (minAccountAgeDays(id, KEY) !== minAccountAgeDays(id, other)) differs++;
    }
    expect(differs).toBeGreaterThan(120); // ~6/7 of accounts expected to move
  });
});
