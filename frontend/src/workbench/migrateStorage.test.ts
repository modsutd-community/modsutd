// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The rename is one-way and eager: a browser holding `classic` is read once and
// rewritten under `ay2024`, in localStorage and in what it pushes to the gist.
// Leaving the old key behind was the earlier design and it meant every browser
// carried both names forever.

const TT = 'modsutd.timetable.v1';
const UI = 'modsutd.workbench.ui.v1';

describe('a browser holding the old `classic` key', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('reads the plan and leaves only `ay2024` in storage', async () => {
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
    expect(state.plans.ay2024.selectedMods).toEqual(['10.013']);

    const stored = JSON.parse(localStorage.getItem(TT)!);
    expect(stored.plans).not.toHaveProperty('classic');
    expect(stored.plans.ay2024.selectedMods).toEqual(['10.013']);
    // Nothing the student did happened just now, so the timestamp stands.
    expect(stored.savedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('leaves a browser that never had the old key alone', async () => {
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

  it('rewrites the stored cohort preference', async () => {
    localStorage.setItem(UI, JSON.stringify({ freshmoreMode: 'classic', showRetired: true }));
    const { loadUi } = await import('./prefs');

    expect(loadUi().freshmoreMode).toBe('ay2024');
    const stored = JSON.parse(localStorage.getItem(UI)!);
    expect(stored.freshmoreMode).toBe('ay2024');
    // Everything else in the blob survives the rewrite.
    expect(stored.showRetired).toBe(true);
  });
});
