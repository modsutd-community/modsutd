// Anonymous timetable-slot relay (Vercel function). Public endpoint -
// validate hard. Valid slots fire a repository_dispatch that a workflow
// re-validates and commits straight to main; no login, no identity attached.
// Requires MODSUTD_BOT_TOKEN (fine-grained PAT, contents:write) server-side.
// Without it the endpoint declines and the site keeps working -
// contributions just pause.
const REPO = 'modsutd-community/modsutd';
const MAX_SLOTS = 80;

// One accepted request costs a dispatch, a workflow run, a commit to main and
// a production deploy, so an unthrottled endpoint is a cost amplifier as much
// as a spam one.
//
// Per MINUTE, not per hour, because the whole campus shares one egress IP: at
// term start a cohort pasting timetables is ONE address making hundreds of
// legitimate requests. An hourly cap punishes the rush and barely inconveniences
// a script; a per-minute one is the other way round.
//
// Sized for the worst honest case, not the average: a Telegram announcement
// telling the whole school to paste at once. Roughly 1,500 students inside ten
// minutes is ~150/min from one address, so the cap sits well above that. A
// runaway script does thousands per second and still trips instantly.
//
// Raising this costs almost nothing now that deploys collapse (see
// .github/workflows/deploy.yml) - the cap protects against a loop, not a crowd.
// The client also retries a 429, so hitting it delays data rather than losing
// it. Prefer raising it to discovering later that a launch day was throttled.
const PER_IP_PER_MINUTE = 300;
const hits = new Map();

function overQuota(ip) {
  const minute = new Date().toISOString().slice(0, 16);
  const key = `${ip}:${minute}`;
  const n = (hits.get(key) ?? 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) {
    for (const k of hits.keys()) if (!k.endsWith(minute)) hits.delete(k);
  }
  return n > PER_IP_PER_MINUTE;
}

// Same-origin only. Does not stop a determined caller - curl sends whatever
// Origin it likes - but it makes drive-by use of the endpoint a deliberate act
// rather than an accident, and costs a legitimate browser nothing.
function foreignOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false; // non-browser callers are handled by the quota
  try {
    const host = new URL(origin).hostname;
    return !(host === 'modsutd.tech' || host.endsWith('.vercel.app') || host === 'localhost');
  } catch {
    return true;
  }
}

const DAYS = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
const TYPES = new Set(['Lecture', 'Cohort', 'Tutorial', 'Lab', 'Studio', 'Seminar', 'Recitation']);
const MOD_RE = /^\d{2}\.\d{3}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const VENUE_RE = /^[\w .\-#()/]{1,30}$/;
const TERM_RE = /^[\w ,/]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanSlots(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const s of raw.slice(0, MAX_SLOTS)) {
    if (!s || typeof s !== 'object') continue;
    const type = TYPES.has(s.type) ? s.type : null;
    if (
      !type ||
      !MOD_RE.test(String(s.mod)) ||
      !DAYS.has(s.day) ||
      !TIME_RE.test(String(s.start)) ||
      !TIME_RE.test(String(s.end)) ||
      !VENUE_RE.test(String(s.venue))
    ) continue;
    const key = `${s.mod}|${s.day}|${s.start}|${s.end}|${s.venue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ mod: s.mod, type, day: s.day, start: s.start, end: s.end, venue: s.venue.trim() });
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  if (foreignOrigin(req)) {
    res.status(403).json({ error: 'this endpoint only serves modsutd' });
    return;
  }
  const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'unknown';
  if (overQuota(ip)) {
    res.status(429).json({ error: 'too many contributions from this network right now - try again shortly' });
    return;
  }
  const token = process.env.MODSUTD_BOT_TOKEN;
  if (!token) {
    res.status(503).json({ error: 'contributions not configured: MODSUTD_BOT_TOKEN missing on the server' });
    return;
  }
  const body = req.body ?? {};
  const term = TERM_RE.test(String(body.term)) ? body.term : 'unspecified';
  const termStart = DATE_RE.test(String(body.termStart)) ? body.termStart : null;
  const termEnd = DATE_RE.test(String(body.termEnd)) ? body.termEnd : null;
  const slots = cleanSlots(body.slots);
  if (slots.length === 0) {
    res.status(422).json({ error: 'no valid slots' });
    return;
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'timetable-contribution',
      client_payload: { term, termStart, termEnd, slots },
    }),
  });
  if (r.status === 204) res.status(202).json({ accepted: slots.length });
  else res.status(502).json({ error: `github dispatch failed (${r.status})` });
}
