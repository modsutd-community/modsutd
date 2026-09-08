// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const pushBackup = vi.fn(async (_b: unknown) => {});
vi.mock('./sync', () => ({
  getToken: () => 'tok',
  pushBackup: (b: unknown) => pushBackup(b as never),
  onLinkChange: () => () => {},
}));

import { useAutoBackup, setAutoSave } from './autoBackup';

const bundle = (n: number) => ({ records: { a: n }, plans: {}, declared: [] }) as never;

// The gist exists for the day someone's storage is gone. A backup that only
// happens when a person remembers to press export is not there on that day.
describe('automatic gist backup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    pushBackup.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Loading a plan is not a change to it, and pushing on sight would put a
  // revision on the gist for every reload.
  it('does not push what it just read', async () => {
    renderHook(() => useAutoBackup(bundle(1)));
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(pushBackup).not.toHaveBeenCalled();
  });

  it('pushes once the plan changes and settles', async () => {
    const { rerender } = renderHook((p: number) => useAutoBackup(bundle(p)), {
      initialProps: 1,
    });
    rerender(2);
    expect(pushBackup).not.toHaveBeenCalled(); // still typing
    await act(async () => { vi.advanceTimersByTime(9000); });
    expect(pushBackup).toHaveBeenCalledTimes(1);
  });

  // Every push is a gist revision, so a burst of edits is one save, not five.
  it('collapses a burst of edits into one revision', async () => {
    const { rerender } = renderHook((p: number) => useAutoBackup(bundle(p)), {
      initialProps: 1,
    });
    for (const n of [2, 3, 4, 5]) {
      rerender(n);
      await act(async () => { vi.advanceTimersByTime(1000); });
    }
    expect(pushBackup).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(9000); });
    expect(pushBackup).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way when it is switched off', async () => {
    setAutoSave(false);
    const { rerender } = renderHook((p: number) => useAutoBackup(bundle(p)), {
      initialProps: 1,
    });
    rerender(2);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(pushBackup).not.toHaveBeenCalled();
  });
});
