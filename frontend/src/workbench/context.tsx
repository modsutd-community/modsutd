import { ReactNode, useEffect, useMemo, useState } from 'react';
import type { Pillar, Term } from '@/types';
import { WorkbenchUiCtx, WorkbenchUi, SortKey, MobileTab, SheetKind, TtMode, FreshmoreMode, DragGhost, HomePillar } from './uiContext';

const STORAGE_KEY = 'modsutd.workbench.ui.v1';

interface PersistedUi {
  filter?: string;
  pillar?: Pillar | 'ALL';
  term?: Term | 'ALL';
  currentTerm?: number;
  currentPillar?: HomePillar | null;
  sortKey?: SortKey;
  sortDir?: 1 | -1;
  selected?: string | null;
  selectedRoom?: string | null;
  mobileTab?: MobileTab;
  ttMode?: TtMode;
  freshmoreMode?: FreshmoreMode;
  showRetired?: boolean;
  declared?: string[];
}

function loadUi(): PersistedUi {
  try {
    return (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as PersistedUi) ?? {};
  } catch {
    return {};
  }
}

export function WorkbenchUiProvider({ children }: { children: ReactNode }) {
  const saved = useMemo(loadUi, []);
  const [filter, setFilter] = useState(saved.filter ?? '');
  const [pillar, setPillar] = useState<Pillar | 'ALL'>(saved.pillar ?? 'ALL');
  const [term, setTerm] = useState<Term | 'ALL'>(saved.term ?? 'ALL');
  const [currentTerm, setCurrentTerm] = useState(saved.currentTerm ?? 1);
  const [currentPillar, setCurrentPillar] = useState<HomePillar | null>(saved.currentPillar ?? null);
  const [sortKey, setSortKey] = useState<SortKey>(saved.sortKey ?? 'code');
  const [sortDir, setSortDir] = useState<1 | -1>(saved.sortDir ?? 1);
  const [selected, setSelected] = useState<string | null>(saved.selected ?? null);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(saved.selectedRoom ?? null);
  // Probe follows the clock on every load - "is it free NOW" is the
  // question 90% of the time (weekends land on Monday morning).
  const now = new Date();
  const weekday = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][now.getDay() - 1];
  const [probeDay, setProbeDay] = useState(weekday ?? 'Monday');
  const [probeTime, setProbeTime] = useState(
    weekday ? `${String(Math.min(20, Math.max(8, now.getHours()))).padStart(2, '0')}:00` : '09:00',
  );
  const [mobileTab, setMobileTab] = useState<MobileTab>(saved.mobileTab ?? 'mods');
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [ttMode, setTtMode] = useState<TtMode | null>(saved.ttMode ?? null);
  // AY2026 by default: a student who has not chosen is far more likely to have
  // matriculated into the current curriculum than an older one, and the choice
  // is saved with the rest of the layout so it is asked once.
  const [freshmoreMode, setFreshmoreMode] = useState<FreshmoreMode>(
    saved.freshmoreMode ?? 'ay2026',
  );
  const [showRetired, setShowRetired] = useState<boolean>(saved.showRetired ?? false);
  const [dragGhost, setDragGhost] = useState<DragGhost | null>(null);
  const [declared, setDeclared] = useState<string[]>(saved.declared ?? []);
  const toggleDeclared = (trackId: string) =>
    setDeclared((cur) => (cur.includes(trackId) ? cur.filter((t) => t !== trackId) : [...cur, trackId]));
  const replaceDeclared = (trackIds: string[]) => setDeclared(trackIds.filter((t) => typeof t === 'string'));

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ filter, pillar, term, currentTerm, currentPillar, sortKey, sortDir, selected, selectedRoom, mobileTab, ttMode: ttMode ?? undefined, freshmoreMode, showRetired, declared }),
        );
      } catch {
        // non-fatal
      }
    }, 300);
    return () => clearTimeout(t);
  }, [filter, pillar, term, currentTerm, currentPillar, sortKey, sortDir, selected, selectedRoom, mobileTab, ttMode, freshmoreMode, showRetired, declared]);

  const sortBy = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(1);
    }
  };

  const value: WorkbenchUi = {
    filter, setFilter,
    pillar, setPillar,
    term, setTerm,
    currentTerm, setCurrentTerm,
    currentPillar, setCurrentPillar,
    sortKey, sortDir, sortBy,
    selected, setSelected,
    selectedRoom, setSelectedRoom,
    probeDay, setProbeDay,
    probeTime, setProbeTime,
    mobileTab, setMobileTab,
    sheet, setSheet,
    ttMode, setTtMode,
    freshmoreMode, setFreshmoreMode,
    showRetired, setShowRetired,
    declared, toggleDeclared, replaceDeclared,
    dragGhost, setDragGhost,
  };

  return <WorkbenchUiCtx.Provider value={value}>{children}</WorkbenchUiCtx.Provider>;
}
