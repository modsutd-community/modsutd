// The batch-chat button has four states and one rule for choosing between
// them. Pure and React-free on purpose: the states were previously spread
// across a `useState`, two localStorage readers and a network probe, and no
// two of them agreed - so this is a table a test can drive directly.

export type TeleState = 'none' | 'committing' | 'ready' | 'creating' | 'live';

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
  return f.committed ? 'ready' : 'none';
}
