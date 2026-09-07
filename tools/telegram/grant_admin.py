"""Sweep: hand each batch chat over to its first human joiner.

Removing spam needs an admin, and in a basic group only the CREATOR can
appoint one (the Bot API cannot at all). So the throwaway stays in each
group it creates until this sweep finds a human inside: it promotes the
earliest joiner, pins the handover note, and leaves. Groups nobody joined
yet stay parked for the next run.

Reads/updates data/telegram-groups.json (adminGranted flag); prints the
codes it handed over, one per line.
"""

from __future__ import annotations

import datetime
import json
import os
import pathlib
import sys

from telethon.sync import TelegramClient
from telethon.sessions import StringSession
from telethon.tl import functions

REG = pathlib.Path(__file__).resolve().parents[2] / "data" / "telegram-groups.json"

HANDOVER = (
    "First person to join is now admin, please do not upgrade into a "
    "supergroup as it breaks the invitation link. Invite your friends and "
    "enjoy!\nCreated by modSUTD"
)


def active(entry: dict) -> bool:
    return bool(entry.get("expires")) and datetime.date.today().isoformat() <= entry["expires"]


def main() -> int:
    reg = json.loads(REG.read_text() or "{}")
    todo = {c: e for c, e in reg.items() if not e.get("adminGranted") and active(e)}
    if not todo:
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
                full = client(functions.messages.GetFullChatRequest(chat_id))
                parts = full.full_chat.participants.participants
                humans = []
                bot_ids = []
                for part in parts:
                    if part.user_id == me.id:
                        continue
                    user = next((u for u in full.users if u.id == part.user_id), None)
                    if user is not None and user.bot:
                        bot_ids.append(part.user_id)
                        continue
                    humans.append((getattr(part, "date", None), part.user_id))
                if not humans:
                    continue  # nobody joined yet - stay parked, retry next run

                humans.sort(key=lambda h: (h[0] is None, h[0]))
                # The legacy admin flag, NOT granular rights - granular
                # rights are a supergroup feature and would migrate the chat.
                client(functions.messages.EditChatAdminRequest(
                    chat_id=chat_id, user_id=humans[0][1], is_admin=True))
                note = client.send_message(chat_id, HANDOVER)
                client(functions.messages.UpdatePinnedMessageRequest(peer=chat_id, id=note.id))
                for bid in bot_ids:  # defensive: the seed bot leaves at creation
                    client(functions.messages.DeleteChatUserRequest(chat_id=chat_id, user_id=bid))
                client(functions.messages.DeleteChatUserRequest(chat_id=chat_id, user_id=me.id))
                entry["adminGranted"] = True
                changed = True
                print(code)
            except Exception as exc:  # noqa: BLE001 - one bad group must not stall the sweep
                print(f"{code}: {type(exc).__name__}: {exc}", file=sys.stderr)
    if changed:
        REG.write_text(json.dumps(reg, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
