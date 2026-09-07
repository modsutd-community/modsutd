import type { Mod, Venue, VenueAvailability, VenueTimeSlot } from '@/types';
import { recordServerDate } from './serverTime';

export interface DataManifest {
  scrapedAt: string;
  coursesUpdatedAt: string | null;
  venuesUpdatedAt: string | null;
  counts: { courses: number; venues: number };
}

// Cache strategy: `default` respects the server's Cache-Control. In dev,
// Vite sends no cache headers, so edited JSON is re-fetched immediately;
// in prod, Vercel long-caches public/ assets and the build hash busts the
// SPA cache. `force-cache` would return stale JSON in dev - don't.
async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'default' });
  // Every response already carries the server's clock; the .ics exporter needs
  // one it can trust, and this costs nothing extra to learn.
  recordServerDate(res.headers.get('date'));
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const loadCourses  = () => fetchJSON<Mod[]>('/data/courses.json');
export const loadVenues   = () => fetchJSON<Venue[]>('/data/venues.json');
export const loadManifest = () => fetchJSON<DataManifest>('/data/manifest.json');

// Roll up every mod's schedules into per-venue availability maps so the
// venue page can render heatmaps without scanning courses each render.
export function buildAvailability(courses: Mod[]): Record<string, VenueAvailability> {
  const map: Record<string, VenueAvailability> = {};
  for (const c of courses) {
    for (const s of c.schedules) {
      const code = s.location?.trim();
      if (!code) continue;
      const slot: VenueTimeSlot = {
        day: s.day,
        startTime: s.startTime,
        endTime: s.endTime,
        modCode: c.code,
        modName: c.name,
        type: s.type,
      };
      const entry = (map[code] ??= { venueCode: code, schedule: [] });
      entry.schedule.push(slot);
    }
  }
  return map;
}
