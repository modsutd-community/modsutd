import { useCallback, useEffect, useState } from 'react';
import { getToken } from './sync';

// Batch-chat registry: bundled copy at build time, refreshed from main
// between deploys, so a new group appears without a redeploy. See fromMain for
// why that read does not go through raw.githubusercontent when it can help it.

export interface TgEntry {
  // Encrypted: the registry is committed to a public repo, so the invite link
  // cannot sit in it in the clear. Publishing the ciphertext is deliberate -
  // the UI can say a chat exists without being able to open it. Only
  // /api/telegram-link holds the key.
  linkEnc: string;
  title: string;
  created: string; // 'YYYY-MM'
  expires: string; // ISO date - the batch term's end, from the timetables
  adminGranted?: boolean;
}
export type TgRegistry = Record<string, TgEntry>;

export interface TermWindow {
  start?: string;
  end?: string;
}

// A batch chat lives exactly as long as its term: expiry comes from the
// term end date parsed out of the contributed timetables. Links vanish
// with the term - before the next term's first paste even arrives. No
// expiry means not active, never a calendar guess.
export function isActive(entry: TgEntry, now = new Date()): boolean {
  return !!entry.expires && now.toISOString().slice(0, 10) <= entry.expires;
}


/**
 * Wait until this mod's crowdsourced slots are actually on main.
 *
 * The button goes live the instant a paste is parsed, off the local overlay,
 * which is the point - nobody should wait four hours for the deploy. But
 * `telegram-group.yml` checks out main and refuses a mod with no `schedules`,
 * and the contribution takes about ten seconds to land there. Click inside
 * that window and the workflow prints `skip=not-offered` and exits 0: no
 * group, no registry entry, no error, and a button that says "setting up the
 * chat" until the page is reloaded.
 *
 * Resolves true once the slots are there, false if they never arrive. Only
 * worth calling for a mod whose schedules came from this browser.
 */
export async function slotsOnMain(code: string, tries = 12, gapMs = 5000): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const mod = await fromMain<{ schedules?: unknown[] }>(
        `data/courses/${code.replace('.', '_')}.json`,
      );
      if ((mod?.schedules?.length ?? 0) > 0) return true;
    } catch {
      // Offline or rate-limited. Same answer as "not yet": try again.
    }
    if (i < tries - 1) await new Promise((done) => setTimeout(done, gapMs));
  }
  return false;
}

interface TgData {
  registry: TgRegistry;
  term: TermWindow;
}

let cache: TgData | null = null;
let cachedAt = 0;

// A group is created by a workflow, minutes after somebody asks for one, and
// the registry is a file on main. Cached for the session, the panel showed
// whatever was true when the page loaded - so a chat that appeared since only
// turned up on a reload, including for the person who requested it from another
// tab. Short enough that opening a mod picks up a new one, long enough that
// clicking through a dozen mods is one fetch.
const STALE_MS = 60_000;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, init);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null; // bundled copy missing / raw unreachable (private repo, offline)
  }
}

/**
 * Read a file from main, as freshly as this browser is able.
 *
 * raw.githubusercontent serves `Cache-Control: max-age=300` and its edge
 * IGNORES the query string, so the `?t=` cache-buster that used to be here did
 * nothing at all. Measured against a real push: the contents API had the new
 * bytes one second later, and raw was still serving the old ones three minutes
 * on. That is the whole reason a chat took five minutes to appear instead of
 * two - the group existed, the registry had it, and this side could not see it.
 *
 * The contents API is not edge-cached that way, so it is the truth. It costs a
 * rate limit: 5000/hr with a token, 60/hr per IP without - and a campus shares
 * one IP behind NAT, which is why the unlinked path stays on raw and simply
 * takes longer rather than risking a 403 for everybody.
 */
const REPO_PATH = 'modsutd-community/modsutd';

async function fromMain<T>(path: string): Promise<T | null> {
  const token = getToken();
  if (token) {
    const r = await fetchJson<T>(
      `https://api.github.com/repos/${REPO_PATH}/contents/${path}?ref=main`,
      { headers: { Accept: 'application/vnd.github.raw', Authorization: `Bearer ${token}` } },
    );
    if (r !== null) return r;
  }
  return fetchJson<T>(
    `https://raw.githubusercontent.com/${REPO_PATH}/main/${path}?t=${Date.now()}`,
    { cache: 'no-store' },
  );
}

async function fetchAll(): Promise<TgData> {
  const [regBundled, regRaw, termBundled, termRaw] = await Promise.all([
    fetchJson<TgRegistry>('/data/telegram-groups.json'),
    fromMain<TgRegistry>('data/telegram-groups.json'),
    fetchJson<TermWindow>('/data/term-window.json'),
    fromMain<TermWindow>('data/term-window.json'),
  ]);
  return {
    registry: { ...(regBundled ?? {}), ...(regRaw ?? {}) },
    term: { ...(termBundled ?? {}), ...(termRaw ?? {}) },
  };
}

export function useTelegramData(): [TgData | null, () => Promise<void>] {
  const [data, setData] = useState<TgData | null>(cache);
  const refresh = useCallback(async () => {
    const next = await fetchAll();
    cache = next;
    cachedAt = Date.now();
    setData(next);
  }, []);
  useEffect(() => {
    // On a timer rather than on mount: the mod panel is one component that
    // swaps its contents, so clicking through mods never remounts this and a
    // mount-only check would only ever fire on a page load - which is the
    // reload this exists to avoid. Two small JSON files, and the stale copy
    // stays on screen while they load, so nothing blanks.
    const check = () => {
      if (cache === null || Date.now() - cachedAt > STALE_MS) void refresh();
    };
    check();
    const id = setInterval(check, 15_000);
    return () => clearInterval(id);
  }, [refresh]);
  return [data, refresh];
}

// Exchanges the public ciphertext for a real invite link. Everything that can
// refuse - not signed in, account too new, daily allowance spent - refuses
// here, server-side, because a client-side check protects nothing.
export async function fetchJoinLink(entry: TgEntry, token: string | null): Promise<string> {
  const r = await fetch('/api/telegram-link', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ linkEnc: entry.linkEnc }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `could not get the join link (HTTP ${r.status})`);
  if (!body.link) throw new Error('the server returned no link');
  return body.link;
}
