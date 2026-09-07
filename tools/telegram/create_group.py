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


def main() -> int:
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
        except errors.RPCError as exc:
            if "USERS_TOO_FEW" not in str(exc) or not bot:
                raise
            seed = [client.get_input_entity(bot)]
            created = client(functions.messages.CreateChatRequest(users=seed, title=title))

        chats = getattr(created, "chats", None) or created.updates.chats
        chat_id = chats[0].id

        invite = client(functions.messages.ExportChatInviteRequest(peer=chat_id))
        for user in seed:
            client(functions.messages.DeleteChatUserRequest(chat_id=chat_id, user_id=user))
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
