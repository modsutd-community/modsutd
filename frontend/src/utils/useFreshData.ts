import { useEffect } from 'react';
import { useAppDispatch } from '@/store';
import { fetchMods } from '@/reducers/modsReducer';
import { fetchVenues } from '@/reducers/venuesReducer';
import { anyAwaiting, CONTRIBUTED_EVENT } from '@/workbench/contributed';

// Deployed data changes underneath a session that is already open. Contributed
// slots reach the browser in a build up to four hours after the paste, and the
// reader waiting on it is the one who pasted - asking them to reload to see
// their own contribution land is asking them to guess when.
//
// Cheap by construction. /data/*.json is served `max-age=0, must-revalidate`,
// so a refetch that finds nothing new is one 304 and no parsing. The interval
// is armed only while this browser has a contribution still waiting; everyone
// else refetches on returning to the tab and not otherwise.

const POLL_MS = 5 * 60 * 1000;
// Below this, a return to the tab is a glance away, not a session that has sat
// through a build.
const STALE_MS = 60 * 1000;

export function useFreshData(): void {
  const dispatch = useAppDispatch();

  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      last = Date.now();
      // Both, because a contribution moves the mod pages and the venue
      // heatmaps, and the heatmaps are built from the same courses file.
      void dispatch(fetchMods());
      void dispatch(fetchVenues());
    };

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - last < STALE_MS) return;
      refresh();
    };

    let timer: number | undefined;
    const arm = () => {
      window.clearInterval(timer);
      timer = anyAwaiting() ? window.setInterval(refresh, POLL_MS) : undefined;
    };
    arm();

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    // A paste arms the poll without a reload; the deploy landing disarms it.
    window.addEventListener(CONTRIBUTED_EVENT, arm);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener(CONTRIBUTED_EVENT, arm);
    };
  }, [dispatch]);
}
