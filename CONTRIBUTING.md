# Contributing

Every bit goes a long way!

- honest module reviews
- design
- code
- data fixes
- donations to keep this alive

## AI-assisted contributions

Most PRs here - including the original codebase - involve AI coding
tools, and that's welcome. Three rules make it work:

1. Point your agent at [CLAUDE.md](CLAUDE.md) first. It encodes the
   architecture invariants (no backend, no DB, no analytics - deliberate),
   the house style, and the verification gate. The project skills in
   `.claude/skills/` encode recurring procedures (term rollover, data edits)
   so agents follow the established way instead of inventing a new one.
2. You read every line before it ships. The AI is your typist, not your
   reviewer.
3. Big idea? [Discussion as an issue](https://github.com/modsutd-community/modsutd/issues/new?template=Feature_Request.md) first, PR second.

## Technical Pre-reqs

With that being said, it is always good to understand what your code does, and what you would do differently. The technologies we use may be in greater detail at [docs/architecture.md](docs/architecture.md) but essentially the following:

- Git
- TypeScript (strongly typed JavaScript)
- React framework

## Development setup

> If you want to work on something big for the project, please [create a Feature Request issue](https://github.com/modsutd-community/modsutd/issues/new?template=Feature_Request.md) where we would be able to consider and discuss first before you start on it

> If you are fixing a bug, you may also similarly [create a Bug Report issue](https://github.com/modsutd-community/modsutd/issues/new?template=Bug_Report.md) if it doesn't exist yet, and comment on the thread that you wish to work on it, so that others will not duplicate your effort.

Install Node.js 24 - the version in `.nvmrc`, which is what CI reads too.
Then:

```bash
git clone https://github.com/modsutd-community/modsutd.git
cd modsutd/frontend
npm install   # install all dependencies
npm run dev   # http://localhost:3000
```

`npm run dev` also copies `/data` into the app, so a JSON edit shows up on a
refresh. You do not need to edit anything under `frontend/public/data/` as they are
generated.

Work in your own branch to isolate your edits from everyone else's

```bash
git checkout -b fix/prereq-50001
# ... edit ...
git commit -m "data: 50.001 prereq is 10.014, not 10.013"
git push -u origin fix/prereq-50001
# open a PR
```

The **branch** says what kind of change it is: `feat/`, `fix/`, `perf/`,
`docs/` or `chore/`.

The PR body has a template - cause, fix, test - which GitHub prefills for you
in the browser. `gh pr create` does not prefill it, so pass
`--body-file .github/pull_request_template.md` and fill it in.

The **PR title** says where it lands, because that is what a reviewer picks
from a list: `data:` for `/data/`, `frontend:`, `scraper:`, `docs:` for
`/docs/` and top-level `*.md`, `chore:` for repo plumbing. One concern per PR.

A data edit cites its source in the PR body - a URL, a screenshot, a syllabus
page. Memory from an individual alone would not suffice

Add a test for anything non-trivial, then run the same five checks CI does:

```bash
cd frontend
# full run of the 5 CI steps
npm run merge-ready
# or separately,
npm run lint        # zero warnings; CI enforces --max-warnings 0
npm run typecheck
npm test            # vitest
npm run build
npm run e2e         # playwright, desktop + mobile
```

All five green, or the PR is not ready.

## Style

- TypeScript: keep types tight. No `any`. Reach for `unknown` first.
- React: function components + hooks. No class components, no HOCs.
- SCSS modules. Variables in `frontend/src/styles/variables.scss`.
- Don't add libraries lightly. Each one is a contributor barrier and a security surface.

## Deployment

You would not have to worry about this, as the site automatically deploys from the main branch through Github Action workflows. Every other branch will be merged into it after review.

## Code of Conduct

Please refer to [Meta's Code of Conduct](https://opensource.fb.com/code-of-conduct/) that we expect contributors to adhere to.

## License

By contributing to modSUTD, you agree that your contributions will be licensed under its Apache 2.0 license.
