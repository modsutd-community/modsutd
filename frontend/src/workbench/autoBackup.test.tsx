// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const pushBackup = vi.fn(async (_b: unknown) => {});

// The pull's two answers, which the autosave has to tell apart: "there is a
// gist and you have read it" and "this account has none".
let settled = true;
let remoteExists = true;
const settleWaiters: Array<() => void> = [];

const notified = vi.fn();
vi.mock('./notice', () => ({ notify: (m: string) => notified(m) }));

vi.mock('./sync', () => ({
  getToken: () => 'tok',
  pushBackup: (b: unknown) => pushBackup(b as never),
  onLinkChange: () => () => {},
  syncSettled: () => settled,
  remoteBackupExists: () => remoteExists,
  onSyncSettled: (fn: () => void) => {
    settleWaiters.push(fn);
    return () => {};
  },
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
    settled = true;
    remoteExists = true;
    settleWaiters.length = 0;
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

  // The bug that made linking look like it did nothing: with no gist on the
  // account there is nothing to be in step with, so calling the first bundle
  // "already saved" left the laptop's work where the phone could never see it.
  it('seeds the gist when the account has none', async () => {
    remoteExists = false;
    renderHook(() => useAutoBackup(bundle(1)));
    await act(async () => { await Promise.resolve(); });
    expect(pushBackup).toHaveBeenCalledTimes(1);
  });

  // The other half of that: pushing before the pull has answered would put an
  // empty phone on top of the laptop's plan.
  it('waits for the pull before it pushes anything', async () => {
    settled = false;
    remoteExists = false;
    renderHook(() => useAutoBackup(bundle(1)));
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(pushBackup).not.toHaveBeenCalled();
    expect(settleWaiters.length).toBeGreaterThan(0);
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

  // A sync that never worked looked exactly like one that did: the status only
  // shows inside the plan panel's export menu, so nobody found out until two
  // devices disagreed.
  it('says so when a push fails, once', async () => {
    notified.mockClear();
    pushBackup.mockRejectedValue(new Error('push failed (HTTP 403)'));
    const { rerender } = renderHook((p: number) => useAutoBackup(bundle(p)), { initialProps: 1 });
    rerender(2);
    await act(async () => { vi.advanceTimersByTime(9000); });
    expect(notified).toHaveBeenCalledTimes(1);
    expect(String(notified.mock.calls[0][0])).toContain('403');

    // Still one complaint, not one per retry.
    rerender(3);
    await act(async () => { vi.advanceTimersByTime(9000); });
    expect(notified).toHaveBeenCalledTimes(1);
    pushBackup.mockResolvedValue(undefined);
  });
});
