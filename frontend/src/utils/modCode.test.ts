import { describe, it, expect } from 'vitest';
// Read as text with Vite's ?raw, the same way the Discuss panel reads the issue
// templates - server.fs.allow is what lets it reach above frontend/.
import contributeRelay from '../../../api/contribute.js?raw';
import reviewRelay from '../../../api/review-thread.js?raw';
import groupRelay from '../../../api/telegram-group.js?raw';
import foldSlots from '../../../tools/fold_slots.py?raw';
import gatherListing from '../../../tools/scraper/gather_mods.py?raw';
import { CANONICAL_MOD, eventsToSlots } from './contributeTimetable';
import { looksLikeCode } from './search';
import type { TimetableEvent } from '@/types';

// SUTD splits a course into 03.007A and 03.007B rather than issuing a second
// number, and both are freshmore core. Every validator that spelled a code as
// \d{2}\.\d{3} dropped them in silence: the contribution relay refused them,
// fold_slots skipped them, and the search treated a typed code as prose.
describe('a mod code may carry a letter', () => {
  it('accepts the shapes the catalogue actually contains', () => {
    for (const code of ['50.001', '03.007A', '03.007B']) {
      expect(CANONICAL_MOD.test(code), code).toBe(true);
    }
  });

  it('is still a code and not a free-for-all', () => {
    for (const bad of ['50.0011', '3.007A', '50.007AB', 'AB.007', '50.007-', '']) {
      expect(CANONICAL_MOD.test(bad), bad).toBe(false);
    }
  });

  // The gate that matters: a slot for a lettered mod has to survive to the
  // relay, or a whole cohort's freshmore contributions vanish.
  it('keeps a contributed slot for a lettered mod', () => {
    const ev = (modCode: string): TimetableEvent => ({
      modCode, modName: 'x', type: 'Lecture', day: 'Monday',
      startTime: '09:00', endTime: '11:00', location: '2.101',
      instructors: [], startDate: '2026-09-14', endDate: '2026-12-19',
    });
    const slots = eventsToSlots([ev('03.007A'), ev('03.007B'), ev('50.001')]);
    expect(slots.map((s) => s.mod)).toEqual(['03.007A', '03.007B', '50.001']);
  });

  it('treats a typed lettered code as a code, not as prose', () => {
    expect(looksLikeCode('03.007A')).toBe(true);
    expect(looksLikeCode('1.510A')).toBe(true);
    expect(looksLikeCode('think tank')).toBe(false);
  });

  // The relays cannot import from the app, so each carries its own copy. A copy
  // that drifts is a validator that rejects what the app just sent.
  it('the relays agree with the app', () => {
    const relays = { 'contribute.js': contributeRelay, 'review-thread.js': reviewRelay,
      'telegram-group.js': groupRelay };
    for (const [f, src] of Object.entries(relays)) {
      const m = src.match(/const MOD_RE = (\/.+?\/);/);
      expect(m, `${f} has no MOD_RE`).toBeTruthy();
      expect(m![1], f).toBe(CANONICAL_MOD.toString());
    }
  });

  // Same rule, other language. fold_slots.py is what writes /data.
  it('the folder agrees with the app', () => {
    const m = foldSlots.match(/MOD_RE = re\.compile\(r"(.+?)"\)/);
    expect(m, 'fold_slots.py has no MOD_RE').toBeTruthy();
    // Python's own source text, which spells the pattern the same way.
    expect(m![1]).toBe(String.raw`^\d{2}\.\d{3}[A-Za-z]?$`);
  });

  // The monthly listing refresh recreates any course file it does not find. A
  // row or a slug that yields only "03.007" would have landed its tags on the
  // base file and quietly re-merged a split someone made on purpose.
  it('the listing refresh refuses to recreate a split base code', () => {
    expect(gatherListing).toContain('refusing to recreate');
    expect(gatherListing).toContain("[A-Za-z].json");
  });
});
