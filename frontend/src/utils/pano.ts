import type { Venue } from '@/types';

// The virtual tour photographed a sample of rooms, not all 225. A cohort
// classroom that was not photographed still looks like the ones that were, so
// showing a room of the same type is more use than showing nothing - 1.412 had
// a 360 view and 1.407, 1.410A, 1.411 and 1.511 did not, for no reason a
// student could see.
//
// It has to say so. A tour of a different room presented as this one is worse
// than no tour: a reader would take the furniture, the whiteboard, the door
// position as facts about a room nobody photographed.

export interface PanoSource {
  scenes: NonNullable<Venue['panoScenes']>;
  /** The room these scenes are actually of. */
  from: string;
  /** True when `from` is a different room of the same type. */
  representative: boolean;
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
    return { scenes: venue.panoScenes, from: venue.code, representative: false };
  }
  // A facility is its own thing - the library does not stand in for the gym -
  // so only room types borrow.
  if (!venue.type || venue.type === 'Facility') return null;

  const stand = all
    .filter((v) => v.type === venue.type && v.code !== venue.code && v.panoScenes?.length)
    .sort((a, b) => a.code.localeCompare(b.code))[0];
  if (!stand) return null;
  return { scenes: stand.panoScenes!, from: stand.code, representative: true };
}
