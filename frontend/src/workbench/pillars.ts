import type { Mod, Pillar } from '@/types';

export const PILLAR_COLORS: Record<Pillar, string> = {
  SMT: '#5b8def',
  EPD: '#3ca87a',
  ESD: '#c9a23a',
  CSD: '#e0683c',
  DAI: '#6c7be0',
  ASD: '#4bb3c4',
  HASS: '#b069d6',
};

export const PILLAR_ORDER: Pillar[] = ['SMT', 'EPD', 'ESD', 'CSD', 'DAI', 'ASD', 'HASS'];

export function pillarColor(p: string): string {
  return PILLAR_COLORS[p as Pillar] ?? '#ffb000';
}

// Official tag texts that name a pillar (ISTD is CSD's department name).
const TAG_PILLAR: Record<string, Pillar> = {
  // Both spellings. SUTD's own listing writes the pillar as ISTD, and the
  // capstones carry it as CSD - the app's own name for it. Mapping only ISTD
  // dropped CSD on the floor, so Capstone 1 and 2 showed four of the five
  // pillars they are open to.
  smt: 'SMT', hass: 'HASS', istd: 'CSD', csd: 'CSD',
  epd: 'EPD', esd: 'ESD', asd: 'ASD', dai: 'DAI',
};

// A mod can belong to several pillars (03.007A is ASD + EPD + SMT).
export function modPillars(mod: Mod): Pillar[] {
  const out: Pillar[] = [mod.pillar];
  for (const t of mod.tags ?? []) {
    const p = TAG_PILLAR[t.trim().toLowerCase()];
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
