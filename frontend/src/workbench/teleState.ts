// The batch-chat button has four states and one rule for choosing between
// them. Pure and React-free on purpose: the states were previously spread
// across a `useState`, two localStorage readers and a network probe, and no
// two of them agreed - so this is a table a test can drive directly.

import type { Mod } from '@/types';
import { modPillars } from './pillars';

export type TeleState =
  | 'none' | 'committing' | 'ready' | 'creating' | 'live' | 'capped';

// Telegram allows 50 groups or channels a day per ACCOUNT and answers a 51st
// with a flood error, so `telegram-group.yml` stops at 40 and leaves room for
// the handover sweep and a retry. Named here as well because the workflow
// cannot be imported and a button that dispatches an ask the gate will drop is
// a button that lies. Change one, change the other: the gate and its
// commit-time re-check are the two copies in `.github/workflows/telegram-group.yml`.
export const DAILY_CREATE_CAP = 40;

/**
 * Whether today's group creations have used the cap up.
 *
 * Counted off the registry the browser already reads from main, because every
 * entry carries the `createdDay` the workflow's own gate counts. No new file
 * and nothing to keep in step: it is the same number read from the same place.
 *
 * The date is UTC on both sides. A runner's `datetime.date.today()` is UTC and
 * so is `toISOString()`, which matters: a Singapore-local date would disagree
 * with the gate for the eight hours after midnight SGT and the button would
 * promise a chat the workflow refuses.
 */
export function capReached(
  registry: Record<string, { createdDay?: string }>,
  today = new Date().toISOString().slice(0, 10),
): boolean {
  let made = 0;
  for (const entry of Object.values(registry)) {
    if (entry.createdDay === today) made += 1;
  }
  return made >= DAILY_CREATE_CAP;
}

// Capstone and thesis mods get no batch chat: students are split across their
// own project teams, so a cohort-wide group is noise. A fallback for records
// that predate the flag and for anything SUTD names a capstone before anyone
// marks it. `noBatchChat` in the data is the real list.
const SOLO_PROJECT = /capstone|thesis/i;

/**
 * Whether a chat is the kind of thing this mod gets at all.
 *
 * Here rather than in the panel that draws the button, because the catalogue
 * marks the same mods in its own column and two copies of this rule would
 * disagree the first time either moved. Nothing is fetched, so it is knowable
 * on the first render of either.
 */
export function chatEligible(mod: Mod): boolean {
  return (
    (Number(mod.term) >= 3 || modPillars(mod).includes('HASS'))
    && !mod.noBatchChat
    && !SOLO_PROJECT.test(mod.name)
  );
}


/**
 * Whether there is a chat to point at: one that exists, or one the button
 * would actually make.
 *
 * Eligibility alone is a property of the record and stays true forever, so it
 * marked every HASS course in the catalogue including the ones not offered
 * this term. The registry alone is too narrow the other way: a mod running
 * this term whose chat nobody has asked for yet is exactly the row worth
 * marking, because one click makes it.
 *
 * So it is the workflow's own gate, minus the parts only the server can know:
 * eligible, running this term (which is what a non-empty `schedules` means,
 * since slots only arrive from a contributed timetable), and inside the term
 * window. Plus anything already in the registry and unexpired.
 */
export function chatOffered(
  mod: Mod,
  entry: { expires?: string } | undefined,
  termEnd: string | undefined,
  today = new Date().toISOString().slice(0, 10),
): boolean {
  if (entry?.expires && today <= entry.expires) return true;
  if (!chatEligible(mod)) return false;
  // No slots means nobody is taking it this term as far as this repo knows,
  // and `telegram-group.yml` refuses it with skip=not-offered.
  if (!mod.schedules?.length) return false;
  return !!termEnd && today <= termEnd;
}

export interface TeleFacts {
  /** Term >= 3 or HASS, not noBatchChat, not a capstone or thesis. */
  chatMod: boolean;
  /** A live registry entry exists for this mod. */
  entry: boolean;
  /** When this browser asked for the group, or null once past the TTL. */
  askedAt: number | null;
  /** The term window covers today. */
  termOk: boolean;
  /** The slots are on main - deployed, or the raw-main probe says so. */
  committed: boolean;
  /** This browser pasted for this mod and the commit has not landed yet. */
  committing: boolean;
  /** Today's group creations have used the daily cap up. */
  capped: boolean;
}

/**
 * Which button to draw.
 *
 * Order is the whole design, so each step says why it sits where it does.
 */
export function teleState(f: TeleFacts): TeleState {
  if (!f.chatMod) return 'none';

  // Outranks everything, including the term window: the entry carries its own
  // expiry, and on the first paste of a term the deployed term-window.json is
  // still empty.
  if (f.entry) return 'live';

  // Above termOk AND above committed. An ask is itself evidence the slots were
  // on main when the button was pressed, because READY is the only state that
  // can be clicked - so a reload mid-create draws CREATING straight out of
  // localStorage with no network round trip.
  if (f.askedAt !== null) return 'creating';

  // Also above termOk. term-window.json is written by the contribution
  // workflow, so on the first paste of a term it is empty, and a state gated
  // on it would be invisible during exactly the window it describes.
  if (f.committing) return 'committing';

  // termOk gates only READY, which is the only state that fires a dispatch,
  // which is the only place the workflow's own no-live-term gate can bite.
  if (!f.termOk) return 'none';
  if (!f.committed) return 'none';

  // Last, and below every state that describes a chat already made or already
  // asked for: the cap is about making a NEW one, and it is the only reason
  // left that the dispatch would be dropped. Above READY because a pressed
  // button whose ask the gate silently drops leaves the student watching
  // "creating the chat..." for ten minutes and then back where they started.
  return f.capped ? 'capped' : 'ready';
}
