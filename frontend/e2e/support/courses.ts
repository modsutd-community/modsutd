import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shipped data carries no schedules until students crowdsource them, so tests
// that need occupancy inject one at the network layer rather than committing
// fake data.
//
// Read from disk, not with route.fetch(): re-requesting the file from the
// server inside a route handler adds a round-trip that can and did fail
// ("route.fetch: read ECONNRESET") while the rest of the suite hammered the
// same server. The bundle on disk is what that request would have returned.
// import.meta.url, not __dirname: this suite loads as an ES module.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILT = path.resolve(HERE, '..', '..', 'public', 'data', 'courses.json');

export interface Mod { code: string; schedules: unknown[] }

/** The real catalogue, with `schedules` replaced for the codes given. */
export function coursesWithSchedules(codes: string[], schedules: unknown[]): Mod[] {
  const mods = JSON.parse(readFileSync(BUILT, 'utf8')) as Mod[];
  for (const m of mods) if (codes.includes(m.code)) m.schedules = schedules;
  return mods;
}
