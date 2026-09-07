import { createDecipheriv, createHmac } from 'node:crypto';

// Vercel serverless function: hands back a batch-chat invite link, but only to
// a signed-in GitHub account that has not already pulled its daily allowance.
//
// The registry ships publicly with the link encrypted, so the repo going public
// does not publish every group. This endpoint holds the only key. Encryption
// stops anonymous bulk collection of the file; the quota below is what raises
// the cost of collecting them one authenticated request at a time. Neither can
// stop a student who has a link from pasting it elsewhere, and nothing can.

const DAILY_LIMIT = 8; // a term is 4-5 mods, so this is generous for real use

// Throwaway accounts are the obvious bypass, and a fixed threshold tells you
// exactly how long to age one. So the threshold is drawn from this range - but
// PER ACCOUNT, never per request: a per-request draw is worse than no gate at
// all, because a one-day-old account simply retries until it draws a 1. The
// draw is an HMAC of the account id under the same key, so it is stable for
// that account, unguessable without the key, and needs nothing stored.
const MIN_AGE_DAYS = [1, 7];

export function minAccountAgeDays(userId, keyB64) {
  const mac = createHmac('sha256', Buffer.from(keyB64, 'base64'))
    .update(`account-age:${userId}`)
    .digest();
  const span = MIN_AGE_DAYS[1] - MIN_AGE_DAYS[0] + 1;
  return MIN_AGE_DAYS[0] + (mac[0] % span);
}

// Best-effort, per warm instance: Vercel gives no shared store, and adding one
// would be the backend this project does not have. A determined scraper gets
// more than DAILY_LIMIT by forcing cold starts; a casual one does not. Swap the
// map for Vercel KV if that ever stops being good enough.
const hits = new Map();

function overQuota(userId) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${userId}:${day}`;
  const n = (hits.get(key) ?? 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) {
    for (const k of hits.keys()) {
      if (!k.endsWith(day)) hits.delete(k);
    }
  }
  return n > DAILY_LIMIT;
}

function decrypt(payload, keyB64) {
  const [version, nonceB64, bodyB64] = String(payload).split(':');
  if (version !== 'v1' || !nonceB64 || !bodyB64) throw new Error('bad ciphertext');
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  const body = Buffer.from(bodyB64, 'base64');
  const tag = body.subarray(body.length - 16);
  const ciphertext = body.subarray(0, body.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonceB64, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const keyB64 = process.env.TG_LINK_KEY;
  if (!keyB64) {
    res.status(503).json({ error: 'chat links are not configured yet' });
    return;
  }

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ code: 'signin', error: 'sign in with GitHub to get the join link' });
    return;
  }
  const enc = req.body && req.body.linkEnc;
  if (!enc || typeof enc !== 'string') {
    res.status(400).json({ error: 'linkEnc required' });
    return;
  }

  const gh = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!gh.ok) {
    res.status(401).json({ code: 'signin', error: 'that GitHub sign-in expired - link again' });
    return;
  }
  const user = await gh.json();

  const ageDays = (Date.now() - new Date(user.created_at).getTime()) / 86_400_000;
  // The threshold is deliberately absent from the message: telling someone
  // their own draw hands them the exact wait, which is the thing the range is
  // hiding.
  if (!(ageDays >= minAccountAgeDays(user.id, keyB64))) {
    res.status(403).json({
      code: 'young',
      error: 'that GitHub account is too new for join links - try again in a few days',
    });
    return;
  }

  if (overQuota(user.id)) {
    res.status(429).json({
      code: 'quota',
      error: `that is ${DAILY_LIMIT} join links today - the rest unlock tomorrow`,
    });
    return;
  }

  try {
    res.status(200).json({ link: decrypt(enc, keyB64) });
  } catch {
    // A registry entry written with a different key, or a truncated copy.
    res.status(500).json({ error: 'this chat link could not be unlocked - please report it' });
  }
}
