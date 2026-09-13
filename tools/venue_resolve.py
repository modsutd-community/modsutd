"""The one place a room string becomes a room code.

    python tools/venue_resolve.py --self-check

WHY THIS IS SHARED AND NOT COPIED
Two things turn a printed room into a `location`: `tools/fold_slots.py`, for a
timetable a student pasted, and `tools/enrolment/parse_enrolment_pdfs.py`, for
the registry's own export. They had a resolver each, and the two disagreed:
one would take a fragment like "Albert" and the other would not; one would write
a code `data/venues` has never heard of and the other would not. A room is a
room whichever door it came through, so there is one reader.

WHAT `location` HAS TO BE
A key into `data/venues`. The room finder, the occupancy heatmaps and the `.ics`
all look the room up by it, so a string that is not one is a room that does not
exist - and nothing says so, because every one of those simply finds nothing.
That is how "Albert", "Lecture" and "Online" sat in /data as room codes with
heatmaps drawn for them.

THE ORDER IS THE DESIGN, AND EACH STEP REFUSES RATHER THAN GUESSES
  1. a code, and only one `data/venues` actually has. A paste is public input
     and "2.999" is as easy to send as "2.507".
  2. a code with a trailing letter whose parent exists: the registry splits a
     divisible classroom and prints 2.507A and 2.507B, and the catalogue holds
     2.507.
  3. the printed name, whole, then with its donor bracket dropped, so
     "Lecture Theatre 1 (Albert Hong)" and "lecture theatre 1" both land.
  4. a fragment, but only a WHOLE WORD of exactly ONE room's name, and at
     least MIN_FRAGMENT long. "Albert" is a word of one name and becomes
     1.102; "Lecture" is a word of dozens and becomes nothing.

     Whole words rather than any substring, and a floor on the length, because
     a room's name carries its donor and a donor is a person: "Wee" and "Hur"
     are both inside "Think Tank 2 (Wee Hur)" and a lecturer with either
     surname could otherwise have been filed as a room. The parser can hand an
     instructor's name to this field when a row prints no room code, so that is
     not hypothetical. Four characters keeps Albert, Hokkien and Yangzheng,
     which are the donor words a timetable actually prints.

A NAME TWO ROOMS SHARE IS NOT AN ANSWER, AND THAT IS THE SUBTLE ONE
2.209 and 2.306 are both really called "Studio 7", and 1.703 and 1.704 are both
"Robotics Innovation Laboratory". An index that maps a name to ONE code has to
drop those, and a resolver that then falls through to step 4 finds
"Dance Studio 7" - a room in another block that merely contains the words. So
the index maps a name to the SET of codes that answer to it, an ambiguous name
stops at step 3 rather than falling through, and step 4 counts every name rather
than the ones that happened to be unique.

Measured over every sub-phrase of every venue name: 1341 fragments, 718 resolve,
and the 13 that land on a room other than the one they came from are all cases
where the fragment is that room's own exact name, which is the right answer -
"Think Tank 11" does not mean "Mini Think Tank 11". Zero guesses.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

VENUES = pathlib.Path(__file__).resolve().parent.parent / "data" / "venues"

# What a room code looks like. `data/venues` is keyed on these.
ROOM_CODE_RE = re.compile(r"^\d{1,2}\.\d{3}[A-Za-z]?$")
# The shape a venue string may arrive in at all. Shape only: what it has to
# RESOLVE to is the whole point of this module.
# 60 to match api/contribute.js. A printed room name carries its donor:
# "Digital Manufacturing and Design (DManD) Research Studio" is 56 characters,
# and the two gates disagreeing on the same field means one accepts what the
# other has already thrown away.
VENUE_RE = re.compile(r"^[\w .\-#()/]{1,60}$")

# The shortest fragment allowed to name a room on its own. See step 4.
MIN_FRAGMENT = 4


def venue_index(venues_dir: pathlib.Path | None = None) -> dict[str, set[str]]:
    """Every name a room answers to, lowercased, to the codes that answer.

    Values are SETS on purpose. A name is not a key, it is a question that
    sometimes has two answers, and the caller has to see that rather than be
    handed one of them.
    """
    root = venues_dir or VENUES
    hits: dict[str, set[str]] = {}
    for f in sorted(root.glob("*.json")):
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
    """The room a venue string names, or None. See the module docstring."""
    text = str(raw).strip()
    if not text:
        return None
    low = text.lower()

    if ROOM_CODE_RE.match(text):
        hit = index.get(low)
        if hit and len(hit) == 1:
            return next(iter(hit))
        if text[-1].isalpha():
            hit = index.get(text[:-1].lower())
            if hit and len(hit) == 1:
                return next(iter(hit))
        return None

    hit = index.get(low)
    if hit is not None:
        # Known, and that includes known to be ambiguous. No fall-through.
        return next(iter(hit)) if len(hit) == 1 else None

    if len(low) < MIN_FRAGMENT:
        return None
    codes: set[str] = set()
    for name, owners in index.items():
        if ROOM_CODE_RE.match(name):
            continue
        if low in [re.sub(r"[^a-z0-9]", "", t) for t in name.split()]:
            codes |= owners
    return next(iter(codes)) if len(codes) == 1 else None


def self_check() -> int:
    """Drive the reader against the real /data/venues. No network, no payload.

    Getting this wrong is invisible: the slot is written, the heatmap draws,
    and the only sign is a room page that lists nothing.
    """
    index = venue_index()
    cases = [
        # (what arrived, what it must become, why it is in the table)
        ("1.102", "1.102", "a code the repo has"),
        ("2.507", "2.507", "another"),
        ("9.999", None, "code-shaped, and not a room the repo has"),
        ("2.507A", "2.507", "half of a divisible classroom"),
        ("2.313A", "2.313A", "a suffix that IS its own room"),
        ("Lecture Theatre 1 (Albert Hong)", "1.102", "the printed name, whole"),
        ("lecture theatre 1", "1.102", "the name with the donor dropped"),
        ("Cohort Classroom 14", "2.507", "a name with no donor"),
        ("Think Tank 2", "1.309", "a donor name, reached without it"),
        ("Albert", "1.102", "a fragment that names exactly one room"),
        # A room's name carries its donor, and a donor is a person. A lecturer
        # surnamed Wee must not be filed as Think Tank 2 (Wee Hur).
        ("Wee", None, "too short to name a room, and it is a person"),
        ("Hur", None, "the other half of the same donor"),
        # The ambiguity trap. Both 2.209 and 2.306 really are "Studio 7", and
        # falling through to the fragment pass found 61.205 "Dance Studio 7".
        ("Studio 7", None, "a name two rooms share is not an answer"),
        ("Robotics Innovation Laboratory", None, "two labs, identical names"),
        ("Incubation Room", None, "so do two incubation rooms"),
        # And its other side: an exact name beats a longer one containing it.
        ("Think Tank 11", "1.503", "its own name, against Mini Think Tank 11"),
        ("Studio 1", "1.521", "the same, against Dance Studio 1"),
        ("Lecture", None, "inside dozens of names, so it names none"),
        ("Online", None, "not a room at all"),
        ("", None, "nothing"),
    ]
    fails = []
    for raw, want, why in cases:
        got = room_code(raw, index)
        if got != want:
            fails.append(f"{why}: {raw!r} gave {got!r}, want {want!r}")

    # No fragment may resolve to a room other than one whose own exact name it
    # is. Generated rather than listed, because the failure it catches is the
    # one nobody thinks to write a case for.
    names = {}
    for f in VENUES.glob("*.json"):
        v = json.loads(f.read_text(encoding="utf-8"))
        names[v["code"]] = v.get("name") or ""
    guesses = []
    for code, name in names.items():
        words = re.sub(r"\s*\([^)]*\)\s*$", "", name).split()
        for i in range(len(words)):
            for j in range(i + 1, len(words) + 1):
                frag = " ".join(words[i:j])
                if len(frag) < 3:
                    continue
                got = room_code(frag, index)
                if got is None or got == code:
                    continue
                target = names.get(got, "")
                bare = re.sub(r"\s*\([^)]*\)\s*$", "", target).strip().lower()
                if frag.lower() not in (target.strip().lower(), bare):
                    guesses.append(f"{frag!r} (from {code}) guessed {got} {target!r}")
    if guesses:
        fails.append(f"{len(guesses)} fragment(s) resolved to a room that is not "
                     f"theirs: {'; '.join(guesses[:5])}")

    if fails:
        print(f"self-check: {len(fails)} failure(s)")
        for f in fails:
            print(f"  - {f}")
        return 1
    print(f"self-check: every venue reads correctly ({len(index)} keys, no guesses)")
    return 0


if __name__ == "__main__":
    raise SystemExit(self_check() if "--self-check" in sys.argv else self_check())
