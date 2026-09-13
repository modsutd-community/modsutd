import { describe, expect, it } from 'vitest';
import { minAccountAgeDays, MIN_AGE_DAYS, DAILY_LIMIT } from './telegram-link.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

// Literals, deliberately. Every other case reads the constants, so it cannot
// tell a policy change from a bug: widening the range back would leave them all
// green. These two are the policy, and moving one has to be a decision somebody
// makes rather than an edit that passes.
describe('the gate on a join link', () => {
  it('asks for between none and three days of account age', () => {
    expect(MIN_AGE_DAYS).toEqual([0, 3]);
  });

  it('hands out five links a day', () => {
    expect(DAILY_LIMIT).toBe(5);
  });
});

describe('minAccountAgeDays', () => {
  it('always lands inside the advertised range', () => {
    for (let id = 1; id <= 500; id++) {
      const n = minAccountAgeDays(id, KEY);
      expect(n).toBeGreaterThanOrEqual(MIN_AGE_DAYS[0]);
      expect(n).toBeLessThanOrEqual(MIN_AGE_DAYS[1]);
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
    // Every value in the range is drawn by somebody, or the range is narrower
    // than it says and a collector has less to plan around than it looks.
    expect(seen.size).toBe(MIN_AGE_DAYS[1] - MIN_AGE_DAYS[0] + 1);
  });

  it('is unguessable without the key - a different key redraws everyone', () => {
    const other = Buffer.alloc(32, 9).toString('base64');
    let differs = 0;
    for (let id = 1; id <= 200; id++) {
      if (minAccountAgeDays(id, KEY) !== minAccountAgeDays(id, other)) differs++;
    }
    // A redraw moves an account unless it lands on the same value by chance,
    // so with a span of 4 about three quarters are expected to move.
    expect(differs).toBeGreaterThan(120);
  });
});
