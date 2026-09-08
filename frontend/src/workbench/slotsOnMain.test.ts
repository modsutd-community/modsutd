// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { slotsOnMain } from './telegram';

// The chat button goes live the moment a paste is parsed, off this browser's
// own overlay - that is the whole point, and nobody should wait four hours for
// the deploy to see it. But telegram-group.yml checks out MAIN and refuses a
// mod with no `schedules`, and the contribution takes about ten seconds to get
// there (measured: dispatch 18:58:51, commit 18:58:57).
//
// Ask inside that window and the workflow prints `skip=not-offered` and exits
// 0. No group, no registry entry, no error - and a button stuck on "setting up
// the chat" until someone reloads the page.
describe('waiting for a contribution to reach main', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const reply = (schedules: unknown[]) => ({
    ok: true,
    json: async () => ({ schedules }),
  });

  it('goes as soon as the slots are there', async () => {
    fetchMock.mockResolvedValue(reply([{ day: 'Monday' }]));
    await expect(slotsOnMain('50.040', 3, 0)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The race itself: main answers, but the fold has not pushed yet.
  it('waits out the seconds between the paste and the commit', async () => {
    fetchMock
      .mockResolvedValueOnce(reply([]))
      .mockResolvedValueOnce(reply([]))
      .mockResolvedValue(reply([{ day: 'Monday' }]));
    await expect(slotsOnMain('50.040', 5, 0)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up rather than dispatching into a refusal', async () => {
    fetchMock.mockResolvedValue(reply([]));
    await expect(slotsOnMain('50.040', 4, 0)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // Offline, rate-limited, or a 404 for a mod main has never heard of: all the
  // same answer as "not yet", never a thrown error into the click handler.
  it('treats a failed fetch as not yet, not as a crash', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(slotsOnMain('50.040', 2, 0)).resolves.toBe(false);
  });

  it('asks main, not the deployed bundle', async () => {
    fetchMock.mockResolvedValue(reply([{ day: 'Monday' }]));
    await slotsOnMain('03.007A', 1, 0);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/main/data/courses/03_007A.json');
  });

  // Measured against a real push: the contents API had the new bytes one
  // second later and raw.githubusercontent was still serving the old ones
  // three minutes on, because its edge ignores the query string the old
  // cache-buster relied on. A linked student must not wait five minutes to
  // find out their own paste landed.
  it('prefers the contents API when the student is linked', async () => {
    localStorage.setItem('modsutd.gh.token.v1', 'tok');
    fetchMock.mockResolvedValue(reply([{ day: 'Monday' }]));
    await slotsOnMain('50.040', 1, 0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('api.github.com');
    expect((init.headers as Record<string, string>).Accept).toContain('vnd.github.raw');
    localStorage.clear();
  });

  it('falls back to raw for a student who has not linked', async () => {
    localStorage.clear();
    fetchMock.mockResolvedValue(reply([{ day: 'Monday' }]));
    await slotsOnMain('50.040', 1, 0);
    expect(String(fetchMock.mock.calls[0][0])).toContain('raw.githubusercontent.com');
  });
});
