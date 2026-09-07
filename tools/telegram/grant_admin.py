"""Sweep: hand each batch chat over to its first human joiner.

Removing spam needs an admin, and in a basic group only the CREATOR can
appoint one (the Bot API cannot at all). So the throwaway stays in each
group it creates until this sweep finds a human inside: it promotes the
earliest joiner and pins the handover note. Groups nobody joined yet stay
parked for the next run.

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
    # Terms that are over and this account has not yet walked out of. The link
    # is dead weight from here - telegram-prune deletes the ciphertext on the
    # first Saturday anyway - and the chat is the students'.
    done = {c: e for c, e in reg.items() if not active(e) and not e.get("left")}
    if not todo and not done:
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
                # Deliberately NOT leaving here: see the module docstring. The
                # invite link in the registry belongs to this account and dies
                # with its membership.
                entry["adminGranted"] = True
                changed = True
                print(code)
            except Exception as exc:  # noqa: BLE001 - one bad group must not stall the sweep
                print(f"{code}: {type(exc).__name__}: {exc}", file=sys.stderr)

        for code, entry in done.items():
            try:
                # Leave AND drop the dialog, so this account does not end up
                # holding a list of every group it ever made. delete_dialog
                # removes it on this side only - the group and its members are
                # untouched, and revoke=False makes that explicit.
                client.delete_dialog(entry["chatId"], revoke=False)
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
        REG.write_text(json.dumps(reg, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
