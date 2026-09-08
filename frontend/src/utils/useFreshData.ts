import { useEffect } from 'react';
import { useAppDispatch } from '@/store';
import { fetchMods } from '@/reducers/modsReducer';
import { fetchVenues } from '@/reducers/venuesReducer';

// Deployed data changes underneath a session that is already open, and a build
// lands up to four hours after the paste that fed it.
//
// Deliberately no interval. A contribution is already on screen from the local
// overlay the moment the relay accepts it, so a timer would burn wakeups for
// four hours to replace data the reader can already see. What is left is the
// cheap case: someone comes back to the tab after a while and should not be
// looking at yesterday. /data/*.json is served max-age=0, must-revalidate, so
// a refetch that finds nothing new is one 304.

// Below this, a return to the tab is a glance away, not a session that has sat
// through a build.
const STALE_MS = 60 * 1000;

export function useFreshData(): void {
  const dispatch = useAppDispatch();

  useEffect(() => {
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - last < STALE_MS) return;
      last = Date.now();
      // Both, because a build moves the mod pages and the venue heatmaps, and
      // the heatmaps are built from the same courses file.
      void dispatch(fetchMods());
      void dispatch(fetchVenues());
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [dispatch]);
}
