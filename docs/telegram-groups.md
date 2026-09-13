# per-mod Telegram chats

One fresh BASIC group per mod per batch, created on demand by @modsutd
Telegram account (bots cannot create groups at all - a Bot API
limitation), handed over to the first student who joins, and retired when
the term ends.

The button ("Join the Tele chat!" on a mod page) appears only when
`term >= 3 or HASS` **and** the mod has crowdsourced schedules **and** the
term window is still live **and** it is not a capstone/thesis (own project
teams, no cohort to chat with) - so no group is ever created for a mod
nobody is currently taking together.

## cast

| actor                  | job                                                                                                          | how long it stays                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| **@modsutd**           | creates the group, exports the invite link; later promotes the first human joiner and pins the handover note | leaves the moment it hands over   |
| **first human joiner** | the group's admin: removes spam, pins, invites                                                               | it is their group                 |
| **@modsutd_bot**       | _fallback only_ - a seed member if a server still enforces the old "a new group needs a second member" rule  | kicked immediately after creation |

Nothing of ours stays in a running chat: no bot, no account, no admin.

## lifecycle

**First click** (no live group for this mod yet):

1. The button POSTs `{mod}` to `/api/telegram-group` (same shape as
   `/api/contribute`: validate hard, fire a `repository_dispatch`, 202).
2. The button flips to "setting up the chat - usually under 2 min" and
   polls the registry (`data/telegram-groups.json` via
   raw.githubusercontent - CORS-open, no redeploy needed; needs the repo
   public, i.e. after launch).
3. `telegram-group.yml` re-validates everything from scratch (code shape,
   mod exists, term >= 3 or HASS, not capstone/thesis, has schedules, a
   live term window, no unexpired registry entry, daily creation cap) and
   runs
   `tools/telegram/create_group.py`:
    - `messages.createChat(users=[], title="50.001 Algorithms Aug'26")` - a
      BASIC group, alone, never a supergroup (bot-seeded only if the
      server refuses);
    - export the invite link (never direct-add members - `PEER_FLOOD`
      bans). Nothing is posted yet: an empty chat greets the first joiner,
      and the only pin is the handover note below;
    - **the throwaway stays**, muted: in a basic group only the creator can
      appoint an admin, so it has to be present when the first student
      arrives.
4. The workflow commits `{ "50.001": { link, title, created, expires,
chatId } }` to the registry (auto-commit, same policy as crowdsourced
   slots), the poll picks it up, and the button becomes the invite link
   with a copy icon.

**Handover** (`telegram-admin.yml`, daily, `tools/telegram/grant_admin.py`):

5. A free pre-check reads the registry; if no live group is still
   admin-less it exits without touching Telegram at all.
6. For each admin-less group it looks inside: no human yet -> stay parked
   for the next run. Otherwise it hands the chat over to the **earliest**
   joiner:
    - `messages.migrateChat` first. The right to appoint further admins is
      granular, granular rights do not exist on a basic group, and any
      Telegram client migrates silently the moment an admin reaches for
      that toggle. Doing it here means it happens once, deliberately, with
      the registry updated to match;
    - `channels.editAdmin` with `add_admins=True`, so one cohort rep going
      on exchange does not leave the group unmoderated for the term;
    - re-export the invite link and store it. The link does survive
      migration - tested on a live chat - but the registry is what
      students are handed, so it holds one this run read back off the
      migrated chat rather than one it assumed still worked;
    - send + pin the one and only message -

        > First person to join is now admin, and can make others admin too.
        > Invite your friends and enjoy!
        > Created by modSUTD.tech

    `adminGranted` and `adminUserId` are recorded. The throwaway **stays**
    until the term ends: Telegram revokes the invite links of a user who
    leaves, so walking out here would kill the link it just exported.

7. Every live chat this account can still address is then asked whether a
   human admin is still inside, because `adminGranted` describes what
   happened once and not what is true now. Telegram takes a member's admin
   rights with them when they leave, and the first joiner is free to join
   and walk straight back out, so a chat can be an hour old, handed over
   and already unmoderated. If the admin list holds nobody but the
   throwaway, the earliest remaining joiner is promoted and the note is
   pinned again. The link is NOT re-exported: nothing migrates here, and
   the link belongs to the throwaway, which is still in the chat. If the
   chat is empty of humans it parks exactly as an
   unadopted one does and waits for the next joiner. The throwaway is
   excluded from that question by construction: migration made it the
   channel creator, so it is an admin forever and would always answer yes. The
   two readings that decide it are `tools/telegram/participants.py`, which
   imports no telethon and so is checked on every pull request.

**Subsequent clicks**: the registry already holds the link, so the button
is a plain `t.me` link - no relay, no workflow, no Telegram API.

**Expiry**: entries carry `expires` = the term's end date (from
`data/term-window.json`, which the timetable contributions fill). Past
that the button and the link disappear from the site; the next term's
first click creates the next batch. Old groups live on in Telegram,
unlisted here.

## hard rules

- **A group is created basic and migrated exactly once**, at handover, by
  `grant_admin.py`. Nothing else may migrate one, and nothing may ask for
  a supergroup-only feature before then - a client that does will migrate
  the chat underneath the registry, leaving it pointing at a peer that no
  longer takes writes. The migration itself does not break the exported
  invite link; leaving the chat does, which is why the throwaway stays.
- **The registry is the only idempotency gate** (`data/telegram-groups.json`,
  keyed by mod code, `expires` decides liveness). Titles are never trusted
  or scanned: members may rename a group freely and the invite link keeps
  working, because the link belongs to the chat.
- **No modSUTD presence in a live chat.** The seed bot (if used) goes at
  creation, the throwaway at handover.

## two gates on the link, and neither is on the chat

Creating a chat is ungated: whoever presses first gets the group made for the
whole cohort, even if they cannot be shown the link themselves. Revealing the
link is where the cost of bulk collection is raised, and both gates live in
`api/telegram-link.js` and nowhere else.

- **Account age.** A threshold between 0 and 3 days, drawn PER ACCOUNT as an
  HMAC of the GitHub user id under `TG_LINK_KEY`: stable for that account,
  unguessable without the key, nothing stored. A fixed number would say exactly
  how long to age a throwaway; a per-request draw would be worse than no gate,
  because a new account would retry until it drew a 0. The range starts at 0 on
  purpose, so some accounts face no wait at all: a student who made an account
  this morning is a real student, and turning them away costs more than one
  throwaway getting through. The message never names the threshold, since that
  hands over the exact wait, and it points at the way out that always works:
  ask a classmate who is already in the chat.
- **Daily allowance.** Five links per account per day, which covers a whole
  timetable. Counted in a warm instance's memory, because a shared store is the
  backend this project does not have: a determined scraper gets more than five
  by forcing cold starts, a casual one does not.

Neither can stop a student who has a link from pasting it elsewhere, and
nothing can. `TG_LINK_KEY` rotating between terms is what makes last term's
ciphertext worthless.

## failure modes to expect

- **Session invalidated** -> both workflows fail loudly; relink by
  re-running `login.py` and replacing `TG_SESSION`.
- **Flood limits on creation**: Telegram allows 50 groups or channels a day
  per account, so the gate in `telegram-group.yml` caps a day at 40 and a
  burst past that spreads across days. The cap is re-checked at the commit,
  because runs for different mods overlap and several can clear one gate. The
  button copy must never promise instant.
  Past the cap the button says so and is unpressable, rather than accepting an
  ask that goes nowhere: the relay answers 202 for any well-formed code, the
  gate prints `skip=daily-cap` and exits green, so a pressed button would have
  shown "creating the chat..." for its ten-minute TTL and then gone back to
  offering with nobody told why. The browser counts it off the registry it
  already reads from main - every entry carries `createdDay` - so there is one
  number and no second place to keep it. `capReached` in
  `frontend/src/workbench/teleState.ts` is the reader, and its `DAILY_CREATE_CAP`
  has to move with the two in the workflow. UTC on both sides, which is 08:00
  in Singapore: a local date would disagree with the gate for those eight
  hours.
- **Two clicks at once**: runs are keyed on the mod, so different mods create
  in parallel and the same mod queues. A single queue for the whole workflow
  cancelled the second of three rapid clicks, because GitHub keeps one pending
  run per concurrency group.
- **Hitting the ceiling**: Telegram counts per ACCOUNT, so it can refuse before
  the registry's cap of 40 does - the session's own history counts, not just
  what this repo knows about. A refusal at creation is clean: nothing exists,
  the run fails, and the button goes back to offering once the browser's
  ten-minute ask expires, so the next click works. `create_group.py` prints the
  `FloodWaitError` wait so the log says when.
- **A group with no link**: the one failure that loses something is anything
  that goes wrong AFTER `CreateChatRequest`, because the group is real from
  that moment. `create_group.py` writes `/tmp/orphan.json` with the chat id and
  the workflow puts it in the job summary, which is enough to export a fresh
  invite for that chat and add the entry by hand. Without the entry nothing
  finds it again: the button, the cap and the end-of-term sweep all read the
  registry.
- **Unadopted groups**: a group nobody joins keeps the throwaway inside
  until it expires. Harmless, but it is why the account must be muted.
- **The admin who left**: a student can join, take the promotion and leave,
  and their admin rights go with them. The daily sweep re-asks rather than
  trusting `adminGranted`, so the next joiner gets it. Between the two the
  chat has no admin, which is the same state an unadopted group is in.
- **A full chat**: 200 members is the hard basic-group cap; further joins
  fail with `USERS_TOO_MUCH`. Only relevant for a very large batch.
