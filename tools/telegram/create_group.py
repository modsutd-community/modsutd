"""Create ONE basic Telegram group for a mod's batch chat.

Called by .github/workflows/telegram-group.yml, which gates on the
registry before us - titles are never trusted, members can rename groups
freely without breaking links.

Never a supergroup: migration is a client-side, creator-only call
(messages.migrateChat) and nothing here asks for a supergroup-only
feature, so the chat cannot drift into one.

Env: TG_API_ID, TG_API_HASH, TG_SESSION, TG_LINK_KEY, MOD_CODE, MOD_NAME,
TG_BOT_USERNAME (optional seed fallback).
Prints one JSON line: {code, title, linkEnc, created, chatId}. The link is
encrypted because the registry it lands in is committed to a public repo -
see linkcrypt.py.

THE ONE FAILURE THAT LOSES SOMETHING
Everything before CreateChatRequest can fail freely: nothing exists yet, the
workflow reports it, and the button goes back to offering once the ten-minute
ask expires. Everything AFTER it is different, because the group is real from
that moment and the throwaway is sitting in it. A failure there used to end the
run with nothing written anywhere, so the group had no link, no registry entry,
and nothing that would ever find it again: the prune sweep reads the registry,
so it would never leave either.

So a failure past that point writes ORPHAN_FILE with the chat id, which is all
a person needs to export a fresh invite link for that chat and add the entry by
hand. The workflow puts it in the job summary.
"""

from __future__ import annotations

import datetime
import json
import os
import sys

from telethon import errors
from telethon.sync import TelegramClient
from telethon.sessions import StringSession
from telethon.tl import functions

from linkcrypt import encrypt


# Read by the workflow's failure path. /tmp rather than the checkout, so a
# `git reset --hard` in a later step cannot take it away.
ORPHAN_FILE = "/tmp/orphan.json"


def main() -> int:
    # Cleared before anything can write it, so the file can only ever describe
    # THIS run. A hosted runner is a fresh VM and /tmp starts empty, but that is
    # a property of where this happens to run rather than of the script, and a
    # stale record would send someone to recover a chat that was already fine.
    try:
        os.remove(ORPHAN_FILE)
    except FileNotFoundError:
        pass

    code = os.environ["MOD_CODE"]
    name = os.environ["MOD_NAME"]
    bot = (os.environ.get("TG_BOT_USERNAME") or "").lstrip("@")
    # Batch identity in the title is the creation month; the registry
    # carries the real window (the term's end date).
    encrypt("preflight")  # refuse before creating anything if the key is unusable
    stamp = datetime.date.today().strftime("%b'%y")
    title = f"{code} {name}"[:110] + f" {stamp}"

    client = TelegramClient(
        StringSession(os.environ["TG_SESSION"]),
        int(os.environ["TG_API_ID"]),
        os.environ["TG_API_HASH"],
    )
    with client:
        # Telegram dropped the "a new group needs a second member" rule in
        # 2023 (TDLib 3979fc1, tdesktop f3e15c7f), so the throwaway creates
        # alone. Should a server still answer USERS_TOO_FEW, fall back to
        # seeding with the bot and kicking it straight back out.
        seed = []
        try:
            created = client(functions.messages.CreateChatRequest(users=[], title=title))
        except errors.FloodWaitError as exc:
            # Telegram's own ceiling, which can bite before the registry's own
            # cap of 40 does: the limit is per ACCOUNT and counts everything
            # this session has created, not only what this repo knows about.
            # Nothing exists yet, so this is a clean refusal - the button goes
            # back to offering once the ask expires and the next click works.
            print(f"{code}: Telegram is rate limiting group creation for "
                  f"{exc.seconds}s. Nothing was created. Try again after that.",
                  file=sys.stderr)
            raise
        except errors.RPCError as exc:
            if "USERS_TOO_FEW" not in str(exc) or not bot:
                raise
            seed = [client.get_input_entity(bot)]
            created = client(functions.messages.CreateChatRequest(users=seed, title=title))

        chats = getattr(created, "chats", None) or created.updates.chats
        chat_id = chats[0].id

        # The group exists from here. Anything that goes wrong below leaves it
        # real and unreachable unless this says where it is.
        # Only the export. It is the one call whose failure loses something
        # that cannot be reconstructed from the chat id alone.
        try:
            invite = client(functions.messages.ExportChatInviteRequest(peer=chat_id))
        except Exception:
            with open(ORPHAN_FILE, "w", encoding="utf-8") as f:
                json.dump({"code": code, "title": title, "chatId": chat_id,
                           "note": "group created, link not exported"}, f)
            print(f"{code}: the group exists (chat {chat_id}) but its link was "
                  f"not exported. {ORPHAN_FILE} has what is needed to finish it "
                  f"by hand.", file=sys.stderr)
            raise

        # Best effort, deliberately. The seed bot only joins on the rare
        # USERS_TOO_FEW fallback, and one lingering in a group is untidy
        # rather than harmful - where failing the run here would throw away a
        # link that exported perfectly well and orphan the group over it.
        for user in seed:
            try:
                client(functions.messages.DeleteChatUserRequest(chat_id=chat_id, user_id=user))
            except Exception as exc:  # noqa: BLE001
                print(f"{code}: the seed bot could not be removed from chat "
                      f"{chat_id}: {type(exc).__name__}. The chat and its link "
                      f"are fine; remove it by hand.", file=sys.stderr)
        # The creator STAYS (muted): in a basic group only it can appoint an
        # admin, so it waits for the sweep to hand over to the first joiner.

    print(json.dumps({
        "code": code,
        "title": title,
        "linkEnc": encrypt(invite.link),
        "created": datetime.date.today().strftime("%Y-%m"),
        "chatId": chat_id,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
