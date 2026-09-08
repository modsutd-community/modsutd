// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { SECTIONS } from './backup';
import { newerSections, readStamps, stampChanged, stampSections } from './sectionSync';
import type { BackupBundle } from './backup';

const bundle = (over: Partial<BackupBundle> = {}): BackupBundle => ({
  records: {} as BackupBundle['records'],
  plans: {} as BackupBundle['plans'],
  declared: [],
  ...over,
});

// Sync is newest-wins PER SECTION. Comparing whole bundles gets one side wrong
// every time: a phone that only edits a note would push its empty timetable
// over the one the laptop pasted an hour ago.
describe('which sections a pulled bundle wins', () => {
  beforeEach(() => localStorage.clear());

  it('takes a section this browser has never written', () => {
    const remote = bundle({ timetable: [{} as never], stamps: { timetable: 100 } });
    expect(newerSections(remote)).toEqual(['timetable']);
  });

  it('refuses a section older than this browser has', () => {
    stampChanged(SECTIONS, 500);
    const remote = bundle({ timetable: [{} as never], stamps: { timetable: 100 } });
    expect(newerSections(remote)).toEqual([]);
  });

  it('takes only the newer half, not the whole bundle', () => {
    stampSections(['timetable'], 900);
    stampSections(['records'], 100);
    const remote = bundle({
      records: { '50.001': {} } as unknown as BackupBundle['records'],
      timetable: [{} as never],
      stamps: { records: 500, timetable: 500 },
    });
    expect(newerSections(remote)).toEqual(['records']);
  });

  // Deletion is an edit. Refusing every empty section was a data-loss guard,
  // and its cost was that clearing a timetable on the phone never reached the
  // laptop - a rule that only propagates additions cannot delete anything.
  it('lets a section that was genuinely cleared win', () => {
    stampChanged(SECTIONS, 1);
    const remote = bundle({ timetable: [], stamps: { timetable: 9_999_999 } });
    expect(newerSections(remote)).toContain('timetable');
  });

  // What replaces the guard: a section is stamped only when it CHANGES, so an
  // empty one arrives newer only when emptying it was the last thing anyone
  // did. A stale empty section still loses.
  it('an older empty section still loses to local work', () => {
    stampChanged(SECTIONS, 5_000);
    const remote = bundle({ timetable: [], stamps: { timetable: 4_000 } });
    expect(newerSections(remote)).not.toContain('timetable');
  });

  // A bundle written before stamps existed must not outrank later local edits.
  it('treats an unstamped bundle as older than anything local', () => {
    stampChanged(SECTIONS, 10);
    const remote = bundle({ timetable: [{} as never] });
    expect(newerSections(remote)).toEqual([]);
  });

  // The bug this replaces: stamping ALL sections on every push meant a laptop
  // saving a note republished its own stale timetable with a fresh stamp, and
  // beat whatever the phone had written since. There was no race to lose.
  it('stamps only what changed, leaving the rest where they were', () => {
    stampChanged(SECTIONS, 1000);
    stampChanged(['records'], 5000);
    expect(readStamps()).toMatchObject({ records: 5000, timetable: 1000, contributed: 1000 });
  });
});
