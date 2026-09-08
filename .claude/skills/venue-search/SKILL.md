---
name: venue-search
description: How room search finds a venue, and the one table to update when a new room type or naming convention appears. Use when adding a venue whose type is new ("Design Studio", "Meeting Pod"), when a search misses a room that exists, or when touching frontend/src/utils/search.ts.
---

# Room search, and the one thing that needs maintaining

Almost all of this is mechanical and needs no attention. Exactly one table is
hand-maintained: `SYNONYMS` in `frontend/src/utils/search.ts`.

**There is no telemetry, deliberately, so nothing tells you which queries
missed.** The only signals are someone reporting a room they could not find,
and you sitting down and typing the abbreviations students actually say. Do not
add a synonym on a hunch that one might be typed: an unused entry costs
precision on every other query, and the cost is invisible for the same reason
the miss was.

Typos need no entry at all. A student who mistypes a room name retypes it in
about a second. Abbreviations are different - `tt`, `cc`, `ds` are what people
*mean* to type, and no amount of retrying turns them into the full name.

## What already works without you

A student types a room a dozen different ways. These are handled by the index,
not by the table, so a new room inherits all of them for free:

| they type | why it lands |
| --------- | ------------- |
| `think tank 22` | the name is indexed |
| `THINK TANK 22`, `Tt 22` | MiniSearch lowercases everything |
| `thinktank 22` | adjacent words are indexed run together |
| `2.311`, `2311` | the code is indexed with and without the dot |
| `1.315A`, `1.315B` | a lettered door strips to its room at query time |
| `coho`, `yangz` | prefix matching |
| `compter lab` | fuzzy, for terms of five characters or more |
| `cyber 5g`, `cyber5g` | the letter-to-digit boundary is indexed both ways |
| `førm axioms` | accents and stroked letters fold to ASCII before indexing |
| `gym` | `altNames` are indexed |

Two behaviours that look like bugs and are not:

- **`tt` returns all 21 think tanks, `cc` returns every cohort classroom.**
  That is the point. The student picks from the list, or types `cc9` and goes
  straight there.
- **Fuzziness is off for terms of four characters or less.** At that length
  everything is within one edit of everything, so `cc2` would fuzzy-match the
  bare `cc` on all twenty cohort classrooms and bury the room it names.

## The one thing to maintain

`SYNONYMS` maps an abbreviation to the words it stands for. It is matched in
**both** directions: a document saying `HASS` gains the long form, and one
saying `Think Tank 21` gains `tt` and `tt21`.

**Add a line when a room type appears that students will abbreviate.** Signs:

- a new `type` value in `frontend/src/types/index.ts`
- a venue name whose first word or two get shortened in conversation
- a search that misses a room which definitely exists, when the query is an
  abbreviation

```ts
const SYNONYMS: Record<string, string> = {
  // ...
  tt:  'think tank',
  cc:  'cohort classroom',
  ds:  'design studio',   // <- the new line
};
```

The value must be **plain lowercase words**, exactly as they appear in the
name. `ds: 'design studio'` fires on "Design Studio 3" and yields `ds` and
`ds3`. It would not fire on "DesignStudio".

Keep it small and high-precision. One bad synonym pollutes every result: a
two-letter key that collides with a real word will attach itself to hundreds of
documents.

## Then lock it

`frontend/src/utils/search.test.ts` ends with a `query variants` block: a table
of the shapes a student types, run against a **fixture**, not the catalogue, so
it keeps testing the mechanism when `/data` moves.

Add one row for the new abbreviation:

```ts
['design studio abbreviation', 'ds3', '2.314'],
```

and a fixture venue for it if none of the existing ones fit. Then, per
CLAUDE.md, **invert the fix and confirm the test goes red** - delete your
SYNONYMS line and re-run - the gate's rule about tests that can fail applies
here as much as anywhere.

## Names and codes never mix

`name` and `altNames` carry **no room code**. `2.204` is the code, `IT Care` is
the name, and the venue page shows them separately. `mapName` is the exception
and must keep whatever the indoor map prints, code included, because the map
resolves by exact label and silently falls back to the whole campus on a miss.

So: never "fix" `mapName` to look tidy, and never paste a code into a name to
make search find it. Search already indexes the code.

## Verifying a real miss

Do not reason about it - measure. Write a throwaway test that loads the real
`/data`, probe the query, delete the file afterwards:

```ts
const V = join(process.cwd(), '..', 'data', 'venues');
const venues: Record<string, Venue> = {};
for (const f of readdirSync(V).filter((x) => x.endsWith('.json'))) {
  const v = JSON.parse(readFileSync(join(V, f), 'utf8')) as Venue;
  venues[v.code] = v;
}
console.log(searchEverything('your query', {}, venues, 5));
```

Most "search is broken" reports turn out to be a missing venue file rather than
a search fault. Check `data/venues/` first.
