// Writes frontend/public/sitemap.xml from /data, so every mod and every room
// has a URL a crawler can find.
//
// WHY IT IS GENERATED AND NOT WRITTEN
// The catalogue is 389 courses and 225 rooms and both move. A hand-kept list is
// right until the first month nobody remembers, and a sitemap naming a course
// that no longer exists is worse than a short one.
//
// WHY IT IS A FILE IN public/ AND NOT A ROUTE
// vercel.json rewrites /(.*) to /index.html, so anything without a real file
// behind it answers 200 with the app shell. Before this, /sitemap.xml and
// /robots.txt both returned the SPA HTML with a 200, which reads to a crawler
// as a site that has neither.
//
// THE URL SHAPES ARE THE APP'S, NOT INVENTED
// Workbench.tsx interprets the inbound path once on boot: `/mods/<code>` is a
// path segment, and a room is `/venues?focus=<code>` and NOT a path. Listing
// /venues/<code> here would be listing URLs that answer 200 and then open
// nothing, which is the one thing a sitemap must not do.
//
// Run from the prebuild hook, beside sync-data.mjs.

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DATA = join(REPO_ROOT, 'data');
const OUT = join(__dirname, '..', 'public', 'sitemap.xml');

const ORIGIN = 'https://modsutd.tech';

function readDir(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}

// The last time anything in a directory changed, as a date. Per-record mtimes
// would be the file's checkout time on a fresh clone, which is today for every
// one of them and tells a crawler nothing.
function lastChanged(dir) {
  let newest = 0;
  if (!statSync(dir, { throwIfNoEntry: false })) return null;
  for (const f of readdirSync(dir)) {
    const s = statSync(join(dir, f));
    if (s.mtimeMs > newest) newest = s.mtimeMs;
  }
  return newest ? new Date(newest).toISOString().slice(0, 10) : null;
}

// XML has five predefined entities and a URL can carry three of them. A venue
// code cannot today, but the code is data and the escape is one line.
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );

const courses = readDir(join(SRC_DATA, 'courses'));
const venues = readDir(join(SRC_DATA, 'venues'));
const courseDay = lastChanged(join(SRC_DATA, 'courses'));
const venueDay = lastChanged(join(SRC_DATA, 'venues'));

const urls = [
  { loc: `${ORIGIN}/`, priority: '1.0', changefreq: 'daily' },
  { loc: `${ORIGIN}/mods`, priority: '0.9', changefreq: 'daily', lastmod: courseDay },
  { loc: `${ORIGIN}/venues`, priority: '0.8', changefreq: 'weekly', lastmod: venueDay },
  // Hand-written and static, so it has no lastmod from /data. It is the one
  // page here a reader who runs no JavaScript can actually read.
  { loc: `${ORIGIN}/faq.html`, priority: '0.6', changefreq: 'monthly' },
];

for (const c of courses) {
  // A retired course keeps its page on purpose: someone took it, their plan
  // still names it, and its review thread is the only record of what taking it
  // was like. Lower priority, not absent.
  urls.push({
    loc: `${ORIGIN}/mods/${encodeURIComponent(c.code)}`,
    priority: c.retired ? '0.3' : '0.7',
    changefreq: 'weekly',
    lastmod: courseDay,
  });
}

for (const v of venues) {
  urls.push({
    loc: `${ORIGIN}/venues?focus=${encodeURIComponent(v.code)}`,
    priority: '0.5',
    changefreq: 'monthly',
    lastmod: venueDay,
  });
}

const body = urls
  .map((u) => {
    const parts = [`    <loc>${esc(u.loc)}</loc>`];
    if (u.lastmod) parts.push(`    <lastmod>${u.lastmod}</lastmod>`);
    parts.push(`    <changefreq>${u.changefreq}</changefreq>`);
    parts.push(`    <priority>${u.priority}</priority>`);
    return `  <url>\n${parts.join('\n')}\n  </url>`;
  })
  .join('\n');

writeFileSync(
  OUT,
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
  'utf-8',
);

// A sitemap may hold 50,000 URLs and 50MB uncompressed. This is nowhere near
// either, and saying so is cheaper than a reader wondering.
console.log(`  sitemap.xml: ${urls.length} urls (${courses.length} mods, ${venues.length} rooms)`);
