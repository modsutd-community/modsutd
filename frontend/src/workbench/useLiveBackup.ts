import { useAppSelector } from '@/store';
import { useWorkbenchUi } from './uiContext';
import { exportContributed } from './contributed';
import { exportAsked } from './teleAsked';
import { exportConsent } from './logic';
import { exportPrefs } from './prefs';
import { useAutoBackup } from './autoBackup';

/**
 * Mount the gist autosave over everything this browser knows.
 *
 * Split from `useAutoBackup` because the two have different jobs: that hook
 * decides WHEN to push, this one decides WHAT is in the bundle, and the bundle
 * is assembled from three different places - redux for records, plans and the
 * parsed timetable, the UI context for declared tracks, and localStorage for
 * the contributed-awaiting-deploy store.
 *
 * Mounted once, in WorkbenchInner. Two of these would race for one gist.
 */
export function useLiveBackup(): void {
  const records = useAppSelector((s) => s.records);
  const plans = useAppSelector((s) => s.timetable.plans);
  const events = useAppSelector((s) => s.timetable.events);
  const { declared } = useWorkbenchUi();

  // Not memoised: the hook compares the SERIALISED bundle, so a fresh object
  // every render costs a JSON.stringify and nothing else. Memoising on
  // `exportContributed()` would need its own identity to be stable, which it
  // is not - it reads localStorage.
  useAutoBackup({
    records,
    plans,
    declared,
    timetable: events,
    contributed: exportContributed(),
    teleAsked: exportAsked(),
    consent: exportConsent(),
    prefs: exportPrefs(),
  });
}
