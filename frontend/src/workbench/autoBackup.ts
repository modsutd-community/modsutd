import { useEffect, useRef, useState } from 'react';
import type { BackupBundle, BundleSection } from './backup';
import { notify } from './notice';
import { SECTIONS } from './backup';
import {
  getToken, pushBackup, onLinkChange, syncSettled, onSyncSettled, remoteBackupExists,
} from './sync';

// Keeps the private gist in step with the plan without anyone pressing export.
//
// The point is the case nobody plans for: a cleared site, a wiped profile, a
// new laptop. A backup that only exists when someone remembered to make one is
// not there on the day it is needed.
//
// Debounced rather than per-change, because every push is a new gist revision
// and a keystroke is not a revision. Also flushed when the tab goes away, which
// is where an edit made and immediately abandoned would otherwise be lost.

const ON_KEY = 'modsutd.gh.autosave.v1';
const IDLE_MS = 8000;

/** Default on once linked: the point of linking is not to have to remember. */
export function autoSaveOn(): boolean {
  return localStorage.getItem(ON_KEY) !== 'off';
}

export function setAutoSave(on: boolean): void {
  localStorage.setItem(ON_KEY, on ? 'on' : 'off');
  window.dispatchEvent(new Event(ON_KEY));
}

export function useAutoSaveSetting(): boolean {
  const [on, setOn] = useState(autoSaveOn);
  useEffect(() => {
    const read = () => setOn(autoSaveOn());
    window.addEventListener(ON_KEY, read);
    return () => window.removeEventListener(ON_KEY, read);
  }, []);
  return on;
}

export type AutoState = { at: number | null; error: string | null; busy: boolean };

// The autosave is a singleton - two of them would race for the same gist - but
// the panel that SHOWS its status is not where it can safely live. So the
// state is published here and read by whoever is on screen.
const STATE_EVENT = 'modsutd.gh.autostate';
let current: AutoState = { at: null, error: null, busy: false };

function publish(next: AutoState): void {
  current = next;
  window.dispatchEvent(new Event(STATE_EVENT));
}

/** The autosave's status, for a panel that wants to show it. */
export function useAutoState(): AutoState {
  const [s, setS] = useState(current);
  useEffect(() => {
    const read = () => setS(current);
    read();
    window.addEventListener(STATE_EVENT, read);
    return () => window.removeEventListener(STATE_EVENT, read);
  }, []);
  return s;
}

/**
 * Push `bundle` to the gist a few seconds after it stops changing.
 *
 * Compares serialised bundles rather than object identity: redux hands back a
 * new object on every render here, and pushing on identity would be a revision
 * per render.
 */
export function useAutoBackup(bundle: BackupBundle): AutoState {
  // What is already in the gist, so a reload does not push what it just read.
  const saved = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  // `woke` is in the effect's deps below, and that is the whole point of it.
  // Bumping state re-renders, but an effect keyed only on the bundle does not
  // run again when the bundle has not changed - so linking, and the first pull
  // settling, both went nowhere. Paste and then link, which is the order a
  // student actually does it in, and nothing was ever pushed: no gist was
  // created, and the account never synced anything in either direction.
  // One complaint per run of failures, not one per retry.
  const told = useRef(false);
  const [woke, bump] = useState(0);
  useEffect(() => onLinkChange(() => bump((n) => n + 1)), []);

  const json = JSON.stringify(bundle);
  useEffect(() => {
    if (!getToken() || !autoSaveOn()) return;

    // The pull decides what "already saved" means, so nothing is pushed until
    // it has answered. Pushing first would upload this browser's state over a
    // gist it has not read yet, which on a fresh phone is an empty plan
    // landing on top of the laptop's.
    if (!syncSettled()) return onSyncSettled(() => bump((n) => n + 1));

    const push = async () => {
      const body = json;
      // Which sections this browser actually edited since its last push. The
      // gist keeps the rest as it stands, so saving a note here cannot
      // republish a stale timetable over the one the phone just wrote.
      const before = saved.current
        ? (JSON.parse(saved.current) as Record<string, unknown>)
        : null;
      const after = JSON.parse(body) as Record<string, unknown>;
      const changed: BundleSection[] = before
        ? SECTIONS.filter((s) => JSON.stringify(before[s]) !== JSON.stringify(after[s]))
        : SECTIONS;
      publish({ ...current, busy: true });
      try {
        await pushBackup(JSON.parse(body) as BackupBundle, changed);
        saved.current = body;
        publish({ at: Date.now(), error: null, busy: false });
        told.current = false;
      } catch (e) {
        // Left unsaved on purpose, so the next change retries rather than
        // marking a failed push as the new baseline.
        const msg = (e as Error).message;
        publish({ ...current, error: msg, busy: false });
        // Said out loud, once. The status only shows inside the plan panel's
        // export menu, so a sync that never worked looked exactly like a sync
        // that did - which is how an account went its whole life without a
        // backup and nobody found out until two devices disagreed.
        if (!told.current) {
          told.current = true;
          notify(`sync failed: ${msg}`);
        }
      }
    };

    if (saved.current === null) {
      saved.current = json;
      // A linked browser whose account has NO gist has nothing to be in step
      // with, and calling its first bundle "already saved" is exactly why
      // linking on a laptop and then opening the phone showed an empty phone:
      // the laptop was waiting for a change it had already made. Seed the
      // gist now, and let the debounce handle everything after it.
      if (!remoteBackupExists()) void push();
      return;
    }
    if (saved.current === json) return;

    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void push(), IDLE_MS);
    // A tab that is being closed gets no second chance at the timer.
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        window.clearTimeout(timer.current);
        void push();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [json, woke]);

  return useAutoState();
}
