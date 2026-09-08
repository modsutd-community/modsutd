import { useEffect, useState } from 'react';

// A one-line banner that appears at the top and clears itself. Used for the
// things a student needs told once - why a join link did not appear - where a
// permanent element would be clutter and an alert() would block the tab.

export type NoticeTone = 'warn' | 'ok';

export interface Notice {
  id: number;
  text: string;
  tone: NoticeTone;
}

const LIFETIME_MS = 7000;

let current: Notice | null = null;
let seq = 0;
const listeners = new Set<(n: Notice | null) => void>();

function emit() {
  for (const fn of listeners) fn(current);
}

export function notify(text: string, tone: NoticeTone = 'warn'): void {
  current = { id: ++seq, text, tone };
  emit();
  const mine = current.id;
  setTimeout(() => {
    // A newer notice replaced this one - let that one run its own clock.
    if (current?.id === mine) {
      current = null;
      emit();
    }
  }, LIFETIME_MS);
}

export function dismissNotice(): void {
  current = null;
  emit();
}

export function useNotice(): Notice | null {
  const [notice, setNotice] = useState<Notice | null>(current);
  useEffect(() => {
    listeners.add(setNotice);
    return () => {
      listeners.delete(setNotice);
    };
  }, []);
  return notice;
}
