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

# One reader for every room string that reaches /data, shared with the
# enrolment import. Two copies disagreed about what a room is.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from venue_resolve import VENUE_RE, room_code, venue_index  # noqa: E402
COURSES = DATA / "courses"

TERM_WINDOW = DATA / "term-window.json"
TERM_CALENDAR = DATA / "term-calendar.json"
MAX_SLOTS = 80
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

DAY_ORDER = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
             "Saturday", "Sunday")
DAYS = set(DAY_ORDER)


def sort_key(entry: dict) -> tuple:
    """Week order, then time. Sorting on the day NAME put Friday before Monday
    and Thursday before Tuesday, so adding one slot reshuffled the whole list
    and a one-line contribution came out as a diff that rewrote every entry."""
    day = str(entry.get("day", ""))
    return (DAY_ORDER.index(day) if day in DAYS else len(DAY_ORDER),
            str(entry.get("startTime", "")),
            str(entry.get("endTime", "")),
            str(entry.get("location", "")))
TYPES = {"Lecture", "Cohort", "Tutorial", "Lab", "Studio", "Seminar", "Recitation"}
# Letters allowed: 03.007A and 03.007B are one course split in two, and
# dropping the suffix threw away every slot for both.
MOD_RE = re.compile(r"^\d{2}\.\d{3}[A-Za-z]?$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
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
        schedules.sort(key=sort_key)
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
    # The venue reading this file used to own moved to venue_resolve.py, and
    # so did its check. Said here because the flag used to work and falling
    # through to the real mode gives "bad payload: PAYLOAD", which explains
    # nothing.
    if "--self-check" in sys.argv:
        sys.exit("the venue reader lives in tools/venue_resolve.py now: "
                 "run `python tools/venue_resolve.py --self-check`")
    raise SystemExit(main())
