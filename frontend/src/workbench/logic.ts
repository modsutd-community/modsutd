import { useEffect, useMemo, useState } from 'react';
import { useAppSelector } from '@/store';
import { searchMods } from '@/utils/search';
import type { Mod, TimetableEvent } from '@/types';
import { PILLAR_ORDER, modPillars } from './pillars';
import { useWorkbenchUi } from './uiContext';

// ---- catalogue filtering --------------------------------------------------

export function useFilteredMods(): Mod[] {
  const mods = useAppSelector((s) => s.mods.data);
  const { filter, pillar, term, sortKey, sortDir } = useWorkbenchUi();

  return useMemo(() => {
    let list = Object.values(mods);
    if (pillar !== 'ALL') list = list.filter((m) => modPillars(m).includes(pillar));
    if (term !== 'ALL') list = list.filter((m) => m.term === term);
    if (filter.trim()) list = searchMods(filter, list);
    return [...list].sort((a, b) => {
      let x: string | number;
      let y: string | number;
      switch (sortKey) {
        case 'pillar':
          x = PILLAR_ORDER.indexOf(a.pillar);
          y = PILLAR_ORDER.indexOf(b.pillar);
          break;
        case 'term':
          x = Number(a.term);
          y = Number(b.term);
          break;
        case 'credits':
          x = a.credits;
          y = b.credits;
          break;
        default:
          x = a[sortKey];
          y = b[sortKey];
      }
      if (x < y) return -sortDir;
      if (x > y) return sortDir;
      return 0;
    });
  }, [mods, filter, pillar, term, sortKey, sortDir]);
}

// ---- timetable conflicts --------------------------------------------------

export interface ConflictPair {
  a: TimetableEvent;
  b: TimetableEvent;
}

export function detectConflicts(events: TimetableEvent[]): ConflictPair[] {
  const out: ConflictPair[] = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i], b = events[j];
      if (a.day !== b.day) continue;
      if (a.startTime < b.endTime && b.startTime < a.endTime) out.push({ a, b });
    }
  }
  return out;
}

// ---- room-finder time input -----------------------------------------------

// "9:30" → "09:30"; null when it isn't a valid 24h time.
export function normaliseHHMM(raw: string): string | null {
  const m = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(raw);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

// ---- "right now" from the parsed timetable ----------------------------------

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

export interface NowInfo {
  clock: string; // "WED 14:32"
  current?: TimetableEvent;
  next?: TimetableEvent;
  // Fill fraction (0–1) for the header chip, snapped to 30-minute steps:
  // during a class, progress start→end; before one, progress from the
  // previous class's end (or 08:00) toward its start.
  fill: number;
}

// A weekday match is not enough: SAMS gives the exact dates a class meets, so
// recess week, public holidays and make-up sessions are all knowable. Without
// this the chip announces a class during recess.
export function meetsOn(e: TimetableEvent, iso: string): boolean {
  if (e.occurrences?.length) return e.occurrences.includes(iso);
  if (e.startDate && e.endDate) return e.startDate <= iso && iso <= e.endDate;
  return true;
}

export function useNowInfo(events: TimetableEvent[]): NowInfo {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  return useMemo(() => {
    const day = DAY_NAMES[now.getDay()];
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const clock = `${day.slice(0, 3).toUpperCase()} ${hhmm}`;
    const z = (n: number) => String(n).padStart(2, '0');
    const iso = `${now.getFullYear()}-${z(now.getMonth() + 1)}-${z(now.getDate())}`;
    const today = events
      .filter((e) => e.day === day && meetsOn(e, iso))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    const current = today.find((e) => e.startTime <= hhmm && hhmm < e.endTime);
    const next = today.find((e) => e.startTime > hhmm);

    const snapped = (from: number, to: number) => {
      if (to <= from) return 0;
      const elapsed = Math.floor(Math.max(0, nowMin - from) / 30) * 30;
      return Math.min(1, elapsed / (to - from));
    };
    let fill = 0;
    if (current) {
      fill = snapped(toMinutes(current.startTime), toMinutes(current.endTime));
    } else if (next) {
      const prev = [...today].reverse().find((e) => e.endTime <= hhmm);
      const anchor = prev ? toMinutes(prev.endTime) : 8 * 60;
      fill = snapped(Math.min(anchor, toMinutes(next.startTime)), toMinutes(next.startTime));
    }
    return { clock, current, next, fill };
  }, [events, now]);
}

// ---- specialisation tracks ----------------------------------------------

export interface TrackRequirement {
  count: number;
  anyOf: string[];
  label?: string;
}

export interface SpecTrack {
  id: string;
  name: string;
  // Degree pillars barred from this track (minors: the offering pillar).
  notFor?: string[];
  pillar: string;
  url?: string;
  requirements: TrackRequirement[];
  notes?: string;
}

let specCache: SpecTrack[] | null | undefined;

export function useSpecializations(): SpecTrack[] {
  const [tracks, setTracks] = useState<SpecTrack[]>(Array.isArray(specCache) ? specCache : []);
  useEffect(() => {
    if (specCache !== undefined) return;
    specCache = null; // in flight
    fetch('/data/specializations.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        specCache = Array.isArray(j?.tracks) ? j.tracks : [];
        setTracks(specCache!);
      })
      .catch(() => {
        specCache = [];
      });
  }, []);
  return tracks;
}

export type TrackStatus = 'achieved' | 'planned' | 'no';

// Tracks with no machine-checkable requirements never badge - they stay data.
export function trackSatisfied(track: SpecTrack, set: Set<string>): boolean {
  if (!track.requirements.length) return false;
  return track.requirements.every((r) => r.anyOf.filter((c) => set.has(c)).length >= r.count);
}

// The earliest term whose cumulative plan (everything placed at or before
// it) completes the track - null when even the full plan falls short.
export function earliestAchieved(track: SpecTrack, cumulativeByLevel: Array<Set<string>>): number | null {
  for (let l = 0; l < cumulativeByLevel.length; l++) {
    if (trackSatisfied(track, cumulativeByLevel[l])) return l + 1;
  }
  return null;
}

let minorsCache: SpecTrack[] | null | undefined;

export function useMinors(): SpecTrack[] {
  const [minors, setMinors] = useState<SpecTrack[]>(Array.isArray(minorsCache) ? minorsCache : []);
  useEffect(() => {
    if (minorsCache !== undefined) return;
    minorsCache = null; // in flight
    fetch('/data/minors.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        minorsCache = Array.isArray(j?.minors) ? j.minors : [];
        setMinors(minorsCache!);
      })
      .catch(() => {
        minorsCache = [];
      });
  }, []);
  return minors;
}

// ---- freshmore fixed core ---------------------------------------------------

export interface FreshmoreTerm {
  fixed: string[];
  choice?: { label: string; count?: number; anyOf: string[] };
}

export type FreshmoreCore = Record<string, FreshmoreTerm>;
type FreshmoreCurricula = Record<string, { terms: FreshmoreCore }>;

let freshmoreCache: FreshmoreCurricula | null | undefined;
const freshmoreListeners = new Set<() => void>();

// The fixed core is pinned automatically and satisfies prerequisites
// without being hand-added. Two curricula ship side by side; the toggle
// switches which core is pinned without touching user data.
export function useFreshmore(mode: 'classic' | 'ay2026' = 'classic'): FreshmoreCore {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    freshmoreListeners.add(l);
    if (freshmoreCache === undefined) {
      freshmoreCache = null; // in flight
      fetch('/data/freshmore.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          freshmoreCache = j?.curricula && typeof j.curricula === 'object' ? j.curricula : {};
          freshmoreListeners.forEach((f) => f());
        })
        .catch(() => {
          freshmoreCache = {};
          freshmoreListeners.forEach((f) => f());
        });
    }
    return () => {
      freshmoreListeners.delete(l);
    };
  }, []);
  return freshmoreCache?.[mode]?.terms ?? {};
}

export function freshmoreFixedSet(core: FreshmoreCore): Map<string, number> {
  const out = new Map<string, number>();
  for (const [term, t] of Object.entries(core)) {
    for (const code of t.fixed ?? []) out.set(code, Number(term));
  }
  return out;
}

// ---- skill-tree placement ---------------------------------------------------

// Catalogue term, clamped to the 8-term undergraduate span.
export function defaultLevel(mod: Mod | undefined): number {
  const t = Number(mod?.term ?? 1);
  return Math.min(8, Math.max(1, Number.isFinite(t) ? t : 1));
}

// ---- timetable consent ------------------------------------------------------

// The key must never change - existing consent survives redesigns; the
// contract is pinned by the e2e suite.
export const CONSENT_KEY = 'modsutd.timetable.consent.v3';
// Only what to say before /data/term-calendar.json has loaded, or when the
// date falls outside every published term. The real label comes from that
// file, which tools/scraper/term_calendar.py regenerates from SUTD's own
// academic-calendar page - a constant edited by hand at rollover is a constant
// that is wrong from the first rollover nobody remembers.
export const DEFAULT_TERM_LABEL = 'the current term';

export function useConsent(): [boolean, () => void] {
  const [agreed, setAgreed] = useState(false);
  useEffect(() => {
    setAgreed(localStorage.getItem(CONSENT_KEY) === 'yes');
  }, []);
  const agree = () => {
    localStorage.setItem(CONSENT_KEY, 'yes');
    setAgreed(true);
  };
  return [agreed, agree];
}
