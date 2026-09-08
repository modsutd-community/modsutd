import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The room map is drawn here, not embedded: an iframe hands over control
// placement and attribution wording with the picture, and OpenLevelUp also
// queries Overpass live, so the plan is blank whenever Overpass is
// unavailable. So the survey ships as a file.

// The room detail opens from the room finder, not from a URL of its own.
async function openRoom(page: import('@playwright/test').Page, code: string) {
  await page.goto('/venues');
  const cell = page.locator(`button[data-code="${code}"]`);
  await cell.scrollIntoViewIfNeeded();
  await cell.click();
  await expect(page.locator('[data-act="campus-map"]')).toHaveCount(1);
  await expect(page.locator('[data-act="campus-map"] .leaflet-container')).toBeVisible();
}

interface ShippedVenue {
  code: string; building: string; floor?: number;
  osmKeys?: string[]; landmarks?: string[]; liftLobby?: string;
}

// The shipped bundle, which is what the browser will read. Built by
// `npm run build` before this suite starts.
const VENUES: ShippedVenue[] = JSON.parse(
  readFileSync(join(process.cwd(), 'public', 'data', 'venues.json'), 'utf8'),
) as ShippedVenue[];

// One surveyed room from every building and every floor that has one - 25 of
// them. Deterministic, not random: a sample that differs per run turns a real
// break into a report nobody can reproduce. The middle of the sorted list, so
// it is not always the same corner of the floor.
const SWEEP = (() => {
  const groups = new Map<string, ShippedVenue[]>();
  for (const v of VENUES) {
    if (!v.osmKeys?.length || v.floor === undefined) continue;
    const key = `${v.building}|${v.floor}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return [...groups.values()]
    .map((g) => g.sort((a, b) => a.code.localeCompare(b.code))[Math.floor(g.length / 2)])
    .sort((a, b) => a.code.localeCompare(b.code));
})();

test.describe('venue map', () => {
  test('draws a map with the controls where they belong', async ({ page }) => {
    await openRoom(page, '1.315');
    const map = page.locator('[data-act="campus-map"]');

    // Nothing is embedded, so nothing else owns the chrome.
    await expect(map.locator('iframe')).toHaveCount(0);
    // Zoom top-left, full screen bottom-left.
    await expect(map.locator('.leaflet-top.leaflet-left .leaflet-control-zoom')).toBeVisible();
    await expect(map.locator('[data-act="map-fullscreen"]')).toBeVisible();
  });

  // OpenStreetMap's credit is required - the data is ODbL, and here it is our
  // own survey given back. Leaflet's is not, and we do not owe it one.
  test('credits OpenStreetMap, briefly, and not Leaflet', async ({ page }) => {
    await openRoom(page, '1.315');
    const credit = page.locator('.leaflet-control-attribution');
    await expect(credit).toContainText('OpenStreetMap');
    await expect(credit).not.toContainText(/Leaflet/i);
    await expect(credit).not.toContainText(/report a problem/i);
    // Short: a line, not a paragraph.
    expect(((await credit.textContent()) ?? '').trim().length).toBeLessThan(40);
  });

  // The map opens on the building in its surroundings, which is what answers
  // "where on campus". One press of + crosses into the plan - no arrow,
  // because getting closer is already the gesture for looking inside.
  test('opens outdoors, and one zoom in goes inside', async ({ page }) => {
    await openRoom(page, '1.315');
    const map = page.locator('[data-act="campus-map"]');

    await expect(map.locator('path.leaflet-interactive')).toHaveCount(1); // the pin
    await expect(map.locator('[data-act="map-level"]')).toHaveCount(0);
    // Its own line, under the place - the place is what the caption is for.
    const hint = map.locator('[data-act="map-zoom-hint"]');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveCSS('display', 'block');

    // Leaflet drops a zoom click while it is still animating the last one, so
    // a second click sent too early is simply lost.
    await map.locator('.leaflet-control-zoom-in').click();
    await expect(map.locator('.leaflet-zoom-anim')).toHaveCount(0);

    await expect.poll(() => map.locator('path.leaflet-interactive').count()).toBeGreaterThan(4);
    await expect(map.locator('[data-act="map-level"]')).toBeVisible();
    await expect(map.locator('[data-act="map-zoom-hint"]')).toHaveCount(0);
  });

  // A venue the survey never reached has no plan to zoom into. Fading the
  // tiles and showing an empty grey field would be worse than staying out.
  test('a venue with no surveyed shape never goes indoors', async ({ page }) => {
    await openRoom(page, 'Antique House');
    const map = page.locator('[data-act="campus-map"]');
    await expect(map.locator('[data-act="map-nodata"]')).toBeVisible();
    await expect(map.locator('[data-act="map-zoom-hint"]')).toHaveCount(0);

    for (let i = 0; i < 3; i += 1) {
      await map.locator('.leaflet-control-zoom-in').click();
      await expect(map.locator('.leaflet-zoom-anim')).toHaveCount(0);
    }
    await expect(map.locator('[data-act="map-level"]')).toHaveCount(0);
    await expect(map.locator('path.leaflet-interactive')).toHaveCount(1);
  });

  test('the floor readout names the floor the way the door plates do', async ({ page }) => {
    await openRoom(page, '1.315');
    await page.locator('.leaflet-control-zoom-in').click();
    // 1.315 is on plate level 3, which OSM stores as 2.
    await expect(page.locator('[data-act="map-level"]')).toHaveText('L3');
  });

  // A floor plan whose names only appear on hover has no names at all on a
  // phone, and reads as a blank diagram on a desktop until you go looking. But
  // at the zoom where the plan first appears a think tank is barely wider than
  // its own name, so the neighbours wait until the words fit.
  test('names the room first, then its neighbours once they fit', async ({ page }) => {
    await openRoom(page, '1.508');
    const map = page.locator('[data-act="campus-map"]');
    const labels = map.locator('.wb-room-label');

    await map.locator('.leaflet-control-zoom-in').click();
    await expect(map.locator('.leaflet-zoom-anim')).toHaveCount(0);
    // The donor in brackets is three times the width of the thing it names, so
    // the plan carries "Think Tank 13", not the venue's full title.
    await expect(map.locator('.wb-room-mine')).toHaveText('Think Tank 13 (Yangzheng…)');
    // Counted, not fixed at one: a hover tooltip carries the same class, and
    // the pointer is left on the map by the zoom click.
    const near = await labels.count();

    await map.locator('.leaflet-control-zoom-in').click();
    await expect(map.locator('.leaflet-zoom-anim')).toHaveCount(0);
    await expect.poll(() => labels.count()).toBeGreaterThan(near + 1);
  });

  // The plan is fetched, the map is not, so on a slow connection the data
  // arrives after the map has already decided it is zoomed in. It still has to
  // draw. It did not, until the arrival was made to re-trigger the draw, and
  // the symptom was indistinguishable from flake: present when the fetch won
  // the race, missing when it lost.
  test('draws the plan even when the floor data arrives late', async ({ page }) => {
    await page.route('**/data/indoor.geojson', async (r) => {
      await new Promise((done) => setTimeout(done, 2500));
      await r.continue();
    });
    await openRoom(page, '1.315');
    await page.locator('.leaflet-control-zoom-in').click();
    await expect.poll(
      () => page.locator('[data-act="campus-map"] path.leaflet-interactive').count(),
      { timeout: 15_000 },
    ).toBeGreaterThan(4);
    await expect(page.locator('[data-act="map-level"]')).toBeVisible();
  });

  // "Building 1, Level 5" then "Lift Lobby A" is how directions are given
  // here, and both chips are derived in sync-data.mjs for every venue.
  test('says which lift lobby to use', async ({ page }) => {
    await openRoom(page, '1.508');
    const chips = page.locator('[data-act="landmarks"] > *');
    await expect(chips.first()).toHaveText('Building 1, Level 5');
    // Which lobby is nearest depends on what is uploaded, so this pins the
    // shape of the answer rather than a letter that a survey edit can move.
    await expect(chips.nth(1)).toHaveText(/^Lift Lobby [A-Z]$/);
  });

  // indoor.geojson has no building on it - OSM tags the room, not the block -
  // so filtering on level alone drew every room on that storey across campus.
  // Buildings 1, 2 and 3 are about 60 m apart and share every storey number,
  // so a building 3 room came up showing building 2's rooms and building 1's
  // lifts, with its own three shapes lost among them.
  test('draws this building floor, not every building on that level', async ({ page }) => {
    await openRoom(page, '3.201');
    const map = page.locator('[data-act="campus-map"]');
    await map.locator('.leaflet-control-zoom-in').click();
    await expect(map.locator('.leaflet-zoom-anim')).toHaveCount(0);

    // Building 3 level 1 is five surveyed shapes. The same level campus-wide is
    // about fifty, so a count anywhere near that is the old bug back.
    await expect.poll(
      () => map.locator('path.leaflet-interactive').count(),
      { timeout: 15_000 },
    ).toBeGreaterThan(0);
    expect(await map.locator('path.leaflet-interactive').count()).toBeLessThan(15);

    // Every lift drawn has to be one of this building's. J serves building 3;
    // A, C, E and F are buildings 1 and 2.
    // Polled, not read once: a lift is a divIcon marker, not a path, so the
    // count of paths above says nothing about whether the markers have landed.
    await expect.poll(() => map.locator('.wb-lift').count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    for (const l of await map.locator('.wb-lift').allInnerTexts()) {
      expect(l).toContain('J');
    }
  });

  // The sweep. Fixing the building filter broke the floor, because the panel
  // never remounts between rooms and the floor was still the previous one's.
  // Both are the same fact - which shapes belong to this room - so they are
  // checked together, on every building and every floor rather than on the one
  // room whose bug was reported.
  test('every building and floor draws its own plan on its own storey', async ({ page }) => {
    test.slow();
    expect(SWEEP.length).toBeGreaterThan(20);
    // One page load for all 25. A goto per room spends the whole budget on
    // boot; going back to the grid keeps the app warm.
    await page.goto('/venues');
    const map = page.locator('[data-act="campus-map"]');

    for (const v of SWEEP) {
      const cell = page.locator(`button[data-code="${v.code}"]`);
      await cell.scrollIntoViewIfNeeded();
      await cell.click();
      await expect(map.locator('.leaflet-container')).toBeVisible();

      // The place chip is derived, so it is the same fact the map is drawing.
      const chips = await page.locator('[data-act="landmarks"] > *').allInnerTexts();
      expect(chips[0], v.code).toBe(`Building ${v.building}, Level ${v.floor}`);
      if (v.liftLobby) expect(chips[1], v.code).toBe(v.liftLobby);

      await map.locator('.leaflet-control-zoom-in').click();
      await expect(map.locator('.leaflet-zoom-anim')).toHaveCount(0);

      // The floor readout reads the way the door plates do. L0 here meant the
      // basement, left over from whichever room was opened first.
      await expect(map.locator('[data-act="map-level"]'), v.code)
        .toHaveText(`L${v.floor}`);

      // And it drew something. A surveyed room with no shapes on screen is the
      // building filter and the floor disagreeing again.
      await expect
        .poll(() => map.locator('path.leaflet-interactive').count(), { timeout: 15_000 })
        .toBeGreaterThan(0);

      // One building's floor, never the campus's. Any level campus-wide is
      // 38-52 shapes; the biggest single floor here is well under 30.
      expect(await map.locator('path.leaflet-interactive').count(), v.code)
        .toBeLessThan(32);

      // Back to the grid: the detail replaces it, so the next room is only
      // reachable from here.
      await page.locator('[data-act="rooms-back"]').click();
      await expect(map).toHaveCount(0);
    }
  });

  // A room the survey never reached still knows its storey from its plate, and
  // has to say so. Without that the floor was guessed from the lowest shape
  // near the pin, which on this campus is a basement lift shaft: 3.303 opened
  // on "L0", two floors below the door it is behind.
  test('an unsurveyed room still names its own floor and lobby', async ({ page }) => {
    const unsurveyed = VENUES.filter((v) => !v.osmKeys?.length && v.floor !== undefined);
    expect(unsurveyed.length).toBeGreaterThan(5);

    await openRoom(page, '3.303');
    const chips = await page.locator('[data-act="landmarks"] > *').allInnerTexts();
    expect(chips).toEqual(['Building 3, Level 3', 'Lift Lobby J']);

    // No shape of its own, so it must not pretend to have a plan.
    await page.locator('[data-act="campus-map"] .leaflet-control-zoom-in').click();
    await expect(page.locator('[data-act="map-level"]')).toHaveCount(0);
  });

  // "zoom in to see indoors" is in the caption and goes the moment you do, so
  // without a reserved height everything under the map slid up as you zoomed.
  test('nothing below the map moves when the zoom hint goes', async ({ page }) => {
    await openRoom(page, '1.508');
    const map = page.locator('[data-act="campus-map"]');
    const heat = page.locator('[data-act="room-heatmap"]');

    await expect(map.locator('[data-act="map-zoom-hint"]')).toBeVisible();
    // Measured from the map, not the viewport: clicking the zoom control
    // scrolls the panel, and that is not the movement under test.
    const gap = async () => {
      const m = (await map.boundingBox())!;
      const h = (await heat.boundingBox())!;
      return h.y - m.y;
    };
    const before = await gap();

    await map.locator('.leaflet-control-zoom-in').click();
    await expect(map.locator('[data-act="map-zoom-hint"]')).toHaveCount(0);
    await expect(map.locator('[data-act="map-level"]')).toBeVisible();

    // Sub-pixel rounding is fine; a line of text appearing or leaving is not.
    expect(Math.abs((await gap()) - before)).toBeLessThan(1.5);
  });

  // A plan with no lifts on it cannot answer "how do I get to this floor".
  test('marks the lift lobbies on the plan', async ({ page }) => {
    await openRoom(page, '1.508');
    const map = page.locator('[data-act="campus-map"]');
    await map.locator('.leaflet-control-zoom-in').click();
    await expect(map.locator('.leaflet-zoom-anim')).toHaveCount(0);
    // Several lobbies serve one floor, and their order in the DOM is the order
    // they were surveyed - so check that the one this room uses is among them,
    // not that it happens to be first.
    await expect(map.locator('.wb-lift').first()).toBeVisible();
    // A lobby can be more than one shaft, so this asks whether the lobby this
    // room uses is drawn at all, not how many doors it has.
    await expect.poll(() => map.locator('.wb-lift', { hasText: 'A' }).count()).toBeGreaterThan(0);
  });

  // A lift is a shaft, so it is in the same place on every floor it serves. The
  // survey walked floors unevenly - Lift Lobby A was recorded on plates 2, 5, 6
  // and 7 and nowhere else - so filtering lifts by level drew building 1 level
  // 4 with one of its two lobbies simply absent.
  test('draws every lobby in the building, not only the ones surveyed on this floor', async ({ page }) => {
    await openRoom(page, '1.407');
    const map = page.locator('[data-act="campus-map"]');
    await map.locator('.leaflet-control-zoom-in').click();
    await expect(map.locator('[data-act="map-level"]')).toHaveText('L4');

    // Both of building 1's lobbies, and nothing else. An unnamed elevator node
    // stays in the data and off the plan: a bare arrow is a mark you cannot
    // act on. Polled because a marker is not a path, so nothing above waits
    // for it.
    const letters = () => map.locator('.wb-lift').allInnerTexts()
      .then((t) => t.map((x) => x.replace(/[^A-Z]/g, '')).sort());
    await expect.poll(letters, { timeout: 15_000 }).toEqual(['A', 'C']);
  });

  // The donor is part of what a room is called, so it stays - but only the
  // first word of it, or it prints across three neighbours.
  test('keeps the donor name, shortened', async ({ page }) => {
    await openRoom(page, '1.508');
    await page.locator('.leaflet-control-zoom-in').click();
    await expect(page.locator('[data-act="campus-map"] .wb-room-mine'))
      .toHaveText('Think Tank 13 (Yangzheng…)');
  });

  // One room per test. Opening a second one means navigating back to a grid
  // that is still settling, and on a phone the cell never passes Playwright's
  // stability check.
  test('a mapped room offers the indoor map', async ({ page }) => {
    await openRoom(page, '1.315');
    await expect(page.locator('[data-act="map-cta"]')).toHaveAttribute('href', /app\.mappedin\.com/);
  });

  test('an unmapped room offers Google Maps at its coordinates', async ({ page }) => {
    // 1.313 is one the survey rescued: no indoor label, but a surveyed
    // coordinate, so it points at itself rather than at its building.
    await openRoom(page, '1.313');
    await expect(page.locator('[data-act="map-cta"]')).toHaveAttribute(
      'href', /google\.com\/maps\/search\/\?api=1&query=1\.3\d+,103\.9\d+/,
    );
  });
});
