# AGENTS.md

The rules for working in this repo live in **[CLAUDE.md](CLAUDE.md)**, and they
apply to every agent, not only Claude. Read that file first and follow it as
written.

It is one file rather than three because the alternative is three files that
disagree, and the one an agent happens to read decides what it does.

Quickest orientation, if you read nothing else:

- **Architecture invariants** are in CLAUDE.md and are not up for renegotiation
  in a PR. No backend, no database, `/data/*.json` is the source of truth, and
  new runtime dependencies need a Discussion.
- **The verification gate** is `npm run merge-ready` in `frontend/`. Green or
  the work is not ready, and report the real numbers.
- **Write the test so it can fail.** After writing one, invert the fix and check
  it goes red. A test that has never failed has not been tested.
- **Never commit or echo credentials**, and never prefix anything `VITE_` that
  is not meant to be public - Vite inlines those into the shipped bundle.
- **No `Co-Authored-By` trailers** on commits, and **no em dashes** in prose.

Repeatable procedures are skills in `.claude/skills/`, and they are plain
Markdown - readable by any agent, whatever runs them. `new-term`, `course-data`,
`gather-listing`, `gather-specialisations`, `venue-search`, `pr-review`.
