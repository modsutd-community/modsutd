import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { Curriculum, PlanState, TimetableEvent, TimetableState } from '@/types';
import { LEGACY_CURRICULUM } from '@/workbench/planFile';

const STORAGE_KEY = 'modsutd.timetable.v1';

const emptyPlan = (): PlanState => ({ selectedMods: [], planLevels: {} });

// One place that knows every cohort, so adding one is a single edit rather
// than four that can disagree. A plan saved before a cohort existed simply
// arrives empty.
const emptyPlans = (): Record<Curriculum, PlanState> => ({
  ay2024: emptyPlan(),
  ay2025: emptyPlan(),
  ay2026: emptyPlan(),
});

function loadFromStorage(): TimetableState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { events: [], plans: emptyPlans() };
    const parsed = JSON.parse(raw);
    const plan = (p: unknown): PlanState => {
      const cand = p as Partial<PlanState> | undefined;
      return {
        selectedMods: Array.isArray(cand?.selectedMods) ? cand.selectedMods : [],
        planLevels: cand?.planLevels && typeof cand.planLevels === 'object' ? cand.planLevels : {},
      };
    };
    const stale = !!parsed.plans && LEGACY_CURRICULUM in parsed.plans;
    const state: TimetableState = {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      plans: parsed.plans
        ? {
            // `classic` is what this cohort was called. A plan saved under it
            // is read once, here, and then written back under the new name.
            ay2024: plan(parsed.plans.ay2024 ?? parsed.plans[LEGACY_CURRICULUM]),
            ay2025: plan(parsed.plans.ay2025),
            ay2026: plan(parsed.plans.ay2026),
          }
        // pre-split shape: the single plan was built against the oldest core
        : { ...emptyPlans(), ay2024: plan(parsed) },
      savedAt: parsed.savedAt,
    };
    // Rewritten now rather than on the next edit. A browser that opens the app
    // and changes nothing would otherwise keep `classic` in storage forever,
    // and one spelling is the entire point of the rename. savedAt is left as
    // it was: nothing the student did happened just now.
    if (stale) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // private window or quota: the migration is on read, so the next load
        // does it again and nothing is lost by failing here
      }
    }
    return state;
  } catch {
    return { events: [], plans: emptyPlans() };
  }
}

function persist(state: TimetableState) {
  try {
    state.savedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

const initialState: TimetableState = loadFromStorage();

const slice = createSlice({
  name: 'timetable',
  initialState,
  reducers: {
    setTimetableEvents(state, { payload }: PayloadAction<TimetableEvent[]>) {
      state.events = payload;
      persist(state);
    },
    addTimetableEvent(state, { payload }: PayloadAction<TimetableEvent>) {
      state.events.push(payload);
      persist(state);
    },
    removeTimetableEvent(state, { payload }: PayloadAction<number>) {
      state.events.splice(payload, 1);
      persist(state);
    },
    // Clears the parsed timetable ONLY - the plans are a separate feature
    // and survive a paste-again.
    clearTimetable(state) {
      state.events = [];
      persist(state);
    },
    selectMod(state, { payload }: PayloadAction<{ mode: Curriculum; code: string; level: number }>) {
      const plan = state.plans[payload.mode];
      if (!plan.selectedMods.includes(payload.code)) plan.selectedMods.push(payload.code);
      plan.planLevels[payload.code] = payload.level;
      persist(state);
    },
    deselectMod(state, { payload }: PayloadAction<{ mode: Curriculum; code: string }>) {
      const plan = state.plans[payload.mode];
      plan.selectedMods = plan.selectedMods.filter((c) => c !== payload.code);
      delete plan.planLevels[payload.code];
      persist(state);
    },
    setPlanLevel(state, { payload }: PayloadAction<{ mode: Curriculum; code: string; level: number }>) {
      state.plans[payload.mode].planLevels[payload.code] = Math.min(10, Math.max(1, payload.level));
      persist(state);
    },
    importPlans(state, { payload }: PayloadAction<Record<Curriculum, PlanState>>) {
      const plan = (p: unknown): PlanState => {
        const cand = p as Partial<PlanState> | undefined;
        return {
          selectedMods: Array.isArray(cand?.selectedMods) ? cand.selectedMods.filter((c) => typeof c === 'string') : [],
          planLevels: cand?.planLevels && typeof cand.planLevels === 'object' ? cand.planLevels : {},
        };
      };
      state.plans = {
        // `classic` again: an imported file or a gist written by a browser
        // that has not loaded since the rename still carries the old key. What
        // this browser pushes back has only the new one.
        ay2024: plan(
          payload?.ay2024 ?? (payload as Record<string, unknown>)?.[LEGACY_CURRICULUM] as PlanState | undefined,
        ),
        ay2025: plan(payload?.ay2025),
        ay2026: plan(payload?.ay2026),
      };
      persist(state);
    },
  },
});

export const {
  setTimetableEvents,
  addTimetableEvent,
  removeTimetableEvent,
  clearTimetable,
  selectMod,
  deselectMod,
  setPlanLevel,
  importPlans,
} = slice.actions;

export default slice.reducer;
