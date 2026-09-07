import { useEffect, useRef, useState } from 'react';
import type { BackupBundle } from './backup';
import { getToken, pushBackup, onLinkChange } from './sync';

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

/**
 * Push `bundle` to the gist a few seconds after it stops changing.
 *
 * Compares serialised bundles rather than object identity: redux hands back a
 * new object on every render here, and pushing on identity would be a revision
 * per render.
 */
export function useAutoBackup(bundle: BackupBundle): AutoState {
  const [state, setState] = useState<AutoState>({ at: null, error: null, busy: false });
  // What is already in the gist, so a reload does not push what it just read.
  const saved = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [, bump] = useState(0);
  useEffect(() => onLinkChange(() => bump((n) => n + 1)), []);

  const json = JSON.stringify(bundle);
  useEffect(() => {
    if (!getToken() || !autoSaveOn()) return;
    if (saved.current === null) {
      saved.current = json; // first sight of this session is the baseline
      return;
    }
    if (saved.current === json) return;

    const push = async () => {
      const body = json;
      setState((s) => ({ ...s, busy: true }));
      try {
        await pushBackup(JSON.parse(body) as BackupBundle);
        saved.current = body;
        setState({ at: Date.now(), error: null, busy: false });
      } catch (e) {
        // Left unsaved on purpose, so the next change retries rather than
        // marking a failed push as the new baseline.
        setState((s) => ({ ...s, error: (e as Error).message, busy: false }));
      }
    };

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
  }, [json]);

  return state;
}
