// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollForToken, type DeviceStart } from './sync';

// The link banner reads "enter CODE at github.com/login/device - waiting..."
// for exactly as long as this neither resolves nor rejects, so every branch
// that can spin forever is a student staring at a dead banner.

const START: DeviceStart = {
  device_code: 'dc',
  user_code: '3101-755A',
  verification_uri: 'https://github.com/login/device',
  interval: 5,
  expires_in: 900,
};

/**
 * A clock the waits move, so fifteen minutes of polling costs no real time.
 *
 * setTimeout runs its callback at once and advances this instead, which is why
 * the expiry case finishes rather than sitting there for a quarter of an hour.
 */
function fakeClock() {
  let t = 1_000_000;
  const gaps: number[] = [];
  vi.stubGlobal('setTimeout', ((fn: () => void, ms: number) => {
    gaps.push(ms);
    t += ms;
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  return { now: () => t, gaps };
}

/** Each call answers with the next body, then repeats the last one. */
function replies(...bodies: object[]) {
  let i = 0;
  const mock = vi.fn(async () => ({
    json: async () => bodies[Math.min(i++, bodies.length - 1)],
  }));
  vi.stubGlobal('fetch', mock as unknown as typeof fetch);
  return mock;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('device flow polling', () => {
  it('stores the token when GitHub hands one over', async () => {
    replies({ error: 'authorization_pending' }, { access_token: 'gho_x' });
    const clock = fakeClock();
    await expect(pollForToken(START, undefined, clock.now)).resolves.toBe('gho_x');
    expect(localStorage.getItem('modsutd.gh.token.v1')).toBe('gho_x');
  });

  it('slows down when told to, rather than polling at the same rate forever', async () => {
    // GitHub answers slow_down while a client polls faster than the interval it
    // was given, and keeps answering it until the client actually waits longer.
    // Treated as "keep going", an authorisation that lands is never collected -
    // which is the banner stuck on "waiting..." after the code was entered.
    const fetchMock = replies(
      { error: 'slow_down' }, { error: 'slow_down' }, { access_token: 'gho_y' },
    );
    const clock = fakeClock();
    await expect(pollForToken(START, undefined, clock.now)).resolves.toBe('gho_y');
    // Three polls, each waiting five seconds longer than the last. Sliced
    // because jsdom schedules a timer of its own once the promise settles, and
    // the call count is what pins the number of polls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(clock.gaps.slice(0, 3)).toEqual([5000, 10000, 15000]);
  });

  it('gives up when the code has expired instead of waiting for good', async () => {
    replies({ error: 'authorization_pending' });
    const clock = fakeClock();
    await expect(pollForToken(START, undefined, clock.now)).rejects.toThrow(/expired/);
  });

  it('gives up on a reply that is neither a token nor an error', async () => {
    // A Vercel error page, or an empty body. Both left `j` with no
    // access_token and no error, which was a `continue` and therefore forever.
    replies({});
    const clock = fakeClock();
    await expect(pollForToken(START, undefined, clock.now)).rejects.toThrow(/expired/);
  });

  it('surfaces a real error rather than spinning', async () => {
    replies({ error: 'access_denied', error_description: 'you said no' });
    const clock = fakeClock();
    await expect(pollForToken(START, undefined, clock.now)).rejects.toThrow('you said no');
  });

  it('keeps waiting through a dropped request', async () => {
    // "Failed to fetch" on one poll is not an answer. This is the behaviour the
    // expiry deadline must not take away.
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (n++ === 0) throw new Error('Failed to fetch');
      return { json: async () => ({ access_token: 'gho_z' }) };
    }) as unknown as typeof fetch);
    const clock = fakeClock();
    await expect(pollForToken(START, undefined, clock.now)).resolves.toBe('gho_z');
  });
});
