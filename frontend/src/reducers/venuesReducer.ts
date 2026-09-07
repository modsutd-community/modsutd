import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import type { Venue, VenueAvailability, VenuesState } from '@/types';
import { loadVenues, loadCourses, buildAvailability } from '@/utils/loadData';

const initialState: VenuesState = {
  data: {},
  availability: {},
  loading: false,
  error: null,
};

// Pulls venues + courses (for availability rollup) in one go so the venue
// page never renders a half-loaded view.
export const fetchVenues = createAsyncThunk('venues/fetch', async () => {
  const [venues, courses] = await Promise.all([loadVenues(), loadCourses()]);
  const availability = buildAvailability(courses);

  // Room codes occasionally appear in schedules before someone curates a
  // venue entry - synthesize a row so they still render.
  for (const code of Object.keys(availability)) {
    if (!venues.find((v) => v.code === code)) {
      const [b, rest] = code.split('.');
      venues.push({
        code,
        name: code,
        building: b ?? '?',
        floor: rest ? parseInt(rest[0], 10) : 0,
        type: 'Cohort Classroom',
      });
    }
  }

  return { venues, availability };
});

const venuesSlice = createSlice({
  name: 'venues',
  initialState,
  reducers: {},
  extraReducers: (b) => {
    b.addCase(fetchVenues.pending, (s) => {
      s.loading = true;
      s.error = null;
    });
    b.addCase(fetchVenues.fulfilled, (s, { payload }) => {
      s.loading = false;
      s.data = Object.fromEntries(payload.venues.map((v: Venue) => [v.code, v]));
      s.availability = payload.availability as Record<string, VenueAvailability>;
    });
    b.addCase(fetchVenues.rejected, (s, a) => {
      s.loading = false;
      s.error = a.error.message ?? 'failed to load venues';
    });
  },
});

export default venuesSlice.reducer;
