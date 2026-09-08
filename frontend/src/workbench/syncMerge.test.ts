// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pushBackup } from './sync';
import { newerSections, stampChanged, readStamps } from './sectionSync';
import type { BackupBundle } from './backup';
import { SECTIONS } from './backup';
import { exportConsent, importConsent } from './logic';
import { exportPrefs, importPrefs, STORAGE_KEY } from './prefs';

// The two things a student actually did, and what each used to do.
//
//   "i cleared the timetable on mobile, how come it isnt cleared on computer?"
//   "if i cleared on my phone but then ... i do another action on computer on
//    the old timetable, then the old timetable gets back into the mobile right?"
//
// Both were yes. Deletion could never propagate, and every push stamped every
// section, so whoever pushed last republished their whole state and won.

const GIST_ID = 'g1';
const FILE = 'modsutd-records.json';

const bundle = (over: Partial<BackupBundle> = {}): BackupBundle => ({
  records: {} as BackupBundle['records'],
  plans: {} as BackupBundle['plans'],
  declared: [],
  timetable: [],
  contributed: {},
  ...over,
}) as BackupBundle;

const slot = { day: 'Monday' } as unknown as NonNullable<BackupBundle['timetable']>[number];

describe('a push does not clobber the other device', () => {
  let remote: BackupBundle;
  let patched: BackupBundle | null;
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('modsutd.gh.token.v1', 'tok');
    patched = null;
    remote = bundle();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/gists?per_page')) {
        return { ok: true, json: async () => [{ id: GIST_ID, description: 'modSUTD records (private) - notes, scores, plan backups' }] };
      }
      if (u.endsWith(`/gists/${GIST_ID}`) && (!init || !init.method)) {
        return { ok: true, json: async () => ({ files: { [FILE]: { content: JSON.stringify(remote) } } }) };
      }
      if (u.endsWith(`/gists/${GIST_ID}`) && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { files: Record<string, { content: string }> };
        patched = JSON.parse(body.files[FILE].content) as BackupBundle;
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The laptop edits a NOTE. Its own timetable is stale - the phone replaced it
  // an hour ago - and the laptop must not republish the stale one.
  it('an edit to one section leaves the others as the gist has them', async () => {
    remote = bundle({
      timetable: [slot],
      stamps: { timetable: 9_000, records: 1_000 },
    });
    stampChanged(['timetable'], 1_000); // this browser last saw the old timetable
    stampChanged(['records'], 500);

    await pushBackup(bundle({ timetable: [] }), ['records']);

    expect(patched).not.toBeNull();
    // The phone's timetable survived the laptop's push.
    expect(patched!.timetable).toHaveLength(1);
    // And it kept the phone's stamp, so nothing ages it forward.
    expect(patched!.stamps?.timetable).toBe(9_000);
  });

  // The clear itself. The laptop is the one clearing, so `changed` names it and
  // the empty array is what lands in the gist.
  it('a section this browser cleared is pushed as empty', async () => {
    remote = bundle({ timetable: [slot], stamps: { timetable: 1_000 } });
    await pushBackup(bundle({ timetable: [] }), ['timetable']);
    expect(patched!.timetable).toEqual([]);
    expect(patched!.stamps!.timetable!).toBeGreaterThan(1_000);
  });
});

describe('what the other device takes from a pull', () => {
  beforeEach(() => localStorage.clear());

  // The phone cleared; the laptop must apply it. Refusing empty sections is
  // what made a deletion invisible forever.
  it('applies a clear that is genuinely newer', () => {
    stampChanged(['timetable'], 1_000);
    const remote = bundle({ timetable: [], stamps: { timetable: 2_000 } });
    expect(newerSections(remote)).toContain('timetable');
  });

  it('ignores a clear that is older than local work', () => {
    stampChanged(['timetable'], 5_000);
    const remote = bundle({ timetable: [], stamps: { timetable: 2_000 } });
    expect(newerSections(remote)).not.toContain('timetable');
  });

  it('stamps only the sections it changed', () => {
    stampChanged(['records', 'timetable'], 100);
    stampChanged(['records'], 900);
    expect(readStamps().timetable).toBe(100);
    expect(readStamps().records).toBe(900);
  });
});


// Everything a student does has to reach the other device. The sections are
// the whole contract, so this is the list that must not quietly shrink.
describe('what the bundle carries', () => {
  it('carries every part of the state a student builds up', () => {
    expect(SECTIONS).toEqual([
      'records', 'plans', 'declared', 'timetable',
      'contributed', 'teleAsked', 'consent', 'prefs',
    ]);
  });

  // One way only. The gate has no revoke button, so clearing site data is how
  // a person withdraws it - and a sync able to carry `false` would be one
  // device silently undoing a permission another one gave.
  it('lets consent travel on, never off', () => {
    localStorage.clear();
    importConsent(true);
    expect(exportConsent()).toBe(true);
    importConsent(false);
    expect(exportConsent()).toBe(true);
  });

  // Settings carry; where you are looking does not.
  it('carries settings but not the search box or the open mod', () => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      freshmoreMode: 'ay2025', showRetired: true, currentTerm: 5, sortKey: 'term',
      filter: 'nlp', selected: '50.040', mobileTab: 'rooms',
    }));
    const out = exportPrefs();
    expect(out).toMatchObject({ freshmoreMode: 'ay2025', showRetired: true, currentTerm: 5 });
    expect(out).not.toHaveProperty('filter');
    expect(out).not.toHaveProperty('selected');
    expect(out).not.toHaveProperty('mobileTab');
  });

  it('applies pulled settings and reports whether anything moved', () => {
    localStorage.clear();
    expect(importPrefs({ showRetired: true })).toBe(true);
    expect(exportPrefs().showRetired).toBe(true);
    expect(importPrefs({ showRetired: true })).toBe(false);
  });
});


// The state two real devices were stuck in: both ran a version that stamped
// every section on every push, so each carried a timetable stamp from the last
// time it pushed anything at all. A clear made on one could land EARLIER than
// the other's inherited stamp and be refused for good.
describe('stamps written by the old all-sections push', () => {
  beforeEach(() => localStorage.clear());

  it('are discarded rather than believed', () => {
    // What the old code left behind: every section at one late timestamp.
    localStorage.setItem('modsutd.sync.stamps.v1', JSON.stringify({
      records: 9_000_000, plans: 9_000_000, declared: 9_000_000,
      timetable: 9_000_000, contributed: 9_000_000,
    }));
    expect(readStamps()).toEqual({});

    // So the other device's clear is taken, instead of losing to a number that
    // never described the timetable in the first place.
    const remote = bundle({ timetable: [], stamps: { timetable: 1_000 } });
    expect(newerSections(remote)).toContain('timetable');
  });
});
