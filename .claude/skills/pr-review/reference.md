# PR review (merge / pull request review)

A thorough, opinionated review. The point is to be the **mirror image of the spec**: the spec says what was intended; the review verifies the code against it and against itself.

## Inputs to gather

- **The PR:** `<branch, or the diff itself>`
- **The product/design doc(s) to check against:** `<link or paste>`
- **Build/test commands** for the changed packages.

## Method (do this literally, and report it at the top)

- Check out the branch locally.
- Read **every non-generated production file** in the diff end to end — not just the hunks.
- Cross-check the implementation against the product/design doc.
- Run the build/vet and the test suite for the changed packages; report results.
- **Actively hunt for cross-file INCONSISTENCY**: two conventions for the same thing, one list endpoint ordered and another not, a comment that contradicts the code, DB/driver semantic gaps the test suite can't catch. (This line is the highest-signal instruction — most sharp findings are impossible from a hunk-only skim.)

## Structure

1. **Header** — branch, merge base, diff stats.
2. **"How this was reviewed"** — the method above, in 2-3 sentences. (Trust anchor.)
3. **"What this PR does"** — neutral summary of each new/changed module; end with one open question you'd ask the author.
4. **"Verdict: Approve / Approve with changes / Request changes"** — one calibrated paragraph. Name the exact number of blocking issues; classify the rest into families.
5. **Findings in severity tiers**, each defined:
    - **P0** — Must fix before merge (real correctness / security / data bugs).
    - **P1** — Must fix, can land as follow-up commits.
    - **P2** — Worth noting, not blocking (test coverage, duplication, code habits).
6. **"What's done well"** — 3-5 SPECIFIC, located things worth propagating to other teams. No filler.

## Per-finding template (every P0/P1)

```javascript
## Pn-k ·
**Location:** file:line-range (list all relevant sites)
### The problem     — the mechanism, in code terms, walked through step by step.
### Why it matters  — the PRODUCTION failure mode, not a restatement. "Looks fine with N test
                      rows; the first time  happens, ."
### Suggested fix   — actual code (a diff or replacement fn), not "consider refactoring".
### Required follow-up / Test gap — ONLY if the fix has a catch (introduces a deadlock, needs a
                      schema change, needs a new concurrent test, etc.).
```

## Signature moves

- Every claim anchored to `file:line`.
- **Root cause over symptom** — chase down to library/DB/driver semantics if that's the real cause (e.g. "gorm sorts map keys → MySQL evaluates SET left-to-right → the guard silently collapses, and SQLite can't catch it so the suite stays green").
- **Concrete interleaving/timeline** for any concurrency claim.
- **Distinguish bug classes** — one real correctness bug vs. a family of performance patterns vs. code habits. Don't inflate.
- **Cite both sites** when the implementation contradicts a principle the code/doc states elsewhere.
- **Praise as specific and located as criticism** — name why the pattern is good, recommend it.
- Calibrated first person — it's fine to say "exactly one blocking issue".
