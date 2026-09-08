---
name: pr-review
description: Write a thorough, opinionated review of a pull request or a branch diff - tiered P0/P1/P2 findings, every claim anchored to file:line, checked against the docs it claims to implement. Use when asked to review a PR, a merge request, or "look over this branch before I merge". Not for casual code questions with no review deliverable.
---

# PR review

The mirror image of a spec: the spec says what was intended, the review
verifies the code against it and against itself.

This is the human-and-agent review, done locally with the branch checked out.
It is not what `.github/workflows/code-review.yml` does - that runs on
`pull_request_target` against untrusted code and deliberately never executes
it, so it can only read the diff. This skill runs the tests. The two are
complementary: the workflow is the automatic first pass on every contributor
PR, this is the read before a merge that matters.

## Discipline

1. **Every claim anchored to `file:line`.** No floating assertions. If
   something is not built yet, say so; never invent it.
2. **Proactive beyond the ask.** Correct the author's list, flag a bug found in
   passing, name the file they forgot.
3. **Backward compatibility is first-class.** For every change, say what old
   callers and old data do, and show it is a no-op for them.
4. **Honest about the unknown.** Close on real open questions, not false
   completeness.
5. **A table for any set of three or more parallel items.** Never narrate a
   comparison.

## This repo's specifics

- Run the gate from `frontend/`: `npm run lint`, `npm run typecheck`,
  `npm test`, `npm run build`, `npm run e2e`. Report the real numbers.
- `npm run e2e` builds and serves the production bundle on port 3100, never
  reusing a server, so `npm run dev` can stay up on 3000 and no run can test a
  stale build. If it cannot bind 3100, something else has the port - the run
  fails loudly rather than testing the wrong thing.
- Data PRs: check the claim against the source the PR body cites, and check
  `sync-data.mjs` still passes. It is the only thing standing between a wrong
  `mapName` and a link that silently opens the whole campus.
- Read the architecture invariants in `CLAUDE.md` before calling something a
  bug. Several things that look wrong are load-bearing and documented.

The full method, structure, per-finding template and signature moves are in
[reference.md](reference.md). Read it before writing.
