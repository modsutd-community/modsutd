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
// Workbench.tsx interprets the inbound path once on boot, and both `/mods/<code>`
// and `/venues/<code>` are path segments it knows. The path form is what gets
// listed because it is what the prerendered page declares canonical, and a
// sitemap that disagreed with the page's own canonical link would be asking a
// crawler to pick. `/venues?focus=<code>` still works and is what every
// existing share link uses; it is simply not the address advertised.
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

// Every record that has a code, and a complaint about any that does not.
// `encodeURIComponent(undefined)` is the string "undefined", so a malformed
// record does not throw here - it quietly puts /mods/undefined in the sitemap
// and sends a crawler at a page that cannot exist. Skipping it is right;
// skipping it silently is not.
function records(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  const out = [];
  const bad = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    if (typeof r.code === 'string' && r.code) out.push(r);
    else bad.push(f);
  }
  if (bad.length) {
    console.warn(`  sitemap: ${bad.length} record(s) with no code, left out: ${bad.join(', ')}`);
  }
  return out;
}

// XML has five predefined entities and a URL can carry three of them. A venue
// code cannot today, but the code is data and the escape is one line.
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );

const courses = records(join(SRC_DATA, 'courses'));
const venues = records(join(SRC_DATA, 'venues'));

// NO lastmod anywhere, deliberately. Every candidate for one here is a
// filesystem mtime, and the build that matters runs on a fresh clone where
// every file was written at checkout - so a per-file date and a per-directory
// date are the same build date wearing different disguises, and they would
// claim all 614 pages changed on every deploy. A lastmod a crawler learns to
// distrust is worse than none; changefreq carries the hint on its own. Git
// would know the real date, but that is one subprocess per record.
const urls = [
  { loc: `${ORIGIN}/`, priority: '1.0', changefreq: 'daily' },
  { loc: `${ORIGIN}/mods`, priority: '0.9', changefreq: 'daily' },
  { loc: `${ORIGIN}/venues`, priority: '0.8', changefreq: 'weekly' },
  // The one page here a reader who runs no JavaScript can actually read.
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
  });
}

for (const v of venues) {
  urls.push({
    loc: `${ORIGIN}/venues/${encodeURIComponent(v.code)}`,
    priority: '0.5',
    changefreq: 'monthly',
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
