// Vercel serverless function: polls GitHub for the device-flow access token.
// Companion to gh-device-code.js - same no-secret device flow.
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
  const deviceCode = (req.body && req.body.device_code) || '';
  if (!deviceCode || typeof deviceCode !== 'string') {
    res.status(400).json({ error: 'device_code required' });
    return;
  }
  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  res.status(r.status).json(await r.json());
}
