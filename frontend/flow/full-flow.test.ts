import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseTimetableText } from '@/utils/timetableParser';
import { eventsToSlots } from '@/utils/contributeTimetable';
import { SAMPLE_LIST_VIEW } from '@/utils/sampleTimetable';

// The whole contribution path, end to end and offline: paste text -> parser ->
// slots -> the same fold_slots.py the workflow runs -> /data. It writes real
// files, so it refuses to start unless /data is clean and it restores /data
// afterwards whether it passed or failed.
//
//   npm run flow
//
// It never touches the network and never creates a Telegram group: the term
// window it writes is reverted with everything else.

const REPO = path.resolve(__dirname, '..', '..');
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();

const COURSE = path.join(REPO, 'data', 'courses', '30_111.json');
const TERM_WINDOW = path.join(REPO, 'data', 'term-window.json');

function schedulesOf(file: string): Array<Record<string, string>> {
  return JSON.parse(readFileSync(file, 'utf8')).schedules ?? [];
}

describe('contribution flow: paste -> slots -> fold_slots -> /data', () => {
  let before = 0;

  beforeAll(() => {
    const dirty = git('status', '--porcelain', 'data');
    if (dirty) {
      throw new Error(
        `/data has uncommitted changes, refusing to run - this test restores by\n` +
        `discarding them. Commit or stash first:\n${dirty}`,
      );
    }
    expect(existsSync(COURSE)).toBe(true);
    before = schedulesOf(COURSE).length;
  });

  afterAll(() => {
    // Restore whether or not the assertions passed. Untracked files (a
    // term-window.json created from nothing) need the clean, not the checkout.
    git('checkout', '--', 'data');
    git('clean', '-fd', 'data');
  });

  it('parses the sample into contributable slots', () => {
    const events = parseTimetableText(SAMPLE_LIST_VIEW);
    const slots = eventsToSlots(events);
    expect(slots.length).toBeGreaterThan(0);
    // Everything that survives eventsToSlots must satisfy the relay's gates,
    // or it would be dropped server-side after the UI said thanks.
    for (const s of slots) {
      expect(s.mod).toMatch(/^\d{2}\.\d{3}$/);
      expect(['Lecture', 'Cohort', 'Tutorial', 'Lab', 'Studio', 'Seminar', 'Recitation'])
        .toContain(s.type);
    }
    expect(slots.some((s) => s.mod === '30.111' && s.venue === '2.507')).toBe(true);
    // The suffixed variant is a different offering and must not ride along.
    expect(slots.some((s) => s.mod.startsWith('50.002'))).toBe(false);
  });

  it('folds those slots into /data through the real workflow script', () => {
    const events = parseTimetableText(SAMPLE_LIST_VIEW);
    const slots = eventsToSlots(events);
    const dates = events.flatMap((e) => [e.startDate, e.endDate]).filter(Boolean).sort();

    const out = execFileSync('python3', ['tools/fold_slots.py'], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        PAYLOAD: JSON.stringify({
          term: 'Term 1, AY2026/27',
          termStart: dates[0],
          termEnd: dates[dates.length - 1],
          slots,
        }),
      },
    });

    expect(out).toMatch(/added \d+ slot/);
    const after = schedulesOf(COURSE);
    expect(after.length).toBeGreaterThan(before);
    expect(after.some((s) => s.location === '2.507' && s.type === 'Cohort')).toBe(true);
    // Contributed schedules carry no instructor - the privacy contract.
    expect(after.every((s) => (s.instructors as unknown as string[]).length === 0)).toBe(true);
  });

  it('opens the term window, which is what makes a mod chat-eligible', () => {
    const win = JSON.parse(readFileSync(TERM_WINDOW, 'utf8') || '{}');
    expect(win.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is idempotent - a second identical contribution adds nothing', () => {
    const events = parseTimetableText(SAMPLE_LIST_VIEW);
    const slots = eventsToSlots(events);
    const dates = events.flatMap((e) => [e.startDate, e.endDate]).filter(Boolean).sort();
    const count = schedulesOf(COURSE).length;

    const out = execFileSync('python3', ['tools/fold_slots.py'], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        PAYLOAD: JSON.stringify({
          term: 'Term 1, AY2026/27',
          termStart: dates[0],
          termEnd: dates[dates.length - 1],
          slots,
        }),
      },
    });

    expect(out).toMatch(/added 0 slot/);
    expect(schedulesOf(COURSE).length).toBe(count);
  });
});
