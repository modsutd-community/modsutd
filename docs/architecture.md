# Architecture

What modSUTD runs on, what it does with data, and why it is shaped this way.
The rules an agent must not break are in [CLAUDE.md](../CLAUDE.md); what the
site does for a student is in the [README](../README.md).

## The stack

| Layer      | Choice                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| Frontend   | React 18 + TypeScript + Vite, SCSS modules                                                            |
| State      | Redux Toolkit, persisted to `localStorage`                                                            |
| Search     | MiniSearch, entirely client-side                                                                      |
| Backend    | **none** - static JSON behind a CDN                                                                   |
| Data store | JSON in `/data`, version-controlled. Git is the database: every change is a reviewable, revertible PR |
| Map        | Leaflet, loaded on demand, over OpenStreetMap tiles                                                   |
| Reviews    | Giscus on GitHub Discussions - identity, moderation and spam handling are GitHub's                    |
| Scraper    | Python + httpx on a monthly Action; every data change lands as a PR a human reviews                   |
| Hosting    | Vercel, with a preview deploy per PR                                                                  |

Redux earns its place because three things converge: the plan holds an
arbitrary set of placed mods per curriculum, the search box needs the whole
catalogue, and timetable, plans and records all have to survive a reload. Each
slice is under a hundred lines.

## What the site knows about you

**Never leaves your browser, unless you link GitHub.** Your pasted timetable is
parsed client-side and kept in `localStorage`, along with your plan, your
per-mod records, your consent flag and your layout. `.ics` exports are
generated locally.

Linking a GitHub account turns that into a **private gist on your own
account**, so a second device shows the same thing. What goes in it: your
records, both curricula's plans, your declared tracks, the parsed timetable,
the slots you contributed but which have not deployed yet, which batch chats
you asked for, your consent tick, and your settings (curriculum, retired-mod
visibility, planned term and pillar, sort order). Not your search box, not
which mod you have open, not the mobile tab you are on - a phone that jumped to
whatever the laptop was looking at would be worse than one that did not sync.

The consent tick travels **one way only**: a device can turn it on for the
others, never off. There is no revoke button, so clearing site data is how you
withdraw it - and a sync that could carry `false` would be one device silently
withdrawing a permission another one gave. Unlink, and nothing further leaves.
The gist stays on your account until you delete it.

**Leaves your device, and how:**

| To                                     | What it sees                                                   | When                                                                                   |
| -------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Vercel                                 | standard web-server logs, including your IP                    | any page load                                                                          |
| Google Fonts                           | your IP                                                        | any page load. Self-hosting is planned                                                 |
| api.github.com + githubusercontent.com | your IP                                                        | opening the Contribute panel, to list contributors                                     |
| tile.openstreetmap.org                 | your IP, and which squares of campus you looked at             | opening a room. The floor plan itself is `/data/indoor.geojson`, served from this site |
| giscus.app                             | your IP, and your GitHub identity if you post                  | opening a mod's reviews                                                                |
| `/api/contribute`                      | the parsed slots below, and your IP in that one request's logs | pasting a timetable, after the consent gate                                            |

**Crowdsourced slots are the one thing contributed automatically**, and the
consent gate says so before anything is parsed. What goes: mod code, session
type, day, start and end time, venue. What does not: instructor names, dates,
your name, any account. A workflow re-validates every field from scratch and
commits the clean ones into the per-mod course files, aggregated. The repo never
stores a per-person timetable.

**Reviews are the opposite**, deliberately. They post to GitHub Discussions
under your own name, because a signed review is a credible one. Linking GitHub
is optional and off by default; the token stays in your browser, and the two
relays involved only pass GitHub's device-code handshake back and forth.

**Deliberately absent:** accounts, passwords, sessions, a database, analytics,
tracking pixels, cookies we set, ads, and any secret in the shipped bundle.

## Which layer owns a change

1. **A fact about a room or a mod** goes in `/data`, as a PR citing its source.
2. **A different spelling of a fact already there** goes in `search.ts`, never
   into `altNames` - every field a record carries is rendered, so a variant
   stored as data is the same sentence twice on one screen.
3. **Something needing a token the browser cannot hold** is a relay in
   `api/`, and it stays request-scoped. The moment it remembers a user
   between requests it has become the backend this project does not have.
4. **One student's business** is `localStorage`.
5. **Geometry** goes to OpenStreetMap, by manual changeset, from your own
   survey. See [osm-instructions.md](osm-instructions.md).

## Tokens, and the three places they go

Every name, and what each one is for, is `.env.example` at the repo root. This
is the other half: where to put it. Everything is optional - the site runs as a
fully static build with none of it, and a missing token switches its path off
rather than failing.

| Set it with                                                       | Where                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `gh secret set NAME --repo modsutd-community/modsutd`             | GitHub Actions (`gh variable set` for the ones marked _var_) |
| `vercel env add NAME production` **and** `preview`, then redeploy | Vercel                                                       |
| a line in `.env.local` at the repo root                           | local, for `npm run dev` and the python tools alike          |

| Name                                                   | Actions | Vercel | local |
| ------------------------------------------------------ | :-----: | :----: | :---: |
| `GEMINI_TOKEN`                                         |    x    |        |   x   |
| `GROQ_TOKEN`                                           |    x    |        |   x   |
| `OPENAI_TOKEN`                                         |    x    |        |   x   |
| `GEMINI_MODEL` / `GROQ_MODEL` / `OPENAI_MODEL` _(var)_ |   opt   |        |  opt  |
| `MODSUTD_BOT_TOKEN`                                    |    x    |   x    |   x   |
| `GITHUB_CLIENT_ID`                                     |         |   x    |   x   |
| `TG_LINK_KEY`                                          |    x    |   x    |   x   |
| `TG_API_ID`                                            |    x    |        |   x   |
| `TG_API_HASH`                                          |    x    |        |   x   |
| `TG_SESSION`                                           |    x    |        |       |
| `TG_BOT_USERNAME` _(var)_                              |   opt   |        |  opt  |
| `SITE_URL` _(var)_                                     |   opt   |        |  opt  |
| `VERCEL_DEPLOY_HOOK`                                   |    x    |        |       |

`GITHUB_TOKEN` is provided by Actions; never set it yourself.

`VERCEL_DEPLOY_HOOK` is a URL from Project Settings → Git → Deploy Hooks,
pointed at `main`. It carries its own secret in the path and needs no token, so
it is all `deploy.yml` uses. The Vercel CLI is deliberately not used: `vercel
pull` and `vercel build` resolve the token's user first, and a token scoped to
a team has none - `/v2/user` answers 404 and the CLI stops at "Could not
retrieve Project Settings" without saying why.

Three that are easy to get wrong:

1. **Never prefix any of these `VITE_`.** Vite inlines a `VITE_` var verbatim
   into the public bundle, which publishes it to every visitor.
2. **`GITHUB_CLIENT_ID` is not an Actions secret**, and not secret at all - it
   is the public client id of an OAuth App, and nothing in CI reads it.
3. **A secret value is never readable again**, by anyone including you. `gh
secret list` shows names and dates. Losing one means rotating it.

## How failure shows up

Failure here is usually silent, so every generator fails loudly instead:
`sync-data.mjs` refuses to write an empty catalogue and fails the build on a
`mapName` the map does not have, the scraper skips rather than wiping when a
source returns nothing, and the OSM generators refuse to write a thin answer -
a mirror can return 200 with almost nothing.

| Mode                        | What happens                                | Recovery                                                                   |
| --------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| SUTD redesigns a page       | the scraper returns nothing for that source | it skips, and the monthly freshness workflow opens an issue naming the gap |
| A relay's secret is missing | `/api/*` answers 503                        | the static site is unaffected, which is why relays hold no data            |
| Vercel bandwidth exhausted  | the site 503s                               | mirror to Cloudflare Pages, same shape                                     |
| Giscus rate-limited         | reviews fail to post                        | the Discussions UI stays reachable, and the panel links to it              |

## Vocabulary

| Term      | Here it means                                                         |
| --------- | --------------------------------------------------------------------- |
| Pillar    | SMT, EPD, ESD, CSD, DAI, ASD or HASS. A mod belongs to one or more    |
| Term      | 1 to 10. A degree is up to ten terms                                  |
| Room code | `building.level+room`, so 2.311 is building 2, level 3, room 11       |
| Slot      | one weekly occurrence of a class in a room, crowdsourced from a paste |
| Workbench | the app: draggable panels on desktop, four tabs on mobile             |
| Relay     | a stateless function in `api/` holding a token a browser cannot       |
