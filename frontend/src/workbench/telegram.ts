import { useCallback, useEffect, useState } from 'react';

// Batch-chat registry: bundled copy at build time, refreshed from raw
// GitHub between deploys (new groups appear without a redeploy; while the
// repo is private the raw fetch 404s and the bundled copy stands alone).
const RAW_URL = 'https://raw.githubusercontent.com/modsutd-community/modsutd/main/data/telegram-groups.json';

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

const RAW_TERM_URL = 'https://raw.githubusercontent.com/modsutd-community/modsutd/main/data/term-window.json';

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
const STALE_MS = 90_000;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, init);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null; // bundled copy missing / raw unreachable (private repo, offline)
  }
}

/**
 * raw.githubusercontent serves `Cache-Control: max-age=300`, and `no-store`
 * only stops the BROWSER reusing a response - the CDN in front of it happily
 * answers with what it has. So a group created a minute ago stayed invisible
 * for five, and the only thing that fixed it was a hard reload, which is not a
 * thing to ask of someone waiting on a button.
 *
 * A unique query string is part of the cache key, so this reaches the origin.
 */
const fresh = (url: string) => `${url}?t=${Date.now()}`;

async function fetchAll(): Promise<TgData> {
  const [regBundled, regRaw, termBundled, termRaw] = await Promise.all([
    fetchJson<TgRegistry>('/data/telegram-groups.json'),
    fetchJson<TgRegistry>(fresh(RAW_URL), { cache: 'no-store' }),
    fetchJson<TermWindow>('/data/term-window.json'),
    fetchJson<TermWindow>(fresh(RAW_TERM_URL), { cache: 'no-store' }),
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

// deploy.yml's cron, in UTC hours: "0 22,2,6,10 * * *". Contributed slots ride
// a schedule rather than deploying per paste, so a chat that has just been
// asked for can be waiting on the next build rather than on Telegram.
const DEPLOY_HOURS_UTC = [22, 2, 6, 10];

/** The next scheduled deploy, in the reader's own clock. */
export function nextDeploy(now = new Date()): string {
  const soonest = DEPLOY_HOURS_UTC
    .map((h) => {
      const d = new Date(now);
      d.setUTCHours(h, 0, 0, 0);
      if (d <= now) d.setUTCDate(d.getUTCDate() + 1);
      return d;
    })
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return soonest.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
