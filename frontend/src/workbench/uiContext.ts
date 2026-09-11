import { createContext, useContext } from 'react';
import type { Pillar, Term } from '@/types';

export type SortKey = 'code' | 'name' | 'pillar' | 'term' | 'credits';
export type MobileTab = 'mods' | 'tt' | 'rooms' | 'more';
export type SheetKind = 'mod' | 'share' | 'discuss' | 'contribute' | null;
export type TtMode = 'paste' | 'grid' | 'tree';
// The matriculation cohort a plan follows. Not a boolean any more: SUTD's
// freshmore core changed twice, and 50.057 alone wants a different prerequisite
// from each of the three. `ay2024` covers AY2024 and earlier; it was called
// `classic` until the cohorts were all spelled the same way.
export type FreshmoreMode = 'ay2026' | 'ay2025' | 'ay2024';

/** In the order the dropdown offers them - newest first, since most students
 *  reading this matriculated most recently. */
export const COHORTS: { value: FreshmoreMode; label: string }[] = [
  { value: 'ay2026', label: 'AY2026' },
  { value: 'ay2025', label: 'AY2025' },
  { value: 'ay2024', label: '≤ AY2024' },
];
// Degree pillars a student can belong to (for badge eligibility).
export type HomePillar = 'EPD' | 'ESD' | 'CSD' | 'ASD' | 'DAI';

// A mod in flight anywhere in the workbench; `level` is the plan row it
// would snap to.
export interface DragGhost {
  key: string;
  label: string;
  x: number;
  y: number;
  level: number | null;
}

export interface WorkbenchUi {
  filter: string;
  setFilter: (v: string) => void;
  pillar: Pillar | 'ALL';
  setPillar: (p: Pillar | 'ALL') => void;
  term: Term | 'ALL';
  setTerm: (t: Term | 'ALL') => void;
  // The term the student is currently in - gates the plan view (later
  // terms render dimmed) and the "achieved as of" specialisation state.
  currentTerm: number;
  setCurrentTerm: (t: number) => void;
  currentPillar: HomePillar | null;
  setCurrentPillar: (p: HomePillar | null) => void;
  sortKey: SortKey;
  sortDir: 1 | -1;
  sortBy: (k: SortKey) => void;
  selected: string | null;
  setSelected: (code: string | null) => void;
  selectedRoom: string | null;
  setSelectedRoom: (code: string | null) => void;
  probeDay: string;
  setProbeDay: (d: string) => void;
  probeTime: string;
  setProbeTime: (t: string) => void;
  mobileTab: MobileTab;
  setMobileTab: (t: MobileTab) => void;
  sheet: SheetKind;
  setSheet: (s: SheetKind) => void;
  ttMode: TtMode | null; // null = auto (grid when events exist, else paste)
  setTtMode: (m: TtMode) => void;
  freshmoreMode: FreshmoreMode;
  setFreshmoreMode: (m: FreshmoreMode) => void;
  showRetired: boolean;
  setShowRetired: (v: boolean) => void;
  // Specialisations the student has formally declared - shown even when
  // the plan doesn't reach them yet.
  declared: string[];
  toggleDeclared: (trackId: string) => void;
  replaceDeclared: (trackIds: string[]) => void;
  dragGhost: DragGhost | null;
  setDragGhost: (g: DragGhost | null) => void;
}

export const WorkbenchUiCtx = createContext<WorkbenchUi | null>(null);

export function useWorkbenchUi(): WorkbenchUi {
  const v = useContext(WorkbenchUiCtx);
  if (!v) throw new Error('useWorkbenchUi outside WorkbenchUiProvider');
  return v;
}
