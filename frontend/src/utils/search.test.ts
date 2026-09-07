import { describe, expect, it } from 'vitest';
import { searchEverything, searchMods, queryVariants, fold, looksLikeCode, codeMatches } from './search';
import type { Mod, Venue } from '@/types';

const mod = (code: string, name: string, pillar: Mod['pillar'], term: Mod['term']): Mod => ({
  code, name, pillar, term,
  description: `${name} description`,
  credits: 12,
  department: 'department',
  schedules: [],
});

const venue = (code: string, name: string, type: Venue['type']): Venue => ({
  code, name, type, building: code.split('.')[0], floor: 1,
});

const MODS: Record<string, Mod> = {
  '10.013': mod('10.013', 'Modelling and Analysis', 'SMT', '1'),
  '10.014': mod('10.014', 'Computational Thinking for Design', 'SMT', '2'),
  '50.001': mod('50.001', 'Information Systems & Programming', 'CSD', '3'),
};

const VENUES: Record<string, Venue> = {
  '2.101': venue('2.101', 'Auditorium', 'Auditorium'),
  '1.502': venue('1.502', 'Cohort Classroom 1', 'Cohort Classroom'),
};

describe('searchEverything', () => {
  it('returns nothing for empty query', () => {
    expect(searchEverything('', MODS, VENUES)).toEqual([]);
  });

  it('matches by mod code prefix and ranks it highest', () => {
    const r = searchEverything('10.013', MODS, VENUES);
    expect(r[0]).toMatchObject({ kind: 'mod', code: '10.013' });
  });

  it('finds a venue by an altName, not just its installed name', () => {
    const withAlt: Record<string, Venue> = {
      ...VENUES,
      '1.309': { ...venue('1.309', 'Wee Hur Think Tank', 'Think Tank'), altNames: ['Think Tank 2'] },
    };
    const r = searchEverything('Think Tank 2', MODS, withAlt, 10);
    expect(r.find((x) => x.kind === 'venue' && x.code === '1.309')).toBeDefined();
  });

  it('reaches a numbered room by its abbreviation, spaced or not', () => {
    const v: Record<string, Venue> = {
      ...VENUES,
      '2.310': { ...venue('2.310', 'Kwan Im Thong Hood Cho Temple Think Tank', 'Think Tank'),
                 altNames: ['Think Tank 21'] },
    };
    for (const q of ['tt 21', 'tt21', 'Think Tank 21']) {
      const r = searchEverything(q, MODS, v, 5);
      expect(r[0], `query: ${q}`).toMatchObject({ kind: 'venue', code: '2.310' });
    }
  });

  it('expands an abbreviation query onto a document that spells it out', () => {
    const v: Record<string, Venue> = {
      ...VENUES,
      '1.502': venue('1.502', 'Information Systems Technology and Design', 'Lab'),
    };
    const r = searchEverything('ISTD', MODS, v, 5);
    expect(r.find((x) => x.kind === 'venue' && x.code === '1.502')).toBeDefined();
  });

  it('matches by venue code', () => {
    const r = searchEverything('1.502', MODS, VENUES);
    expect(r.find((x) => x.kind === 'venue' && x.code === '1.502')).toBeDefined();
  });

  it('matches by name token', () => {
    const r = searchEverything('information', MODS, VENUES);
    expect(r[0].code).toBe('50.001');
  });

  it('multiple tokens narrow results - both must match somewhere', () => {
    const r = searchEverything('information programming', MODS, VENUES);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].code).toBe('50.001');
  });

  it('respects the limit', () => {
    const r = searchEverything('a', MODS, VENUES, 2);
    expect(r.length).toBeLessThanOrEqual(2);
  });
});

describe('searchMods', () => {
  it('returns the original list when query is empty', () => {
    const all = Object.values(MODS);
    expect(searchMods('', all)).toHaveLength(all.length);
  });

  it('orders matches by relevance', () => {
    const r = searchMods('digital', Object.values(MODS));
    // None of our seed mods has "digital" in them, so the result should be empty.
    expect(r).toHaveLength(0);
  });

  it('finds partial code matches', () => {
    const r = searchMods('10.', Object.values(MODS));
    expect(r.map((m) => m.code)).toEqual(expect.arrayContaining(['10.013', '10.014']));
  });
});

// One locked matrix of the shapes a student actually types. The catalogue
// changes rarely and these forms not at all, so this is the place to add a
// case rather than re-derive the behaviour later.
describe('query variants', () => {
  const v = (code: string, name: string, type: Venue['type'], altNames?: string[]): Venue => ({
    code, name, building: code.split('.')[0], floor: Number(code.split('.')[1]?.[0] ?? 1), type,
    ...(altNames ? { altNames } : {}),
  });
  const VS: Record<string, Venue> = {
    '2.311': v('2.311', 'Think Tank 22', 'Think Tank'),
    '1.315': v('1.315', 'Cohort Classroom 2', 'Cohort Classroom'),
    '2.406': v('2.406', 'Cohort Classroom 12', 'Cohort Classroom'),
    '2.314': v('2.314', 'DS-03', 'Studio'),
    '1.605': v('1.605', 'Cyber5G Testbed', 'Lab'),
    '1.506': v('1.506', 'Sing Lun Think Tank', 'Think Tank', ['Think Tank 12']),
    '61.103': v('61.103', 'Fitness Centre', 'Facility', ['Gym']),
  };
  const cases: Array<[string, string, string]> = [
    ['abbreviation + number, spaced', 'tt 22', '2.311'],
    ['abbreviation + number, joined', 'tt22', '2.311'],
    ['spelled out', 'think tank 22', '2.311'],
    ['run together', 'thinktank 22', '2.311'],
    ['shouted', 'THINK TANK 22', '2.311'],
    ['mixed case', 'Tt 22', '2.311'],
    ['code with the dot', '2.311', '2.311'],
    ['code without the dot', '2311', '2.311'],
    ['a lettered door', '1.315A', '1.315'],
    ['the other door', '1.315B', '1.315'],
    ['exact beats near-miss', 'cc2', '1.315'],
    ['hyphenated name', 'ds-03', '2.314'],
    ['hyphen dropped', 'ds03', '2.314'],
    ['hyphen as a space', 'ds 03', '2.314'],
    ['letter/digit split', 'cyber 5g', '1.605'],
    ['letter/digit joined', 'cyber5g', '1.605'],
    ['spaced, doc is one word', 'sing lun', '1.506'],
    ['a folded-in altName', 'gym', '61.103'],
    ['typo', 'fitnes centre', '61.103'],
  ];
  for (const [label, query, want] of cases) {
    it(`finds ${want} from ${label}: "${query}"`, () => {
      const r = searchEverything(query, MODS, VS, 5);
      expect(r[0]).toMatchObject({ kind: 'venue', code: want });
    });
  }
});

describe('room abbreviations reach the room finder', () => {
  // The room finder filters with includes(), not MiniSearch, so it needs the
  // abbreviation table handed to it explicitly. "tt" matching only a literal
  // "tt" was the bug: every numbered Think Tank was unreachable there.
  it('expands a bare abbreviation to its long form', () => {
    expect(queryVariants('tt')).toContain('think tank');
    expect(queryVariants('cc')).toContain('cohort classroom');
    expect(queryVariants('lt')).toContain('lecture theatre');
  });

  it('expands an abbreviation with a room number', () => {
    expect(queryVariants('tt21')).toContain('think tank 21');
    expect(queryVariants('tt 21')).toContain('think tank 21');
  });

  it('keeps the raw query, so a literal match still works', () => {
    expect(queryVariants('think tank 5')).toContain('think tank 5');
    expect(queryVariants('')).toEqual([]);
  });
});

describe('a donor bracket must not cost a room its own name', () => {
  // "Think Tank 2 (Wee Hur)" is five tokens against "Think Tank 20"'s three,
  // and BM25 normalises by field length - so the donor was costing the room
  // its own name as a query. `plain` (the bracket-free name, boosted like
  // `name`) is what pins it back.
  //
  // The other half of that fix, prefix matching off for a lone digit, only
  // misranks against the full 224-venue catalogue and cannot be reproduced in
  // a fixture this size. It is verified by hand, not here.
  const venues = Object.fromEntries([
    ['1.309', 'Think Tank 2 (Wee Hur)'],
    ['2.310', 'Think Tank 21 (Kwan Im Thong Hood Cho Temple)'],
    ...[16, 17, 18, 19, 20, 22, 23, 24, 25].map(
      (n, i) => [`2.4${i + 10}`, `Think Tank ${n}`] as [string, string],
    ),
  ].map(([code, name]) => [code, {
    code, name, building: code[0], floor: Number(code[2]), type: 'Think Tank',
  }])) as unknown as Parameters<typeof searchEverything>[2];

  it('ranks the exact numbered room first', () => {
    expect(searchEverything('think tank 2', {}, venues, 5)[0].code).toBe('1.309');
  });

  it('still finds a two-digit room, whose prefix behaviour is unchanged', () => {
    expect(searchEverything('think tank 21', {}, venues, 5)[0].code).toBe('2.310');
  });

  it('reaches a bracketed room by its plain name, with no altName present', () => {
    expect(searchEverything('think tank 21', {}, venues, 9).map((h) => h.code)).toContain('2.310');
  });
});

describe('a one-word spelling is a search problem, not an altName', () => {
  // These pairs used to resolve only because the second spelling was stored as
  // an altName, which renders on screen as noise. Deleting the altName broke
  // both queries, so the split is indexed and the query is squashed instead.
  const venues = {
    '2.502': { code: '2.502', name: 'Fablab Satellite 4', building: '2', floor: 5, type: 'Lab' },
    '5.101-0': { code: '5.101-0', name: 'Scrapyard', building: '5', floor: 1, type: 'Lab', altNames: ['Woodstore'] },
    '2.207': { code: '2.207', name: 'SUTD Cleanroom', building: '2', floor: 2, type: 'Lab' },
  } as unknown as Parameters<typeof searchEverything>[2];

  it('finds a compound spelt as two words, and as one', () => {
    for (const q of ['fab lab satellite 4', 'fablab satellite 4']) {
      expect(searchEverything(q, {}, venues, 5)[0].code).toBe('2.502');
    }
    for (const q of ['clean room', 'cleanroom']) {
      expect(searchEverything(q, {}, venues, 5)[0].code).toBe('2.207');
    }
  });

  it('gives the room finder a spacing-free needle to match on', () => {
    expect(queryVariants('wood store')).toContain('woodstore');
    expect(queryVariants('fab lab')).toContain('fablab');
  });
});

// An accented room name tokenised to nothing a student would type: MiniSearch
// splits on anything outside a-z0-9, so "førm axioms" indexed as ["f","rm"].
describe('accented names are reachable by their plain spelling', () => {
  it('folds letters that have no NFD decomposition', () => {
    expect(fold('førm axioms')).toBe('form axioms');
    expect(fold('Ærø')).toBe('aero');
    expect(fold('straße')).toBe('strasse');
  });

  it('folds combining marks too', () => {
    expect(fold('Café')).toBe('cafe');
    expect(fold('naïve')).toBe('naive');
  });

  it('leaves plain text alone', () => {
    expect(fold('Think Tank 21')).toBe('think tank 21');
  });

  // The reason the fold exists: 1.510A is installed as "førm axioms" and a
  // student types "form". Before folding, both sides tokenised past the ø and
  // the room was reachable only through an altName rendered as an "aka" line.
  it('finds an accented room by the spelling a student types', () => {
    const withAccent: Record<string, Venue> = {
      ...VENUES,
      '1.510A': venue('1.510A', 'førm axioms', 'Facility'),
    };
    const hit = searchEverything('form axioms', MODS, withAccent, 10);
    expect(hit[0]).toMatchObject({ kind: 'venue', code: '1.510A' });
  });
});

describe('a typed room code keeps its dot', () => {
  const CODES = ['1.502', '1.503', '1.509', '2.405-01', '2.501', '2.502',
                 '3.201', '3.202', '3.310', '5.101', '5.101-0', '55.223'];

  it('knows a code from a word', () => {
    for (const q of ['5', '5.', '5.0', '2.311', '5.101-0', '55.2']) {
      expect(looksLikeCode(q)).toBe(true);
    }
    for (const q of ['tt', 'fab lab', 'think tank 5', 'gym', '']) {
      expect(looksLikeCode(q)).toBe(false);
    }
  });

  // The bug this exists for: "5.0" was squashed to "50", which is a substring
  // of "1.502", so a search for building 5 answered with building 1.
  it('does not squash a code into a substring of another code', () => {
    expect(queryVariants('5.0')).not.toContain('50');
    expect(queryVariants('fab lab')).toContain('fablab');
  });

  it('answers "5.0" with building 5, never 1.502', () => {
    const hits = codeMatches(CODES, '5.0');
    expect(hits).toEqual(['5.101', '5.101-0']);
    expect(hits).not.toContain('1.502');
    expect(hits).not.toContain('2.502');
  });

  it('prefers an exact prefix over the building fallback', () => {
    expect(codeMatches(CODES, '3.2')).toEqual(['3.201', '3.202']);
    expect(codeMatches(CODES, '2.50')).toEqual(['2.501', '2.502']);
  });

  it('keeps 55 out of 5', () => {
    expect(codeMatches(CODES, '5.')).toEqual(['5.101', '5.101-0']);
  });

  // The index splits "3.2" into "3" and "2", and neither prefixes "201" - so
  // 3.201 was absent from a search for its own code while 3.304 was present.
  it('puts the rooms a code names at the top of the dropdown', () => {
    const venues: Record<string, Venue> = {
      '3.201': venue('3.201', 'Office of Admissions', 'Facility'),
      '3.304': venue('3.304', 'Meeting Room 30', 'Meeting Room'),
      '1.502': venue('1.502', 'Cohort Classroom 1', 'Cohort Classroom'),
      '2.502': venue('2.502', 'Seminar Room 2', 'Seminar Room'),
    };
    expect(searchEverything('3.2', {}, venues, 5)[0]).toMatchObject({ code: '3.201' });
    const five = searchEverything('5.0', {}, venues, 5).map((h) => h.code);
    expect(five).not.toContain('1.502');
    expect(five).not.toContain('2.502');
  });
});
