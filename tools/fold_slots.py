"""Fold anonymously contributed timetable slots into /data/courses.

Runs inside .github/workflows/timetable-contribution.yml and commits
straight to main - this validation IS the merge gate. The payload
arrives via the PAYLOAD env var (never shell-interpolated) and is
re-validated from scratch: the relay is public, so nothing it sends is
trusted. Slots dedupe against each mod's existing schedules; unknown
mods and malformed entries drop silently.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
COURSES = DATA / "courses"
VENUES = DATA / "venues"
TERM_WINDOW = DATA / "term-window.json"
TERM_CALENDAR = DATA / "term-calendar.json"
MAX_SLOTS = 80
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

DAYS = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"}
TYPES = {"Lecture", "Cohort", "Tutorial", "Lab", "Studio", "Seminar", "Recitation"}
# Letters allowed: 03.007A and 03.007B are one course split in two, and
# dropping the suffix threw away every slot for both.
MOD_RE = re.compile(r"^\d{2}\.\d{3}[A-Za-z]?$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
# The shape a venue may arrive in. Shape only: what it has to RESOLVE to is
# `room_code` below, because a shape check let "Albert", "Lecture" and "Online"
# into /data as room codes, and the room finder then grew heatmaps for rooms
# that do not exist.
VENUE_RE = re.compile(r"^[\w .\-#()/]{1,40}$")
# What a real room code looks like. `data/venues` is keyed on these.
ROOM_CODE_RE = re.compile(r"^\d{1,2}\.\d{3}[A-Za-z]?$")


def venue_index() -> dict[str, set[str]]:
    """Every name a room answers to, lowercased, to the codes that answer.

    Values are SETS on purpose. Two rooms really are both called "Studio 7"
    (2.209 and 2.306) and two more are both "Robotics Innovation Laboratory",
    so a name is not a key - it is a question that sometimes has two answers,
    and the caller has to see that rather than be handed one of them.

    Three keys per room, because a pasted timetable prints whichever it feels
    like: the code, the full name, and the name with its donor bracket dropped.
    "Lecture Theatre 1 (Albert Hong)" is reachable by all three.
    """
    hits: dict[str, set[str]] = {}
    for f in sorted(VENUES.glob("*.json")):
        v = json.loads(f.read_text(encoding="utf-8"))
        code = v["code"]
        keys = {code.lower()}
        for n in filter(None, [v.get("name"), *(v.get("altNames") or [])]):
            keys.add(n.strip().lower())
            bare = re.sub(r"\s*\([^)]*\)\s*$", "", n).strip().lower()
            if bare:
                keys.add(bare)
        for k in keys:
            hits.setdefault(k, set()).add(code)
    return hits


def room_code(raw: str, index: dict[str, set[str]]) -> str | None:
    """The room a contributed venue string names, or None.

    Four steps, each refusing rather than guessing.

    A code passes only if `data/venues` actually has it: a paste is public
    input and "2.999" is as easy to send as "2.507". A trailing letter whose
    parent exists is a divisible classroom's half, so 2.507A is 2.507 - the
    same rule the enrolment import uses.

    Then the name, whole. If that name belongs to TWO rooms it stops here and
    returns None; it does not fall through. That fall-through is what made
    "Studio 7", a real name shared by 2.209 and 2.306, resolve to 61.205
    "Dance Studio 7" - a room on another campus block that merely contains the
    words.

    Last, a fragment, matched against every venue name rather than against the
    names that happened to be unambiguous. "Albert" is inside exactly one name
    and becomes 1.102; "Robotics" is inside two identically named labs and
    becomes nothing; "Lecture" is inside dozens.
    """
    text = raw.strip()
    if not text:
        return None
    low = text.lower()

    if ROOM_CODE_RE.match(text):
        hit = index.get(low)
        if hit and len(hit) == 1:
            return next(iter(hit))
        parent = text[:-1].lower()
        if text[-1].isalpha():
            hit = index.get(parent)
            if hit and len(hit) == 1:
                return next(iter(hit))
        return None

    hit = index.get(low)
    if hit is not None:
        # Known, and that includes known to be ambiguous.
        return next(iter(hit)) if len(hit) == 1 else None

    # A fragment. Over every name, so a name two rooms share counts twice and
    # refuses, rather than being invisible here because it was deduped away.
    codes: set[str] = set()
    for name, owners in index.items():
        if ROOM_CODE_RE.match(name):
            continue
        if low in name.split() or low in name:
            codes |= owners
    return next(iter(codes)) if len(codes) == 1 else None


def valid(slot: object) -> bool:
    if not isinstance(slot, dict):
        return False
    return bool(
        MOD_RE.match(str(slot.get("mod", "")))
        and slot.get("type") in TYPES
        and slot.get("day") in DAYS
        and TIME_RE.match(str(slot.get("start", "")))
        and TIME_RE.match(str(slot.get("end", "")))
        and VENUE_RE.match(str(slot.get("venue", "")))
        and str(slot.get("start")) < str(slot.get("end"))
    )


def term_span(start: str, end: str) -> tuple[str, str]:
    """The published span of the term a paste falls in, or the paste's own.

    tools/scraper/term_calendar.py generates the calendar from SUTD's page, so
    this is the real first Monday and last day rather than whatever dates one
    student's timetable happens to carry.
    """
    try:
        cal = json.loads(TERM_CALENDAR.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - no calendar is not a reason to drop slots
        return start, end
    for term in cal.get("terms") or []:
        first = str(term.get("weekOneMonday") or "")
        last = str(term.get("lastDay") or "")
        if not DATE_RE.match(first) or not DATE_RE.match(last):
            continue
        # Overlapping, not containing: a paste can start after week 1 and can
        # end before the last teaching day.
        if start <= last and end >= first:
            return first, last
    return start, end


def self_check() -> int:
    """Drive the venue reader against /data. No payload, no network.

    Where a contributed room lands is invisible when it goes wrong: the slot is
    written, the heatmap draws, and nothing says the room does not exist. These
    are the strings that actually reached /data before this had a resolver.
    """
    index = venue_index()
    cases = [
        # (what a paste sent, what it must become, why)
        ("1.102", "1.102", "a code the repo has"),
        ("2.507", "2.507", "another"),
        ("Lecture Theatre 1 (Albert Hong)", "1.102", "the printed name, whole"),
        ("lecture theatre 1", "1.102", "the name with the donor dropped"),
        ("Cohort Classroom 14", "2.507", "a name with no donor"),
        ("Albert", "1.102", "a fragment that names exactly one room"),
        ("2.507A", "2.507", "half of a divisible classroom"),
        ("2.313A", "2.313A", "a suffix that IS its own room"),
        ("Lecture", None, "in dozens of names, so it names none"),
        # The ambiguous-name trap. Both 2.209 and 2.306 really are called
        # "Studio 7", and the fallback used to skip past that and hand back
        # 61.205 "Dance Studio 7", a room in another block that merely
        # contains the words.
        ("Studio 7", None, "a name two rooms share is not an answer"),
        ("Robotics", None, "two labs have the identical name"),
        ("Incubation Room", None, "so do two incubation rooms"),
        # And the other side of it: an exact name wins over a longer one that
        # contains it. A paste saying Think Tank 11 does not mean Mini Think
        # Tank 11.
        ("Think Tank 11", "1.503", "its own name beats a longer one"),
        ("Studio 1", "1.521", "the same, against Dance Studio 1"),
        ("Online", None, "not a room at all"),
        ("9.999", None, "code-shaped, and not a room the repo has"),
        ("", None, "nothing"),
    ]
    fails = []
    for raw, want, why in cases:
        got = room_code(raw, index)
        if got != want:
            fails.append(f"{why}: {raw!r} gave {got!r}, want {want!r}")
    if fails:
        print(f"self-check: {len(fails)} failure(s)")
        for f in fails:
            print(f"  - {f}")
        return 1
    print(f"self-check: every venue reads correctly ({len(index)} keys)")
    return 0


def main() -> int:
    try:
        payload = json.loads(os.environ["PAYLOAD"])
    except (KeyError, json.JSONDecodeError) as exc:
        print(f"bad payload: {exc}", file=sys.stderr)
        return 1

    # Server-side recency gate: the term span rides with every payload
    # (identical for every student's paste of the same term). Stale or
    # window-less contributions are dropped whole.
    import datetime
    start = str(payload.get("termStart") or "")
    end = str(payload.get("termEnd") or "")
    today = datetime.date.today().isoformat()
    if not DATE_RE.match(start) or not DATE_RE.match(end) or start >= end or end < today:
        print("stale or window-less contribution - dropped")
        return 0

    # The window is the TERM's, not the paste's. A student who pastes in week 3,
    # or whose one mod starts late, would otherwise set the term's start to
    # whenever their own classes happen to begin - and the batch chats expire
    # against this. The published calendar knows the real span; the paste is
    # only used to say which term it is.
    start, end = term_span(start, end)

    window = json.loads(TERM_WINDOW.read_text(encoding="utf-8") or "{}") if TERM_WINDOW.exists() else {}
    if end > str(window.get("end") or ""):
        TERM_WINDOW.write_text(json.dumps({"start": start, "end": end}, indent=2) + "\n", encoding="utf-8")

    slots = [s for s in (payload.get("slots") or [])[:MAX_SLOTS] if valid(s)]
    added: list[str] = []
    skipped = 0

    index = venue_index()
    unplaced: list[str] = []

    for slot in slots:
        path = COURSES / f"{slot['mod'].replace('.', '_')}.json"
        if not path.exists():
            skipped += 1
            continue
        # A room this repo knows, or the slot does not go in. Everything
        # downstream treats `location` as a venue key: the room finder, the
        # heatmaps, the .ics. A string that is not one is a room that does not
        # exist, and it is invisible until someone searches for it.
        room = room_code(str(slot["venue"]), index)
        if room is None:
            unplaced.append(f"{slot['mod']} {slot['day']} {slot['start']} @ {slot['venue']!r}")
            skipped += 1
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        schedules = data.setdefault("schedules", [])
        entry = {
            "type": slot["type"],
            "day": slot["day"],
            "startTime": slot["start"],
            "endTime": slot["end"],
            "location": room,
            "instructors": [],
        }
        if any(
            s.get("day") == entry["day"]
            and s.get("startTime") == entry["startTime"]
            and s.get("endTime") == entry["endTime"]
            and s.get("location") == entry["location"]
            for s in schedules
        ):
            skipped += 1
            continue
        schedules.append(entry)
        schedules.sort(key=lambda s: (s.get("day", ""), s.get("startTime", "")))
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        added.append(f"{slot['mod']} {slot['day']} {slot['start']}-{slot['end']} @ {room}")

    if unplaced:
        # Reported, not silent: a room this repo has never heard of is usually
        # a venue worth adding rather than a bad paste.
        print(f"{len(unplaced)} slot(s) named a room that is not in data/venues "
              f"and were left out:", file=sys.stderr)
        for u in unplaced:
            print(f"  {u}", file=sys.stderr)

    # The term string is attacker-reachable too - whitelist it.
    term = str(payload.get("term", "unspecified"))
    if not re.fullmatch(r"[\w ,/]{1,40}", term):
        term = "unspecified"
    print(f"term: {term}")
    print(f"added {len(added)} slot(s), skipped {skipped} (dupes/unknown mods)")
    for line in added:
        print(f"- {line}")
    return 0


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        sys.exit(self_check())
    raise SystemExit(main())
