import type { TimetableEvent, LessonType } from '@/types';

// Privacy contract: only (mod, type, day, start, end, venue) leaves the
// browser - no instructor names, no dates. Slots go to the anonymous
// /api/contribute relay (see api/), which re-validates them into
// a human-reviewed data PR; no GitHub account involved anywhere.
export interface OccupancySlot {
  mod: string;
  type: string;
  day: string;
  start: string;
  end: string;
  venue: string;
}

// The relay and tools/fold_slots.py both accept only these, and a slot that
// fails either is dropped server-side after the UI has already said thanks.
// Filtering here keeps the two gates strict while making the loss visible and
// testable. A suffixed code (50.002X) is a different offering, so it is
// dropped rather than folded into the base mod's room data.
const CANONICAL_TYPES: ReadonlySet<string> = new Set<LessonType>([
  'Lecture', 'Cohort', 'Tutorial', 'Lab', 'Studio', 'Seminar', 'Recitation',
]);
// A code may carry a letter: SUTD splits a course into 03.007A and 03.007B
// rather than issuing a second number. Without the suffix every slot for a
// lettered mod was dropped here in silence, and 03.007A/B are freshmore
// core - most of a cohort's timetable would have gone missing.
export const CANONICAL_MOD = /^\d{2}\.\d{3}[A-Za-z]?$/;

// The sample timetable uses real course codes so the app behaves normally
// when testing, which means a stray paste would otherwise auto-commit invented
// schedules. The marker rides in the text itself, so it survives copy-paste.
export const SAMPLE_MARKER = 'modSUTD SYNTHETIC SAMPLE';

export function isSampleTimetable(text: string): boolean {
  return text.includes(SAMPLE_MARKER);
}

export function eventsToSlots(events: TimetableEvent[]): OccupancySlot[] {
  const slots: OccupancySlot[] = [];
  for (const e of events) {
    if (!e.location?.trim()) continue;
    if (!CANONICAL_TYPES.has(e.type)) continue;
    if (!CANONICAL_MOD.test(e.modCode)) continue;
    slots.push({
      mod: e.modCode,
      type: e.type,
      day: e.day,
      start: e.startTime,
      end: e.endTime,
      venue: e.location.trim(),
    });
  }
  const seen = new Set<string>();
  return slots.filter((s) => {
    const k = `${s.mod}|${s.venue}|${s.day}|${s.start}|${s.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// The relay throttles per IP per minute, and the whole campus shares one
// address - so on launch day a student can be refused through no fault of
// their own. Retrying turns the cap into a delay instead of lost data, which
// is the only reason the cap is safe to have at all.
//
// Fire-and-forget from the caller's view: their own timetable already parsed
// and rendered, this only decides whether the thanks is honest.
const RETRY_DELAYS_MS = [4000, 15000];

// The span is a discriminated union rather than two optional strings, because
// only a List View paste knows one. The Weekly Calendar View shows a single
// week: any term end read off it is invented, and it would anchor the
// batch-chat window and expiry to a five-day term. `source: 'weekly'` makes
// that unrepresentable instead of relying on the caller returning early.
export type ContributionSpan =
  | { source: 'list'; termStart: string; termEnd: string }
  | { source: 'weekly' };

export async function postSlots(payload: {
  term: string;
  span: ContributionSpan;
  slots: OccupancySlot[];
}): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      const { term, span, slots } = payload;
      res = await fetch('/api/contribute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          span.source === 'list'
            ? { term, termStart: span.termStart, termEnd: span.termEnd, slots }
            : { term, slots },
        ),
      });
    } catch {
      return false; // offline or blocked - nothing to retry against
    }
    if (res.ok) return true;
    // Only a throttle is worth repeating. A 422 means the slots were rejected
    // and will be rejected again; a 503 means contributions are switched off.
    if (res.status !== 429 || attempt >= RETRY_DELAYS_MS.length) return false;
    const jitter = RETRY_DELAYS_MS[attempt] * (0.5 + Math.random());
    await new Promise((r) => setTimeout(r, jitter));
  }
}
