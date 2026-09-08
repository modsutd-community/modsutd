import { useEffect, useRef } from 'react';
import { useAppDispatch } from '@/store';
import { importRecords } from '@/reducers/recordsReducer';
import { fetchMods } from '@/reducers/modsReducer';
import { fetchVenues } from '@/reducers/venuesReducer';
import { importPlans, setTimetableEvents } from '@/reducers/timetableReducer';
import { useWorkbenchUi } from './uiContext';
import { getToken, onLinkChange, pullBackup, markSyncSettled } from './sync';
import { importContributed } from './contributed';
import { importAsked, anyAsked, TELE_ASKED_EVENT } from './teleAsked';
import { importConsent } from './logic';
import { importPrefs, PREFS_EVENT } from './prefs';
import { isBundle } from './backup';
import type { BackupBundle } from './backup';
import { newerSections, stampSections } from './sectionSync';

// A chat being created is the one thing a reader watches, so pull often then
// and rarely otherwise. 15s against GitHub's 5000/hr authenticated ceiling is
// 240/hr, and only while a creation is outstanding.
const FAST_MS = 15_000;
// 30s, not 60. A student who clears a timetable on one device and picks up the
// other expects it gone, and the worst case is this plus the 8s push debounce.
// 120 requests an hour per device against an authenticated ceiling of 5000.
const SLOW_MS = 30_000;

// Pull the private gist when GitHub is linked, and take whichever sections it
// holds that are newer than this browser's.
//
// Without this, everything lived in localStorage and nothing followed a
// student from laptop to phone: they pasted the same timetable twice and the
// two devices still disagreed, because the contributed-awaiting-deploy state
// is per browser too.
//
// Runs on link and once per session, not on a timer: the gist is written by
// this same account, so the only way it changes under a live session is
// another device - and a device switch always involves opening the app.

export function useSync(): void {
  const dispatch = useAppDispatch();
  const { replaceDeclared } = useWorkbenchUi();
  // Held in a ref, the shape CLAUDE.md already names for onDiscussion. The
  // provider rebuilds this arrow on every render and it owns the filter box and
  // the mobile tab, so in the deps below a single keystroke tore down the
  // repeat pull and restarted its clock - it could never actually fire.
  const replace = useRef(replaceDeclared);
  replace.current = replaceDeclared;
  const pulled = useRef(false);
  // One request at a time: a slow pull must not stack up behind the timer.
  const inFlight = useRef(false);

  useEffect(() => {
    const run = (force = false) => {
      if (!getToken()) return;
      if (pulled.current && !force) return;
      if (inFlight.current) return;
      pulled.current = true;
      inFlight.current = true;
      void pullBackup()
        .then((b) => {
          // Even a bundle this browser takes nothing from proves the gist is
          // there, which is what stops the autosave seeding an empty one.
          markSyncSettled(true);
          if (!isBundle(b)) return;
          const bundle = b as BackupBundle;
          const take = newerSections(bundle);
          if (!take.length) return;
          if (take.includes('records')) dispatch(importRecords(bundle.records));
          if (take.includes('plans')) dispatch(importPlans(bundle.plans));
          if (take.includes('declared')) replace.current(bundle.declared ?? []);
          if (take.includes('timetable') && bundle.timetable) {
            dispatch(setTimetableEvents(bundle.timetable));
          }
          if (take.includes('contributed')) {
            importContributed(bundle.contributed);
            // overlayLocal runs where the courses are loaded, so a contribution
            // arriving over the wire reaches the heatmap and the mod pages only
            // by reloading those slices - the same step the local paste takes.
            void dispatch(fetchMods());
            void dispatch(fetchVenues());
          }
          if (take.includes('teleAsked')) importAsked(bundle.teleAsked);
          if (take.includes('consent')) importConsent(bundle.consent);
          // The provider reads its store once on mount, so a changed setting
          // needs the tree rebuilt to show. Only when something actually moved.
          if (take.includes('prefs') && importPrefs(bundle.prefs)) {
            window.dispatchEvent(new Event(PREFS_EVENT));
          }
          // Each section keeps the stamp of the write it came from, not
          // `now` - stamping a pull as an edit would push it straight back -
          // and not take[0]'s, which handed one section's timestamp to all of
          // them and could age a section forward past a local edit it should
          // have lost to.
          for (const sec of take) {
            stampSections([sec], bundle.stamps?.[sec] ?? Date.now());
          }
        })
        .finally(() => {
          inFlight.current = false;
        })
        .catch(() => {
          // No gist yet, or offline. Nothing to merge, and nothing to say:
          // the student did not ask for a sync, they opened the app. But the
          // autosave is waiting on this answer, and without it a first link
          // uploads nothing at all - which is what left a freshly linked phone
          // showing an empty plan.
          markSyncSettled(false);
          pulled.current = false;
        });
    };
    run();
    // Forced. Unforced it hits the once-per-mount guard that this page load's
    // own pull already set, so relinking fetched nothing at all.
    const off = onLinkChange(() => run(true));

    // A repeat pull, which is what makes a second browser follow the first.
    // Without it this ran once per session and a tab left open never saw
    // anything the other device did - the student had to reload to find out.
    //
    // Faster while a chat is being created, because that is the one state a
    // reader is actively watching. Skipped entirely when the tab is hidden: a
    // backgrounded tab should cost the GitHub API nothing.
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      run(true);
    };
    let id = window.setInterval(tick, anyAsked() ? FAST_MS : SLOW_MS);
    const repace = () => {
      window.clearInterval(id);
      id = window.setInterval(tick, anyAsked() ? FAST_MS : SLOW_MS);
    };
    window.addEventListener(TELE_ASKED_EVENT, repace);
    // Coming back to the tab is exactly when the answer is most out of date.
    document.addEventListener('visibilitychange', tick);

    return () => {
      off();
      window.clearInterval(id);
      window.removeEventListener(TELE_ASKED_EVENT, repace);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [dispatch]);
}
