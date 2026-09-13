---
name: retire-mod
description: Retire a course SUTD no longer offers - mark it, keep its history, and close its review thread. Use when a course page 404s, disappears from the sitemap, or is replaced by a new code.
---

# Retiring a mod

SUTD drops courses occasionally. 10.009 The Digital World became 10.014, which became
10.025, which became a course with no number yet. 40.014 was replaced by
40.018.

**Never delete the file.** A student on an older cohort took that course, their
saved plan still names it, its code is still a prerequisite of something, and
its giscus thread is the only record of what taking it was like. Deleting takes
all four and cannot be undone from the app.

## 1. Prove it is actually gone

A course missing from one page is not retired. Check the sitemaps, which are
what `freshness.py` compares against:

```bash
curl -s https://www.sutd.edu.sg/course-sitemap.xml \
     https://www.sutd.edu.sg/course-sitemap2.xml \
  | grep -oE "/course/20-099[a-z0-9-]*/"
```

A hit means it is live and must not be retired - the page you were reading is
just the wrong page. This is not hypothetical: 20.099 was retired here on an
agent's word and had to be restored, because `/course/20-099-urban-sketching/`
is in the sitemap.

Nothing there? Confirm the course page 404s directly, and check whether a
successor code exists (`40.014` -> `40.018`).

## 2. Mark it

One field, in the course's own JSON:

```json
"retired": true
```

`useFilteredMods` drops retired mods from the catalogue unless the reader ticks
**retired** on the pillar row. Everything else keeps working: prerequisite trees
still resolve to it, saved plans still render it, search still finds it when the
box is ticked.

If a successor exists, say so in the description rather than inventing a field:

> Superseded by 40.018 Engineering Systems Architecture.

## 3. Close its review thread

The thread stays - the reviews on it are the point - but it should stop taking
new ones. Discussions are closed through the GraphQL API; the REST API cannot
do it.

```bash
# the discussion is titled `mod-<code>`
gh api graphql -f query='
  query($q: String!) {
    search(type: DISCUSSION, query: $q, first: 5) {
      nodes { ... on Discussion { id title closed } }
    }
  }' -f q='repo:modsutd-community/modsutd in:title mod-40.014'

gh api graphql -f query='
  mutation($id: ID!) {
    closeDiscussion(input: { discussionId: $id, reason: OUTDATED }) {
      discussion { closed closedAt }
    }
  }' -f id='<the id from above>'
```

`reason: OUTDATED` is the honest one - the course is gone, the reviews are not
wrong. giscus still renders a closed thread and its comments; it just refuses
new ones.

## 4. Verify

```bash
cd frontend && npm run merge-ready
```

`retired.test.ts` pins that the flag is set on a mod that has one and absent on
a live mod, and that a retired code is still reachable as a prerequisite. If you
retired something that is still someone's prerequisite, that test is what tells
you the file had to stay.

## What this is not for

- **A course that moved term or changed name.** Edit the record; see
  `.claude/skills/course-data`.
- **A course split into lettered halves** (03.007 -> 03.007A/03.007B). All three
  can be live at once. `gather_mods.py` refuses to recreate a base code whose
  lettered siblings exist, so do not "tidy" the base file away.
- **A placeholder** (`99.999`, `02.XFER`). Those are ours, not SUTD's, and are
  removed outright when they stop being needed.
