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
- **Docs change with the code.** If you touched a field, flag, filename or
  rule, grep for it and update every doc, skill and comment that names it, in
  the same PR. And write each fact once, linking to its home rather than
  restating it - two copies become two answers.
- **Never commit or echo credentials**, and never prefix anything `VITE_` that
  is not meant to be public - Vite inlines those into the shipped bundle.
- **No `Co-Authored-By` trailers** on commits, and **no em dashes** in prose.

- **Opening a PR?** `.github/pull_request_template.md` is the shape: cause,
  fix, migration, test, checklist. GitHub prefills it in the browser; `gh pr
  create` does not, so paste it in with
  `--body-file .github/pull_request_template.md` and fill it, or it lands blank.
  The comment at the top of that file says how to write the body, including the
  two rules agents break most: no em dashes, and no count of how often something
  went wrong before.
- **Changing a stored shape?** A localStorage key, a gist section, an export
  file or a JSON field name. The site is live and has no backend, so that data
  is in browsers a deploy cannot reach. Read the old name or say whose data you
  are dropping, and answer it in the PR's Migration section.

Repeatable procedures are skills in `.claude/skills/`, and they are plain
Markdown - readable by any agent, whatever runs them. `new-term`, `course-data`,
`gather-listing`, `gather-specialisations`, `venue-search`, `pr-review`.
