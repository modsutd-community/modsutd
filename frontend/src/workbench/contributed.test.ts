// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  rememberContributed, awaitingDeploy, overlayLocal, pruneContributed, CONTRIBUTED_EVENT,
} from './contributed';
import type { Mod, Schedule } from '@/types';

const KEY = 'modsutd.contributed.v3';

const SLOT = {
  type: 'Lecture', day: 'Monday', startTime: '09:00', endTime: '10:30',
  location: '1.502', instructors: [],
} as unknown as Schedule;
const one = (...codes: string[]) =>
  Object.fromEntries(codes.map((c) => [c, [SLOT]]));

// A batch chat needs crowdsourced schedules, and those only reach the browser
// through the deployed bundle. Between pasting and the next deploy, the mod
// just contributed looked exactly like one nobody is taking.
describe('a mod this browser contributed, waiting on the next deploy', () => {
  beforeEach(() => localStorage.clear());

  it('knows nothing about a mod nobody here pasted', () => {
    expect(awaitingDeploy('60.006', false)).toBe(false);
  });

  it('waits for a mod this browser pasted', () => {
    rememberContributed(one('60.006', '01.400'), '2026-12-12');
    expect(awaitingDeploy('60.006', false)).toBe(true);
    expect(awaitingDeploy('01.400', false)).toBe(true);
    expect(awaitingDeploy('10.013', false)).toBe(false);
  });

  // The whole point of keying on the deployed data: the note cannot outlive
  // the thing it is describing.
  it('forgets the moment the deployed data has schedules', () => {
    rememberContributed(one('60.006'));
    expect(awaitingDeploy('60.006', true)).toBe(false);
    // and stays forgotten, so it cannot come back on the next render
    expect(awaitingDeploy('60.006', false)).toBe(false);
  });

  it('ages out, so slots that were rejected stop promising a button', () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(KEY, JSON.stringify({ '60.006': old }));
    expect(awaitingDeploy('60.006', false)).toBe(false);
  });

  it('survives junk in the key rather than throwing at render', () => {
    localStorage.setItem(KEY, 'not json');
    expect(awaitingDeploy('60.006', false)).toBe(false);
    localStorage.setItem(KEY, JSON.stringify({ '60.006': 'yesterday' }));
    expect(awaitingDeploy('60.006', false)).toBe(false);
  });

  it('clears the key when the last entry goes, rather than leaving {}', () => {
    rememberContributed(one('60.006'));
    awaitingDeploy('60.006', true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  // The term end travels with the entry so the waiting state does not depend on
  // term-window.json, which is written by the contribution workflow and read
  // back through GitHub's raw CDN. On the first paste of a term that file is
  // still empty, which is exactly the window this state exists to cover.
  it('waits without any deployed term window', () => {
    rememberContributed(one('60.006'), '2099-12-12');
    expect(awaitingDeploy('60.006', false)).toBe(true);
  });

  // A stale timetable still parses and renders. It must not promise a chat.
  it('drops an entry whose own term has already ended', () => {
    rememberContributed(one('60.006'), '2020-01-01');
    expect(awaitingDeploy('60.006', false)).toBe(false);
    expect(localStorage.getItem(KEY)).toBe(null);
  });

  // Weekly pastes never reach rememberContributed - they return before the
  // relay post. Pinned here because the button is the visible half of that.
  it('offers nothing for a mod that was never remembered', () => {
    rememberContributed(one('60.006'), '2099-12-12');
    expect(awaitingDeploy('01.400', false)).toBe(false);
  });

  it('tells an open panel to re-read', () => {
    let fired = 0;
    window.addEventListener(CONTRIBUTED_EVENT, () => { fired += 1; });
    rememberContributed(one('60.006'), '2099-12-12');
    expect(fired).toBe(1);
  });

  // The overlay is what makes a contribution visible before the build. It fills
  // an empty mod and never touches one the build already filled: the local copy
  // is one browser's reading of one timetable, the folded file is everyone's.
  describe('overlayLocal', () => {
    const mod = (code: string, schedules: Schedule[] = []) =>
      ({ code, name: code, schedules }) as unknown as Mod;

    it('fills a mod the build has not shipped yet', () => {
      rememberContributed(one('60.006'), '2099-12-12');
      expect(overlayLocal([mod('60.006')])[0].schedules).toHaveLength(1);
    });

    it('never overwrites what the build shipped', () => {
      rememberContributed(one('60.006'), '2099-12-12');
      const deployed = [mod('60.006', [SLOT, SLOT])];
      expect(overlayLocal(deployed)[0].schedules).toHaveLength(2);
    });

    // It reads and never writes. Two loaders call it at once, and during a
    // deploy those two fetches of courses.json can come back with DIFFERENT
    // bodies - so a version that forgot on sight dropped the entry from the
    // fetch that saw the new file while the other was still rendering the old
    // one, and the contribution vanished on reload.
    it('never forgets on its own, however it is called', () => {
      rememberContributed(one('60.006'), '2099-12-12');
      overlayLocal([mod('60.006', [SLOT])]);   // as if the build had landed
      overlayLocal([mod('60.006')]);           // and the other fetch had not
      expect(localStorage.getItem(KEY)).toContain('60.006');
      expect(overlayLocal([mod('60.006')])[0].schedules).toHaveLength(1);
    });

    it('marks what it filled, so a caller can tell it from shipped data', () => {
      rememberContributed(one('60.006'), '2099-12-12');
      expect(overlayLocal([mod('60.006')])[0].localSchedules).toBe(true);
      expect(overlayLocal([mod('60.006', [SLOT])])[0].localSchedules).toBeUndefined();
    });
  });

  // Forgetting is one deliberate pass over the settled catalogue, not a side
  // effect of whichever fetch answered first.
  describe('pruneContributed', () => {
    const mod = (code: string, schedules: Schedule[] = [], local = false) =>
      ({ code, name: code, schedules, ...(local ? { localSchedules: true } : {}) }) as unknown as Mod;

    it('forgets a mod the build has shipped', () => {
      rememberContributed(one('60.006'), '2099-12-12');
      pruneContributed([mod('60.006', [SLOT])]);
      expect(localStorage.getItem(KEY)).toBe(null);
    });

    it('keeps one whose schedules are still only ours', () => {
      rememberContributed(one('60.006'), '2099-12-12');
      pruneContributed([mod('60.006', [SLOT], true)]);
      expect(localStorage.getItem(KEY)).toContain('60.006');
    });

    it('keeps one the build still has nothing for', () => {
      rememberContributed(one('60.006'), '2099-12-12');
      pruneContributed([mod('60.006')]);
      expect(localStorage.getItem(KEY)).toContain('60.006');
    });

    it('leaves every other mod alone', () => {
      rememberContributed(one('60.006'), '2099-12-12');
      expect(overlayLocal([mod('01.400')])[0].schedules).toHaveLength(0);
    });
  });
});
