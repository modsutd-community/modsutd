// TEMPORARY. A short link that lands on a mod's page with its batch chat in
// view: GET /api/telegram-groups?modCode=50.040 -> /mods/50.040
//
// It exists to cut the friction of the current path, which is: open MyPortal,
// export a timetable, paste it here, wait for the slots to reach main, find the
// mod, then press join. A T7 student already has a way to make a group chat -
// create one, post the link in the cohort chat - and that is three steps
// against six. This gives one link that can be posted the same way, and lands
// somewhere that explains what the platform does with it.
//
// Delete this once the paste flow is the habit rather than the novelty. It adds
// no state: the redirect is computed from the code and nothing is stored.
//
// A full stop in a query value needs no encoding. RFC 3986 lists "." as
// unreserved, so `?modCode=50.040` is literal in the query and literal again in
// the /mods/50.040 path segment. Encoding it would be legal too and would land
// on the same place, which is why the decode below accepts either.
const CODE = /^\d{2}\.\d{3}[A-Za-z]?$/;
const SITE = 'https://modsutd.tech';

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'GET only' });
    return;
  }

  const raw = req.query?.modCode;
  // A repeated param arrives as an array, and a caller who sends two codes has
  // not told us which mod they meant.
  const code = typeof raw === 'string' ? decodeURIComponent(raw).trim() : '';

  // Validated, not just forwarded. Without this the endpoint is an open
  // redirect: `?modCode=//evil.example` would send a reader off-site under a
  // modsutd.tech link, which is the whole trick.
  if (!CODE.test(code)) {
    res.status(400).json({
      error: 'modCode must look like 50.040',
      example: '/api/telegram-groups?modCode=50.040',
    });
    return;
  }

  const to = `${SITE}/mods/${code}`;
  // 302, not 301. A permanent redirect is cached by the browser forever, and
  // this endpoint is meant to be deleted.
  res.setHeader('Location', to);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(302).end();
}
