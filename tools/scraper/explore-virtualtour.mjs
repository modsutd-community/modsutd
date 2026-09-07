#!/usr/bin/env node
// Explore SUTD's krpano-powered virtual tour, dump every scene + thumbnail.
//
// Usage: node tools/scraper/explore-virtualtour.mjs
//
// Output:
//   - frontend/public/maps/scenes/<code>.jpg  (thumbnails)
//   - data/venues/<code>.json                 (new rooms only; never overwrites)
//   - data/_meta/virtualtour_scenes.md        (summary)
//   - tools/scraper/_out/virtualtour_scrape.json (raw extracted scenes)
//
// Engine: krpano (confirmed via `krpano_vtour` element + krpanoJS shipping
// `embedpano`). The XML is "encrypted" but krpano decrypts it client-side, so
// we just read the live DOM/krpano API with Playwright.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const REPO_ROOT      = path.resolve(__dirname, '..', '..');

// Playwright is installed in the frontend workspace, not at the repo root,
// and Node ESM doesn't auto-search ancestor `node_modules`. Resolve it
// explicitly so this script can sit anywhere.
const PLAYWRIGHT_ENTRY = path.join(REPO_ROOT, 'frontend', 'node_modules', 'playwright', 'index.mjs');
const { chromium } = await import(PLAYWRIGHT_ENTRY);
const VENUES_DIR     = path.join(REPO_ROOT, 'data', 'venues');
const META_DIR       = path.join(REPO_ROOT, 'data', '_meta');
const SCENES_OUT_DIR = path.join(REPO_ROOT, 'frontend', 'public', 'maps', 'scenes');
const RAW_OUT_DIR    = path.join(__dirname, '_out');

const TOUR_URL = 'https://virtualtour.sutd.edu.sg/';

// Existing venue codes - never overwrite these JSONs.
const EXISTING_CODES = new Set([
  '1.101','1.310','1.502','1.503','1.504','1.505','1.508','1.510',
  '1.609','1.611','1.612','2.101','2.207','2.301','2.502','3.201',
  '3.410','5.204','5.310',
]);

// Code regex: 1.502, 2.101, B.04, M.301, P.207, etc.
const CODE_RE = /\b([1-9]|[BMP])\.\d{2,3}\b/i;

// Curated scene → known room code map. The virtual tour titles its panoramas
// by theme rather than room number ("Auditorium", "Cohort Classroom", …) so
// these are the only confident identity links between a panorama and a real
// room. Each entry must point to a code in EXISTING_CODES - we never invent
// rooms here, just attach a thumbnail to a known one.
//
// 2.101 is the Auditorium - confirmed: existing JSON labels 2.101 as
// "Auditorium" and the tour group "Campus" exposes scene_auditorium_level_1
// with title "Auditorium". Other panoramas (architecture studio, hostel
// rooms, fab lab levels, cohort classroom etc.) don't pin to a single
// numbered room in the existing catalog, so we leave them as scene-only
// thumbnails rather than guess.
const SCENE_TO_KNOWN_CODE = {
  scene_auditorium_level_1: '2.101',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers ---------------------------------------------------------

function codeFromTitle(title) {
  if (!title) return null;
  const m = title.match(CODE_RE);
  if (!m) return null;
  return m[0].toUpperCase().replace(/^B/i,'B').replace(/^M/i,'M').replace(/^P/i,'P');
}

function buildingFromCode(code) {
  // "2.101" -> "2"; "B.04" -> "B"
  const head = code.split('.')[0];
  return head;
}

function floorFromCode(code) {
  // "2.101" -> 1; "1.612" -> 6; "B.04" -> 0 (basement)
  const head = code.split('.')[0];
  if (/^\d$/.test(head)) {
    const tail = code.split('.')[1] || '';
    // First digit of the room number is the floor.
    const f = parseInt(tail[0], 10);
    return Number.isFinite(f) ? f : 1;
  }
  if (head.toUpperCase() === 'B') return 0;
  if (head.toUpperCase() === 'M') return 0;  // mezzanine - close enough
  if (head.toUpperCase() === 'P') return -1; // podium/parking
  return 1;
}

const TYPE_KEYWORDS = [
  // Order matters - first match wins, more-specific phrases up top.
  ['Lecture Theatre', /(lecture\s*theatre|theatre|theater)/i],
  ['Auditorium',      /auditorium/i],
  ['Lab',             /\b(lab\b|laboratory|workshop|fab(\s*lab)?|maker)/i],
  ['Studio',          /studio/i],
  ['Think Tank',      /think\s*tank/i],
  ['Cohort Classroom',/(cohort|classroom|class\s*room)/i],
  ['Seminar Room',    /seminar/i],
  ['Meeting Room',    /(meeting\s*room|conference)/i],
];

function venueTypeFromTitle(title) {
  for (const [t, re] of TYPE_KEYWORDS) {
    if (re.test(title)) return t;
  }
  return 'Cohort Classroom';
}

function cleanName(rawTitle) {
  // Strip code prefix/suffix and tidy whitespace.
  let n = (rawTitle || '').replace(CODE_RE, '').trim();
  n = n.replace(/^[\s\-:|,]+|[\s\-:|,]+$/g, '');
  return n || rawTitle || '';
}

function safeFilenameForCode(code) {
  // Match repo convention - underscores, e.g. "2_101".
  return code.replace('.', '_');
}

// ---------- main ------------------------------------------------------------

async function main() {
  await fs.mkdir(SCENES_OUT_DIR, { recursive: true });
  await fs.mkdir(VENUES_DIR,     { recursive: true });
  await fs.mkdir(META_DIR,       { recursive: true });
  await fs.mkdir(RAW_OUT_DIR,    { recursive: true });

  const networkLog  = [];   // every network response (URL, content-type, size)
  const imageBuffers = new Map(); // url -> Buffer

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-web-security'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await context.newPage();

  page.on('console', (msg) => {
    // Surface any in-page errors for debugging - quiet otherwise.
    if (msg.type() === 'error') console.warn('[page-error]', msg.text());
  });

  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const ct  = resp.headers()['content-type'] || '';
      const status = resp.status();
      networkLog.push({ url, status, ct });
      if (status === 200 && /image\/(jpeg|png|webp)/i.test(ct)) {
        // Cache thumbnail/preview-sized images. Most thumbnails sit under
        // panos/ and are small (< 200 KB).
        try {
          const buf = await resp.body();
          if (buf && buf.length < 800 * 1024) {
            imageBuffers.set(url, buf);
          }
        } catch (_) { /* response body sometimes unavailable */ }
      }
    } catch (_) { /* ignore */ }
  });

  console.log('[*] Visiting', TOUR_URL);
  await page.goto(TOUR_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // krpano self-loads; wait for the embed to materialise.
  console.log('[*] Waiting for krpano …');
  await page.waitForFunction(
    () => {
      const el = document.getElementById('krpano_vtour');
      return !!(el && typeof el.get === 'function' && el.get('xml.scene'));
    },
    { timeout: 60_000 },
  );
  // Let the scene array fully populate.
  await sleep(2_000);

  // Pull every scene the engine knows about.
  const scenes = await page.evaluate(() => {
    const kr = document.getElementById('krpano_vtour');
    if (!kr) return { error: 'no krpano element' };
    const scenes = kr.get('scene');
    const out = [];
    if (!scenes || typeof scenes.getArray !== 'function') {
      return { error: 'scene array missing' };
    }
    const arr = scenes.getArray();
    const lang = kr.get('language') || 'en';
    for (const sc of arr) {
      const name = sc.name;
      const lang_sc = kr.get(`lang[${lang}].scene[${name}]`) || {};
      // Hotspots inside this scene have description/title strings too.
      const hotspots = [];
      try {
        const hs = sc.hotspot;
        if (hs && typeof hs.getArray === 'function') {
          for (const h of hs.getArray()) {
            const lang_h = kr.get(`lang[${lang}].hotspot[${h.name}]`) || {};
            hotspots.push({
              name: h.name,
              type: h.type,
              linkedscene: h.linkedscene,
              title: lang_h.title || h.title || null,
              description: lang_h.description || null,
            });
          }
        }
      } catch (_) { /* some scenes have no hotspots */ }
      out.push({
        name,
        title:        lang_sc.title       || sc.title       || null,
        dot_title:    lang_sc.dot_title   || null,
        description:  lang_sc.description || null,
        thumburl:     sc.thumburl  || null,
        previewurl:   sc.previewurl || null,
        sceneurl:     sc.sceneurl   || null,
        index:        sc.index,
        hotspots,
      });
    }
    // Also dump the scene_group structure for grouping context.
    const groups = [];
    const sg = kr.get('scene_group');
    if (sg && typeof sg.getArray === 'function') {
      for (const g of sg.getArray()) {
        const langG = kr.get(`lang[${lang}].scene_group[${g.name}]`) || {};
        const gScenes = [];
        if (g.scene && typeof g.scene.getArray === 'function') {
          for (const s of g.scene.getArray()) gScenes.push(s.name);
        }
        groups.push({
          name: g.name,
          title: langG.title || g.title || null,
          scenes: gScenes,
        });
      }
    }
    return { scenes: out, groups, language: lang };
  });

  if (scenes.error) {
    console.error('[!] Failed to extract scenes:', scenes.error);
    await browser.close();
    process.exit(2);
  }

  console.log(`[*] Extracted ${scenes.scenes.length} scenes, ${scenes.groups.length} groups.`);

  // Trigger thumbnail loads - krpano lazy-loads previews; visit each scene
  // briefly so its preview/tile responses fire and we capture the image bytes.
  // While we're there, harvest the (also lazy-loaded) hotspots for each scene.
  console.log('[*] Hopping scenes to trigger thumbnail loads + hotspots …');
  const hotspotsBySceneName = new Map();
  for (const sc of scenes.scenes) {
    try {
      await page.evaluate((name) => {
        const kr = document.getElementById('krpano_vtour');
        if (kr) kr.call(`loadscene(${name},null,KEEPVIEW,BLEND(0));`);
      }, sc.name);
      // Short dwell - long enough for the preview tile to fetch.
      await sleep(600);
      const hs = await page.evaluate((name) => {
        const kr = document.getElementById('krpano_vtour');
        if (!kr) return [];
        const lang = kr.get('language') || 'en';
        const out = [];
        const arr = kr.get('hotspot');
        if (!arr || typeof arr.getArray !== 'function') return [];
        for (const h of arr.getArray()) {
          const lang_h = kr.get(`lang[${lang}].hotspot[${h.name}]`) || {};
          out.push({
            name: h.name,
            type: h.type || null,
            linkedscene: h.linkedscene || null,
            title: lang_h.title || h.title || null,
            description: lang_h.description || null,
          });
        }
        return out;
      }, sc.name);
      hotspotsBySceneName.set(sc.name, hs);
    } catch (e) { /* keep going */ }
  }
  // Glue captured hotspots back into the scene records.
  for (const sc of scenes.scenes) {
    sc.hotspots = hotspotsBySceneName.get(sc.name) || [];
  }
  // Final settle.
  await sleep(1_000);

  // ---- Resolve thumbnail per scene ----------------------------------------
  // krpano scenes typically reference thumbs via:
  //   - sc.thumburl  (e.g. "panos/<id>.tiles/thumb.jpg")
  //   - sc.previewurl ("panos/<id>.tiles/preview.jpg")
  // We've also captured every image response in imageBuffers, so we can match
  // a scene to a preview image by its URL substring.
  function findImageBufferFor(scene) {
    const candidates = [];
    if (scene.thumburl)   candidates.push(scene.thumburl);
    if (scene.previewurl) candidates.push(scene.previewurl);
    // Also try url patterns based on scene name.
    candidates.push(`panos/${scene.name}.tiles/thumb.jpg`);
    candidates.push(`panos/${scene.name}.tiles/preview.jpg`);
    candidates.push(`panos/${scene.name}/thumb.jpg`);
    for (const c of candidates) {
      // Match any logged URL that ends with this candidate path.
      for (const [u, b] of imageBuffers) {
        if (u.includes(c)) return { url: u, buf: b };
      }
    }
    // Last-resort: any image whose URL contains the scene name.
    for (const [u, b] of imageBuffers) {
      if (u.includes(scene.name)) return { url: u, buf: b };
    }
    return null;
  }

  // ---- Write thumbnails + venue JSONs -------------------------------------
  const dumped = [];
  const newVenues = [];
  const skippedExisting = [];
  const noCode = [];
  let imageBytesTotal = 0;

  // Resize+recompress helper. ~400 wide JPEG @ Q60 → almost always < 80 KB.
  async function shrinkInPlace(p) {
    try {
      execFileSync('sips', [
        '-Z', '400',
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', '60',
        p, '--out', p,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (_) { /* leave file as-is if sips missing */ }
    try {
      const stat = await fs.stat(p);
      return stat.size;
    } catch (_) { return null; }
  }

  for (const sc of scenes.scenes) {
    // Code from the title regex (none in this tour today, but if SUTD
    // re-titles a scene to "Cohort Room 1.502" or similar we'll catch it).
    const codeFromTitleHit = codeFromTitle(sc.title || sc.name || '');
    // Curated mapping for the well-known thematic scenes.
    const curatedCode = SCENE_TO_KNOWN_CODE[sc.name] || null;
    const friendly = cleanName(sc.title || '');

    // ------- Image: always write <scene_name>.jpg -------------------------
    const sceneOutImg = path.join(SCENES_OUT_DIR, `${sc.name}.jpg`);
    const hit = findImageBufferFor(sc);
    let sceneSize = null;
    let codeSize  = null;
    if (hit) {
      try {
        await fs.writeFile(sceneOutImg, hit.buf);
        sceneSize = await shrinkInPlace(sceneOutImg);
        if (sceneSize) imageBytesTotal += sceneSize;

        // Mirror the same image at <code>.jpg if a curated mapping exists,
        // so the existing venue catalog gets a real thumbnail too.
        if (curatedCode) {
          const codeOutImg = path.join(SCENES_OUT_DIR, `${safeFilenameForCode(curatedCode)}.jpg`);
          await fs.copyFile(sceneOutImg, codeOutImg);
          codeSize = await shrinkInPlace(codeOutImg);
        }
      } catch (e) {
        console.warn(`[!] image save failed for ${sc.name}: ${e.message}`);
      }
    }

    dumped.push({
      sceneName: sc.name,
      title: sc.title,
      friendly,
      code: codeFromTitleHit || curatedCode || null,
      curatedFromName: !!curatedCode,
      type: (codeFromTitleHit || curatedCode) ? venueTypeFromTitle(sc.title || '') : null,
      thumbsource: hit?.url || null,
      thumbpath: hit ? sceneOutImg : null,
      thumbbytes: sceneSize,
      mirrorCodeThumb: curatedCode
        ? path.join(SCENES_OUT_DIR, `${safeFilenameForCode(curatedCode)}.jpg`)
        : null,
      hotspots: sc.hotspots,
    });

    // ------- Venue JSON: only when the title regex finds a code -----------
    // The curated mapping only attaches images to existing rooms - it never
    // creates new venue records, because mapping a thematic scene to a
    // single room would be a guess.
    if (!codeFromTitleHit) {
      noCode.push({ name: sc.name, title: sc.title });
      continue;
    }
    if (EXISTING_CODES.has(codeFromTitleHit)) {
      skippedExisting.push(codeFromTitleHit);
      continue;
    }

    const venue = {
      code: codeFromTitleHit,
      name: friendly || codeFromTitleHit,
      building: buildingFromCode(codeFromTitleHit),
      floor: floorFromCode(codeFromTitleHit),
      type: venueTypeFromTitle(sc.title || ''),
    };
    const venuePath = path.join(VENUES_DIR, `${safeFilenameForCode(codeFromTitleHit)}.json`);
    let already = false;
    try { await fs.access(venuePath); already = true; } catch (_) { /* fresh */ }
    if (already) {
      skippedExisting.push(codeFromTitleHit);
    } else {
      await fs.writeFile(venuePath, JSON.stringify(venue, null, 2) + '\n');
      newVenues.push(venue);
    }
  }

  // ---- Save raw + summary --------------------------------------------------
  await fs.writeFile(
    path.join(RAW_OUT_DIR, 'virtualtour_scrape.json'),
    JSON.stringify({ scenes: dumped, groups: scenes.groups }, null, 2),
  );
  await fs.writeFile(
    path.join(RAW_OUT_DIR, 'virtualtour_network.json'),
    JSON.stringify(networkLog, null, 2),
  );

  const codes = dumped.map((d) => d.code).filter(Boolean).sort();
  const curatedHits = dumped.filter((d) => d.curatedFromName);
  const thumbsSaved = dumped.filter((d) => d.thumbpath);

  const md = [];
  md.push('# SUTD Virtual Tour - scene inventory');
  md.push('');
  md.push(`Source: ${TOUR_URL}`);
  md.push('Engine: **krpano 1.21** (build 2023-04-30). Embedded as ');
  md.push('`embedpano({ id: "krpano_vtour", xml: "tour.xml" })` from `main.js`. ');
  md.push('`tour.xml` ships obfuscated inside `<encrypted>…</encrypted>` but krpano decrypts ');
  md.push('it client-side, so the scenes are queryable on the live page via the krpano JS API.');
  md.push('');
  md.push(`Run: ${new Date().toISOString()}`);
  md.push('');
  md.push(`- Scenes discovered: **${dumped.length}**`);
  md.push(`- Scene groups: **${scenes.groups.length}**`);
  md.push(`- Thumbnails saved (per scene id): **${thumbsSaved.length}** (~${(imageBytesTotal/1024).toFixed(1)} KB total)`);
  md.push(`- Curated scene → known room-code mirrors: **${curatedHits.length}**`);
  md.push(`- New venue JSONs written from title-regex codes: **${newVenues.length}**`);
  md.push(`- Already-on-disk codes skipped: **${skippedExisting.length}**`);
  const totalHotspots = dumped.reduce((n, d) => n + (d.hotspots?.length || 0), 0);
  md.push(`- Hotspots captured (across all scenes): **${totalHotspots}**`);
  md.push('');
  md.push('## Caveat');
  md.push('');
  md.push('The tour titles its panoramas thematically ("Auditorium", "Cohort Classroom", ');
  md.push('"Architecture Studio") rather than by SUTD room number. There is **no embedded ');
  md.push('room code** in any scene title, description, or hotspot text on the live tour. ');
  md.push('That means a 1:1 scene→room mapping has to be curated by hand. The current ');
  md.push('curated map only contains rooms we can confirm against the existing catalog ');
  md.push('(`2.101` Auditorium); other panoramas (Cohort Classroom, Architecture Studio, ');
  md.push('the various Fab Lab levels, the hostel rooms) are deliberately left without a ');
  md.push('venue-code link rather than guessed at.');
  md.push('');
  md.push('## Scene → thumbnail map');
  md.push('');
  md.push('| Scene id | Title | Curated code | Saved thumbnail |');
  md.push('|---|---|---|---|');
  for (const d of dumped) {
    md.push(
      `| \`${d.sceneName}\` | ${(d.title || '').replace(/\|/g, '\\|')} | ${d.code || ''} | ${d.thumbpath ? path.relative(REPO_ROOT, d.thumbpath) : ''} |`,
    );
  }
  md.push('');
  md.push('## Scene groups (campus zones)');
  md.push('');
  for (const g of scenes.groups) {
    md.push(`- **${g.title || g.name}** (${g.scenes.length} scenes): ${g.scenes.join(', ')}`);
  }
  md.push('');
  md.push('## Curated scene → room-code overrides');
  md.push('');
  if (curatedHits.length === 0) {
    md.push('- (none yet - extend `SCENE_TO_KNOWN_CODE` in `tools/scraper/explore-virtualtour.mjs`)');
  } else {
    for (const d of curatedHits) {
      md.push(`- \`${d.sceneName}\` (${d.title}) → **${d.code}** - image mirrored to \`${path.relative(REPO_ROOT, d.mirrorCodeThumb)}\``);
    }
  }
  md.push('');
  md.push('## How this was extracted');
  md.push('');
  md.push('- Visited `https://virtualtour.sutd.edu.sg/` headless via Playwright + Chromium.');
  md.push('- Waited for `document.getElementById("krpano_vtour").get("xml.scene")` to be truthy.');
  md.push('- Pulled the scene array with `krpano.get("scene").getArray()` and per-scene labels via `krpano.get("lang[en].scene[<name>]")`.');
  md.push('- For each scene, ran `loadscene(<name>, null, KEEPVIEW, BLEND(0))` to force krpano to fetch the preview tile, then captured the bytes from `page.on("response")` (URLs of the form `panos/<id>.tiles/preview.jpg`). Saved to `frontend/public/maps/scenes/<scene_name>.jpg` and downsampled with `sips -Z 400 -s formatOptions 60`.');
  md.push('- Curated map mirrors the same image to `<code>.jpg` for known rooms.');
  md.push('- Re-run with: `node tools/scraper/explore-virtualtour.mjs`.');
  md.push('');
  md.push('## What\'s next');
  md.push('');
  md.push('- **Curate more mappings.** Each cohort classroom / studio panorama corresponds to specific room numbers visible on SUTD floor plans - extend `SCENE_TO_KNOWN_CODE` once those identities are confirmed.');
  md.push('- **Pull bigger panoramas.** The script saves the *preview* tile (~400 px). For full 360 panoramas we\'d need to download all `mres_<L>_<X>_<Y>.jpg` tiles per scene and stitch - only worth it if the frontend ever renders an embedded krpano view.');
  md.push('- **Floor plan / map tie-in.** The tour\'s `scene_group` ("Library", "Fab Lab", "FCP", "Hostel", "Sports", "Aerial") could feed a building/zone breadcrumb in the venue UI even when individual codes are unknown.');
  md.push('- **Hotspot graph.** The current run captures hotspot `linkedscene` references (the navigation arrows between scenes) but ignores their geometry. A future tweak could lift `linkedscene` + `lang[en].hotspot[<name>].weblink/youtube` into a scene-graph JSON, which would let the venue UI offer "you can see this room from there" hints.');

  await fs.writeFile(path.join(META_DIR, 'virtualtour_scenes.md'), md.join('\n'));

  console.log('[+] DONE.');
  console.log(`    scenes:        ${dumped.length}`);
  console.log(`    with code:     ${codes.length}`);
  console.log(`    new venues:    ${newVenues.length}`);
  console.log(`    skipped:       ${skippedExisting.length}`);
  console.log(`    images saved:  ${dumped.filter(d => d.thumbpath).length} (${imageBytesTotal} bytes total)`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
