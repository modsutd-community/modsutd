import MiniSearch, { type SearchResult as MSResult } from 'minisearch';
import type { Mod, Venue } from '@/types';

export type SearchKind = 'mod' | 'venue';

export interface SearchResult {
  kind: SearchKind;
  code: string;
  name: string;
  meta: string;
  score: number;
}

// SUTD-specific shortcuts students actually type, matched in BOTH directions:
// a doc saying "HASS" gains the long form, and a doc saying "Think Tank 21"
// gains "tt" and "tt21". Only the first direction existed before, which left
// every entry whose abbreviation never appears in the text (ml, lt, cc, tt)
// dead - no course is written "ml", so a query for it matched nothing.
// Keep this small and high-precision; one bad synonym pollutes every result.
const SYNONYMS: Record<string, string> = {
  // The ASD curriculum grid calls 20.501 "Sustainable Design Option Studio 3";
  // its own course page, which the catalogue follows, calls it Graduate
  // Studio. Both names are real, so both have to find it.
  'sustainable design option studio': 'graduate studio',
  ml:          'machine learning',
  ai:          'artificial intelligence',
  dl:          'deep learning',
  nlp:         'natural language processing',
  cv:          'computer vision',
  os:          'operating systems',
  algo:        'algorithm',
  dsa:         'data structures algorithms',
  calc:        'calculus',
  diffeq:      'differential equations',
  prob:        'probability',
  stats:       'statistics',
  thermo:      'thermodynamics',
  oop:         'object oriented programming',
  fp:          'functional programming',
  webdev:      'web development',
  econ:        'economics',
  micro:       'microeconomics',
  macro:       'macroeconomics',
  hass:        'humanities arts social sciences',
  fyp:         'final year capstone project',
  freshmore:   'freshmore foundation core',
  // room types, because nobody types "cohort classroom 5" into a room finder
  tt:          'think tank',
  lt:          'lecture theatre',
  cc:          'cohort classroom',
  mph:         'multipurpose hall',
  ish:         'indoor sports hall',
  gsc:         'graduate studies cluster',
  istd:        'information systems technology and design',
  asd:         'architecture and sustainable design',
  esd:         'engineering systems and design',
  epd:         'engineering product development',
  dai:         'design and artificial intelligence',
};

// A typed room code: "5", "5.", "5.1", "2.311", "5.101-0". The dot is what
// makes it one - it is the only separator a plate uses, and its POSITION is
// the whole meaning. Squashing "5.0" to "50" made it a substring of "1.502",
// which is how a search for building 5 answered with nine rooms in building 1.
// A trailing letter is part of the code, not a word: mods split as 03.007A /
// 03.007B, and room plates carry 1.510A. Without it, typing a full lettered
// code fell through to the fuzzy index and ranked by name.
const CODE_QUERY = /^\d{1,2}(\.[\d-]*[A-Za-z]{0,2})?$/;
export const looksLikeCode = (query: string): boolean => CODE_QUERY.test(query.trim());

// The room finder filters with a plain substring test, so it cannot reach the
// index-side `syn` field. Give it the same abbreviations: "tt" has to reach
// "Think Tank 5" the way it already does in the command palette, and "tt21"
// has to reach the numbered one.
export function queryVariants(query: string): string[] {
  const low = fold(query.trim());
  if (!low) return [];
  const out = new Set<string>([low]);
  if (SYNONYMS[low]) out.add(SYNONYMS[low]);
  const numbered = low.match(/^([a-z]+)\s*(\d+)$/);
  if (numbered && SYNONYMS[numbered[1]]) out.add(`${SYNONYMS[numbered[1]]} ${numbered[2]}`);
  // "fab lab" has to reach a room installed as "Fablab", and the reverse. The
  // caller compares with includes(), so hand it the spacing-free form and let
  // it squash the haystack the same way. Never for a code: see CODE_QUERY.
  if (!looksLikeCode(low)) out.add(low.replace(/[^a-z0-9]/g, ''));
  return [...out];
}

/**
 * Venue codes matching a typed code, most specific first: those that start
 * with what was typed, and failing that every room in that building - "5.0"
 * names no room, and building 5 is a better answer than nothing.
 */
export function codeMatches(codes: string[], query: string): string[] {
  const q = fold(query.trim());
  const exact = codes.filter((c) => fold(c).startsWith(q));
  if (exact.length) return exact;
  const building = q.split('.')[0];
  return codes.filter((c) => fold(c).startsWith(`${building}.`));
}

/**
 * Mods whose code answers a typed code, most specific first.
 *
 * The same rule the room finder uses, for the same reason: the catalogue
 * re-sorts by code, which throws away relevance, so a fuzzy hit on a name or a
 * description outranked nothing and "50.0" listed 02.136 above 50.001. A code
 * query is answered by codes or not at all.
 *
 * A leading zero is optional on the way in - "2" and "02" both reach 02.136,
 * because the catalogue prints the padded form and students type either.
 */
export function modCodeMatches(mods: Mod[], query: string): Mod[] {
  const q = fold(query.trim());
  // "2" and "02" both mean pillar 02: the catalogue prints the padded form
  // and students type either. No regex - the first segment's length says it.
  const pad = (q.split('.')[0] ?? '').length === 1 ? `0${q}` : q;
  const starts = (m: Mod) => {
    const c = fold(m.code);
    return c.startsWith(q) || c.startsWith(pad);
  };
  const exact = mods.filter(starts);
  if (exact.length) return exact;
  // Nothing starts with it. The pillar it names is a better answer than none,
  // the way building 5 is for "5.0".
  const head = (q.split('.')[0] || '').padStart(2, '0');
  return mods.filter((m) => fold(m.code).startsWith(`${head}.`));
}

interface ModDoc {
  id: string;
  kind: 'mod';
  code: string;
  name: string;
  description: string;
  pillar: string;
  department: string;
  term: string;
  syn: string;
  plain: string;
}
interface VenueDoc {
  id: string;
  kind: 'venue';
  code: string;
  name: string;
  type: string;
  building: string;
  syn: string;
  plain: string;
  // Mirror the indexable fields from ModDoc with empty values so the unified
  // index doesn't trip TS when we addAll a heterogeneous list.
  description: string;
  pillar: string;
  department: string;
  term: string;
}
type AnyDoc = ModDoc | VenueDoc;

// Extra spellings of the same thing, because a room finder gets typed fast and
// MiniSearch splits on non-word characters. Without these, "fablab" misses Fab
// Lab and "cyber 5g" misses Cyber5G: one runs adjacent words together, the
// other pulls a letter/digit boundary apart, and neither survives tokenizing.
// One-word spellings of two-word things. A document that says "Fablab" has no
// token a query for "fab lab" can prefix-match, so the split has to be indexed
// explicitly. Small and high-precision on purpose, like SYNONYMS: this is the
// list of compounds that actually appear on SUTD signage.
const COMPOUNDS: Record<string, string> = {
  fablab: 'fab lab',
  woodstore: 'wood store',
  makerspace: 'maker space',
  nightowl: 'night owl',
  scrapyard: 'scrap yard',
  cleanroom: 'clean room',
};

// MiniSearch splits on anything outside a-z0-9, so an accented letter is a
// SEPARATOR, not a letter: "form axioms" tokenises to ["f", "rm", "axioms"] and
// a student typing "form" matches nothing. Combining marks come off with NFD;
// the rest are letters in their own right with no decomposition, so they need
// naming. This is search's job, not an altName per accented room - an altName
// renders on screen as an "aka" line, and "aka Form axioms" tells a reader
// nothing they did not already see.
const FOLD: Record<string, string> = {
  'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss',
  'đ': 'd', 'ð': 'd', 'ł': 'l', 'þ': 'th',
};

export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[øæœßđðłþ]/g, (c) => FOLD[c] ?? c);
}

function spellingVariants(text: string): string[] {
  const words = fold(text).split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length - 1; i += 1) out.push(words[i] + words[i + 1]);
  for (const w of words) {
    // Letter-to-digit only. Splitting digit-to-letter as well would turn
    // "cyber5g" into "cyber 5 g" and destroy the "5g" half a student types.
    const split = w.replace(/([a-z])(\d)/g, '$1 $2');
    if (split !== w) out.push(...split.split(' '));
    if (COMPOUNDS[w]) out.push(...COMPOUNDS[w].split(' '));
  }
  return out;
}

function expandSynonyms(text: string): string {
  const low = fold(text);
  const extras: string[] = [];
  for (const t of low.split(/\W+/).filter(Boolean)) if (SYNONYMS[t]) extras.push(SYNONYMS[t]);
  for (const [abbr, long] of Object.entries(SYNONYMS)) {
    if (!low.includes(long)) continue;
    extras.push(abbr);
    // MiniSearch splits on non-word characters, so "tt 21" and "tt21" are
    // different tokens and a numbered room has to answer to both. Every
    // occurrence, not the first: 2.310's type and name both read "Think Tank"
    // before the altName that actually carries the 21.
    // Every SYNONYMS value is plain words, so it needs no regex escaping.
    for (const m of low.matchAll(new RegExp(`${long}\\s*(\\d+)`, 'g'))) extras.push(abbr + m[1]);
  }
  return extras.join(' ');
}

let cached: { ms: MiniSearch<AnyDoc>; mods: Record<string, Mod>; venues: Record<string, Venue> } | null = null;

function buildIndex(mods: Record<string, Mod>, venues: Record<string, Venue>) {
  const ms = new MiniSearch<AnyDoc>({
    fields: ['code', 'name', 'plain', 'description', 'pillar', 'department', 'type', 'building', 'syn'],
    storeFields: ['kind', 'code', 'name', 'pillar', 'term', 'type'],
    searchOptions: {
      // `plain` is the name with the donor bracket removed, weighted like the
      // name itself. Without it "think tank 2" ranks below Think Tank 20/23/24:
      // BM25 normalises by field length, and "Think Tank 2 (Wee Hur)" is five
      // tokens against their three, so the donor was costing the room its own
      // name as a query.
      boost: { code: 6, name: 3, plain: 3, pillar: 2, type: 2, syn: 1.5 },
      // No fuzziness on a short term. At three characters everything is within
      // one edit of everything, so "cc2" fuzzy-matches the bare "cc" on all
      // twenty cohort classrooms and buries the one room it names.
      fuzzy: (term) => (term.length <= 4 ? false : 0.18),
      // Prefix-match everything except a lone digit. "2" must not reach Think
      // Tank 20-29 - that is how the exact room a student typed ended up
      // ranked twelfth behind rooms it only prefixes. Two digits and up keep
      // the prefix, so half-typing a code ("1.31" -> 1.310) still works.
      prefix: (term) => !/^\d$/.test(term),
      // And an exact hit outranks a fuzzy one. MiniSearch weights fuzzy at 0.45
      // by default, enough to float a near-miss above the real answer.
      weights: { fuzzy: 0.15, prefix: 0.375 },
      // A student copying "1.315A" off a timetable is looking for 1.315: the
      // doors are lettered, the room is not, and the letter belongs to neither
      // the name nor the code. Three digits or more before it, so the "5g" in
      // "cyber 5g" keeps its letter.
      tokenize: (q) => fold(q).split(/[^a-z0-9]+/).filter(Boolean)
        .map((t) => t.replace(/^(\d{3,})[a-z]$/, '$1')),
      combineWith: 'AND',
    },
    // Folded on BOTH sides, and as a processTerm rather than a tokenizer:
    // MiniSearch's default tokenizer is Unicode-aware, so replacing it with a
    // [^a-z0-9] split would keep "form axioms" working and quietly destroy any
    // name outside the Latin alphabet. processTerm runs per token, after the
    // split, and leaves the splitting alone.
    processTerm: (term) => fold(term) || null,
    extractField: (doc, field) => (doc as unknown as Record<string, string>)[field] ?? '',
  });

  const docs: AnyDoc[] = [];
  for (const m of Object.values(mods)) {
    docs.push({
      id: `mod:${m.key ?? m.code}`,
      kind: 'mod',
      code: m.code,
      name: m.name,
      description: m.description,
      pillar: m.pillar,
      department: m.department,
      term: m.term,
      plain: '',
      syn: expandSynonyms(`${m.code} ${m.name} ${m.description} ${m.pillar} ${m.department}`),
    });
  }
  for (const v of Object.values(venues)) {
    docs.push({
      id: `venue:${v.code}`,
      kind: 'venue',
      code: v.code,
      name: v.name,
      type: v.type,
      building: v.building,
      plain: v.name.replace(/\s*\([^)]*\)/g, '').trim(),
      description: '',
      pillar: '',
      department: '',
      term: '',
      // altNames ride in `syn` because they are the name half the signage
      // disagrees on: the door plate says "Wee Hur Think Tank", the room is
      // booked as "Think Tank 2". Indexing only `name` makes the other half
      // unfindable, and which half wins `name` is a data rule, not a search one.
      // altNames go through expandSynonyms too, not just alongside it: 2.310 is
      // installed as the Kwan Im Thong Hood Cho Temple Think Tank and only its
      // altName carries "Think Tank 21", which is what "tt21" has to reach.
      syn: [
        expandSynonyms([v.code, v.name, v.type, ...(v.altNames ?? [])].join(' ')),
        ...(v.altNames ?? []),
        // Names carry their donor in brackets - "Think Tank 2 (Wee Hur)". Index
        // the bracket-free form too, or the canonical name a student actually
        // types ranks below every other think tank, which all match "think
        // tank" equally and have nothing competing with the number. This is a
        // search concern, not a data one: the plain form is not an altName and
        // must not show up in the "aka" line.
        v.name.replace(/\s*\([^)]*\)/g, '').trim(),
        // The code is in here too, so "2311" reaches 2.311 by being indexed
        // rather than by happening to fall within a fuzzy edit of it.
        ...spellingVariants([v.code, v.name, v.type, ...(v.altNames ?? [])].join(' ')),
      ]
        .filter(Boolean)
        .join(' '),
    });
  }
  ms.addAll(docs);
  cached = { ms, mods, venues };
}

function ensureIndex(mods: Record<string, Mod>, venues: Record<string, Venue>) {
  if (!cached || cached.mods !== mods || cached.venues !== venues) buildIndex(mods, venues);
}

// Building the index is ~110ms over 372 mods and 224 venues, and it used to be
// paid synchronously on the first character typed. Call this once the data is
// in and the first keystroke is free.
export function warmIndex(mods: Record<string, Mod>, venues: Record<string, Venue>) {
  if (!Object.keys(mods).length || !Object.keys(venues).length) return;
  ensureIndex(mods, venues);
  // The catalogue panel has its own mods-only index, and with no pillar or term
  // filter it is built over exactly this list. Prime it here so the first
  // character typed there is free as well.
  searchMods(WARM_QUERY, Object.values(mods));
}

function metaFor(hit: MSResult): string {
  if (hit.kind === 'mod') return `${hit.pillar} · T${hit.term}`;
  if (hit.kind === 'venue') return hit.type ?? '';
  return '';
}

export function searchEverything(
  query: string,
  mods: Record<string, Mod>,
  venues: Record<string, Venue>,
  limit = 8,
): SearchResult[] {
  const q = query.trim();
  if (!q) return [];
  ensureIndex(mods, venues);
  const out = hits(cached!.ms.search(q), limit);

  // A typed code is a place, and the index does not treat it as one: it splits
  // "3.2" into "3" and "2", neither of which prefixes "201", so 3.201 was
  // missing from its own search. Answer the code first, in code order, then
  // fill the rest of the list from the index.
  if (!looksLikeCode(q)) return out;
  const byCode = codeMatches(Object.keys(venues), q)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, limit)
    .map((code) => ({
      kind: 'venue' as SearchKind,
      code,
      name: venues[code].name,
      meta: venues[code].type ?? '',
      score: Infinity,
    }));
  const seen = new Set(byCode.map((h) => h.code));
  return [...byCode, ...out.filter((h) => h.kind !== 'venue' || !seen.has(h.code))]
    .slice(0, limit);
}

function hits(found: MSResult[], limit: number): SearchResult[] {
  return found.slice(0, limit).map((h) => ({
    kind: h.kind as SearchKind,
    code: h.code,
    name: h.name,
    meta: metaFor(h),
    score: h.score,
  }));
}

// The caller passes a freshly filtered array on every keystroke, so caching on
// array identity never hits. Key on the ids instead: joining 372 codes costs
// microseconds against the ~53ms rebuild it avoids. Two entries is enough - the
// visible list only changes when the pillar or term filter does.
const modIndexCache = new Map<string, MiniSearch<ModDoc>>();

// Matches nothing, so priming the cache costs one build and returns an empty
// list. searchMods returns early on an empty string, so it cannot be used here.
const WARM_QUERY = 'warmindexnomatch';

export function searchMods(query: string, mods: Mod[]): Mod[] {
  const q = query.trim();
  if (!q) return mods;
  // A code query never reaches the index: see modCodeMatches.
  if (looksLikeCode(q)) return modCodeMatches(mods, q);
  const key = mods.map((m) => m.key ?? m.code).join('|');
  const hit = modIndexCache.get(key);
  if (hit) {
    const byIdCached = new Map(mods.map((m) => [m.key ?? m.code, m]));
    return hit.search(q).map((h) => byIdCached.get(h.id as string)!).filter(Boolean);
  }
  // A mods-only index, so callers that already filtered the visible list (by
  // pillar / term) don't fight the global one.
  const ms = new MiniSearch<ModDoc>({
    fields: ['code', 'name', 'description', 'pillar', 'department', 'syn'],
    storeFields: ['code'],
    searchOptions: {
      boost: { code: 6, name: 3, pillar: 2, syn: 1.5 },
      fuzzy: 0.2,
      prefix: true,
      combineWith: 'AND',
    },
  });
  ms.addAll(mods.map((m) => ({
    id: m.key ?? m.code,
    kind: 'mod' as const,
    code: m.code,
    name: m.name,
    description: m.description,
    pillar: m.pillar,
    department: m.department,
    term: m.term,
    plain: '',
    syn: expandSynonyms(`${m.code} ${m.name} ${m.description} ${m.pillar} ${m.department}`),
  })));
  if (modIndexCache.size >= 2) modIndexCache.delete(modIndexCache.keys().next().value as string);
  modIndexCache.set(key, ms);
  const hits = ms.search(q);
  const byId = new Map(mods.map((m) => [m.key ?? m.code, m]));
  return hits.map((h) => byId.get(h.id as string)!).filter(Boolean);
}
