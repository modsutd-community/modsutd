import { test, expect } from '@playwright/test';

// robots.txt and sitemap.xml have to be real FILES. vercel.json rewrites
// /(.*) to /index.html, so anything without a file behind it answers 200 with
// the app shell, and a robots.txt that is secretly an HTML page reads to a
// crawler as a site that has none. That is what both of these were: 200,
// text/html, byte-identical to the homepage.
//
// Checked against the preview server because it serves `dist`, which is the
// only place the generated sitemap exists. Nothing here asserts copy: the test
// is about what the response IS, not what it says.
test.describe('crawlable files', () => {
  test('robots.txt is a robots file, not the app shell', async ({ request }) => {
    const res = await request.get('/robots.txt');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/plain');
    const body = await res.text();
    expect(body).not.toContain('<div id="root">');
    expect(body).toMatch(/^User-agent:/m);
    expect(body).toMatch(/^Sitemap: https:\/\/modsutd\.tech\/sitemap\.xml$/m);
  });

  test('sitemap.xml is xml, and holds a mod and a room', async ({ request }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('xml');
    const body = await res.text();
    expect(body).not.toContain('<div id="root">');
    expect(body.startsWith('<?xml')).toBe(true);
    // Both are path segments the boot-time reader knows, and both have a
    // prerendered page whose canonical link says the same. `?focus=` still
    // works and is what existing shares use; it is not what is advertised.
    expect(body).toContain('<loc>https://modsutd.tech/venues/');
    expect(body).not.toContain('<loc>https://modsutd.tech/venues?focus=');
    expect(body).toContain('<loc>https://modsutd.tech/mods/');
    // Every mod and every room, not a sample.
    const urls = body.match(/<loc>/g) ?? [];
    expect(urls.length).toBeGreaterThan(500);
  });

  test('the faq is prose in the first response, with no javascript', async ({ request }) => {
    const res = await request.get('/faq.html');
    expect(res.status()).toBe(200);
    const body = await res.text();
    // Not the app wearing a different filename: it loads no bundle at all.
    expect(body).not.toMatch(/<script[^>]+src=/);
    expect(body).toContain('<h1>modSUTD FAQ</h1>');
    // The point of the page: a crawler that runs nothing still reads an answer.
    expect(body).toContain('"@type": "FAQPage"');
    expect(body).toMatch(/List View/);
  });

  // A sitemap that lists a URL which opens nothing is a sitemap of soft 404s,
  // and crawl budget spent on 225 of them is budget not spent on the mods. The
  // two shapes it lists are checked here rather than assumed: a mod is a path
  // segment, a room is a query param, and the boot-time reader in Workbench.tsx
  // is the only thing that knows either.
  test('every shape the sitemap lists opens what it claims', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'same routes, and the mobile sheet is covered elsewhere');
    await page.goto('/venues/2.507');
    await expect(page.locator('[data-panel="rooms"]')).toContainText('2.507');
    // The older query form is not advertised any more and still has to work:
    // it is in every link anyone has already shared.
    await page.goto('/venues?focus=2.507');
    await expect(page.locator('[data-panel="rooms"]')).toContainText('2.507');
    await page.goto('/mods/50.040');
    await expect(page.locator('[data-panel="mod"]')).toContainText('50.040');
  });

  test('the homepage describes itself before any script runs', async ({ request }) => {
    const res = await request.get('/');
    const body = await res.text();
    const ld = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(ld).not.toBeNull();
    const parsed = JSON.parse(ld![1]) as Record<string, unknown>;
    expect(parsed['@type']).toBe('SoftwareApplication');
    // No rating exists anywhere in /data, and claiming one is the kind of
    // structured data Google issues manual actions for.
    expect(parsed).not.toHaveProperty('aggregateRating');
    expect(parsed).not.toHaveProperty('review');
    // A reader with no JavaScript gets a white page without this.
    expect(body).toContain('<noscript>');
  });
});
