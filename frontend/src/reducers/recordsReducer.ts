import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { ModRecord, RecordComponent, RecordsState } from '@/types';

// Records keep their own EDITABLE copy of the grading components - not a
// reference to the mod's data - so students can adjust weights ad hoc.
const STORAGE_KEY = 'modsutd.records.v1';

function loadFromStorage(): RecordsState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persist(state: RecordsState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota errors are non-fatal
  }
}

const emptyRecord = (): ModRecord => ({ notes: '', components: [] });

const slice = createSlice({
  name: 'records',
  initialState: loadFromStorage(),
  reducers: {
    setNotes(state, { payload }: PayloadAction<{ code: string; notes: string }>) {
      state[payload.code] = { ...(state[payload.code] ?? emptyRecord()), notes: payload.notes };
      persist(state);
    },
    // One-time prefill; migrates the legacy name-keyed scores when present.
    initComponents(state, { payload }: PayloadAction<{ code: string; defaults: Array<{ name: string; weight: number }> }>) {
      // NOTHING TO SEED IS NOTHING TO STORE. A mod with no published grading
      // table has no default components, so this wrote {notes:"", components:[]}
      // for the mere act of opening its card. Those empty shells then travelled:
      // an export carried a record for every chip the reader had happened to
      // hover, so exporting the same plan twice produced different files.
      if (!payload.defaults.length && !state[payload.code]) return;
      const rec = state[payload.code] ?? emptyRecord();
      if (rec.components && rec.components.length > 0) return;
      const legacy = rec.scores ?? {};
      rec.components = payload.defaults.map((d) => ({
        name: d.name,
        weight: d.weight,
        score: typeof legacy[d.name] === 'number' ? legacy[d.name] : null,
      }));
      delete rec.scores;
      state[payload.code] = rec;
      persist(state);
    },
    setComponent(
      state,
      { payload }: PayloadAction<{ code: string; index: number; patch: Partial<RecordComponent> }>,
    ) {
      const rec = state[payload.code] ?? emptyRecord();
      const comps = [...(rec.components ?? [])];
      if (!comps[payload.index]) return;
      comps[payload.index] = { ...comps[payload.index], ...payload.patch };
      state[payload.code] = { ...rec, components: comps };
      persist(state);
    },
    addComponent(state, { payload }: PayloadAction<{ code: string }>) {
      const rec = state[payload.code] ?? emptyRecord();
      state[payload.code] = {
        ...rec,
        components: [...(rec.components ?? []), { name: '', weight: 0, score: null }],
      };
      persist(state);
    },
    removeComponent(state, { payload }: PayloadAction<{ code: string; index: number }>) {
      const rec = state[payload.code];
      if (!rec?.components) return;
      rec.components = rec.components.filter((_, i) => i !== payload.index);
      persist(state);
    },
    importRecords(state, { payload }: PayloadAction<RecordsState>) {
      for (const [code, rec] of Object.entries(payload)) {
        if (rec && typeof rec === 'object') {
          state[code] = {
            notes: typeof rec.notes === 'string' ? rec.notes : '',
            components: Array.isArray(rec.components) ? rec.components : undefined,
            scores: rec.scores && typeof rec.scores === 'object' ? rec.scores : undefined,
          };
        }
      }
      persist(state);
    },
  },
});

export const { setNotes, initComponents, setComponent, addComponent, removeComponent, importRecords } =
  slice.actions;
export default slice.reducer;
