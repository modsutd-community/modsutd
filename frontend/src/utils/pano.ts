import type { Venue } from '@/types';

// The virtual tour photographed a sample of rooms, not all 225. A cohort
// classroom that was not photographed still looks like the ones that were, so
// showing a room of the same type is more use than showing nothing - 1.412 had
// a 360 view and 1.407, 1.410A, 1.411 and 1.511 did not, for no reason a
// student could see.
//
// Only within a type whose rooms are built to one template, and only where
// enough of them were photographed for the stand-in to be typical - see below.
// Everywhere else it shows nothing rather than a room that is not this one.

/**
 * Types whose rooms are built to one template, so any of them stands for the
 * rest.
 *
 * Cohort Classroom is the only one, and it is not a judgement call: they are
 * numbered 1 to 16 and 19 of the 28 were photographed, so the stand-in is a
 * room the reader could have been shown anyway.
 *
 * Every other type fails on the same point, that ONE room carries the tour and
 * it is not typical of the rest:
 *
 *   Lab (56 rooms, 1 photographed)  the Fab Lab. Handing it to the SUTD
 *     Cleanroom, the Furnace Lab or Chemistry Biology Learning Lab shows a
 *     maker space to someone looking up a wet lab.
 *   Studio (20, 1)  Dance Studio 1, which would stand in for the architecture
 *     studios and the Academic Media Studio.
 *   Lecture Theatre (7, 1)  the Auditorium, the largest room on campus, for
 *     Lecture Theatre 2.
 *
 * Think Tank, Meeting Room and Seminar Room have no tour at all, so they
 * borrow nothing either way. Adding a type here is a data question: it needs
 * enough photographed rooms that the stand-in is representative, not one.
 */
const TEMPLATED_TYPES = new Set<string>(['Cohort Classroom']);

export interface PanoSource {
  scenes: NonNullable<Venue['panoScenes']>;
  /** The room these scenes are actually of. */
  from: string;
}

/**
 * The 360 scenes to show for a venue: its own, or a stand-in of the same type.
 *
 * The stand-in is chosen by code order rather than "first in the list" so the
 * same room always represents a type - a tour that changes identity between
 * visits reads as a bug.
 */
export function panoFor(venue: Venue | undefined, all: Venue[]): PanoSource | null {
  if (!venue) return null;
  if (venue.panoScenes?.length) {
    return { scenes: venue.panoScenes, from: venue.code };
  }
  if (!venue.type || !TEMPLATED_TYPES.has(venue.type)) return null;

  const stand = all
    .filter((v) => v.type === venue.type && v.code !== venue.code && v.panoScenes?.length)
    .sort((a, b) => a.code.localeCompare(b.code))[0];
  if (!stand) return null;
  return { scenes: stand.panoScenes!, from: stand.code };
}
