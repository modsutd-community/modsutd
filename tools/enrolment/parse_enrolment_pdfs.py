#!/usr/bin/env python3
"""Read a term's six subject-enrolment PDFs into data/courses schedules.

    python tools/enrolment/parse_enrolment_pdfs.py <folder>
    python tools/enrolment/parse_enrolment_pdfs.py <folder> --dry-run
    python tools/enrolment/parse_enrolment_pdfs.py <folder> --report out.md

WHY THIS EXISTS
Schedules otherwise arrive one browser at a time, from students who paste their
own timetable, so a mod nobody has pasted has no rooms, no heatmap and no batch
chat. The enrolment PDFs are the registry's own export of the same timetable
for every mod at once, which is the difference between a term that fills in over
weeks and a term that is complete on day one.

WHY NOT OCR
These PDFs carry a full text layer and vector blocks, so nothing here rasterises
anything. Every class is a filled rounded rectangle drawn as a `curve`, and its
text sits inside its own bounds - so the block IS the record, and cropping to it
gives the text already grouped, in reading order, with no guessing about which
column or which hour a line belongs to.

Two traps in reading them, both hit here before this settled:
  * `page.extract_words()` over the WHOLE page interleaves two blocks that sit
    side by side in the same hour, producing "3 0 .1 1 9 , C P 0 1". Cropping to
    one block first is what fixes it, not a tolerance.
  * a block's own start and end time are PRINTED inside it, so no pixels-to-
    hours calibration is needed, and a half-hour start cannot be rounded wrong.

WHAT A BLOCK SAYS
    11x w38-43, 45, 47-50                 <- repeats and teaching weeks
    50.006, CI01, CBL, Think Tank 10, Think Tank 9, 1.416, 1.415, CHOO Tsu Wei Kenny
      code   sect  kind  <---- venues, named then coded ---->  <- instructors

The names and the codes are the same rooms twice, so the codes win - except
that the registry splits a divisible classroom into halves the catalogue does
not hold, so `2.507A, 2.507B` becomes the one room 2.507 that the venue page
and the heatmap can actually show. A block
with no code at all (the HASS lectures: "Lecture Theatre 4,") is resolved
through data/venues, which is why "Lecture Theatre 4 (Hokkien Foundation)" has
to match on its name with the donor stripped.

THE LEGEND IS THE TALLY
Every file prints its own colour key along the bottom, one swatch per mod, and
that is the list this checks itself against: a mod in the legend with no block
parsed is a parse failure, not an empty week. `HASS` appears in five of the six
as a placeholder colour and is not a course.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from collections import defaultdict


def load_pdfplumber():
    """Imported on use, not at the top. `--self-check` drives the readers
    against text these files produce and opens nothing, so CI runs it without
    installing a PDF library for it."""
    try:
        import pdfplumber
    except ImportError:
        sys.exit("pdfplumber is needed to read a PDF: "
                 "pip install -r tools/enrolment/requirements.txt")
    return pdfplumber


ROOT = pathlib.Path(__file__).resolve().parents[2]
COURSES = ROOT / "data" / "courses"
VENUES = ROOT / "data" / "venues"

DAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

# The six files, keyed by the token that has to appear in the filename. CSD and
# ISTD are the same pillar under two names, and HASS ships as "HASS & TE".
PILLARS: dict[str, tuple[str, ...]] = {
    "ASD": ("ASD",),
    "DAI": ("DAI",),
    "EPD": ("EPD",),
    "ESD": ("ESD",),
    "ISTD": ("ISTD", "CSD"),
    "HASS": ("HASS & TE", "HASS"),
}

# The registry's own code, which carries a track suffix the catalogue does not:
# 02.143HT is 02.143 taught on the Humanities track. Two letters, where a real
# course suffix is one (03.007A), so they cannot be confused.
CODE = re.compile(r"\d{2}\.\d{3}[A-Za-z]{0,2}")
TRACK_SUFFIX = re.compile(r"^(\d{2}\.\d{3})[A-Za-z]{2}$")
ROOM = re.compile(r"^\d\.\d{3}[A-Za-z]?$")
TIME = re.compile(r"\d{2}:\d{2}")
# "11x w38-43, 45, 47-50" - the repeat count and the teaching weeks. It wraps,
# so it is stripped by finding where the record starts rather than by line.
WEEKS_HEAD = re.compile(r"^\s*\d+x\s+w")

# The kind letters the registry prints. C and L also open the section id
# (CI01 / LI01), so the two agree and a mismatch is worth reporting.
KIND = {"CBL": "Cohort", "LEC": "Lecture", "LAB": "Lab", "TUT": "Tutorial",
        "SEM": "Seminar", "STU": "Studio", "REC": "Recitation"}

# Not a course. Five of the six files block out the HASS hour in the cohort's
# week with a placeholder colour, so every one of them carries this.
PLACEHOLDER = "HASS"


def die(msg: str) -> None:
    sys.exit(f"error: {msg}")


# ---------------------------------------------------------------- venues ----

def venue_codes() -> set[str]:
    """Every room the catalogue holds, which is what a `location` may name."""
    return {json.loads(f.read_text(encoding="utf-8"))["code"]
            for f in VENUES.glob("*.json")}


def whole_room(code: str, known: set[str]) -> str:
    """The room a printed code belongs to.

    The registry splits a divisible classroom when a cohort takes both halves:
    Cohort Classroom 14 is printed as `2.507A, 2.507B`, and the catalogue holds
    one room, 2.507. A `location` naming a code no venue has is a slot the room
    page and the heatmap can never show, so the halves resolve to the room they
    are halves of. A suffix that IS its own room stays: the design studios are
    2.313A and 2.313B, two records, two doors.
    """
    if code in known:
        return code
    parent = code[:-1]
    return parent if code[-1:].isalpha() and parent in known else code


def venue_index() -> dict[str, str]:
    """Every name a room answers to, lowercased, to its code.

    The donor in brackets is dropped as a SECOND key, never as a replacement:
    "Think Tank 2 (Wee Hur)" is what the record says and the registry prints
    "Think Tank 2", and both have to resolve. A name two rooms share resolves
    to neither, because guessing between them puts a class in the wrong room.
    """
    hits: dict[str, set[str]] = defaultdict(set)
    for f in sorted(VENUES.glob("*.json")):
        v = json.loads(f.read_text(encoding="utf-8"))
        names = [v.get("name"), *(v.get("altNames") or [])]
        for n in filter(None, names):
            hits[n.strip().lower()].add(v["code"])
            bare = re.sub(r"\s*\([^)]*\)\s*$", "", n).strip().lower()
            if bare:
                hits[bare].add(v["code"])
    return {k: next(iter(v)) for k, v in hits.items() if len(v) == 1}


# ------------------------------------------------------------------ parse ----

def block_text(page, box) -> str:
    """The text of one class block, in reading order.

    Cropped first: over the whole page pdfplumber groups words across block
    boundaries, and two classes side by side in the same hour come back
    character-interleaved.
    """
    return page.crop(box).extract_text(x_tolerance=1) or ""


def weeks_of(head: str) -> list[int]:
    """[38, 39, ... 43, 45, 47, 48, 49, 50] from "w38-43, 45, 47-50"."""
    out: list[int] = []
    for part in re.findall(r"\d+\s*-\s*\d+|\d+", head.split("w", 1)[-1] if "w" in head else ""):
        if "-" in part:
            a, b = (int(x) for x in part.split("-"))
            out.extend(range(a, b + 1))
        else:
            out.append(int(part))
    # The leading "11x" is a count, not a week, and is already left of the "w".
    return sorted({w for w in out if 1 <= w <= 53})


def split_record(lines: list[str]) -> tuple[str, str]:
    """(weeks head, record) - the record starts at the first mod code.

    Not "drop line 2": the weeks line wraps on the narrow HASS columns, so
    "43, 45, 47- 50" lands on the record's own line and would read as a room.
    """
    joined = ""
    for line in lines:
        if joined and not joined.endswith("-"):
            joined += " "
        joined += line
    m = CODE.search(joined)
    if not m:
        return joined, ""
    return joined[: m.start()].strip(), joined[m.start():].strip()


def resolve_named(fields: list[str], venues: dict[str, str]) -> tuple[list[str], list[str]]:
    """Room codes for venue names, and the names that stayed unplaced.

    A field at a time, except that one venue name carries a comma of its own
    ("Humanities, Arts and Social Sciences (HASS) office"), so a field that
    does not resolve is retried joined to the one after it. Instructor names
    are in this same tail and resolve to nothing, which is how they are told
    apart from rooms: there is no separator in the record that marks where the
    venues stop.
    """
    rooms: list[str] = []
    unresolved: list[str] = []
    i = 0
    while i < len(fields):
        f = fields[i]
        hit = venues.get(f.lower())
        if hit is None and i + 1 < len(fields):
            pair = f"{f}, {fields[i + 1]}"
            hit = venues.get(pair.lower())
            if hit is not None:
                rooms.append(hit)
                i += 2
                continue
        if hit is not None:
            rooms.append(hit)
        else:
            unresolved.append(f)
        i += 1
    return rooms, unresolved


def r_day(block, day_x) -> str:
    """The day a block is nearest, for a message. Not the day it is given."""
    centre = (block["x0"] + block["x1"]) / 2
    return min(day_x, key=lambda d: abs(d[1] - centre))[0][:3]


def parse_page(page, venues: dict[str, str], known: set[str],
               ) -> tuple[list[dict], list[str]]:
    """Every class block on the page, plus whatever could not be read."""
    words = page.extract_words()
    day_x = sorted(
        ((w["text"], (w["x0"] + w["x1"]) / 2) for w in words if w["text"] in DAYS),
        key=lambda r: r[1],
    )
    if not day_x:
        return [], ["no day headers on the page"]

    # Where each day's column starts and ends, measured from the spacing of the
    # headers rather than assumed: the pillar files are A4 with 150pt columns
    # and the HASS file is A3 with 220pt ones. A block belongs to the day whose
    # column CONTAINS it, which is not the same as the day whose header is
    # nearest - a block centred on a boundary is nearest to one of them and
    # inside neither, and putting it on that day would read as a real class
    # nobody can find. Distance from the centre cannot express this: classes
    # run up to six abreast in one day, so a legitimate block sits as far as
    # (column - its own width) / 2 off centre.
    gaps = [b[1] - a[1] for a, b in zip(day_x, day_x[1:])]
    half = (min(gaps) / 2) if gaps else page.width
    SLACK = 2.0  # the columns are drawn to the point, not to the pixel

    # The legend sits below the grid; its swatches mark where the week ends.
    swatches = [r for r in page.rects
                if 5 < (r["x1"] - r["x0"]) < 12 and 5 < (r["bottom"] - r["top"]) < 12]
    floor = min((s["top"] for s in swatches), default=page.height) - 5

    blocks = [c for c in page.curves
              if c.get("non_stroking_color") not in (None, (1, 1, 1))
              and (c["x1"] - c["x0"]) > 20 and (c["bottom"] - c["top"]) > 10
              and c["top"] > 60 and c["bottom"] < floor]

    out: list[dict] = []
    problems: list[str] = []
    for b in sorted(blocks, key=lambda b: (b["x0"], b["top"])):
        raw = block_text(page, (b["x0"], b["top"], b["x1"], b["bottom"]))
        lines = [l.strip() for l in raw.split("\n") if l.strip()]
        if not lines:
            continue
        times = [t for line in lines for t in TIME.findall(line)]
        body = [l for l in lines if not re.fullmatch(r"(\d{2}:\d{2}\s*)+", l)]
        head, record = split_record(body)
        if not record:
            continue  # a colour band with no course in it
        if len(times) < 2:
            problems.append(f"no start/end time on {record[:40]!r}")
            continue

        fields = [f.strip() for f in record.split(",") if f.strip()]
        code = fields[0]
        if code == PLACEHOLDER:
            continue
        if not CODE.fullmatch(code):
            problems.append(f"unreadable code {code!r}")
            continue

        section = fields[1] if len(fields) > 1 else ""
        kind = fields[2] if len(fields) > 2 else ""
        rest = fields[3:]

        rooms = [f for f in rest if ROOM.fullmatch(f)]
        if not rooms:
            # No code printed at all, so the name is all there is. The HASS
            # lectures are the whole of this case.
            rooms, unresolved = resolve_named(rest, venues)
            if not rooms:
                problems.append(f"{code}: no room in {rest!r}")
            elif unresolved:
                # Some resolved and some did not, so the record would go in
                # with fewer rooms than the registry printed and nothing would
                # say so. The class is still written, because a class on a
                # known room is better than no class, but the run reports it.
                problems.append(f"{code} {r_day(b, day_x)} {times[0]}: kept "
                                f"{', '.join(rooms)} but could not place "
                                f"{', '.join(unresolved)}")

        # Both halves of a divisible classroom name one room, so this also
        # collapses "2.507A, 2.507B" to a single 2.507: one room, busy once.
        seen_rooms: list[str] = []
        for r in rooms:
            whole = whole_room(r, known)
            if whole not in seen_rooms:
                seen_rooms.append(whole)
        rooms = seen_rooms

        # A location naming a room the catalogue does not hold is a slot the
        # room page and the heatmap can never show. It still goes in, because
        # the class is real and the code is what the registry printed, but the
        # run says so.
        strangers = [r for r in rooms if r not in known]
        if strangers:
            problems.append(f"{code} {r_day(b, day_x)} {times[0]}: "
                            f"{', '.join(strangers)} has no venue record, so "
                            f"nothing will show this class on that room's page")

        centre = (b["x0"] + b["x1"]) / 2
        name, at = min(day_x, key=lambda d: abs(d[1] - centre))
        if b["x0"] < at - half - SLACK or b["x1"] > at + half + SLACK:
            problems.append(f"{code}: spans {b['x0']:.0f}-{b['x1']:.0f}, which "
                            f"does not fit {name}'s column "
                            f"({at - half:.0f}-{at + half:.0f}). Dropped rather "
                            f"than guessed at.")
            continue
        day = name
        out.append({
            "code": code,
            "section": section,
            "type": KIND.get(kind.upper(), "Cohort"),
            "kind_raw": kind,
            "day": day,
            "start": times[0],
            "end": times[-1],
            "rooms": rooms,
            "weeks": weeks_of(head),
        })
    return out, problems


def legend_of(page) -> list[str]:
    """The colour key along the bottom: one mod per swatch, HASS included."""
    swatches = [r for r in page.rects
                if 5 < (r["x1"] - r["x0"]) < 12 and 5 < (r["bottom"] - r["top"]) < 12]
    if not swatches:
        return []
    top = min(s["top"] for s in swatches)
    bottom = max(s["bottom"] for s in swatches)
    right = max(s["x1"] for s in swatches)
    seen: list[str] = []
    for w in sorted(page.extract_words(), key=lambda w: w["x0"]):
        if not (top - 4 <= w["top"] and w["bottom"] <= bottom + 4):
            continue
        # Past the last swatch is the export footer (TimeEdit, the date, 1/1).
        if w["x0"] > right + 60:
            break
        t = w["text"].strip().rstrip(",")
        if (CODE.fullmatch(t) or t == PLACEHOLDER) and t not in seen:
            seen.append(t)
    return seen


def pillar_of(name: str) -> str | None:
    """The pillar a filename names, matched as a word.

    A bare `in` test reads a pillar out of any longer word that happens to
    contain it, and the export names carry dates and job numbers. "HASS & TE"
    is tried before "HASS" so the combined file is not claimed by the shorter
    token first.
    """
    upper = name.upper()
    for pillar, tokens in PILLARS.items():
        for t in tokens:
            if re.search(rf"(?<![A-Z0-9]){re.escape(t.upper())}(?![A-Z0-9])", upper):
                return pillar
    return None


def label_of(name: str) -> str:
    """"2630 Term 7 HASS & TE_260826.pdf" -> "HASS & TE"."""
    stem = pathlib.Path(name).stem
    stem = re.sub(r"_\d+$", "", stem)
    stem = re.sub(r"^\d+\s*", "", stem)
    stem = re.sub(r"(?i)^term\s*\d+\s*", "", stem)
    return stem.strip() or stem


# ------------------------------------------------------------------ write ----

def canonical(code: str, known: set[str]) -> tuple[str, str | None]:
    """The catalogue's code for a registry code, and the suffix dropped.

    02.143HT is 02.143 on the Humanities track. The track is the registry's
    business; the catalogue has one record per course and the app's own code
    pattern allows one trailing letter, not two.
    """
    if code in known:
        return code, None
    m = TRACK_SUFFIX.match(code)
    if m and m.group(1) in known:
        return m.group(1), code[len(m.group(1)):]
    return code, None


def to_schedules(rows: list[dict], instructors: list[str] | None = None) -> list[dict]:
    """One schedule per room, deduplicated.

    Per room because `location` holds a single room and the venue heatmaps
    count occupancy off it, so a cohort split across two think tanks occupies
    both.

    Deduplicated because a course taught to several pillars is printed in each
    of their files: 01.400 Capstone 1 is in five of the six, identical every
    time, and without this it lands five times over. Two sections that really
    do meet in one room at one hour differ by `cohort` and both survive.
    """
    out: list[dict] = []
    seen: set[tuple] = set()
    for r in rows:
        for room in r["rooms"]:
            s = {
                "type": r["type"],
                "day": r["day"],
                "startTime": r["start"],
                "endTime": r["end"],
                "location": room,
                "instructors": instructors or [],
            }
            if r["section"]:
                s["cohort"] = r["section"]
            if r["weeks"]:
                s["weeks"] = r["weeks"]
            key = (s["type"], s["day"], s["startTime"], s["endTime"],
                   s["location"], s.get("cohort"), tuple(s.get("weeks", ())))
            if key in seen:
                continue
            seen.add(key)
            out.append(s)
    return out


def sort_key(s: dict) -> tuple:
    return (DAYS.index(s["day"]), s["startTime"], s["endTime"], s["location"],
            s.get("cohort", ""))


class FakePage:
    """A page shaped like pdfplumber's, built from text rather than a file.

    parse_page is the half of this that geometry decides - which day a block
    lands in, where the legend cuts the grid off, which curve is a class - and
    none of it was reachable without a PDF. Committing a real enrolment export
    to test it is not an option: it is SUTD's internal document and it names
    teaching staff on every block. So the page is described here instead, in
    the same shape pdfplumber hands over.

    Geometry copied from a real export: a 150pt day column, the grid starting
    at y=69 with 44pt to the hour, the legend swatches at y=569.
    """

    width, height = 842.0, 595.0

    def __init__(self, blocks):
        # blocks: (day index, top, bottom, text[, x nudge]), text as printed
        # lines. The nudge is how a block is put between two columns.
        self.blocks = [b if len(b) == 5 else (*b, 0.0) for b in blocks]

    def _left(self, day_i, nudge):
        return 52.8 + day_i * 150 + nudge

    def extract_words(self):
        out = []
        for i, day in enumerate(DAYS[:5]):
            left = 52.8 + i * 150
            out.append({"text": day, "x0": left + 59, "x1": left + 91,
                        "top": 58.2, "bottom": 67.2})
        return out

    @property
    def rects(self):
        # the legend swatches, which is how the grid's floor is found
        return [{"x0": 36.0 + i * 32, "x1": 43.0 + i * 32,
                 "top": 569.0, "bottom": 576.0} for i in range(3)]

    @property
    def curves(self):
        return [{"non_stroking_color": (0.67, 0.85, 0.58),
                 "x0": self._left(d, n), "x1": self._left(d, n) + 150,
                 "top": top, "bottom": bottom}
                for d, top, bottom, _, n in self.blocks]

    def crop(self, box):
        x0, top, _x1, _bottom = box
        for d, t, _b, text, n in self.blocks:
            if abs(self._left(d, n) - x0) < 0.5 and abs(t - top) < 0.5:
                return _Cropped(text)
        return _Cropped("")


class _Cropped:
    def __init__(self, text):
        self.text = text

    def extract_text(self, **_):
        return self.text


def self_check() -> int:
    """Drive the readers that turn a block's text into a record.

    No PDF and no network, so CI can run it. Everything here is a shape that
    actually came out of one of these files, including the two that read
    correctly right up until they did not: a weeks line that wrapped into the
    record, and a course code the registry suffixes with its track.
    """
    fails: list[str] = []

    def eq(label: str, got: object, want: object) -> None:
        if got != want:
            fails.append(f"{label}\n      got  {got!r}\n      want {want!r}")

    # A wrapped weeks line puts "43, 45, 47- 50" on the record's own line, and
    # reading from "line 2" would take those four numbers as rooms.
    eq("wrapped weeks",
       split_record(["11x w38-", "43, 45, 47- 50 02.183HT, LH01, LEC, Lecture Theatre 4,"]),
       ("11x w38-43, 45, 47- 50", "02.183HT, LH01, LEC, Lecture Theatre 4,"))
    eq("plain weeks",
       split_record(["12x w38-43, 45-50", "01.400, CC01, CBL, Capstone 1, 1.411"]),
       ("12x w38-43, 45-50", "01.400, CC01, CBL, Capstone 1, 1.411"))
    # A line that wraps mid-token joins with no space, or DS-01 becomes "DS- 01"
    # and matches no room.
    eq("hyphen wrap",
       split_record(["12x w38-43, 45-50", "30.303, LP01, LEC, DS-", "01, DS-02, 2.313A"])[1],
       "30.303, LP01, LEC, DS-01, DS-02, 2.313A")

    eq("weeks, ranges and singles", weeks_of("11x w38-43, 45, 47-50"),
       [38, 39, 40, 41, 42, 43, 45, 47, 48, 49, 50])
    eq("weeks, one range", weeks_of("6x w45-50"), [45, 46, 47, 48, 49, 50])
    eq("the repeat count is not a week", weeks_of("2x w38-39"), [38, 39])

    known = {"02.143", "03.007A", "50.040"}
    eq("track suffix dropped", canonical("02.143HT", known), ("02.143", "HT"))
    eq("a real suffix is part of the code", canonical("03.007A", known), ("03.007A", None))
    eq("a code we hold is left alone", canonical("50.040", known), ("50.040", None))
    eq("an unknown code is not invented", canonical("99.999ZZ", known), ("99.999ZZ", None))

    # One schedule per room: `location` holds a single room and the venue
    # heatmaps count occupancy off it, so a cohort split across two think tanks
    # has to occupy both.
    rows = [{"code": "50.006", "section": "CI01", "type": "Cohort", "day": "Monday",
             "start": "09:30", "end": "11:30", "rooms": ["1.416", "1.415"],
             "weeks": [38, 39]}]
    got = to_schedules(rows)
    eq("one slot per room", [s["location"] for s in got], ["1.416", "1.415"])
    eq("the section is the cohort", got[0]["cohort"], "CI01")
    eq("weeks carried", got[0]["weeks"], [38, 39])

    # 01.400 Capstone 1 is printed in five of the six files, identical each
    # time, because every pillar's cohort takes it.
    eq("the same class in two files lands once",
       len(to_schedules(rows + [dict(rows[0])])), 2)
    # Two sections really do share a lecture theatre at one hour: 50.046 CI01
    # and CI02, two instructors, one room. Both are real.
    eq("two sections in one room both survive",
       len(to_schedules(rows + [dict(rows[0], section="CI02")])), 4)

    # A block prints its rooms as names when it prints no code, and the
    # instructors sit in the same tail with no separator marking where the
    # venues stop. Anything that does not resolve is named rather than dropped.
    index = {"lecture theatre 4": "2.404", "think tank 2": "1.309",
             "humanities, arts and social sciences (hass) office": "1.402"}
    eq("names resolve to codes",
       resolve_named(["Lecture Theatre 4", "KOEK Hui Xia Christina"], index),
       (["2.404"], ["KOEK Hui Xia Christina"]))
    eq("a venue whose own name has a comma is rejoined",
       resolve_named(["Humanities", "Arts and Social Sciences (HASS) office"], index),
       (["1.402"], []))
    eq("a room nobody knows is reported, not swallowed",
       resolve_named(["Think Tank 2", "Room 9 3/4"], index),
       (["1.309"], ["Room 9 3/4"]))

    # The registry splits a divisible classroom when a cohort takes both
    # halves, and the catalogue holds the room rather than the halves.
    rooms_known = {"2.507", "2.313A", "2.313B", "1.411"}
    eq("a half resolves to the room it is half of",
       whole_room("2.507A", rooms_known), "2.507")
    eq("a suffix that is its own room stays",
       whole_room("2.313B", rooms_known), "2.313B")
    eq("a room nobody has is left as it was",
       whole_room("9.999Z", rooms_known), "9.999Z")
    eq("a plain code is untouched", whole_room("1.411", rooms_known), "1.411")

    eq("pillar from a filename", pillar_of("2630 Term 7 HASS & TE_260826.pdf"), "HASS")
    eq("CSD is ISTD", pillar_of("2630 Term 7 CSD_180826.pdf"), "ISTD")
    eq("no pillar in the name", pillar_of("timetable.pdf"), None)
    # A bare `in` test reads DAI out of "daily", and these filenames are
    # whatever the person exporting them typed.
    eq("a pillar inside a longer word is not a pillar",
       pillar_of("2630 Term 7 daily rooms_180826.pdf"), None)
    eq("the pillar still matches next to punctuation",
       pillar_of("term7-ESD.pdf"), "ESD")
    eq("label keeps only the pillar", label_of("2630 Term 7 HASS & TE_260826.pdf"),
       "HASS & TE")
    eq("label, plain", label_of("2630 Term 7 ESD_180826.pdf"), "ESD")

    # parse_page, driven end to end. Everything above is a reader; this is the
    # geometry that decides which day a block belongs to and where the grid
    # stops, and it was unreachable without opening a file.
    index = {"think tank 10": "1.416", "think tank 9": "1.415",
             "lecture theatre 4": "2.404"}
    rooms_known = {"1.416", "1.415", "2.404", "2.507"}

    page = FakePage([
        (0, 201.0, 289.0,
         "09:30\n11x w38-43, 45, 47-50\n50.006, CI01, CBL, Think Tank 10, Think\n"
         "Tank 9, 1.416, 1.415, CHOO Tsu Wei Kenny\n11:30"),
        (3, 113.0, 201.0,
         "09:00\n12x w38-43, 45-50\n02.183HT, LH01, LEC, Lecture Theatre 4,\n11:00"),
        (1, 377.0, 509.0, "15:00\n11x w38-43\nHASS, HASS placehold\n18:00"),
    ])
    rows, notes = parse_page(page, index, rooms_known)
    eq("a page parses to one row per class", len(rows), 2)
    eq("no note on a clean page", notes, [])
    eq("the block is on the day its column is",
       [r["day"] for r in rows], ["Monday", "Thursday"])
    eq("the printed times are the times", (rows[0]["start"], rows[0]["end"]),
       ("09:30", "11:30"))
    eq("codes beat the names beside them", rows[0]["rooms"], ["1.416", "1.415"])
    eq("a block with no code resolves its name", rows[1]["rooms"], ["2.404"])
    eq("the HASS placeholder is not a class",
       [r["code"] for r in rows], ["50.006", "02.183HT"])
    eq("CBL is a cohort, LEC a lecture",
       [r["type"] for r in rows], ["Cohort", "Lecture"])

    # A block sitting between two columns is a layout this has not seen. Put on
    # the nearer day it would read as a real class nobody can find.
    astray = FakePage([(0, 201.0, 289.0,
                        "09:30\n11x w38-43\n50.006, CI01, CBL, Think Tank 10, 1.416, X\n11:30",
                        90.0)])
    rows2, notes2 = parse_page(astray, index, rooms_known)
    eq("a block between two columns is dropped", rows2, [])
    eq("and says so", len(notes2), 1)

    # A room the catalogue does not hold still goes in, because the class is
    # real, but the run has to say so.
    stranger = FakePage([(0, 201.0, 289.0,
                          "09:30\n11x w38-43\n50.006, CI01, CBL, 9.999, Someone\n11:30")])
    rows3, notes3 = parse_page(stranger, index, rooms_known)
    eq("an unknown room is still written", [r["rooms"] for r in rows3], [["9.999"]])
    eq("an unknown room is reported", len(notes3), 1)

    if fails:
        print(f"self-check: {len(fails)} failure(s)")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("self-check: every reader behaves")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--self-check", action="store_true",
                    help="run the readers against known shapes, no PDF needed")
    # Optional so --self-check can stand alone, and required below when it is
    # not given: argparse owns the whole command line, so a flag passed beside
    # a folder is an error rather than something silently ignored.
    ap.add_argument("folder", nargs="?",
                    help="the folder holding the six enrolment PDFs")
    ap.add_argument("--dry-run", action="store_true", help="report, write nothing")
    ap.add_argument("--report", help="write the report here as well as to stdout")
    args = ap.parse_args()
    if args.self_check:
        if args.folder:
            ap.error("--self-check opens nothing, so it takes no folder")
        return self_check()
    if not args.folder:
        ap.error("a folder holding the six enrolment PDFs is required")

    folder = pathlib.Path(args.folder)
    if not folder.is_dir():
        die(f"{folder} is not a folder")

    pdfs = sorted(folder.glob("*.pdf"))
    if not pdfs:
        die(f"no PDFs in {folder}")

    by_pillar: dict[str, pathlib.Path] = {}
    for p in pdfs:
        pillar = pillar_of(p.name)
        if pillar is None:
            die(f"{p.name} names no pillar. Expected one of "
                f"{', '.join(PILLARS)} in the filename.")
        if pillar in by_pillar:
            die(f"two files claim {pillar}: {by_pillar[pillar].name} and {p.name}")
        by_pillar[pillar] = p
    missing = [p for p in PILLARS if p not in by_pillar]
    if missing:
        die(f"no file for {', '.join(missing)}. All six are needed: a pillar "
            f"read as empty would look like a pillar with no classes.")

    pdfplumber = load_pdfplumber()

    known = {json.loads(f.read_text(encoding="utf-8"))["code"]
             for f in COURSES.glob("*.json")}
    venues = venue_index()
    rooms_known = venue_codes()

    sections: list[str] = []
    per_mod: dict[str, list[dict]] = defaultdict(list)
    every_expected: set[str] = set()
    every_parsed: set[str] = set()
    renamed: dict[str, str] = {}
    absent: set[str] = set()
    noted = 0

    for pillar in PILLARS:
        path = by_pillar[pillar]
        with pdfplumber.open(path) as pdf:
            rows: list[dict] = []
            legend: list[str] = []
            problems: list[str] = []
            for page in pdf.pages:
                r, pr = parse_page(page, venues, rooms_known)
                rows.extend(r)
                problems.extend(pr)
                legend.extend(c for c in legend_of(page) if c not in legend)

        expected: list[str] = []
        for raw in legend:
            if raw == PLACEHOLDER:
                continue
            code, suffix = canonical(raw, known)
            if suffix:
                renamed[raw] = code
            if code not in known:
                absent.add(raw)
            expected.append(code)
        expected = sorted(set(expected))
        every_expected.update(expected)

        mine: dict[str, list[dict]] = defaultdict(list)
        for r in rows:
            code, suffix = canonical(r["code"], known)
            if suffix:
                renamed[r["code"]] = code
            if code not in known:
                absent.add(r["code"])
                continue
            r = dict(r, code=code)
            mine[code].append(r)
            per_mod[code].append(r)
        every_parsed.update(mine)

        lines = [f"### {label_of(path.name)} ({len(mine)})", ""]
        for code in sorted(mine):
            when = []
            for r in sorted(mine[code], key=lambda r: (DAYS.index(r["day"]), r["start"])):
                rooms = " ".join(r["rooms"]) or "room unknown"
                # The section is what tells two identical-looking rows apart:
                # 50.046 CI01 and CI02 meet in the same lecture theatre at the
                # same hour, and 40.302/40.305 share a room across half a term.
                when.append(f"{r['day'][:3]} {r['start']}-{r['end']} "
                            f"{r['section']} @ {rooms}".replace("  ", " "))
            lines.append(f"- `{code}`: " + ", ".join(when))
        gap = [c for c in expected if c not in mine]
        extra = [c for c in sorted(mine) if c not in expected]
        lines.append("")
        lines.append(f"Expected ({len(expected)}): {', '.join(expected) or 'none'}")
        if gap:
            lines.append(f"**In the legend but no block parsed ({len(gap)}): "
                         f"{', '.join(gap)}**")
        if extra:
            lines.append(f"Parsed but not in the legend ({len(extra)}): {', '.join(extra)}")
        for p in problems:
            lines.append(f"- **note**: {p}")
        noted += len(problems)
        sections.append("\n".join(lines))

    # ---- write ----------------------------------------------------------
    written: list[str] = []
    for code, rows in sorted(per_mod.items()):
        f = COURSES / f"{code.replace('.', '_')}.json"
        mod = json.loads(f.read_text(encoding="utf-8"))
        fresh = sorted(to_schedules(rows), key=sort_key)
        if mod.get("schedules") == fresh:
            continue
        mod["schedules"] = fresh
        if not args.dry_run:
            f.write_text(json.dumps(mod, indent=2, ensure_ascii=False) + "\n",
                         encoding="utf-8")
        written.append(code)

    tag = "[dry-run] " if args.dry_run else ""
    total = sorted(every_parsed)
    report = ["# Subject enrolment, parsed", "",
              f"Source: {len(pdfs)} PDFs in `{folder.name}`", ""]
    report.extend(s + "\n" for s in sections)
    report.append("## Tally\n")
    report.append(f"Total ({len(total)}): {', '.join(total)}")
    report.append("")
    exp = sorted(every_expected)
    report.append(f"Expected ({len(exp)}): {', '.join(exp)}")
    report.append("")
    short = [c for c in exp if c not in every_parsed]
    if short:
        report.append(f"**Missing ({len(short)}): {', '.join(short)}**\n")
    if renamed:
        report.append("Track suffixes dropped, because the catalogue holds one "
                      "record per course and the track is the registry's own: "
                      + ", ".join(f"`{k}` -> `{v}`" for k, v in sorted(renamed.items()))
                      + "\n")
    if absent:
        report.append(f"**No catalogue record ({len(absent)}): "
                      f"{', '.join(sorted(absent))}**\n")
    report.append(f"{tag}{len(written)} course file(s) rewritten: "
                  f"{', '.join(written) or 'none'}")

    text = "\n".join(report)
    print(text)
    if args.report:
        pathlib.Path(args.report).write_text(text + "\n", encoding="utf-8")
    # A note means a block went in with less than the registry printed, or did
    # not go in at all. Neither is a clean run, and neither is visible unless
    # the exit code says so. It is NOT "nothing happened": everything that
    # parsed has already been written, and the line above says what.
    if short or absent or noted:
        print()
        print("Exit 1: the courses above are written, and the report has "
              "something in it a person has to look at before committing.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
