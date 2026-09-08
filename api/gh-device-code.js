// Vercel serverless function: CORS-friendly proxy for GitHub's OAuth device
// flow (github.com/login/device/code sends no CORS headers, so the static
// site can't call it directly). No secrets involved - the device flow only
// needs the public client id, set as the GITHUB_CLIENT_ID env var on Vercel.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    res.status(503).json({ error: 'sync not configured: GITHUB_CLIENT_ID missing on the server' });
    return;
  }
  const r = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'gist public_repo' }),
  });
  res.status(r.status).json(await r.json());
}
