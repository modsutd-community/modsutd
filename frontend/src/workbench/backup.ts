import type { Curriculum, PlanState, RecordsState, TimetableEvent } from '@/types';

// Everything one student's browser knows, in one exportable blob: records,
// both curricula's plans, declared tracks, the parsed timetable, and the
// contributed-but-not-yet-deployed state.
//
// The last two are new, and they are the reason a student had to paste their
// timetable twice - once on the laptop and again on the phone - and still saw
// two different answers on the two devices, because localStorage does not
// travel. Old exports were bare RecordsState, then records+plans+declared;
// importers accept every shape.
export interface BackupBundle {
  records: RecordsState;
  plans: Record<Curriculum, PlanState>;
  declared: string[];
  /** The parsed timetable, so a second browser does not need the paste. */
  timetable?: TimetableEvent[];
  /** Raw contents of the contributed-awaiting-deploy store, keyed by mod. */
  contributed?: Record<string, unknown>;
  /**
   * When a chat was asked for, keyed by mod. Carried so the OTHER browser can
   * show "creating the chat" too: the ask is an action this student took, and
   * a device that cannot see it offers a button that would ask again.
   */
  teleAsked?: Record<string, number>;
  /**
   * The timetable consent tick. Carried because the person is the same person:
   * their timetable already travels, so device two was showing a gate asking
   * permission to contribute slots that device one had already contributed.
   * Note this makes docs/architecture.md's "never leaves your browser" false
   * for this flag, which is why that file changed with it.
   */
  consent?: boolean;
  /**
   * Settings, not view state. Which curriculum, whether retired mods show, the
   * term and pillar being planned, the sort, and whether autosave is on - a
   * student answers each of those once and means it on every device.
   * Deliberately NOT the search box, the selected mod or the mobile tab: those
   * are where you are looking right now, and a phone that jumped to whatever
   * the laptop had open would be worse than one that did not sync at all.
   */
  prefs?: Record<string, unknown>;
  /**
   * When each section was last written, in ms. Sync is newest-wins PER
   * SECTION: a phone that only ever edits notes must not push a stale
   * timetable over the one the laptop pasted an hour ago.
   */
  stamps?: Partial<Record<BundleSection, number>>;
}

export type BundleSection =
  | 'records'
  | 'plans'
  | 'declared'
  | 'timetable'
  | 'contributed'
  | 'teleAsked'
  | 'consent'
  | 'prefs';

export const SECTIONS: BundleSection[] = [
  'records',
  'plans',
  'declared',
  'timetable',
  'contributed',
  'teleAsked',
  'consent',
  'prefs',
];

/**
 * Everything this browser would put in the gist.
 *
 * ONE BUILDER, because there were two and they disagreed. The autosave sent all
 * eight sections; the manual "save to github now" button sent five, and
 * pushBackup defaults `changed` to every section - so the three the button left
 * out were written as undefined OVER the gist. Pressing save wiped teleAsked,
 * consent and prefs, which is the timetable consent flag and every setting.
 *
 * The redux half is passed in because this is not a hook; everything else is
 * read from its own store.
 */
export function liveBundle(
  from: Pick<BackupBundle, 'records' | 'plans' | 'declared' | 'timetable'>,
  extras: {
    contributed: Record<string, unknown>;
    teleAsked: Record<string, number>;
    consent: boolean;
    prefs: Record<string, unknown>;
  },
): BackupBundle {
  return { ...from, ...extras };
}

export function isBundle(x: unknown): x is BackupBundle {
  return !!x && typeof x === 'object' && 'records' in (x as Record<string, unknown>)
    && 'plans' in (x as Record<string, unknown>);
}
