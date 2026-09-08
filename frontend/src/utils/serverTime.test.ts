import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordServerDate, serverNow, serverTimeKnown, __resetServerTime } from './serverTime';

afterEach(() => {
  __resetServerTime();
  vi.useRealTimers();
});

describe('serverTime', () => {
  it('falls back to the device clock until a response is seen', () => {
    expect(serverTimeKnown()).toBe(false);
    expect(Math.abs(serverNow() - Date.now())).toBeLessThan(50);
  });

  // A device set to last year makes every export look stale, so the calendar
  // ignores it and the student never sees their corrected room.
  it('corrects a clock that is running behind', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    recordServerDate('Thu, 13 Aug 2026 09:00:00 GMT');
    expect(new Date(serverNow()).getUTCFullYear()).toBe(2026);
  });

  // A device set forward is worse: one export poisons the ceiling and every
  // correct export afterwards is discarded as older.
  it('corrects a clock that is running ahead', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    recordServerDate('Thu, 13 Aug 2026 09:00:00 GMT');
    expect(new Date(serverNow()).getUTCFullYear()).toBe(2026);
  });

  it('ignores a header it cannot parse rather than corrupting the clock', () => {
    const before = serverNow();
    recordServerDate('not a date');
    recordServerDate(null);
    expect(serverTimeKnown()).toBe(false);
    expect(Math.abs(serverNow() - before)).toBeLessThan(50);
  });
});
