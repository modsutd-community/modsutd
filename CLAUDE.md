# modSUTD - guidance for AI-assisted contributors

Most contributions here will involve an AI coding agent. That's fine - this
project was largely built that way. These rules keep a hundred different
agents from slowly turning it into a hundred different projects.

## Architecture invariants - do NOT change these in a PR

The following are **deliberate decisions**, not gaps. Read
[docs/architecture.md](docs/architecture.md) before questioning them; open a
GitHub Discussion (not a PR) if you want to revisit one.

1. **No backend, no database.** The app reads static JSON from `/data`. Do
   not add a server, an ORM, auth, accounts, or "a small API" for any
   feature. Wanting one is a Discussion, never a PR; see
   [docs/architecture.md](docs/architecture.md) for what the static shape buys.
   The relays in `api/` are not the exception they look like: each is
   stateless, holds no user data, and exists only because a browser cannot keep
   a token. The line is **state** - the moment something needs to remember a
   user between requests, that is the backend this rule forbids.
2. **`/data/*.json` is the source of truth**, and within it the order is: the
   2026-08-22 walk (door plates and wayfinding signs) beats any third-party
   indoor map, which beats older repo and web data. The loser is wrong, not a
   tie to weigh.
   It is version-controlled and edited via human-reviewed PRs. Do not move
   data to a CMS, spreadsheet, or database.
   (One deliberate exception: machine-validated crowdsourced timetable
   slots auto-commit via `.github/workflows/timetable-contribution.yml`.)
3. **No new runtime dependencies without strong cause.** Every package is a
   contributor barrier and a security surface. Prefer the ~90 lines of code.
   One has cleared that bar: **Leaflet**, for the room map. The alternative was
   an iframe, and an iframe hands over control placement and attribution
   wording along with the picture; OpenLevelUp additionally queries Overpass on
   every load, so the map is blank whenever Overpass is having a bad minute. It
   is loaded on demand, so it is a separate 43 KB gzipped chunk that only a
   reader who opens a room ever fetches, and the main bundle grew 2 KB. Do not add a second map library, and do not pull
   Leaflet into the main bundle by importing it statically.
4. **No analytics, tracking, cookies, or telemetry.** The privacy posture in
   [docs/architecture.md](docs/architecture.md) is a public promise. It has to
   stay literally true - if a change alters what leaves the browser, that file
   changes in the same PR.
5. **Consent & privacy semantics are load-bearing.** Anything touching the
   timetable consent gate, `contributeTimetable`, or what data leaves the
   browser needs a Discussion first - the e2e suite pins the current
   contract deliberately.
6. **Community tools get credit.** SamBot, butter9fe, Itsskiip, MarkHershey -
   attribution stays in README/docs. Don't strip it during refactors.
7. **modSUTD is not officially endorsed.**

## House style

- TypeScript strict; no `any` (reach for `unknown`); function components +
  hooks; SCSS modules with tokens from `frontend/src/styles/variables.scss`.
- Comments explain _why_, never _what_. Match the existing lowercase,
  plain-spoken doc voice - no corporate tone, no emoji in docs
- **No incident tallies.** Give the mechanism and the rule, never a count of
  how often something went wrong before or how long it took: "one run in
  three", "57 retries", "122 of 162", "this shipped once". A reader needs to
  know what breaks and why, not the project's history of breaking it.
- **Docs change in the same PR as the thing they describe.** A skill, a doc,
  a workflow header or a comment that outlived its subject is worse than none:
  the next agent believes it. Before opening a PR, grep the repo for the field,
  flag, filename or rule you touched and update every hit. `directions` was
  documented as an authored venue field for a while after it stopped existing.
- **`frontend/public/faq.html` is copy that no test can check.** It is the only
  page a crawler that runs no JavaScript reads, and it states three things the
  repo decides elsewhere: that a timetable is pasted from MyPortal's LIST view
  and not the weekly grid, that reviews are giscus comments, and that the
  licence is Apache 2.0. Change any of those and change that file in the same
  PR. It is hand-written and static on purpose - it names no course and no room,
  so it cannot go stale against `/data`, only against a decision.

- **Say a thing once, and link to it.** Each fact has one home: fields in
  `docs/data-format.md`, procedures in `.claude/skills/`, invariants and the
  gate here, why-it-is-shaped-this-way in `docs/architecture.md`. Everywhere
  else points at that home. A rule written out twice is a rule that will
  disagree with itself, and the reader cannot tell which copy is stale.

- Small PRs. One concern per PR. Prefix titles: `data:` / `frontend:` /
  `scraper:` / `docs:` / `chore:`.
- **How to write the PR body is in `.github/pull_request_template.md`**, in the
  comment at the top. That is where the rules live; everywhere else points at
  it rather than restating them. It is not decoration: an agent
  that writes its own shape produces marketing prose, em dashes, and a tally of
  how long the bug went unnoticed. Open PRs with
  `gh pr create --body-file .github/pull_request_template.md` and fill it in,
  because `gh` does not prefill the template the way the browser does.
- **A stored shape change needs a migration answer in the PR.** modsutd.tech is
  live and has no backend, so every plan, layout, consent flag and parsed
  timetable lives in someone's browser or their gist, where no deploy can reach
  it. Renaming a localStorage key, a gist section, a JSON field or an export
  format drops that data unless something reads the old name. Say in the PR what
  a browser holding the old shape does on its first load, name the function that
  decides, and cover it with a test.
- Every UI change ships desktop **and** mobile in the same PR (bottom nav
  and heatmap scroll are the usual casualties).
- Never find an element in a test by copy that gets reworded - use a
  `data-act` hook or wait on the request. Accessible names and assertions
  _about_ copy are the exception. Rules: `frontend/e2e/README.md`.
- Data edits cite a source (URL / screenshot / syllabus) in the PR body.
- Placeholder or synthetic data must stay visibly labelled as such - in the
  data notes and in the UI. Never present invented schedules as real, and
  never attach real people's names to synthetic data.

- **The LLM reviewer is taught in `.opencodereview/rule.json`, and nowhere
  else.** It sees the diff hunk and nothing else: not this file, not the rest of
  the file it is commenting on. So it cannot tell a bug from a decision, and its
  wrong findings all have one shape, which is proposing to revert something
  deliberate in the same red badge as a real defect. When a review argues with a
  decision the repo has already made, add a rule naming that decision rather
  than explaining it in a PR comment nobody will read twice. The rules live on
  the TRUSTED BASE: the action checks out `main`, so a change to them does
  nothing until it is merged.

- **Lint is ESLint 10 flat config**, `frontend/eslint.config.js`. `.eslintrc.cjs`
  is gone; ESLint 10 reads nothing else. Two things there are deliberate. The
  relays in `api/` are NOT linted - ESLint refuses a file above the config's own
  directory, and moving the config to the repo root to reach six handlers would
  drag every path in it up too; they are syntax-checked by node and covered by
  `telegram-link.test.js`. And the three React Compiler rules that
  `eslint-plugin-react-hooks` 7 turns on by default are off: they are a
  different standard from rules-of-hooks, not a stricter one, and
  `set-state-in-effect` alone flags the ordinary "fetch, then setState when it
  resolves" that loads every panel here. Worth adopting one rule at a time, not
  in a batch. `rules-of-hooks` and `exhaustive-deps` stay on.

## Verification gate - run before claiming anything works

```bash
cd frontend
npm run merge-ready   # lint, typecheck, test, build, e2e - in that order
```

Green, or the work is not ready. Each step is a script of its own for when you
want one; `lint` runs `--max-warnings 0`, and `e2e` runs the selector guard
first. If you changed parser or ICS logic, add a regression test - the
term-long-VEVENT bug shipped because the old fixture only covered
`startDate === endDate`.

`npm run flow` is separate and deliberate: it pushes the sample timetable
through the real parser, the real slot gate and the real `fold_slots.py` into
`/data`, then restores. It refuses to start on a dirty `/data`.

**Write the test so it can fail.** After writing one, delete or invert the fix
and confirm it goes red. The ways a test passes against the bug it was written
for are mundane: a `page.goto` that remounts the component under test, a CSS
assertion at a viewport where the cap never binds, a check below its own
threshold. A test that has never failed has not been tested.

## Recurring maintenance

Use the project skills in `.claude/skills/` - they encode the procedures so
each new maintainer (or their agent) doesn't re-derive them:

- `new-term` - everything that must change when a new term starts
- `course-data` - how to add or fix course/venue JSON correctly
- `gather-mods` - refresh the catalogue from the official listing
- `gather-specialisations` - refresh the specialisation-track criteria
- `venue-search` - what room search already handles, and the one table to
  update when a new room type appears
- `parse-subject-enrolment-pdfs` - fill a whole term's schedules and rooms
  from the registry's six enrolment PDFs, rather than waiting for pastes
- `retire-mod` - a course SUTD dropped: mark it, keep its history, close
  its review thread. Never delete the file

Every token, what happens without it, and which of Actions, Vercel and local
it belongs in, is `.env.example` at the repo root. Editing the campus map in
OpenStreetMap - which tool for which job, and how to confirm an edit landed -
is [docs/osm-instructions.md](docs/osm-instructions.md).

Scheduled workflows default to **the first Saturday of the month, 00:00
Singapore**, because a runner that finds nothing changed still costs a runner.
`osm-refresh`, `telegram-prune`, `freshness` and `scrape` all run then.

cron cannot express "first Saturday" - with day-of-month and day-of-week both
set it fires when EITHER matches - so each is scheduled Fridays 16:00 UTC and
gates every later step on a first step that keeps only the runs where the
Singapore day is 7 or less. Copy that shape for a new monthly job.

Two are deliberately not monthly, and say why in their own headers:

- `deploy.yml` - four times a day. Contributed slots auto-commit to main, and a
  student who pastes a timetable should see the heatmaps move the same day.
- `telegram-admin.yml` - daily. Until a human is promoted the chat has no admin
  and nobody can remove spam from it.

## Things that look like bugs but aren't

- `frontend/public/data/` is generated (gitignored) - edit `/data` instead.
- `scrape.py` reads **hass.sutd.edu.sg and nothing else**, which is why the step
  is called `hass`. It used to also fetch epd/esd/istd/asd.sutd.edu.sg through
  `sources/pillar.py`, whose selectors were a best-effort guess that returned
  before yielding anything: four hosts fetched per run to produce nothing, under
  a step named `pillars` that scraped no pillar. A real pillar parser is written
  against whatever HTML SUTD serves that day, so the stub was not a head start
  and it is gone. Everything else about a mod, in every pillar, comes from the
  `mods` step, because sutd.edu.sg's own course sitemap covers all of them.
  The "never wipe on empty" rule in `scrape.py` stays and is a safety feature.
- `semanticSearch.ts` is a documented stub behind `ENABLED = false`.
- Room search behaviour that looks like a bug - every think tank for `tt`, no
  fuzziness at four characters or less - is deliberate and explained once, in
  `.claude/skills/venue-search`. Read it before changing `utils/search.ts`.
- A venue `name` puts the number first and the donor in brackets - "Think Tank
  2 (Wee Hur)" - and never contains the room code; the panel header joins
  `code · name` itself.
- `mapName` is the map's own label copied character for character, which is
  why it is the one field allowed to carry a room code. Copy it, never compose
  it, and above all never trim it: most labels end in ` - <code>`, and cutting
  that tail off resolves the link to the whole campus instead of the room. The map matches by exact label and falls back silently,
  so a wrong one looks like a working link. `data/_meta/map_labels.json` is
  every label the map has, and `sync-data.mjs` fails the build on a `mapName`
  that is not in it. A venue with no `mapName` is **unmapped** - 64 of 225.
  Unmapped is not missing: the map block renders for every room, in three
  tiers. A `mapName` deep-links the indoor map. Failing that, `lat`/`lng` from
  the 2026-08-22 survey pins the room itself on OpenStreetMap, which now covers
  53 of those 64. Failing both, it falls back to the building's OSM element,
  and only says nothing maps this one yet (with a data-issue link) when there
  is no coordinate and no building either.
- The room map draws the floor plan itself, from `/data/indoor.geojson` (341
  shapes including the lifts, generated by
  `tools/osm/extract_indoor_geojson.py` - see `docs/osm-instructions.md`).
  It opens outdoors at zoom 18; one press of + crosses 19 and the plan takes
  over. There is deliberately no button for it, because getting closer is
  already the gesture for looking inside. The floor is a readout under the zoom
  control, labelled the way the door plates are, so OSM level 2 shows as **L3**.
  Going indoors requires the venue to have `osmKeys` - its own surveyed shape.
  Rooms merely being on the same floor is not enough: a venue pinned to its
  building's average would otherwise draw a confident plan of somewhere else.
  Two things there are load-bearing and easy to undo by accident. The basemap
  is faded to 0.18 while the plan is up, because tiles carry ground-floor shops
  and their labels at every zoom, so a cafe downstairs otherwise sits on a
  fourth-floor plan as if it were on it. And room labels are `permanent` - hover-only means invisible on a phone, and
  invisible on a desktop until you go looking - but only the room being viewed
  gets one at zoom 19, where a think tank is barely wider than its own name. Its
  neighbours within 30 m appear at 20. Labels drop all but the first word of the
  bracketed donor: "Think Tank 13 (Yangzheng…)".
- `lat`, `lng` and `osmLevel` are **derived, and never hand-edited into a venue
  file**. `sync-data.mjs` attaches them to the shipped bundle from
  `data/_meta/room-coords.json`, which has exactly one generator,
  `tools/osm/extract_room_coords.py`, reading live OpenStreetMap. An edit in a
  venue record could only disagree with the map. Three door plates
  (2.301, 5.101-0, 5.303) cover two rooms each, so each entry is a LIST and the
  sync picks by name; collapsing them would put two rooms on one pin about 45 m
  from where one of them is. Note `osmLevel` is OSM's numbering, where ground is
  0, so it is one less than the plate's `floor`.
- **Venue fields are defined in [docs/data-format.md](docs/data-format.md), and
  nowhere else.** The three that get edited wrongly most often: `altNames` is a
  genuinely different name a sign carries and never a spelling variant (that is
  `utils/search.ts`); `landmarks`, `lat`, `lng` and `osmLevel` are derived by
  `sync-data.mjs` and never typed into a record; `mapName` is the map's own
  label copied character for character, and trimming its ` - <code>` tail
  resolves the link to the whole campus instead of the room. `directions` is
  gone.
  A venue with no `mapName` is **unmapped** - 64 of 225 - which is not the same
  as missing: the map block renders for every room in three tiers, deep-linking
  the indoor map, else pinning `lat`/`lng` on OpenStreetMap, else falling back
  to the building's element.
- Lifts are **nodes** in the survey (`highway=elevator`, named "Lift Lobby A".."J"),
  not ways. A way-only reader silently drops every one of them, which is how the
  plan came to have no lifts on it at all.
- **A lift is a shaft, not a room.** It stands in the same place on every floor
  it serves, and OSM has Lift Lobby A on levels 1, 4, 5 and 6 only. So the plan
  filters ROOMS by level and takes the building's lobbies wherever they were
  surveyed, one mark each. Filtering lifts by level drew building 1 level 4 with
  one of its two lobbies simply absent. The landmark chip is a different
  question and stays nearest-by-distance: on level 5, where both are surveyed,
  C is 48 m from 1.508 and A is 84 m.
- **Read what is on the level, not what carries a plate.** The extractor keeps
  any way with a `level` tag, not only `indoor=room|corridor|area`, and keeps
  `highway=elevator` nodes whether or not they are named. Plates are used for
  one thing only: telling which building a shape sits in, since OSM tags the
  room and never the block. Every shape gets a building that way, none is
  dropped for lacking a ref.
  The plan is stricter than the file, and deliberately: it draws one mark per
  NAMED lobby. A bare arrow with no letter is a mark a reader cannot act on, and
  the three unnamed elevator nodes on this campus sit where no lobby is.
- **The floor readout is OSM's `level:ref`, copied.** Not `level + 1`: ground is
  level 0 and plate 1 nearly everywhere, but the basement is plate "B1", which
  no arithmetic on 0 produces. Every shape in `indoor.geojson` carries it.
- **A floor is a building AND a level, never a level alone.** `indoor.geojson`
  carries no building of its own - OSM tags the room, not the block - so
  `useIndoorMap` derives one per feature from the plate (`3.201` is building 3)
  and gives a lift or a corridor the building of the nearest plated room, the
  same rule `sync-data.mjs` uses. Buildings 1, 2 and 3 are about 60 m apart and
  share every storey number, so filtering on level alone drew all three at once:
  a building 3 room opened onto building 2's plan and building 1's lifts.
- **OpenStreetMap is the source**, not the `.osm` files the survey was uploaded
  from. Those stopped being true the moment anyone edited the map.
  `tools/osm/*.py` read live OSM through Overpass by default; naming a directory
  reads an old snapshot instead. Refreshing is a maintainer command
  whose output is committed, so Overpass being flaky costs a retry and nothing
  else - but both generators **refuse to write when the answer is thin**, the
  same rule `scrape.py` follows: a mirror can answer 200 with almost nothing,
  and writing that over a good file loses the map.
  Two traps in that query: Overpass returns any way that INTERSECTS the bbox,
  so a road clipping the corner arrives whole and its centroid lands half a
  kilometre away - judge the centroid, not the intersection. And asking only
  for `indoor=*` misses venues that are not rooms: Campus Centre, the plaza,
  the link bridges.
- The Discuss panel **imports** the two issue templates from
  `.github/ISSUE_TEMPLATE` with Vite's `?raw`, so there is one copy of each and
  no network. It used to read them through the GitHub contents API, which
  answers only for the default branch, so on localhost the fetch failed and the
  panel fell back to a link to the issue form - and a reader who clicked it
  filed an issue instead of posting on the board the panel exists to fill.
  There is deliberately no link to `issues/new` anywhere in that panel, and an
  e2e test asserts there is none. `server.fs.allow` in the vite config is what
  lets the dev server read above `frontend/`.
- **giscus cannot attach a file** (giscus/giscus#197), so a screenshot has to go
  on the thread itself. The theme injects a line above the box saying so, and
  the bug template says it too. Do not add an upload control: there is nothing
  behind it. The line is plain text because CSS `content:` cannot hold an
  anchor - a version with a real link lived in our own markup for a while and
  read as clutter.
- **giscus never polls.** It fetches a thread once, so a board left open would
  show what it fetched and nothing anyone has said since. `DiscussBody` rebuilds
  the frame on a slow loop instead, and on the way in to a board.
  Two things keep that from being destructive. A rebuild throws away whatever
  is in giscus's box, so it is skipped while someone is writing: the box is
  cross-origin and its contents cannot be read, but focus can be - focus moving
  into an iframe shows up here as the window blurring while that iframe is
  `document.activeElement` - and anyone who has been in it within
  `DRAFT_GRACE_MS` is left alone. And the rebuild loads OFF-STAGE (absolutely
  positioned at opacity 0, and `loading="eager"`, because a lazy iframe under
  `display:none` is never fetched at all), taking over only once it reports
  itself laid out, so a refresh has nothing visible to it.
- **A callback prop must never reach a giscus effect's deps.** `onDiscussion`
  is held in a ref. Passed as an inline arrow it is a new function every
  render, and in the deps it rebuilt the iframe, which emitted its discussion
  again, which set state again: the board reloaded on a loop and lost whatever
  had been typed into it each time.
- **A giscus board is mounted once and then hidden, never unmounted.** It is a
  cross-origin iframe, so unmounting throws away everything it loaded and coming
  back pays for the whole board again - which is what made switching Feature to
  Bug feel slow. A board nobody has opened is not mounted at all.
- The giscus themes are `data:` URIs built in `config/giscus.ts`, and they carry
  the workbench palette as Primer variables. Without it the frame keeps GitHub's
  near-white on GitHub's navy and reads as a window from another site.
- **The batch-chat button has four states, and one function decides between
  them.** `workbench/teleState.ts` is a pure table: COMMITTING (dotted, this
  browser's paste has not reached main yet), READY (solid, no share link),
  CREATING (dotted, a group was asked for), LIVE (solid, share link beside it).
  The ORDER of its checks is the design and each step says why it sits where it
  does - in particular COMMITTING is tested above the term-window gate, because
  `term-window.json` is written by the contribution workflow and is still empty
  on the first paste of a term, so a state gated on it would be invisible for
  exactly the window it describes.
  The wait that matters is the ~11s COMMIT, not the deploy: `telegram-group.yml`
  checks out main, so a chat can be created long before the build that shows the
  slots to anyone else. `slotsOnMain` is the signal.
  "I asked for a chat" lives in `workbench/teleAsked.ts`, in localStorage and in
  the sync bundle, never in React state. As component state it vanished on
  reload, leaked onto the next mod opened (the panel swaps its contents rather
  than remounting), and never existed in a second tab. It expires after ten
  minutes so a workflow that never finished cannot spin forever.
  `workbench/contributed.ts` still remembers which mods a paste covered, and
  those entries age out after a week so rejected slots stop promising a button.
- **The stored invite link dies when the creator leaves - but survives
  migration.** `create_group.py` exports the link as the creating account, and
  Telegram revokes the invite links of a user who leaves, so `grant_admin.py`
  stays in the chat until the term ends. Migrating to a supergroup is a
  different question and was tested on a live chat: the link keeps working.
  Handover migrates deliberately, because `add_admins` is a granular right and
  granular rights do not exist on a basic group; it then re-exports the link so
  the registry holds one read back off the migrated chat. The registry then serves a link that
  answers "This invite link has expired" forever, because nothing re-exports
  it. Seen live: the group's own link changed. Not one-use and not owner-bound -
  creator-bound. Anything that changes the handover has to answer this first.
- A review must be a **comment** on the mod's discussion, never the discussion
  body. giscus renders a discussion's comments and never its body, so a review
  written into the first post is invisible on the mod page forever.
- **Cite a data change from the record, never from the diff hunk.** A hunk in
  `data/specializations.json` reading `+ "50.057"` sits in one of 21 tracks and
  the diff does not say which, and the nearest `"id"` line above it is
  frequently a different record. `tools/scraper/what_changed.py` walks both
  documents and prints each change with its record and the source URL that
  record itself carries, which is the line a reviewer opens. `mods_refresh.py`
  runs it on every refresh. Lists of records are matched on `id`/`code`/`name`
  rather than index, because inserting one record makes every later index look
  changed.
- `tools/scraper/reports/drift.md` is **generated**, by `mods_refresh.py`, and
  is the only tracked thing the report-only steps produce. It exists so they can
  open a pull request: a run that changes no file opens none, and the prereq and
  minor checks change no file by design, so their findings used to reach a run
  summary and stop there. It carries no timestamp, so a month that finds the same
  drift as the last changes nothing and opens nothing. Deleted when there is
  nothing to say. Do not hand-edit it.
- **A model proposes prerequisite edits; it never writes one.**
  `tools/scraper/propose_edits.py` reads `audit_prereqs.py`'s JSON, asks a model
  whether the page MEANT the codes it names, and validates every proposal before
  touching a file: the record has to exist, the field has to be one of three, every
  code has to have a file, and the `quote` has to appear in the page text that
  course was reported with. A proposal that fails is listed as dropped, never
  applied. `--self-check` runs the validator against known-good and known-bad
  edits without a network call. Which providers exist and in what order is
  `tools/scraper/agents/llm.py`, and nowhere else.
- `data/term-calendar.json` is **generated**, by
  `tools/scraper/gather_terms.py`, in the monthly `scrape` job. Do not
  hand-edit it, and do not add a rollover step that does: a file a human has to
  remember to update is right until the first year nobody remembers. What it
  contains and what reads it: `.claude/skills/new-term`.
  One thing there is easy to get wrong from the outside: SUTD numbers the recess
  week as **week 7**, so the teaching weeks are 1-6 and 8-14 and no arithmetic
  on the term start finds them.
- `DEFAULT_TERM_LABEL` in `logic.ts` is **only a fallback**, for before the
  calendar has loaded or a date between terms; `labelFor()` reads the real one
  out of `term-calendar.json`. A stale label cannot corrupt a contribution -
  `.claude/skills/new-term` says why.
- A weekly-view paste is **derived, and List View beats it**. The grid shows one
  week, so the term is filled by repeating it, which assumes every week is the
  same. List View prints one row per real meeting and therefore catches a
  cancelled week or a make-up class. Worse than merely missing one: a class the
  derived export invents on a date it does not meet cannot be removed by a later
  List View export, because the UID is keyed on the date and nothing names it
  again. Do not make the weekly path the default when List View is available.
- The weekly parser reads `text/html` off the clipboard, not the pasted text,
  and that is not a stylistic choice to tidy away. A class cell in the Weekly
  Calendar View spans several half-hour rows, so a later row carries fewer
  `<td>` than the table has columns; the plain text loses those rowspans and
  every class after the first lands on the wrong day. Measured on a real
  timetable: a Wednesday class read as Tuesday. A weekly paste also covers one
  week and carries no term end, so it renders but never contributes - a 5-day
  span would anchor the batch-chat window and expiry wrongly.
- The `.ics` UID is keyed on mod + type + date only. Room and time are left out
  on purpose: they are what gets corrected, and including them turned a fix into
  a duplicate term. SEQUENCE comes from the server's clock, not the device's -
  a wrong device clock silently breaks updates in both directions.
- The Contribute panel id is `contribute`; a saved layout still holding `about` is inert,
  because `load()` in `layout.ts` keeps unknown ids and the new panel takes its
  default. It lists contributors from api.github.com ranked by commits, with
  bots filtered out - a bot with 400 commits would top the list and mean
  nothing. The money section carries the costs and the ledger itself, behind a
  `<details>` disclosure rather than in a separate file: the ask and the
  accounting belong in the same place, and a native disclosure gets keyboard
  and screen-reader behaviour without any state to manage.
- The six relays live at the repo ROOT, in `api/`, not under `frontend/`.
  Vercel's Root Directory cannot reach above itself - "you also cannot use `..`
  to move up a level" - and the build reads `/data` and
  `.github/ISSUE_TEMPLATE`, both above `frontend/`. So the project is rooted at
  the repo, `vercel.json` at the root drives the build into `frontend/`, and
  `api/` sits where Vercel looks for functions. Do not move it back.
  They are server-side and read `process.env`.
  `npm run dev` runs them through `vite-dev-api.ts`, reading `.env.local` at
  the repo ROOT - one file for the relays and the python tools both, because
  two meant the same token pasted twice. Vite alone serves no `/api` and every
  call 404s.

- **Every mod and every room has a real HTML file in `dist`**, written by
  `frontend/scripts/prerender.mjs` in the `postbuild` hook. Nothing renders
  React: each page is the same shell with its own `<title>`, description,
  canonical link and `Course`/`Place` JSON-LD, plus a `<noscript>` body
  carrying that record's facts. `#root` is left empty, so React mounts exactly
  as before and a reader with JavaScript never sees the static copy.
  It reads `dist/data/*.json`, the bundle the app itself fetches, so the page
  and the app cannot describe the same course differently.
  Two things there are load-bearing. The canonical url is `/mods/50.040` with
  NO trailing slash, and no static server resolves that to
  `mods/50.040/index.html` on its own: the last segment has a dot, so it reads
  as a filename with an extension and falls through to the SPA. `vercel.json`
  rewrites `/mods/:code` and `/venues/:code` to the file explicitly, ahead of
  the catch-all, and `prerenderedPaths()` in `vite.config.ts` does the same for
  `vite preview` so the e2e suite tests what production does. A consequence
  worth knowing: an unknown code now 404s rather than opening the app empty.
  `/venues/<code>` is an ADDITION to `/venues?focus=<code>`, which still works
  and is what every already-shared link uses.

- **A room string becomes a room code in exactly one place**,
  `tools/venue_resolve.py`, shared by `fold_slots.py` (a pasted timetable) and
  `tools/enrolment/parse_enrolment_pdfs.py` (the registry's export). There was
  a copy in each and they disagreed about what a room is, which is how
  `Albert`, `Lecture` and `Online` came to sit in `/data` as room codes with
  heatmaps drawn for them. `location` is a key into `data/venues` and nothing
  else: the room finder, the heatmaps and the `.ics` all look the room up by
  it, so a string that is not one fails silently everywhere at once.
  Three things there are load-bearing. A name two rooms really share - 2.209
  and 2.306 are both "Studio 7" - resolves to NEITHER and does not fall through
  to fragment matching, or it lands on "Dance Studio 7" in another block. A
  fragment must be a whole word of exactly one room's name and at least four
  characters, because a room's name carries its donor and a donor is a person:
  "Wee" and "Hur" are inside "Think Tank 2 (Wee Hur)". And a code the catalogue
  does not hold is refused rather than written, on both doors.
  The remaining hole is upstream and known: `timetableParser.ts` picks the room
  cell by looking for a bracketed code, and a row that prints none falls back to
  a lazy capture that truncates at the first word. That is where `Albert` came
  from. It is caught by the resolver rather than prevented, and fixing it
  properly needs the venue list in the browser.

- **Vercel does not deploy main; `deploy.yml` does.** `vercel.json` sets
  `git.deploymentEnabled.main: false`, so pushes to main build only through the
  workflow. That is the whole reason the workflow exists: contributed slots
  auto-commit to main, and Vercel's own integration would build production for
  every one of them. Preview deploys on other branches are untouched. Turning
  this back on means two builds per push, not one.

## Secrets

Never commit or echo credentials. `.env.local` at the repo root is the only
env file, it is gitignored, and it is personal to one machine - never
transferred, never pasted into CI. `.env.example` lists every name and where
each belongs. Never introduce `VITE_`-prefixed secrets: Vite inlines them into
the public bundle.
