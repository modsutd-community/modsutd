"""Sweep: hand each batch chat over to its first human joiner.

Removing spam needs an admin, and in a basic group only the CREATOR can
appoint one (the Bot API cannot at all). So the throwaway stays in each
group it creates until this sweep finds a human inside: it promotes the
earliest joiner and pins the handover note. Groups nobody joined yet stay
parked for the next run.

The promoted student gets the right to appoint further admins, which one
cohort rep leaving campus for exchange should not be able to take away with
them. That right is granular, granular rights are a supergroup feature, so
the chat is migrated first - which is what any Telegram client does silently
the moment an admin reaches for that toggle.

Migration keeps the exported invite link working (tested on a live chat), and
this re-exports it afterwards regardless, so the registry never holds a link
that has not just been read back off the migrated chat.

It does NOT leave at handover, and that is load-bearing. Telegram revokes the
invite links of a user who leaves, so the link the registry stores died the
moment the throwaway walked out - every chat served "This invite link has
expired" from its first handover onwards, and a departed account can neither
read the new link nor make one ("You must be an admin in this chat to do
this"). It stays as an ordinary member instead, holding the link alive, with
the promoted human as the only admin.

It leaves once the term is over, in the same sweep: the entry has expired, the
link is about to be pruned from the registry anyway, and the chat belongs to
its members by then. Leaving also deletes the dialog on this side, so the
throwaway is not left carrying a list of every group it ever made - that
removes it for us only, never for anyone else.

A handover is not permanent, and `adminGranted` on its own stopped describing
a chat that has an admin. Telegram takes a member's admin rights with them when
they leave, and the first joiner is free to join and walk straight back out: a
chat can be an hour old, handed over, and already unmoderated. So every live
chat is asked each run whether a human admin is still inside, and one that is
not goes back in the queue for the next joiner. The throwaway does not count -
it is the channel creator after the migration, so it is an admin by
construction and would answer yes forever.

Reads/updates data/telegram-groups.json (adminGranted, adminUserId); prints the
codes it handed over, one per line.

    python grant_admin.py --self-check   # the two readers, no network
"""

from __future__ import annotations

import datetime
import json
import os
import pathlib
import sys

from telethon.sync import TelegramClient
from telethon.sessions import StringSession
from telethon.tl import functions, types

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from linkcrypt import encrypt  # noqa: E402

REG = pathlib.Path(__file__).resolve().parents[2] / "data" / "telegram-groups.json"

HANDOVER = (
    "First person to join is now admin, and can make others admin too. "
    "Invite your friends and enjoy!\nCreated by modSUTD"
)

# Everything a cohort needs to run its own chat, and nothing that only makes
# sense for a broadcast channel. add_admins is the point of the exercise: the
# rep who set the chat up should not be the one thing standing between the
# cohort and a moderated group for the rest of the term.
RIGHTS = types.ChatAdminRights(
    change_info=True,
    delete_messages=True,
    ban_users=True,
    invite_users=True,
    pin_messages=True,
    add_admins=True,
    manage_call=True,
    anonymous=False,
    other=True,
    post_messages=False,
    edit_messages=False,
)


def active(entry: dict) -> bool:
    return bool(entry.get("expires")) and datetime.date.today().isoformat() <= entry["expires"]


def peer_of(client, entry: dict):
    """The addressable peer for a registry entry, migrated or not.

    Never a bare int. Telethon reads a positive integer as a USER id, so
    `delete_dialog(5356139899)` goes looking for a person and fails with
    "Could not find the input entity for PeerUser" - which the sweep then
    recorded as a clean exit while the account stayed in the group.

    Three shapes: a supergroup this sweep migrated (id plus the access hash it
    stored), a chat somebody migrated from a Telegram client (the old chat
    survives as a tombstone carrying `migrated_to`, so follow it), and a basic
    group still as it was created.
    """
    if entry.get("supergroup") and entry.get("accessHash") is not None:
        return types.InputPeerChannel(
            channel_id=entry["chatId"], access_hash=entry["accessHash"]
        )
    chat = types.PeerChat(chat_id=entry["chatId"])
    moved = getattr(client.get_entity(chat), "migrated_to", None)
    if moved is not None:
        return types.InputPeerChannel(
            channel_id=moved.channel_id, access_hash=moved.access_hash
        )
    return chat


def sort_joiners(parts, users, me_id: int) -> tuple[list[int], list[int]]:
    """(humans earliest first, bots) out of a participant list.

    Pure, and shared by the basic group and the migrated channel, because the
    two requests answer with different participant classes carrying the same
    two fields. The creator has no `date` at all, so a missing one sorts last
    rather than raising against an int.
    """
    by_id = {u.id: u for u in users}
    humans: list[tuple[object, int]] = []
    bots: list[int] = []
    for part in parts:
        uid = getattr(part, "user_id", None)
        if uid is None or uid == me_id:
            continue
        user = by_id.get(uid)
        if user is not None and getattr(user, "bot", False):
            bots.append(uid)
            continue
        if user is not None and getattr(user, "deleted", False):
            continue
        humans.append((getattr(part, "date", None), uid))
    humans.sort(key=lambda h: (h[0] is None, h[0]))
    return [uid for _, uid in humans], bots


def has_human_admin(parts, users, me_id: int) -> bool:
    """Whether anyone but this account still administers the chat.

    Asked of the ADMIN list rather than of one recorded user id, because the
    two ways a handover comes undone look identical from here: the admin left,
    or another admin demoted them. Deleted accounts do not count - a deactivated
    Telegram account keeps its rank and can do nothing with it.
    """
    return bool(sort_joiners(parts, users, me_id)[0])


def migrate(client, chat_id: int) -> types.Channel:
    """Migrate the basic group and return the Channel it became.

    The Channel itself, not an InputChannel. The two are not interchangeable:
    channels.editAdmin wants an InputChannel, while send_message and
    exportChatInvite want an InputPeer, and handing either the wrong one raises
    before anything is sent. Telethon casts a Channel to whichever is needed,
    so the caller passes this object everywhere and lets it decide.

    Read out of the response rather than guessed from the old id: a migrated
    chat is a DIFFERENT peer, and writing to the old one is a PEER_ID_INVALID.
    """
    updates = client(functions.messages.MigrateChatRequest(chat_id=chat_id))
    for chat in getattr(updates, "chats", []):
        if isinstance(chat, types.Channel):
            return chat
    raise RuntimeError("migrateChat returned no channel")


def main() -> int:
    reg = json.loads(REG.read_text(encoding="utf-8") or "{}")
    todo = {c: e for c, e in reg.items() if not e.get("adminGranted") and active(e)}
    # Handed over by THIS sweep, still running, and addressable as a channel.
    # Asked every run whether the promotion still holds: a chat whose only human
    # admin has left is in the state the sweep exists to prevent, and it can
    # arrive there any day rather than only on the day of the handover.
    #
    # The three conditions past `adminGranted` are narrower than "every live
    # chat" on purpose. `channels.getParticipants` answers for a channel and not
    # for a basic group, and the handover writes `adminGranted`, `supergroup`
    # and `accessHash` in one block, so an entry carrying the first without the
    # other two is one a person edited. A term that is over is the `done` queue
    # below: the chat belongs to its members by then and this account is walking
    # out of it.
    recheck = {
        c: e for c, e in reg.items()
        if e.get("adminGranted") and active(e) and not e.get("left")
        and e.get("supergroup") and e.get("accessHash") is not None
    }
    # Terms that are over and this account has not yet walked out of. The link
    # is dead weight from here - telegram-prune deletes the ciphertext on the
    # first Saturday anyway - and the chat is the students'.
    done = {c: e for c, e in reg.items() if not active(e) and not e.get("left")}
    if not todo and not done and not recheck:
        return 0

    client = TelegramClient(
        StringSession(os.environ["TG_SESSION"]),
        int(os.environ["TG_API_ID"]),
        os.environ["TG_API_HASH"],
    )
    changed = False
    with client:
        me = client.get_me()
        for code, entry in todo.items():
            try:
                chat_id = entry["chatId"]
                if entry.get("supergroup"):
                    # Migrated by hand between runs. Nothing here can promote
                    # into it blind, and guessing the first joiner from a
                    # channel's participant list is a different query with
                    # different ordering - leave it for a person.
                    print(f"{code}: already a supergroup, skipping", file=sys.stderr)
                    continue
                full = client(functions.messages.GetFullChatRequest(chat_id))
                humans, bot_ids = sort_joiners(
                    full.full_chat.participants.participants, full.users, me.id)
                if not humans:
                    continue  # nobody joined yet - stay parked, retry next run
                first = humans[0]

                for bid in bot_ids:  # defensive: the seed bot leaves at creation
                    client(functions.messages.DeleteChatUserRequest(chat_id=chat_id, user_id=bid))

                # Migrate BEFORE promoting. add_admins is a granular right and
                # granular rights do not exist on a basic group, so the promotion
                # has to land on a channel or it silently degrades to the legacy
                # flag, which cannot appoint anyone.
                channel = migrate(client, chat_id)
                client(functions.channels.EditAdminRequest(
                    channel=channel, user_id=first, admin_rights=RIGHTS, rank=""))

                # Re-export rather than trust the old one. The link does survive
                # migration, but the registry is what students are handed, and it
                # should hold something this run has read back off the live chat.
                invite = client(functions.messages.ExportChatInviteRequest(peer=channel))
                entry["linkEnc"] = encrypt(invite.link)
                # Both halves of the peer. A channel id alone is not
                # addressable: resolving it needs the access hash, and the
                # session that leaves months later may not have this chat in
                # its entity cache any more.
                entry["chatId"] = channel.id
                entry["accessHash"] = channel.access_hash
                entry["supergroup"] = True

                note = client.send_message(channel, HANDOVER)
                client(functions.messages.UpdatePinnedMessageRequest(peer=channel, id=note.id))
                # Deliberately NOT leaving here: see the module docstring. The
                # invite link in the registry belongs to this account and dies
                # with its membership.
                entry["adminGranted"] = True
                entry["adminUserId"] = first
                changed = True
                print(code)
            except Exception as exc:  # noqa: BLE001 - one bad group must not stall the sweep
                print(f"{code}: {type(exc).__name__}: {exc}", file=sys.stderr)

        for code, entry in recheck.items():
            try:
                peer = peer_of(client, entry)
                admins = client(functions.channels.GetParticipantsRequest(
                    channel=peer, filter=types.ChannelParticipantsAdmins(),
                    offset=0, limit=200, hash=0))
                if has_human_admin(admins.participants, admins.users, me.id):
                    continue

                members = client(functions.channels.GetParticipantsRequest(
                    channel=peer, filter=types.ChannelParticipantsRecent(),
                    offset=0, limit=200, hash=0))
                humans, _ = sort_joiners(members.participants, members.users, me.id)
                if not humans:
                    # The screenshot case: the first and only joiner left the
                    # same minute they arrived. Nothing to promote, so the chat
                    # waits for the next joiner exactly as an unadopted one does.
                    print(f"{code}: admin left, nobody inside - parked",
                          file=sys.stderr)
                    continue

                client(functions.channels.EditAdminRequest(
                    channel=peer, user_id=humans[0], admin_rights=RIGHTS, rank=""))
                # Deliberately NOT re-exporting the link. The handover does it
                # because migration makes a different peer; nothing migrates
                # here, and the link belongs to the throwaway, which is still
                # inside. It is the same link it always was.
                entry["adminUserId"] = humans[0]
                note = client.send_message(peer, HANDOVER)
                client(functions.messages.UpdatePinnedMessageRequest(peer=peer, id=note.id))
                changed = True
                print(f"{code}: re-granted")
            except Exception as exc:  # noqa: BLE001 - one bad group must not stall the sweep
                print(f"{code}: recheck: {type(exc).__name__}: {exc}", file=sys.stderr)

        for code, entry in done.items():
            try:
                # Leave AND drop the dialog, so this account does not end up
                # holding a list of every group it ever made. delete_dialog
                # removes it on this side only - the group and its members are
                # untouched, and revoke=False makes that explicit.
                client.delete_dialog(peer_of(client, entry), revoke=False)
                entry["left"] = True
                changed = True
                print(f"{code}: left")
            except Exception as exc:  # noqa: BLE001 - already gone is not a failure
                print(f"{code}: leave: {type(exc).__name__}: {exc}", file=sys.stderr)
                # Do not retry a chat that no longer exists on every run.
                if "PEER_ID_INVALID" in str(exc) or "CHAT_ID_INVALID" in str(exc):
                    entry["left"] = True
                    changed = True
    if changed:
        REG.write_text(json.dumps(reg, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


def self_check() -> int:
    """The two readers, against participant lists shaped like Telegram's."""
    fails: list[str] = []

    def eq(label: str, got: object, want: object) -> None:
        if got != want:
            fails.append(f"{label}\n      got  {got}\n      want {want}")

    class P:  # a participant: the two fields both request classes carry
        def __init__(self, user_id, date=None):
            self.user_id, self.date = user_id, date

    class U:
        def __init__(self, uid, bot=False, deleted=False):
            self.id, self.bot, self.deleted = uid, bot, deleted

    ME = 1
    users = [U(1), U(2), U(3), U(4, bot=True), U(5, deleted=True)]

    # The creator carries no date and must not be compared against an int.
    got, bots = sort_joiners([P(1), P(3, 30), P(2, 20)], users, ME)
    eq("earliest human first, this account dropped", got, [2, 3])
    eq("and no bots among them", bots, [])

    got, bots = sort_joiners([P(4, 10), P(2, 20)], users, ME)
    eq("a bot is not a candidate", got, [2])
    eq("and is reported so it can be removed", bots, [4])

    eq("a deleted account is neither", sort_joiners([P(5, 10)], users, ME)[0], [])

    # A chat somebody migrated from a Telegram client has a creator that is not
    # this account, and ChannelParticipantCreator carries no join date. Sorting
    # it first would hand a chat back to whoever already runs it.
    eq("no join date sorts last, not first",
       sort_joiners([P(2, 20), P(3)], users, ME)[0], [2, 3])

    # The screenshot: joined 20:28, left 20:28. Telegram drops a member who
    # leaves from the participant list, so by the next sweep only the throwaway
    # is there and there is nobody to promote.
    eq("the only joiner left, so nobody is promotable",
       sort_joiners([P(1)], users, ME)[0], [])

    # ChannelParticipantsAdmins after that: the throwaway is the creator of the
    # migrated channel, so it is always in this list and never an answer.
    eq("the creator alone is not a human admin",
       has_human_admin([P(1)], users, ME), False)
    eq("a promoted student is", has_human_admin([P(1), P(2, 20)], users, ME), True)
    eq("a bot admin is not", has_human_admin([P(1), P(4, 20)], users, ME), False)

    if fails:
        print(f"self-check: {len(fails)} failure(s)")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("self-check: the participant readers behave")
    return 0


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        sys.exit(self_check())
    sys.exit(main())
