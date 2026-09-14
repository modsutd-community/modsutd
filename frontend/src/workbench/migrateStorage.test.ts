// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `classic` was this cohort's key before they were all spelled `ay<year>`. The
// one-way migration that read it is gone, so what these pin is the other half:
// a value the app does not recognise must not reach `plans[...]`, in storage or
// in a gist. `plans` has exactly three keys, so anything else makes the next
// render read `.selectedMods` of undefined and the panel stays dead through
// every reload, because the bad value is persisted.

const TT = 'modsutd.timetable.v1';
const UI = 'modsutd.workbench.ui.v1';

describe('a browser holding a cohort key this app does not have', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('gets an empty AY2024 plan rather than a crash', async () => {
    localStorage.setItem(TT, JSON.stringify({
      events: [],
      savedAt: '2026-01-01T00:00:00.000Z',
      plans: {
        classic: { selectedMods: ['10.013'], planLevels: { '10.013': 1 } },
        ay2025: { selectedMods: [], planLevels: {} },
        ay2026: { selectedMods: [], planLevels: {} },
      },
    }));

    const { default: reducer } = await import('@/reducers/timetableReducer');
    const state = reducer(undefined, { type: '@@INIT' });
    expect(state.plans.ay2024.selectedMods).toEqual([]);
    expect(state.plans).not.toHaveProperty('classic');
  });

  it('leaves storage exactly as it found it', async () => {
    // The migration used to rewrite on read. Nothing rewrites now, so a load
    // that changes nothing must write nothing either.
    const clean = {
      events: [],
      plans: { ay2024: { selectedMods: [], planLevels: {} } },
    };
    localStorage.setItem(TT, JSON.stringify(clean));
    const before = localStorage.getItem(TT);

    const { default: reducer } = await import('@/reducers/timetableReducer');
    reducer(undefined, { type: '@@INIT' });

    expect(localStorage.getItem(TT)).toBe(before);
  });

  it('drops a stored cohort preference it cannot honour', async () => {
    localStorage.setItem(UI, JSON.stringify({ freshmoreMode: 'classic', showRetired: true }));
    const { loadUi } = await import('./prefs');

    // undefined, not 'classic': the context then falls to its own default,
    // which is a cohort the reader can change rather than a blank panel.
    expect(loadUi().freshmoreMode).toBeUndefined();
    const stored = JSON.parse(localStorage.getItem(UI)!);
    expect(stored.freshmoreMode).toBeUndefined();
    // Everything else in the blob survives the rewrite.
    expect(stored.showRetired).toBe(true);
  });

  it('keeps a cohort preference it does know', async () => {
    localStorage.setItem(UI, JSON.stringify({ freshmoreMode: 'ay2025' }));
    const { loadUi } = await import('./prefs');
    expect(loadUi().freshmoreMode).toBe('ay2025');
  });
});
