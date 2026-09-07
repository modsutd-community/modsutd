import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import type { Mod, ModsState } from '@/types';
import { loadCourses } from '@/utils/loadData';

const initialState: ModsState = {
  data: {},
  loading: false,
  error: null,
};

export const fetchMods = createAsyncThunk('mods/fetch', async () => {
  const list = await loadCourses();
  return list;
});

const modsSlice = createSlice({
  name: 'mods',
  initialState,
  reducers: {
    upsertMod(state, { payload }: PayloadAction<Mod>) {
      state.data[payload.code] = payload;
    },
  },
  extraReducers: (b) => {
    b.addCase(fetchMods.pending, (s) => {
      s.loading = true;
      s.error = null;
    });
    b.addCase(fetchMods.fulfilled, (s, { payload }) => {
      s.loading = false;
      // App-side unique key: the code - except the AY2026 placeholders,
      // which all share code 99.999 and are distinct by NAME only, so
      // their key is 'code|name'.
      const data: Record<string, Mod> = {};
      for (const m of payload) {
        const composite = m.code === '99.999' || data[m.code] !== undefined;
        const key = composite ? `${m.code}|${m.name}` : m.code;
        data[key] = { ...m, key };
      }
      s.data = data;
    });
    b.addCase(fetchMods.rejected, (s, a) => {
      s.loading = false;
      s.error = a.error.message ?? 'failed to load mods';
    });
  },
});

export const { upsertMod } = modsSlice.actions;
export default modsSlice.reducer;
