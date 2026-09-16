"""Who a batch chat should be handed to, read off a participant list.

Split out of grant_admin.py, and free of telethon on purpose. Reaching
`messages.getFullChat` or `channels.getParticipants` needs TG_SESSION, which is
full access to the throwaway account and belongs in two workflows' secrets and
nowhere else - so a CI job that could run the sweep would be a third place that
token lives, on every pull request including one from a fork.

This is the half that can be wrong in a way nobody notices. A chat handed to the
wrong person, or one left with no admin for a term, looks exactly like a chat
that is fine. The Telegram calls around it either raise or do not.

One reading, asked of two different lists. Given the members it names who should
be promoted; given the admins it names who already holds the chat, and an empty
answer there is a chat with nobody but this account in charge.

    python participants.py --self-check   # no network, no telethon, no session
"""

from __future__ import annotations

import sys


def members_of(participants):
    """The member list inside a ChatFull.participants, or None when there is none.

    `messages.getFullChat` answers with `ChatParticipants`, which carries a
    list, or `ChatParticipantsForbidden`, which carries no `participants`
    attribute at all. Telegram answers the second one for the TOMBSTONE a basic
    group leaves behind when it is upgraded to a supergroup - at 200 members, or
    the moment anyone reaches for a supergroup-only setting.

    Reading straight through raised AttributeError once a day for every chat in
    that state, so they were never handed over: no admin, no note, nothing
    pinned. Asked rather than assumed.
    """
    return getattr(participants, "participants", None)


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
    # Dated first, in join order, then the undated. Sorted in two passes rather
    # than on a `(date is None, date)` key so that no comparison ever reaches a
    # second element of a different type: only dates are compared with dates.
    dated = sorted((h for h in humans if h[0] is not None), key=lambda h: h[0])
    undated = [h for h in humans if h[0] is None]
    return [uid for _, uid in dated + undated], bots


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

    # ChatParticipants carries a list; ChatParticipantsForbidden does not, and
    # that is what a chat Telegram upgraded under us answers with.
    class Allowed:
        participants = [P(2, 20)]

    class Forbidden:
        pass

    eq("a readable chat hands over its members", members_of(Allowed()), Allowed.participants)
    eq("an unreadable one says so rather than raising", members_of(Forbidden()), None)

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

    # The same reading, asked of the ADMIN list. The throwaway is the creator of
    # the migrated channel, so it is in that list for every chat it ever handed
    # over and must never be the answer to "does this chat have an admin".
    eq("the creator alone leaves no admin", sort_joiners([P(1)], users, ME)[0], [])
    eq("a promoted student is one", sort_joiners([P(1), P(2, 20)], users, ME)[0], [2])
    eq("a bot admin is not", sort_joiners([P(1), P(4, 20)], users, ME)[0], [])

    if fails:
        print(f"self-check: {len(fails)} failure(s)")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("self-check: the participant readers behave")
    return 0


if __name__ == "__main__":
    sys.exit(self_check())
