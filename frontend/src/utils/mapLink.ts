// Deep links into the third-party indoor map of campus.
//
// It resolves ?location= by EXACT label and falls back to the whole-campus
// view on anything else, with no error and no distinguishable HTTP status -
// so a stale label is invisible. mapLink.test.ts pins every stored label
// against its own venue code, and sync-data.mjs re-checks it at build time.
//
// We store labels, never geometry: the map is someone else's, and its data
// is not ours to mirror.
const MAP_ID = '6608dfd37c0c4fe5b4cc47fa';
const BASE = `https://app.mappedin.com/map/${MAP_ID}`;

export function mapLink(mapName: string, from?: string | null): string {
  const to = encodeURIComponent(mapName);
  if (!from) return `${BASE}?location=${to}`;
  return `${BASE}/directions?location=${to}&departure=${encodeURIComponent(from)}`;
}
