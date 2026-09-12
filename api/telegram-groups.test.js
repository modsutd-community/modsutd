import { describe, expect, it } from 'vitest';
import handler from './telegram-groups.js';

// A tiny stand-in for Vercel's res. The endpoint only ever sets headers and a
// status, so this is the whole surface it touches.
const run = (query, method = 'GET') => {
  const out = { headers: {}, code: 0, body: null };
  const res = {
    setHeader: (k, v) => { out.headers[k] = v; },
    status(c) { out.code = c; return this; },
    json(b) { out.body = b; return this; },
    end() { return this; },
  };
  handler({ method, query }, res);
  return out;
};

describe('the short link to a mod', () => {
  it('sends a valid code to that mod page', () => {
    const r = run({ modCode: '50.040' });
    expect(r.code).toBe(302);
    expect(r.headers.Location).toBe('https://modsutd.tech/mods/50.040');
  });

  // A full stop is unreserved in RFC 3986, so it arrives literal - but a client
  // that encodes it anyway must land in the same place.
  it('accepts the dot encoded or not', () => {
    expect(run({ modCode: '50%2E040' }).headers.Location)
      .toBe('https://modsutd.tech/mods/50.040');
  });

  it('carries a lettered code through', () => {
    expect(run({ modCode: '03.007A' }).headers.Location)
      .toBe('https://modsutd.tech/mods/03.007A');
  });

  // Without the pattern check this is an open redirect: a modsutd.tech link
  // that lands somewhere else is the whole trick.
  it.each(['//evil.example', 'https://evil.example', '../../etc', '', '50.04', undefined])(
    'refuses %p rather than redirecting to it',
    (bad) => {
      const r = run({ modCode: bad });
      expect(r.code).toBe(400);
      expect(r.headers.Location).toBeUndefined();
    },
  );

  it('refuses a repeated param, which names no single mod', () => {
    expect(run({ modCode: ['50.040', '50.001'] }).code).toBe(400);
  });

  it('is GET only', () => {
    expect(run({ modCode: '50.040' }, 'POST').code).toBe(405);
  });

  // 302 on purpose: a permanent redirect is cached forever and this endpoint is
  // meant to be deleted.
  it('redirects temporarily, not permanently', () => {
    expect(run({ modCode: '50.040' }).code).toBe(302);
  });
});
