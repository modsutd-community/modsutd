import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { Curriculum, PlanState, TimetableEvent, TimetableState } from '@/types';
import { withLegacyAlias } from '@/workbench/planFile';

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
    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      plans: parsed.plans
        ? {
            // `classic` is the old name for this cohort. Plans under it are
            // in people's browsers and in their gists right now, so it is read
            // for as long as anyone might still have one.
            ay2024: plan(parsed.plans.ay2024 ?? parsed.plans.classic),
            ay2025: plan(parsed.plans.ay2025),
            ay2026: plan(parsed.plans.ay2026),
          }
        // pre-split shape: the single plan was built against the oldest core
        : { ...emptyPlans(), ay2024: plan(parsed) },
      savedAt: parsed.savedAt,
    };
  } catch {
    return { events: [], plans: emptyPlans() };
  }
}

function persist(state: TimetableState) {
  try {
    state.savedAt = new Date().toISOString();
    localStorage.setItem(
      STORAGE_KEY,
      // withLegacyAlias, not a plain stringify: a tab open on the pre-rename
      // bundle reads this same key and would otherwise find no plan at all.
      JSON.stringify({ ...state, plans: withLegacyAlias(state.plans) }),
    );
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
        // `classic` again: an imported file or a pulled gist can still be
        // carrying the old key.
        ay2024: plan(
          payload?.ay2024 ?? (payload as Record<string, unknown>)?.classic as PlanState | undefined,
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
