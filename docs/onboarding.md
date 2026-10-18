# modSUTD Onboarding Guide

Welcome to modSUTD. We're more than happy that you wish to contribute, here's more information to understand and contribute cleanly to the project.

---

## 1. Mental Model

modSUTD is a fast, static client-side web application for SUTD students: timetable parsing, degree planning, mod & venue search, venue navigation, and mod reviews.

### Core Architecture

- **No backend, no database, no user accounts**: modSUTD is a static Single Page Application (SPA). Everything runs client-side inside the user's web browser.
- **Client-owned state**: Timetable selections, 10-term degree plans, custom grades, and review drafts stay strictly inside browser `localStorage` (with optional private GitHub Gist backup). No student data ever lives in a remote database.
- **Static JSON as the source of truth**: All mod descriptions, term schedules, prerequisites, and venue coordinates live as version-controlled JSON files in `/data`. Build scripts sync these files into `frontend/public/data/` for local serving.
- **Stateless API relays only**: The serverless functions in `/api` (hosted on Vercel) hold no user state. They exist solely to proxy requests that require authentication secrets (such as GitHub OAuth device flow or Telegram link verification) which a client browser cannot safely hold.

### Visual Architecture & Diagrams

Refer to the visual diagrams in the repository:
- **[System Overview Poster](https://github.com/modsutd-community/modsutd#what-you-can-do-with-it)**: See `marketing/poster.png` in the repository for the full panel and layout breakdown.
- **[Monthly Pipeline & Data Flow](https://github.com/modsutd-community/modsutd#what-it-does)**: See `marketing/monthly_pipeline.png` for how regularly scraped data moves into `/data`, gets human-reviewed via PR, and builds into static JSON.

---

## 2. Local Setup (5 Minutes)

### Prerequisites

- Node.js 24 (the exact version pinned in `.nvmrc` and read by CI)
- Git
- Python 3.10+ (only required if running web scrapers or data audits)

### Quick Start

```bash
git clone https://github.com/modsutd-community/modsutd.git
cd modsutd/frontend
npm install
npm run dev   # http://localhost:3000
```

> [!NOTE]
> `npm run dev` triggers the `predev` hook (`node scripts/sync-data.mjs && node scripts/gen-sitemap.mjs`). This copies `/data/*.json` into `frontend/public/data/`. Never edit files in `frontend/public/data/` directly because they are generated and overwritten on every build.

---

## 3. Directory Layout

```
modsutd/
├── data/                  # Source of truth JSON files
│   ├── mods/              # One JSON per mod (e.g. 10_014.json, 50_001.json)
│   ├── venues/            # One JSON per venue (e.g. 1_309.json)
│   └── _meta/             # Term calendars, specialisations, virtual tour scenes
├── frontend/              # React 18 + Vite + TypeScript application
│   ├── src/
│   │   ├── workbench/     # Desktop window manager, panels, timetable, mobile sheets
│   │   ├── utils/         # Timetable parser, ICS generator, bookmarklet extractor
│   │   ├── reducers/      # Redux state (mods, timetable, venues, layout)
│   │   └── types/         # TypeScript interface definitions (Mod, Venue, Plan)
│   ├── e2e/               # Playwright test specs (desktop + mobile)
│   └── scripts/           # sync-data.mjs, prerender.mjs, check-selectors.mjs
├── tools/scraper/         # Python scrapers for official SUTD mod pages
└── .claude/skills/        # Repeatable procedure playbooks
```

---

## 4. The Verification Gate: What `npm run merge-ready` Does

Before opening a pull request, all five checks must pass. In `frontend/`, run:

```bash
npm run merge-ready
```

Behind the scenes, this runs:

```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run e2e
```

### What Each Step Executes

1. **`npm run lint` (`eslint . --report-unused-disable-directives --max-warnings 0`)**
   - Scans all TypeScript and React files.
   - Enforces React hook dependency rules and import hygiene.
   - Fails if there is even one warning or unused directive.
2. **`npm run typecheck` (`tsc --noEmit`)**
   - Runs the TypeScript compiler in check-only mode without outputting files.
   - Catches type mismatches, missing props, and unsafe `any` types.
3. **`npm run test` (`vitest run`)**
   - Runs all 450+ unit and component tests in `frontend/src/` inside jsdom.
   - Validates RFC 5545 `.ics` calendar generation, prerequisite tree evaluation, timetable regex parsing, and mod review's draft persistence across panel remounts.
4. **`npm run build` (`prebuild` -> `tsc && vite build` -> `postbuild`)**
   - **`prebuild`**: Runs `scripts/sync-data.mjs` to validate `/data` JSON, compile mod/venue bundles, and generate `sitemap.xml`.
   - **`tsc && vite build`**: Bundles the client app into production static assets (`dist/`).
   - **`postbuild`**: Runs `scripts/prerender.mjs`, which launches a headless browser to pre-render all 618 mod and venue pages into static HTML so crawlers and direct navigations work without JavaScript execution.
5. **`npm run e2e` (`pree2e` -> `playwright test`)**
   - **`pree2e`**: Runs `scripts/check-selectors.mjs` to ensure required accessibility selectors and `data-panel` attributes exist in the production bundle.
   - **`playwright test`**: Runs the full browser automation suite across two browser viewports:
     - `chromium-desktop` (1280x720 windowed workbench).
     - `chromium-mobile` (Pixel 7 touch-emulated viewport 412x915).
   - Tests complete user journeys: timetable drag-and-drop, `.ics` exports, review form editing, bookmarklet prefill precedence, and timetable clash detection.

---

## 5. AI Agent Skills & Worked Examples

Repeatable procedures live in `.claude/skills/`. Both human developers and AI assistants follow these:

### 1. `mod-data`
- **What it does**: Standards for adding or editing mods and venues in `/data`.
- **Constraint**: Every prerequisite and syllabus link must cite official documentation. Never invent synthetic schedules or instructor names.
- **Worked Example**:
  Updating `data/mods/50_001.json` when the mod requires either 10.014 or 10.020:
  ```json
  "prerequisites": ["10.014", "10.020"],
  "prereqTree": {
    "or": ["10.014", "10.020"]
  }
  ```

### 2. `venue-search`
- **What it does**: Manages room codes, coordinates, and search aliases.
- **Constraint**: Room names and lift lobbies must match physical door plates and campus wayfinding signs.
- **Worked Example**:
  Adding a campus alias for "Think Tank 3" in `data/venues/1_309.json`:
  ```json
  {
    "code": "1.309",
    "name": "1.309",
    "altNames": ["Think Tank 3", "TT3"],
    "liftLobby": "Lobby A",
    "floor": 3
  }
  ```

### 3. `pr-review`
- **What it does**: Checklist for running adversarial code reviews before merge.
- **Constraint**: Enforces zero em dashes, checks data migration compatibility, verifies both desktop and mobile layouts.
- **Worked Example**:
  Verifying a PR before merge:
  ```bash
  # Check for forbidden em dashes in diff
  git diff main...HEAD | grep -P "[\x{2014}\x{2013}]"
  # Run full verification suite
  npm run merge-ready
  ```

### 4. `new-term`
- **What it does**: Rollover procedure when a new academic term begins.
- **Constraint**: Updates term calendar dates and active terms without breaking past cohort degree plans.
- **Worked Example**:
  Adding Term 1 2026 to `data/_meta/term-calendar.json`:
  ```json
  {
    "term": "1",
    "year": "2026",
    "start": "2026-09-14",
    "recessWeek": 7,
    "end": "2026-12-18"
  }
  ```

### 5. `retire-mod`
- **What it does**: Archives a discontinued mod.
- **Constraint**: Hides the mod from new searches while keeping it intact for students who completed it in previous years.
- **Worked Example**:
  Marking `data/mods/01_112.json` as retired:
  ```json
  {
    "code": "01.112",
    "retired": true,
    "retiredReason": "Replaced by 01.114 effective AY2026"
  }
  ```

### 6. `gather-mods`
- **What it does**: Scrapes official SUTD mods pages to identify new or changed subjects.
- **Constraint**: Outputs structured diffs for human review; scrapers never auto-commit raw text.
- **Worked Example**:
  ```bash
  python tools/scraper/gather_mods.py --limit 5
  python tools/scraper/what_changed.py
  ```

---

## 6. How to Collaborate: AI Agents + Human Review

modSUTD is developed collaboratively using AI coding tools alongside human review.

### The "Typist vs Reviewer" Principle

- **The AI is the typist, you are the technical lead**: Never ship AI-generated code without reading the diff line by line.
- **AI claims, tests verify**: An AI model might assert that a fix works. Only passing test outputs and real terminal exit codes confirm it.

### Step-by-Step AI Pairing Workflow

1. **Set Context and Constraints Early**:
   Point your AI assistant to `CLAUDE.md` and `docs/architecture.md` on your first prompt:
   ```
   Read CLAUDE.md and docs/architecture.md before proposing edits.
   Invariants: no backend, no database, no new libraries without discussion, no em dashes.
   ```
2. **Test-First Implementation (TDD)**:
   Have the AI write a reproducible failing test before modifying implementation code:
   ```
   Write a Vitest test in frontend/src/workbench/ReviewForm.test.tsx that reproduces
   the issue where arriving bookmarklet text beats an older draft. Verify the test fails.
   ```
3. **Minimal, Targeted Implementation**:
   Keep code changes bounded. Fix the immediate problem without bundled refactoring or unrelated cleanup.
4. **Human Review Gate**:
   Inspect `git diff` for repo style invariants:
   - Are there any em dashes (\u2014 or \u2013 unicode characters)?
   - Do comments explain **WHY** and **HOW**, never **WHAT**?
   - Does any file contain personal machine paths (e.g. `/Users/name/`)?
5. **Run the Verification Gate**:
   Execute `cd frontend && npm run merge-ready`. If any step fails, feed the exact compiler or test log back to the AI to diagnose the root cause.

---

## 7. Submitting Your Pull Request

1. **Branch Naming**:
   - `feat/` for new capabilities (e.g. `feat/room-filter-by-building`).
   - `fix/` for bug fixes (e.g. `fix/eval-prefill-reversion`).
   - `data/` for mod or venue metadata edits (e.g. `data/50-001-prereq`).
   - `docs/` for documentation updates.
2. **PR Title**:
   Prefix with the affected domain: `frontend:`, `data:`, `scraper:`, or `docs:`.
3. **PR Template**:
   Use `.github/pull_request_template.md`:
   - **Cause**: What problem or gap triggered this PR?
   - **Fix**: How does the code resolve it?
   - **Migration**: Did any `localStorage` key or JSON format change? If so, how are older browser clients migrated without losing user data?
   - **Verification**: Paste real terminal command outputs from `npm run merge-ready`.
