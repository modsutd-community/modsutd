# Data format

The catalogue is `/data/courses/*.json` and `/data/venues/*.json`. One file per record; filenames replace `.` with `_` (e.g. `10.013` → `10_013.json`).

The TypeScript types in [`frontend/src/types/index.ts`](../frontend/src/types/index.ts) are the contract. If you change a field, change the type, the scraper, and any existing JSON.

## Mod (course)

386 records, one per course.

```json
{
  "code": "10.013",
  "name": "Modelling and Analysis",
  "description": "Single-variable calculus, differentiation, integration…",
  "credits": 12,
  "department": "Science, Mathematics and Technology",
  "pillar": "SMT",
  "term": "1",
  "prerequisites": [],
  "corequisites": [],
  "schedules": [
    {
      "type": "Lecture",
      "day": "Monday",
      "startTime": "09:00",
      "endTime": "11:00",
      "location": "2.101",
      "instructors": ["Prof. Wong Ee Hou"]
    }
  ],
  "grading": {
    "components": [
      { "name": "Quizzes", "percentage": 20, "description": "Weekly progressive quizzes" }
    ],
    "passingGrade": "D"
  },
  "workload": { "lecture": 6, "tutorial": 0, "project": 0, "preparation": 6, "total": 12, "source": "official" },
  "tags": ["Term 1", "Freshmore Core", "SMT"]
}
```

### Field notes

- `code` - `XX.YYY` (two digits, dot, three), with an optional trailing letter: SUTD splits a course into `03.007A` and `03.007B` rather than issuing a second number. The letter is part of the code and never trimmed - a suffixed code is its OWN course, never folded into the base one. The pattern is `\d{2}\.\d{3}[A-Za-z]?`, spelled that way in the app (`CANONICAL_MOD`), in each `api/` relay and in `tools/fold_slots.py`; `modCode.test.ts` fails if those copies drift. One entry does not fit it, `02.XFER`, a HASS transfer placeholder that is not a schedulable class.
- `pillar` - `SMT | EPD | ESD | CSD | DAI | ASD | HASS`. There is no "Freshmore" pillar - freshmore subjects belong to SMT (or HASS). A mod can span extra pillars via its official tags (e.g. 03.007A carries ASD + EPD + SMT); `pillar` is the primary.
- `term` - `1` … `10`. Singular. We don't model multiple offerings per year - pick the canonical one.
- `prerequisites` - flat list of mod codes. Use this for the simple "all of the above" case (covers ~95% of SUTD courses).
- `tags` - the official listing's own tags ("Term 5", "AI Track", "Freshmore Core"). Specialisation-track matching runs off them, so copy them verbatim rather than tidying them.
- `prereqTree` - optional, and optional fields are **omitted, never `null`**. Use it only when the prereq logic actually needs AND/OR/N-of, or when a leaf needs more than a code:
  a leaf may be an object `{name, code?, cohort?}`. `name` alone is a course SUTD has
  announced but not numbered - it renders on the mod page and cannot block a plan,
  because there is nothing to place. `cohort` scopes a leaf to matriculation years
  (`ay2026` / `ay2025` / `ay2024`), which is how 50.057 asks AY2024 students for
  10.014, AY2025 for 10.025, and AY2026 for a course with no code yet.

```json
"prereqTree": {
  "and": [
    "10.013",
    { "or": ["10.014", "10.020"] }
  ]
}
```

Special leaves:
- `"10.013:B"` - minimum grade B for this prereq
- `"10.%"`     - wildcard, any mod whose code starts with `10.`

The recursive renderer handles arbitrary nesting. Keep it shallow - three levels max - or no one will read it.

- `workload` - OFFICIAL only: it exists solely when the course page publishes a `Workload: a-b-c` line (lecture/cohort - lab/design - independent study, h/wk), which the gatherer maps into the fields and marks `source: "official"`. Never invent or estimate one; a mod without a published workload simply has no `workload` key.
- `schedules` - placeholder times are acceptable while the scraper isn't tied to MyPortal. Mark synthetic ones in the commit message.

## Venue

```json
{
  "code": "1.508",
  "name": "Think Tank 13 (Yangzheng Foundation)",
  "building": "1",
  "floor": 5,
  "type": "Think Tank",
  "directions": "Along the think tank run: 1.510 Think Tank 15, then 1.509 Think Tank 14, then this one.",
  "landmarks": [
    "Building 1 Level 5",
    "near Level 5 skybridge"
  ],
  "mapName": "YangZheng Foundation Think Tank/Think Tank 13 - 1.508"
}
```

225 records, one per room. The panel header already prints `code · name`, the
type, the capacity, the landmark chips and the building and level, so the bar
for every optional field below is the same: does it say something that header
does not?

### Field notes

- `code` - usually `B.FRR`: building, floor, room. Real campus codes also carry
  suffixes (`1.510A`, `2.301.09`, `5.101-08`), and six named places have no
  number at all (`Library`, `Stadium`, `Hostel`, ...) - those use the name as
  the code and set `facility: true`.
- `name` - the number first, the donor in brackets: "Think Tank 2 (Wee Hur)",
  "Lecture Theatre 1 (Albert Hong)". The number is what a student types and
  what a timetable prints; the donor is what the door plate says. A `name`
  never contains the room code - the header joins the two itself.
- `type` - one of `Lecture Theatre | Cohort Classroom | Think Tank | Lab |
  Seminar Room | Meeting Room | Studio | Auditorium | Facility`.
- `altNames` - optional, and only for a **genuinely different** name a sign
  carries: "Seminar Room 2A" on what is now Fablab Satellite 4, "Gym" for the
  Fitness Centre, "Blk 55/57/59" for the hostel. It renders on screen as an
  "aka" line, so a spelling or abbreviation variant there ("Fab Lab" for
  Fablab, "ESD office" spelt out) is noise a reader cannot act on. Variants
  are search's job, not the data's: `frontend/src/utils/search.ts` carries a
  SYNONYMS table, a `queryVariants` helper for the room finder, and indexes
  the bracket-free form of every name, so "Think Tank 2" reaches 1.309 with no
  `altNames` entry at all. A variant that misses is a bug in that file.
- `directions` - **gone.** Adjacency is what the floor plan is for, and
  "Building X, Level Y" was the room's own location printed twice. Do not
  reintroduce it.
- `landmarks` - **derived, never authored.** `sync-data.mjs` writes
  `["Building 1, Level 5", "Lift Lobby C"]` from the survey, the lobby being
  the nearest surveyed lift in the same building on the same floor. A room
  that is hard to find needs a lift added to the survey, not a chip typed
  into its record.
- `mapName` - this room's label on the third-party indoor map, copied
  character for character. Some labels carry the code and some do not
  ("Data Analytics Lab"); it is the one field allowed to carry a code, because
  the map resolves by exact label and falls back to the whole-campus view with
  no error on anything else - a guessed label is invisible breakage.
  `mapLink.test.ts` pins every stored label to its venue and `sync-data.mjs`
  re-checks them at build time. 162 venues have one; a venue without one is
  **unmapped** (that map never listed it), and the panel links the building on
  OpenStreetMap instead.
- `facility: true` - a named campus place with no room number. It never shows
  FREE/BUSY state and drops out of the FREE filter.
- Availability is **not stored** on the venue. It is computed at runtime by
  rolling up every mod's `schedules`. If a class isn't in `/data/courses/`, it
  isn't in the heatmap.

## Adding a new mod

1. Create `data/courses/XX_YYY.json` with the structure above.
2. `cd frontend && npm run dev`. The `predev` script picks up your new file.
3. Visit `/mods/XX.YYY` - your mod should render.
4. Open a PR. Mention where you got the data (URL, syllabus PDF, screenshot).
