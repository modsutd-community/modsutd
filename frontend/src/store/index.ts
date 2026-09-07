import { configureStore } from '@reduxjs/toolkit';
import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
import modsReducer from '@/reducers/modsReducer';
import venuesReducer from '@/reducers/venuesReducer';
import timetableReducer from '@/reducers/timetableReducer';
import recordsReducer from '@/reducers/recordsReducer';

// The workbench is single-theme (dark) - no theme slice.
export const store = configureStore({
  reducer: {
    mods: modsReducer,
    venues: venuesReducer,
    timetable: timetableReducer,
    records: recordsReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        // Ignore these action types
        ignoredActions: ['persist/PERSIST'],
      },
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Typed hooks
export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
