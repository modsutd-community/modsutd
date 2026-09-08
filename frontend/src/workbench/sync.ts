import { useEffect, useState } from 'react';
import type { RecordsState } from '@/types';
import type { BackupBundle } from './backup';
import { isBundle } from './backup';
import { stampChanged, readStamps } from './sectionSync';
import { SECTIONS } from './backup';
import type { BundleSection } from './backup';
import { GISCUS_CONFIG } from '@/config/giscus';

// One "link github" powers two things on the student's OWN account:
// records backup to a private gist, and posting reviews directly to the
// repo's Discussions (scope 'gist public_repo'). Auth is GitHub's device
// flow (public client id only, no secrets); the two /api functions exist
// purely to add CORS to github.com's device-flow endpoints. api.github.com
// itself is CORS-open and called directly from the browser.

const TOKEN_KEY = 'modsutd.gh.token.v1';
const GIST_DESC = 'modSUTD records (private) - notes, scores, plan backups';
const GIST_FILE = 'modsutd-records.json';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

// Linking happens in one panel but banners and buttons everywhere react to it.
// Two channels, because one is not enough: a CustomEvent reaches this tab, and
// `storage` reaches every OTHER tab of the site - the device flow sends you to
// github.com and people come back in a second tab, which used to leave the
// first one insisting it was not linked until a reload.
const LINK_EVENT = 'modsutd:gh-link';
const announce = () => window.dispatchEvent(new Event(LINK_EVENT));

/** Subscribe to every way the link state can change. Returns an unsubscribe. */
export function onLinkChange(fn: () => void): () => void {
  const storage = (e: StorageEvent) => {
    // A null key is localStorage.clear(), which also took the token.
    if (e.key === null || e.key === TOKEN_KEY) fn();
  };
  window.addEventListener(LINK_EVENT, fn);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(LINK_EVENT, fn);
    window.removeEventListener('storage', storage);
  };
}

export function useGithubLink(): boolean {
  const [linked, setLinked] = useState(() => !!getToken());
  useEffect(() => onLinkChange(() => setLinked(!!getToken())), []);
  return linked;
}

/**
 * Counts link changes. Anything that cannot re-read the token by itself - the
 * giscus iframes, which are cross-origin - rebuilds when this moves, so one
 * link makes every corner of the page current without a reload.
 */
export function useLinkVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => onLinkChange(() => setV((n) => n + 1)), []);
  return v;
}

export function unlink(): void {
  localStorage.removeItem(TOKEN_KEY);
  forgetSettled();
  announce();
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
}

export async function startDeviceFlow(): Promise<DeviceStart> {
  const r = await fetch('/api/gh-device-code', { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `device flow unavailable (HTTP ${r.status}) - sync needs the deployed site`);
  return j as DeviceStart;
}

export async function pollForToken(start: DeviceStart, signal?: AbortSignal): Promise<string> {
  const interval = Math.max(5, start.interval ?? 5) * 1000;
  for (;;) {
    if (signal?.aborted) throw new Error('cancelled');
    await new Promise((r) => setTimeout(r, interval));
    // The student is away on github.com for half a minute or more, and this
    // polls the whole time. One dropped request used to reject the entire
    // link and put the banner back to "Link now" - the "Failed to fetch" that
    // worked on a second try. A transient failure is not an answer, so wait
    // and ask again.
    let j: { access_token?: string; error?: string; error_description?: string };
    try {
      const r = await fetch('/api/gh-device-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: start.device_code }),
      });
      j = (await r.json().catch(() => ({}))) as typeof j;
    } catch {
      continue;
    }
    if (j.access_token) {
      localStorage.setItem(TOKEN_KEY, j.access_token);
      announce();
      return j.access_token;
    }
    if (j.error && j.error !== 'authorization_pending' && j.error !== 'slow_down') {
      throw new Error(j.error_description ?? j.error);
    }
  }
}

async function gh(token: string, path: string, init?: RequestInit): Promise<Response> {
  const go = () => fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  try {
    return await go();
  } catch (e) {
    // A network-level failure, which is what the browser reports as "Failed to
    // fetch" - never an HTTP status. The first call after linking is a
    // cross-origin preflight to a host this page has not spoken to yet, and
    // that is the one that drops. Retried only when it is safe to repeat:
    // a POST could create a second gist.
    if (init?.method && init.method !== 'GET') throw e;
    await new Promise((r) => setTimeout(r, 700));
    return go();
  }
}

async function findGistId(token: string): Promise<string | null> {
  const r = await gh(token, '/gists?per_page=100');
  if (!r.ok) throw new Error(`gist list failed (HTTP ${r.status})`);
  const gists = (await r.json()) as Array<{ id: string; description: string }>;
  return gists.find((g) => g.description === GIST_DESC)?.id ?? null;
}

/**
 * Write this browser's state to the gist, section by section.
 *
 * `changed` names the sections this browser actually edited. Everything else
 * is taken from the gist as it stands, so a laptop saving a note cannot
 * republish its own stale timetable over the one the phone just wrote. Pushing
 * the whole bundle with every section freshly stamped is what made the last
 * writer win outright, whatever they had touched.
 *
 * Gists have no If-Match, so this is a read-then-write and not a compare-and-
 * swap. The window is one round trip, and the loser of a true tie is the
 * section whose stamp is older, which is the right one to lose.
 */
export async function pushBackup(
  bundle: BackupBundle,
  changed: BundleSection[] = SECTIONS,
): Promise<void> {
  const token = getToken();
  if (!token) throw new Error('not linked');
  const id = await findGistId(token);

  let remote: BackupBundle | null = null;
  if (id) {
    try {
      const got = await gh(token, `/gists/${id}`);
      if (got.ok) {
        const g = (await got.json()) as { files?: Record<string, { content?: string }> };
        const raw = g.files?.[GIST_FILE]?.content;
        if (raw) remote = JSON.parse(raw) as BackupBundle;
      }
    } catch {
      // Unreadable: fall through and write what this browser has. Losing the
      // other device's newer section is bad; refusing to back up at all is
      // worse, and this is the path a first push takes anyway.
    }
  }

  const stamps = stampChanged(changed);
  const remoteStamps = remote?.stamps ?? {};
  const mine = readStamps();
  const mineRow = bundle as unknown as Record<string, unknown>;
  const theirRow = (remote ?? {}) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...theirRow };
  const now = Date.now();
  for (const sec of SECTIONS) {
    // This browser touched it, or it holds the newer copy, or the gist has
    // nothing there at all.
    const takeMine = changed.includes(sec)
      || theirRow[sec] === undefined
      || (mine[sec] ?? 0) >= (remoteStamps[sec] ?? 0);
    out[sec] = takeMine ? mineRow[sec] : theirRow[sec];
    stamps[sec] = takeMine ? (stamps[sec] ?? now) : remoteStamps[sec];
  }

  const stamped: BackupBundle = { ...(out as unknown as BackupBundle), stamps };
  const body = {
    description: GIST_DESC,
    public: false,
    files: { [GIST_FILE]: { content: JSON.stringify(stamped, null, 2) } },
  };
  const r = id
    ? await gh(token, `/gists/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
    : await gh(token, '/gists', { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`push failed (HTTP ${r.status})`);
}

// Whether the pull has run yet, and whether it found anything.
//
// The autosave needs both. It treats the state it first sees as already saved,
// which is right after a pull that brought the gist down and wrong when there
// is no gist at all: linking on a laptop then stored a token, uploaded
// nothing, and the phone had nothing to fetch.
const SETTLED_EVENT = 'modsutd:gh-sync-settled';
let settled = false;
let remoteExists = false;

export function syncSettled(): boolean {
  return settled;
}

/** True once the pull has run AND a gist was there. */
export function remoteBackupExists(): boolean {
  return remoteExists;
}

export function markSyncSettled(found: boolean): void {
  settled = true;
  remoteExists = found;
  window.dispatchEvent(new Event(SETTLED_EVENT));
}

export function onSyncSettled(fn: () => void): () => void {
  window.addEventListener(SETTLED_EVENT, fn);
  return () => window.removeEventListener(SETTLED_EVENT, fn);
}

/** Reset on unlink, so linking a different account starts its own pull. */
function forgetSettled(): void {
  settled = false;
  remoteExists = false;
}

export async function pullBackup(): Promise<BackupBundle | RecordsState> {
  const token = getToken();
  if (!token) throw new Error('not linked');
  const id = await findGistId(token);
  if (!id) throw new Error('no backup gist yet - push first');
  const r = await gh(token, `/gists/${id}`);
  if (!r.ok) throw new Error(`pull failed (HTTP ${r.status})`);
  const gist = (await r.json()) as { files: Record<string, { content: string }> };
  const content = gist.files?.[GIST_FILE]?.content;
  if (!content) throw new Error('backup gist has no records file');
  const parsed = JSON.parse(content) as unknown;
  return isBundle(parsed) ? parsed : (parsed as RecordsState);
}

// ---- direct review posting --------------------------------------------------

async function graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error('github said no - unlink and relink (older links lack the review scope)');
  }
  const j = (await r.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (j.errors?.length) throw new Error(j.errors[0].message);
  if (!j.data) throw new Error('empty response from github');
  return j.data;
}

// The thread per mod is the SAME one giscus renders on the mod page
// (matched by exact title `mod-<code>`), so a directly-posted review shows
// up everywhere.
async function findOrCreateThread(token: string, modCode: string, modName: string): Promise<string> {
  const title = `mod-${modCode}`;
  const found = await graphql<{
    search: { nodes: Array<{ id?: string; title?: string }> };
  }>(token, `query($q: String!) {
    search(type: DISCUSSION, query: $q, first: 10) {
      nodes { ... on Discussion { id title } }
    }
  }`, { q: `repo:${GISCUS_CONFIG.repo} in:title ${title}` });
  const hit = found.search.nodes.find((n) => n.title === title);
  if (hit?.id) return hit.id;

  const created = await graphql<{ createDiscussion: { discussion: { id: string } } }>(
    token,
    `mutation($repo: ID!, $cat: ID!, $title: String!, $body: String!) {
      createDiscussion(input: { repositoryId: $repo, categoryId: $cat, title: $title, body: $body }) {
        discussion { id }
      }
    }`,
    {
      repo: GISCUS_CONFIG.repoId,
      cat: GISCUS_CONFIG.categories.reviews.id,
      title,
      // Whoever gets here first owns the thread's body forever, and the
      // unlinked student lands on it expecting the paste note. Keep in step
      // with the same string in api/review-thread.js.
      body: `**${modCode} ${modName}** - student reviews. one comment per review.`
        + '\n\nCame from modSUTD? Your review is on your clipboard already -'
        + ' paste it into the comment box below and press Comment.',
    },
  );
  return created.createDiscussion.discussion.id;
}

export async function postReview(modCode: string, modName: string, body: string): Promise<string> {
  const token = getToken();
  if (!token) throw new Error('not linked');
  const threadId = await findOrCreateThread(token, modCode, modName);
  const added = await graphql<{ addDiscussionComment: { comment: { url: string } } }>(
    token,
    `mutation($d: ID!, $body: String!) {
      addDiscussionComment(input: { discussionId: $d, body: $body }) { comment { url } }
    }`,
    { d: threadId, body },
  );
  return added.addDiscussionComment.comment.url;
}
