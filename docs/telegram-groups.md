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
        > Created by modSUTD

    `adminGranted` is recorded so the group is never visited again. The
    throwaway **stays** until the term ends: Telegram revokes the invite
    links of a user who leaves, so walking out here would kill the link it
    just exported.

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

## failure modes to expect

- **Session invalidated** -> both workflows fail loudly; relink by
  re-running `login.py` and replacing `TG_SESSION`.
- **Flood limits on creation**: the daily cap spreads a burst of
  first-clicks across days. The button copy must never promise instant.
- **Unadopted groups**: a group nobody joins keeps the throwaway inside
  until it expires. Harmless, but it is why the account must be muted.
- **A full chat**: 200 members is the hard basic-group cap; further joins
  fail with `USERS_TOO_MUCH`. Only relevant for a very large batch.
