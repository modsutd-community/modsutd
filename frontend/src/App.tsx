import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { Workbench } from '@/workbench/Workbench';
import { useAppDispatch, useAppSelector } from '@/store';
import { fetchMods } from '@/reducers/modsReducer';
import { fetchVenues } from '@/reducers/venuesReducer';
import { warmIndex } from '@/utils/search';
import { useFreshData } from '@/utils/useFreshData';

// The Workbench is the whole app: one window-manager surface that interprets
// every route (/mods/:code, /venues?focus=, /share, …) as panel state.
export default function App() {
  const dispatch = useAppDispatch();

  const mods = useAppSelector((s) => s.mods.data);
  const venues = useAppSelector((s) => s.venues.data);

  useEffect(() => {
    dispatch(fetchMods());
    dispatch(fetchVenues());
  }, [dispatch]);

  // Deployed data moves under an open session; this picks it up in place.
  useFreshData();

  // The search index costs ~110ms to build and used to be paid on the first
  // character typed, which is the whole of the "typing feels slow" complaint.
  // Build it once the data has landed, while the user is still reading.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200));
    const id = idle(() => warmIndex(mods, venues));
    return () => (window.cancelIdleCallback ?? window.clearTimeout)(id as number);
  }, [mods, venues]);

  return (
    <BrowserRouter>
      <Workbench />
    </BrowserRouter>
  );
}
