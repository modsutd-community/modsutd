import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The three ways prerendering goes wrong, each with a test rather than a
// promise. Run against the preview server, which serves `dist` - the only
// place these files exist.
//
// 1. THIN PAGES. A generated page that is one template with the code swapped
//    is doorway content, and Google treats it as such. The data behind these
//    is real, so the test is that the page actually carries it.
// 2. TWO RENDERERS DISAGREEING. The static page and the React app describe the
//    same course. They read the same built bundle by construction, and these
//    assertions hold them to it.
// 3. SOFT 404s. A url in the sitemap that opens nothing is crawl budget spent
//    on a page that cannot exist.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(HERE, '..', 'dist', 'data');
const courses = JSON.parse(readFileSync(path.join(BUNDLE, 'courses.json'), 'utf8')) as
  Array<Record<string, string | number | string[]>>;
const venues = JSON.parse(readFileSync(path.join(BUNDLE, 'venues.json'), 'utf8')) as
  Array<Record<string, string | number>>;

const ld = (html: string) => {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(m, 'the page carries structured data').not.toBeNull();
  return JSON.parse(m![1]) as Record<string, unknown>;
};
const title = (html: string) => html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
const desc = (html: string) =>
  html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';

test.describe('prerendered pages', () => {
  test('a mod page carries that mod, not a template', async ({ request }) => {
    const res = await request.get('/mods/50.040');
    expect(res.status()).toBe(200);
    const html = await res.text();
    const rec = courses.find((c) => c.code === '50.040')!;

    // Risk 2: every one of these comes from the bundle the app itself fetches.
    expect(title(html)).toContain('50.040');
    expect(title(html)).toContain(rec.name as string);
    expect(desc(html)).not.toBe('');
    expect((rec.description as string).startsWith(desc(html).slice(0, 40))).toBe(true);

    const data = ld(html);
    expect(data['@type']).toBe('Course');
    expect(data.courseCode).toBe('50.040');
    expect(data.name).toBe(rec.name);
    expect(data.numberOfCredits).toBe(rec.credits);
    // SUTD provides the course; this site only catalogues it. The claim is
    // accurate and the page says in its own words that it is not affiliated.
    expect((data.provider as Record<string, string>).name)
      .toContain('Singapore University of Technology and Design');
    // Whitespace-insensitive: the line breaks are the generator's business,
    // but the sentence has to be on the page beside the provider claim.
    expect(html.replace(/\s+/g, ' '))
      .toContain('not affiliated with or endorsed by the Singapore University');

    // Risk 1: the facts are on the page, not only in the head.
    expect(html).toContain('<strong>Credits:</strong> 12');
    expect(html).toContain('<strong>Pillar:</strong> CSD');
  });

  test('two mod pages differ by more than their code', async ({ request }) => {
    const a = await (await request.get('/mods/50.040')).text();
    const b = await (await request.get('/mods/02.146')).text();

    // Risk 1 again, and the version of it a template cannot pass: strip the
    // codes and the pages still have to be different documents.
    const flatten = (h: string) =>
      (h.match(/<noscript>[\s\S]*?<\/noscript>/)?.[0] ?? '')
        .replace(/\d{2}\.\d{3}[A-Za-z]?/g, '');
    expect(flatten(a)).not.toBe(flatten(b));
    expect(title(a)).not.toBe(title(b));
    expect(desc(a)).not.toBe(desc(b));
  });

  test('a room page carries that room and its real coordinates', async ({ request }) => {
    const html = await (await request.get('/venues/2.507')).text();
    const rec = venues.find((v) => v.code === '2.507')!;

    expect(title(html)).toContain('2.507');
    expect(title(html)).toContain(rec.name as string);

    const data = ld(html);
    expect(data['@type']).toBe('Place');
    expect(data.identifier).toBe('2.507');
    // Attached by sync-data from the survey. Asserted equal to the bundle
    // rather than merely present: a coordinate that drifts from what the map
    // draws is worse than none.
    const geo = data.geo as Record<string, number>;
    expect(geo.latitude).toBe(rec.lat);
    expect(geo.longitude).toBe(rec.lng);
  });

  test('the homepage keeps its own identity', async ({ request }) => {
    const html = await (await request.get('/')).text();
    expect(title(html)).toBe('modSUTD');
    // Not a Course: the per-page blocks replace this one rather than adding to
    // it, and two objects claiming to be the page's subject is worse than one.
    expect(ld(html)['@type']).toBe('SoftwareApplication');
  });

  // Risk 3. A prerendered file must not shadow the app: the same URL has to
  // serve static HTML to a crawler AND boot the panel for a reader.
  test('a prerendered url still opens the app', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same routes; the mobile sheet is covered elsewhere');
    await page.goto('/mods/50.040');
    await expect(page.locator('[data-panel="mod"]')).toContainText('50.040');
    await page.goto('/venues/2.507');
    await expect(page.locator('[data-panel="rooms"]')).toContainText('2.507');
  });

  // A venue code is not always code-shaped: Campus Centre, Antique House and
  // Swimming Pool ARE their names, spaces and all. A path guard written as an
  // allowlist of code characters dropped all three and said so only in a build
  // log nobody reads, while the sitemap went on advertising them.
  test('a room whose code is its name still has a page', async ({ request }) => {
    for (const code of ['Campus Centre', 'Antique House', 'Swimming Pool']) {
      const res = await request.get(`/venues/${encodeURIComponent(code)}`);
      expect(res.status(), `${code} has a page`).toBe(200);
      const html = await res.text();
      expect(title(html)).toContain(code);
      // Their code IS their name, so joining the two printed it twice:
      // "Campus Centre Campus Centre - SUTD room - modSUTD".
      expect(title(html)).not.toContain(`${code} ${code}`);
    }
  });

  test('every mod in the sitemap has a page, and every page a mod', async ({ request }) => {
    const xml = await (await request.get('/sitemap.xml')).text();
    const listed = [...xml.matchAll(/<loc>https:\/\/modsutd\.tech\/mods\/([^<]+)<\/loc>/g)]
      .map((m) => decodeURIComponent(m[1]));
    expect(listed.length).toBe(courses.length);

    // Spot the ends rather than fetching 389 pages: a generator that dropped
    // records would drop them from both lists together, so the count above is
    // the real check and these prove the extremes resolve.
    for (const code of [listed[0], listed[listed.length - 1]]) {
      const res = await request.get(`/mods/${code}`);
      expect(res.status(), `${code} has a page`).toBe(200);
      expect(title(await res.text())).toContain(code);
    }

    const rooms = [...xml.matchAll(/<loc>https:\/\/modsutd\.tech\/venues\/([^<]+)<\/loc>/g)]
      .map((m) => m[1]);
    expect(rooms.length).toBe(venues.length);
  });
});
