import { createContext, useContext } from 'react';
import type { Pillar, Term } from '@/types';

export type SortKey = 'code' | 'name' | 'pillar' | 'term' | 'credits';
export type MobileTab = 'mods' | 'tt' | 'rooms' | 'more';
export type SheetKind = 'mod' | 'share' | 'discuss' | 'contribute' | null;
export type TtMode = 'paste' | 'grid' | 'tree';
export type FreshmoreMode = 'classic' | 'ay2026';
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
