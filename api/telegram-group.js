// Kickstarts a mod's batch Telegram chat: validates the code shape and
// fires a repository_dispatch; the workflow re-validates everything
// (eligibility, registry) from scratch. Requires MODSUTD_BOT_TOKEN.
const REPO = 'modsutd-community/modsutd';
// Letters allowed: SUTD splits a course into 03.007A/03.007B rather than
// issuing a second number. Kept in step with CANONICAL_MOD in
// frontend/src/utils/contributeTimetable.ts - the relays cannot import
// from the app, so this is a copy on purpose.
const MOD_RE = /^\d{2}\.\d{3}[A-Za-z]?$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const token = process.env.MODSUTD_BOT_TOKEN;
  if (!token) {
    res.status(503).json({ error: 'not configured: MODSUTD_BOT_TOKEN missing on the server' });
    return;
  }
  const mod = String((req.body ?? {}).mod ?? '');
  if (!MOD_RE.test(mod)) {
    res.status(422).json({ error: 'bad mod code' });
    return;
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'telegram-group', client_payload: { mod } }),
  });
  if (r.status === 204) res.status(202).json({ accepted: mod });
  else res.status(502).json({ error: `github dispatch failed (${r.status})` });
}
