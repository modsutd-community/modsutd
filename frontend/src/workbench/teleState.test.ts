// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { teleState, type TeleFacts } from './teleState';
import {
  askedAt, markAsked, clearAsked, anyAsked, exportAsked, importAsked, CREATING_TTL_MS,
} from './teleAsked';

const facts = (over: Partial<TeleFacts> = {}): TeleFacts => ({
  chatMod: true, entry: false, askedAt: null,
  termOk: true, committed: false, committing: false,
  ...over,
});

// The order of the checks IS the design, so each of these pins one step of it.
describe('which chat button to draw', () => {
  it('draws nothing for a mod that gets no chat', () => {
    expect(teleState(facts({ chatMod: false, entry: true, committed: true }))).toBe('none');
  });

  // The entry carries its own expiry, and on the first paste of a term the
  // deployed term-window.json is still empty - so a live group must outrank it.
  it('a live group outranks a missing term window', () => {
    expect(teleState(facts({ entry: true, termOk: false, committed: false }))).toBe('live');
  });

  it('shows the group once it exists, even mid-create', () => {
    expect(teleState(facts({ entry: true, askedAt: 1 }))).toBe('live');
  });

  // An ask is evidence the slots were on main when it happened, because READY
  // is the only pressable state. So CREATING survives a reload with no fetch.
  it('stays creating without needing to re-check the commit', () => {
    expect(teleState(facts({ askedAt: 1, committed: false, termOk: false }))).toBe('creating');
  });

  // The regression this ordering exists to prevent: on the FIRST paste of a
  // term the workflow has not written term-window.json yet, so a committing
  // state gated on termOk would be invisible for exactly its own window.
  it('shows committing on the first paste of a term, before the term window exists', () => {
    expect(teleState(facts({ committing: true, termOk: false }))).toBe('committing');
  });

  it('is ready only once the slots are on main', () => {
    expect(teleState(facts({ committed: true }))).toBe('ready');
    expect(teleState(facts({ committed: false }))).toBe('none');
  });

  // termOk gates READY alone, because READY is the only state that dispatches
  // and the workflow's no-live-term gate is the only thing it protects.
  it('will not offer a chat outside the term', () => {
    expect(teleState(facts({ committed: true, termOk: false }))).toBe('none');
  });
});

describe('remembering that this student asked', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('survives a reload, which useState did not', () => {
    markAsked('50.040');
    // A fresh read is what a reload does.
    expect(askedAt('50.040')).not.toBeNull();
  });

  // The leak: the mod panel swaps its contents rather than remounting, so a
  // component-local flag showed a spinner on the NEXT mod opened.
  it('is per mod, so it cannot leak onto the next one opened', () => {
    markAsked('50.040');
    expect(askedAt('60.006')).toBeNull();
  });

  it('expires, so a workflow that never finished does not spin forever', () => {
    markAsked('50.040', Date.now());
    expect(askedAt('50.040')).not.toBeNull();
    vi.advanceTimersByTime(CREATING_TTL_MS + 1000);
    expect(askedAt('50.040')).toBeNull();
    expect(anyAsked()).toBe(false);
  });

  it('clears once the group exists, so live never falls back to creating', () => {
    markAsked('50.040');
    clearAsked('50.040');
    expect(askedAt('50.040')).toBeNull();
  });

  // Merged, not replaced: each browser may have asked for a different mod, and
  // a replace drops whichever arrived second.
  it('merges the other browser rather than overwriting it', () => {
    markAsked('50.040', 1000);
    importAsked({ '60.006': 2000 });
    expect(exportAsked()).toEqual({ '50.040': 1000, '60.006': 2000 });
  });

  it('takes the newer of two asks for the same mod', () => {
    markAsked('50.040', 5000);
    importAsked({ '50.040': 1000 });
    expect(exportAsked()['50.040']).toBe(5000);
    importAsked({ '50.040': 9000 });
    expect(exportAsked()['50.040']).toBe(9000);
  });

  it('ignores rubbish rather than throwing into a render', () => {
    importAsked({ '50.040': 'soon' as unknown as number });
    importAsked(null);
    importAsked('nope');
    expect(exportAsked()).toEqual({});
  });
});
