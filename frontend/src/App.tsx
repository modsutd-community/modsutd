import { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { Workbench } from '@/workbench/Workbench';
import { useAppDispatch, useAppSelector } from '@/store';
import { fetchMods } from '@/reducers/modsReducer';
import { fetchVenues } from '@/reducers/venuesReducer';
import { warmIndex } from '@/utils/search';
import { useFreshData } from '@/utils/useFreshData';
import { pruneContributed } from '@/workbench/contributed';
import { loadManifest } from '@/utils/loadData';

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

  // Forget a contribution once the build has it. Done here, off the settled
  // catalogue, rather than inside the loaders: two of those run at once and
  // during a deploy they can see different versions of the same file.
  // Which build is on screen. A contribution that a later build did not ship
  // is a contribution that did not make it, and the app should stop promising
  // it rather than leave every browser telling a different story.
  const [builtAt, setBuiltAt] = useState<string | undefined>();
  useEffect(() => {
    loadManifest()
      .then((m) => setBuiltAt(m.coursesUpdatedAt ?? m.scrapedAt))
      .catch(() => setBuiltAt(undefined));
  }, []);

  useEffect(() => {
    pruneContributed(Object.values(mods), builtAt);
  }, [mods, builtAt]);

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
