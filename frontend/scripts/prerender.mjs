// Writes one real HTML file per mod and per room into dist/, so a crawler that
// runs no JavaScript gets a page about THAT course instead of the app shell.
//
// WHY
// The app reads the URL once on boot and never writes a title back, so every
// route served the identical `<title>modSUTD</title>`. GPTBot, ClaudeBot and
// PerplexityBot execute no JavaScript at all, and Google's render pass is a
// queue a new domain waits in. Until a page has its own title, "sutd 50.012
// review" has nothing here to match.
//
// WHAT IT DOES NOT DO
// It does not render the React app. Each page is the same shell with a
// different `<head>` and a `<noscript>` body carrying the record's own facts.
// Nothing inside `#root` changes, so there is no flash: React mounts into an
// empty container exactly as it does today, and a reader with JavaScript never
// sees the static copy.
//
// THE FACTS COME FROM THE BUILT BUNDLE, NOT FROM /data
// `dist/data/courses.json` is the file the app itself fetches, after
// sync-data.mjs has attached everything derived. Reading /data instead would
// mean the page and the app could describe the same course differently, which
// is the one failure this shape makes possible.
//
// Runs as `postbuild`, after vite has written dist/index.html.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');
const ORIGIN = 'https://modsutd.tech';

// Long enough to say what the course is, short enough that Google shows it
// rather than its own extract. Cut on a word.
const DESC_MAX = 155;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// JSON-LD sits inside a <script> element, where the ONLY sequence that can end
// it early is `</script`, and a lone `<` is legal. Escaping the slash keeps the
// string identical to a JSON reader while making that sequence impossible.
const ld = (obj) => JSON.stringify(obj, null, 2).replace(/<\//g, '<\\/');

function trim(text, max = DESC_MAX) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ')) || cut}…`;
}

function page(shell, { title, description, canonical, jsonld, body }) {
  let out = shell;
  out = out.replace('<title>modSUTD</title>', `<title>${esc(title)}</title>`);
  out = out.replace(
    /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${esc(description)}" />`,
  );
  // After the description so the canonical sits with the rest of the head.
  out = out.replace('</head>', `    <link rel="canonical" href="${canonical}" />\n  </head>`);
  // The homepage's own SoftwareApplication block describes the app, which is
  // not what this page is about. Replaced rather than added to: two top-level
  // objects claiming to be the page's subject is worse than either alone.
  out = out.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">\n${ld(jsonld)}\n    </script>`,
  );
  // Inside the existing noscript, replacing the generic copy. A reader without
  // JavaScript is on this page because they searched for this course.
  out = out.replace(/<noscript>[\s\S]*?<\/noscript>/, `<noscript>\n${body}\n    </noscript>`);
  return out;
}

const NOT_AFFILIATED =
  '<p style="color:#7e828d;font-size:.85rem">modSUTD is independent and is not '
  + 'affiliated with or endorsed by the Singapore University of Technology and '
  + 'Design.</p>';

function noscriptBody(rows, heading, lead, sourceUrl) {
  const facts = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<li><strong>${esc(k)}:</strong> ${esc(v)}</li>`)
    .join('\n          ');
  const source = sourceUrl
    ? `<p><a href="${esc(sourceUrl)}" style="color:#7aa2f7">SUTD's own page for this course</a></p>`
    : '';
  return `      <div style="max-width:40rem;margin:3rem auto;padding:0 1.25rem;color:#e9eaed;font:16px/1.6 system-ui,sans-serif">
        <h1 style="font-size:1.4rem">${esc(heading)}</h1>
        <p>${esc(lead)}</p>
        <ul>
          ${facts}
        </ul>
        ${source}
        <p><a href="/" style="color:#7aa2f7">Open modSUTD</a> &middot; <a href="/faq.html" style="color:#7aa2f7">FAQ</a></p>
        ${NOT_AFFILIATED}
      </div>`;
}

function write(relDir, html) {
  const dir = join(DIST, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html, 'utf-8');
}

// ---------------------------------------------------------------------------

const shellPath = join(DIST, 'index.html');
if (!existsSync(shellPath)) {
  console.error('prerender: dist/index.html is missing - run after vite build');
  process.exit(1);
}
const shell = readFileSync(shellPath, 'utf-8');

const courses = JSON.parse(readFileSync(join(DIST, 'data', 'courses.json'), 'utf-8'));
const venues = JSON.parse(readFileSync(join(DIST, 'data', 'venues.json'), 'utf-8'));

let mods = 0;
for (const c of courses) {
  if (typeof c.code !== 'string' || !c.code) continue;
  const url = `${ORIGIN}/mods/${encodeURIComponent(c.code)}`;
  const retired = c.retired ? ' (no longer offered)' : '';
  const lead = trim(c.description, 400)
    || `${c.name} is a ${c.credits}-credit ${c.pillar} course at SUTD.`;

  write(`mods/${c.code}`, page(shell, {
    title: `${c.code} ${c.name} - SUTD course - modSUTD`,
    description: trim(
      c.description
      || `${c.code} ${c.name}: a ${c.credits}-credit SUTD ${c.pillar} course in term ${c.term}.`,
    ),
    canonical: url,
    jsonld: {
      '@context': 'https://schema.org',
      '@type': 'Course',
      name: c.name,
      courseCode: c.code,
      url,
      // SUTD provides the course; modSUTD only catalogues it. Naming the
      // provider is the accurate claim, and the page says in its own words
      // that this site is not affiliated with them.
      provider: {
        '@type': 'CollegeOrUniversity',
        name: 'Singapore University of Technology and Design',
        url: 'https://www.sutd.edu.sg',
      },
      ...(c.description ? { description: trim(c.description, 600) } : {}),
      ...(c.prerequisites?.length ? { coursePrerequisites: c.prerequisites } : {}),
      ...(c.credits ? { numberOfCredits: c.credits } : {}),
      ...(c.sourceUrl ? { sameAs: c.sourceUrl } : {}),
    },
    body: noscriptBody(
      [
        ['Course code', c.code],
        ['Pillar', c.pillar],
        ['Term', c.term],
        ['Credits', c.credits],
        ['Department', c.department],
        ['Prerequisites', c.prerequisites?.length ? c.prerequisites.join(', ') : 'none'],
        ['Scheduled classes', c.schedules?.length || 0],
      ],
      `${c.code} ${c.name}${retired}`,
      lead,
      c.sourceUrl,
    ),
  }));
  mods += 1;
}

let rooms = 0;
for (const v of venues) {
  if (typeof v.code !== 'string' || !v.code) continue;
  const url = `${ORIGIN}/venues/${encodeURIComponent(v.code)}`;
  const where = `Building ${v.building}, floor ${v.floor}`;

  write(`venues/${v.code}`, page(shell, {
    title: `${v.code} ${v.name} - SUTD room - modSUTD`,
    description: trim(
      `${v.name} is room ${v.code} at SUTD: ${where}. See what is scheduled in it and how to find it.`,
    ),
    canonical: url,
    jsonld: {
      '@context': 'https://schema.org',
      '@type': 'Place',
      name: v.name,
      identifier: v.code,
      url,
      containedInPlace: {
        '@type': 'CollegeOrUniversity',
        name: 'Singapore University of Technology and Design',
        url: 'https://www.sutd.edu.sg',
      },
      // Attached by sync-data.mjs from the 2026-08-22 survey via
      // data/_meta/room-coords.json. A room with no surveyed shape of its own
      // carries its building's point, which is approximate rather than
      // invented; nothing here is generated when the bundle has no coordinate.
      ...(typeof v.lat === 'number' && typeof v.lng === 'number'
        ? { geo: { '@type': 'GeoCoordinates', latitude: v.lat, longitude: v.lng } }
        : {}),
    },
    body: noscriptBody(
      [
        ['Room code', v.code],
        ['Building', v.building],
        ['Floor', v.floor],
        ['Type', v.type],
      ],
      `${v.code} ${v.name}`,
      `${v.name} is a room at the Singapore University of Technology and Design. ${where}.`,
    ),
  }));
  rooms += 1;
}

console.log(`  prerendered ${mods + rooms} pages (${mods} mods, ${rooms} rooms)`);
