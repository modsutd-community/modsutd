// A clock we can defend, for the one thing that needs one: the .ics SEQUENCE.
//
// SEQUENCE decides whether a re-import updates a class or duplicates it, and it
// must only ever rise. The device clock breaks that in both directions - set
// behind, every later export is ignored as stale; set forward, one export
// poisons the ceiling and every correct export afterwards is ignored too. A
// student cannot tell either has happened.
//
// Every HTTP response carries the server's Date header, so the site is already
// being told the real time on load. Recording the offset once costs nothing and
// nothing is transmitted to get it.
//
// Falls back to the device clock when nothing has been recorded - offline, or a
// response without the header. That is no worse than before.
let offsetMs = 0;
let known = false;

export function recordServerDate(header: string | null | undefined): void {
  if (!header) return;
  const server = Date.parse(header);
  if (!Number.isFinite(server)) return;
  offsetMs = server - Date.now();
  known = true;
}

export function serverNow(): number {
  return Date.now() + offsetMs;
}

// Exposed so the exporter can say whether it is working from a trusted clock.
export function serverTimeKnown(): boolean {
  return known;
}

// Test seam - resets the module between cases.
export function __resetServerTime(): void {
  offsetMs = 0;
  known = false;
}
