#!/usr/bin/env python3
"""Turn the drift reports into proposed edits to data/courses/*.json.

    python tools/scraper/propose_edits.py --prereqs pre.json --minors min.json \\
        --report-out report.md
    python tools/scraper/propose_edits.py --prereqs pre.json --dry-run

WHY A MODEL IS IN THIS LOOP AT ALL
`audit_prereqs.py` can say that a page names 50.012 and the record does not. It
cannot say whether the page MEANT it: 50.037's block names three codes and then
calls them "helpful but not required". That judgement is reading a sentence,
which is the one thing here worth a model, and the reason those reports have sat
unapplied. The reports stay report-only. This reads them.

THE MODEL NEVER TOUCHES A FILE. It returns proposed edits and this script
validates every one before writing:

  * the course record has to exist
  * the field has to be `prerequisites`, `corequisites` or a one-level
    `prereqTree`
  * every code has to have a file in data/courses/
  * `quote` has to appear in the page text the report captured, compared with
    whitespace flattened. This is the gate against invention: a proposal the
    page does not support is dropped and listed as dropped, never applied

Anything that fails is in the report with its reason, so a rule that is too
strict shows up as a pattern rather than as silence.

WHAT COMES OUT is an edited working tree and a markdown report. The workflow
commits both into a pull request. Nothing here pushes and nothing here writes to
main: /data is human-reviewed, and a model proposing an edit does not change
that.

BOTH REPORTS, not just prerequisites. `audit_prereqs.py` asks whether a course
page means the codes it names; `gather_minors.py` asks the same question of a
minor page. The judgement is identical and so is the gate, so both feed this.

What it will NOT do for minors is add or remove a minor. Discovery reports that
SUTD publishes a programme the repo has never heard of, and writing a whole
record from a page of prose is not the same job as adding one code to a list a
human already shaped. Those stay in the report.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from agents import llm  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
COURSES = ROOT / "data" / "courses"

FIELDS = {"prerequisites", "corequisites", "prereqTree"}
MINORS = ROOT / "data" / "minors.json"
CODE_RE = re.compile(r"^\d{2}\.\d{3}[A-Za-z]?$")

# Five, not one and not fifty. One per request is forty round trips for a
# monthly job; a batch big enough to matter is a batch where one malformed reply
# loses every case in it.
BATCH = 5

SYSTEM = """You reconcile a university's course records against its own web pages.

You are given, per course, the prerequisite text printed on the page and the
codes the repository record holds. Decide whether the record should change.

A code appearing on a page is NOT automatically a requirement. Pages say things
like "helpful but not required", "recommended", "or equivalent experience", and
name a code inside an example or inside another course's description. Propose an
edit only when the sentence says the course requires it.

Reply with JSON and nothing else, in exactly this shape:

{"edits": [{"code": "50.037", "field": "prerequisites",
            "value": ["50.001", "50.002"],
            "quote": "exact substring copied from the page text",
            "why": "one sentence"}],
 "skipped": [{"code": "50.043", "why": "one sentence"}]}

Rules you must follow:
- `value` REPLACES the field. Include every code that should remain, not only
  the new one.
- `field` is one of: prerequisites, corequisites, prereqTree.
- For prereqTree, `value` is {"or": ["50.001", "50.002"]} or {"and": [...]},
  one level deep, codes only. Use it only when the page joins the codes
  with "or".
- `quote` MUST be copied character for character from the page text you were
  given for that course. If you cannot quote the page, put the course in
  `skipped` instead.
- Every code must look like NN.NNN.
- Propose nothing when the page and the record already agree, or when the page
  is ambiguous. Skipping is the correct answer more often than editing."""


MINOR_SYSTEM = """You reconcile a university's minor-programme records against its own web pages.

You are given, per minor, the visible text of its page and the requirement groups
the repository holds. Each group is "choose `count` from `anyOf`". Decide whether
a code the page names should join one of those groups.

A code appearing on a page is NOT automatically a requirement. These pages name
codes inside prerequisites, inside examples, and inside sentences about other
programmes. Several groups in the repo are a deliberate expansion of an
open-ended phrase like "any HASS elective", so a code the repo lists that the
page does not name is normal and is not your problem.

Reply with JSON and nothing else, in exactly this shape:

{"edits": [{"minor": "minor-ai", "requirement": 0, "add": ["50.057"],
            "quote": "exact substring copied from the page text",
            "why": "one sentence"}],
 "skipped": [{"minor": "minor-dh", "why": "one sentence"}]}

Rules you must follow:
- `requirement` is the INDEX of the group to add to, from the list you were given.
- `add` lists only codes to ADD. Never removes, never reorders.
- `quote` MUST be copied character for character from the page text you were
  given for that minor. If you cannot quote the page, skip the minor instead.
- Every code must look like NN.NNN.
- Propose nothing when the page is describing a prerequisite, an example, or
  another programme. Skipping is the correct answer more often than editing."""


# A QUOTE HAS TO BE A SENTENCE, NOT A CODE. Every code a drift report flags was
# pulled out of that same page text, so quoting the bare code is guaranteed to
# match and the gate passes on exactly the population it exists to guard. A real
# quote carries the words around the code, which is the only part that says
# whether the page MEANT it.
QUOTE_MIN_CHARS = 25
QUOTE_MIN_WORDS = 5

# The phrases a SUTD page uses to name a course and then disown it. A quote
# carrying one of these is evidence AGAINST a requirement, so accepting it as
# support for adding a prerequisite gets the answer exactly backwards. 50.037's
# block is the worked example: it names 50.012, 50.020 and 50.043 and then says
# they are helpful but not required.
HEDGES = (
    "helpful but not required",
    "not required",
    "not a prerequisite",
    "recommended",
    "optional",
    "preferably",
    "or equivalent",
    "assumed knowledge",
    "nice to have",
)


def quote_is_substantial(quote: str) -> str:
    """Empty when the quote will do, otherwise the reason it will not."""
    q = " ".join((quote or "").split())
    if len(q) < QUOTE_MIN_CHARS:
        return f"quote is {len(q)} chars, needs {QUOTE_MIN_CHARS}: a code is not a sentence"
    if len(q.split()) < QUOTE_MIN_WORDS:
        return f"quote is {len(q.split())} words, needs {QUOTE_MIN_WORDS}"
    return ""


def quote_supports(quote: str, codes: list[str]) -> str:
    """Empty when the quote actually argues FOR requiring `codes`.

    Length alone was the whole gate, and length is satisfied by any run of
    words. Two things were getting through:

    - a bare enumeration lifted out of a sentence whose verdict is the opposite,
      "50.012 Networks , 50.020 Security , and 50.0", which is 44 characters of
      nothing;
    - the disowning sentence itself, quoted as support for adding the very
      courses it disowns.

    So the quote has to name every code being added, and must not be one of the
    sentences that take a requirement away.
    """
    q = " ".join((quote or "").split()).lower()
    for h in HEDGES:
        if h in q:
            return f"quote says {h!r}, which is evidence against a requirement"
    missing = [c for c in codes if c.lower() not in q]
    if missing:
        return f"quote does not name {', '.join(missing)}"
    return ""


def norm(s: str) -> str:
    """Whitespace-flattened and lowercased, for comparing a quote to a page.

    Models reflow whitespace and change case in a quote they are otherwise
    copying faithfully, so an exact-substring test rejects true quotes. Dropping
    a real edit is as costly here as accepting an invented one.
    """
    return " ".join((s or "").split()).lower()


def known_codes() -> set[str]:
    return {p.stem.replace("_", ".") for p in COURSES.glob("*.json")}


# Enough page text to hold a sentence. A block that is one dash, or one code and
# nothing else, cannot be quoted and cannot say whether it meant it.
MIN_PAGE_CHARS = 24


def candidates(rows: list[dict]) -> list[dict]:
    """The rows where the page and the record disagree, AND the page says why.

    `differs` only. `agrees` and `none listed` carry no question; `no page` and
    `fetch failed` carry no page text. `record adds` is excluded for the same
    reason it looks like the most interesting case: the page printed a
    Prerequisite heading with nothing under it, so there is no sentence to read
    and a model asked to decide would be inventing one. 01.401 Capstone 2 plainly
    needs 01.400 and its page says so nowhere, which is a human's call.
    """
    return [
        r for r in rows
        if r.get("status") == "differs" and len(r.get("listed") or "") >= MIN_PAGE_CHARS
    ]


def payload(rows: list[dict]) -> str:
    return "\n".join(
        json.dumps(
            {
                "code": r["code"],
                "name": r["name"],
                "page_text": r.get("listed", ""),
                "record_prerequisites": r.get("prerequisites", []),
                "record_corequisites": r.get("corequisites", []),
                "page_names_record_does_not": r.get("gap", []),
                "record_names_page_does_not": r.get("extra", []),
                "record_has_prereq_tree": bool(r.get("tree")),
            },
            ensure_ascii=False,
        )
        for r in rows
    )


def minor_candidates(rows: list[dict]) -> list[dict]:
    """Minors whose page names a code the record does not, with text to quote.

    The `_index` row is discovery, not a minor. A minor SUTD added is reported
    and never proposed: writing a whole record from prose is a different job
    from adding one code to a list a human already shaped.
    """
    return [
        r for r in rows
        if r.get("id") != "_index" and r.get("extra")
        and len(r.get("page_text") or "") >= MIN_PAGE_CHARS
    ]


def minor_payload(rows: list[dict], book: dict) -> str:
    by_id = {m.get("id"): m for m in book.get("minors") or []}
    out = []
    for r in rows:
        m = by_id.get(r["id"], {})
        groups = [
            {"index": i, "label": g.get("label", ""), "count": g.get("count"),
             "anyOf": g.get("anyOf") or []}
            for i, g in enumerate(m.get("requirements") or [])
        ]
        out.append(json.dumps({
            "minor": r["id"],
            "name": r.get("name"),
            "page_text": r.get("page_text", ""),
            "requirement_groups": groups,
            "page_names_repo_does_not": r.get("extra", []),
            "repo_note": m.get("note", ""),
        }, ensure_ascii=False))
    return "\n".join(out)


def validate_minor(edit: dict, by_id: dict, book_ids: dict, codes: set[str]) -> tuple[bool, str]:
    mid = str(edit.get("minor", ""))
    add = edit.get("add")
    quote = str(edit.get("quote", ""))

    if mid not in book_ids:
        return False, f"no minor {mid!r} in data/minors.json"
    if mid not in by_id:
        return False, f"{mid} was not one of the minors reported to the model"
    reqs = book_ids[mid].get("requirements") or []
    idx = edit.get("requirement")
    if not isinstance(idx, int) or not 0 <= idx < len(reqs):
        return False, f"requirement {idx!r} is not a group on {mid}"
    # ADDING TO AN ALL-MANDATORY GROUP LOOSENS IT. `count == len(anyOf)` means
    # every course in the list is required; append one and it silently becomes
    # "choose count of len+1", so a student may now skip a course the page says
    # they must take. minor-aai's first group is count 1 over ["10.022"], a
    # single mandatory course, and 16 of the 37 groups in data/minors.json have
    # this shape. Whether a new code is also mandatory (count goes up) or an
    # alternative (count stays) is exactly the thing the page rarely says, so it
    # is refused and reported rather than guessed.
    group = reqs[idx]
    if group.get("count") == len(group.get("anyOf") or []):
        return False, (f"group {idx} on {mid} is all-mandatory "
                       f"(count {group.get('count')} of {len(group.get('anyOf') or [])}); "
                       "adding to it would turn a required course into a choice")
    if not isinstance(add, list) or not add or not all(isinstance(c, str) for c in add):
        return False, "add must be a non-empty list of course codes"
    for c in add:
        if not CODE_RE.match(c):
            return False, f"{c!r} is not a course code"
        if c not in codes:
            return False, f"{c} has no record in data/courses"
        if c in (reqs[idx].get("anyOf") or []):
            return False, f"{c} is already in that group"
    thin = quote_is_substantial(quote) or quote_supports(quote, list(add))
    if thin:
        return False, thin
    if norm(quote) not in norm(by_id[mid].get("page_text", "")):
        return False, "quote is not in the page text this minor was reported with"
    return True, ""


def apply_minor(edit: dict, book: dict) -> str:
    """Mutate the in-memory book. One write happens after every edit is applied.

    data/minors.json is a single file holding all of them, so writing per edit
    would reread a file the previous edit had already changed.
    """
    for m in book.get("minors") or []:
        if m.get("id") == edit["minor"]:
            group = m["requirements"][edit["requirement"]]
            group["anyOf"] = list(group.get("anyOf") or []) + list(edit["add"])
            return "staged"
    return "not found"


def load_record(code: str) -> dict:
    path = COURSES / f"{code.replace('.', '_')}.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def top_level(node: object) -> list[object]:
    """The items directly under the outermost and/or, not recursed.

    A nested group has to stay a dict here, which is exactly what recursion
    destroys.
    """
    if isinstance(node, dict):
        for k in ("and", "or"):
            if k in node and isinstance(node[k], list):
                return list(node[k])
        return [node]
    if isinstance(node, list):
        return list(node)
    return [node] if node is not None else []


def flatten_tree(node: object) -> list[object]:
    """Every leaf of a prereqTree, keeping dict leaves as dicts.

    A dict leaf is a leaf that says more than its code: a cohort, a name, an
    nOf. Those are what a flat list of codes silently throws away.
    """
    if isinstance(node, list):
        return [y for x in node for y in flatten_tree(x)]
    if isinstance(node, dict):
        for k in ("and", "or"):
            if k in node:
                return flatten_tree(node[k])
        if "nOf" in node:
            return [node]
        return [node]
    return [node] if node is not None else []


def validate(edit: dict, by_code: dict[str, dict], codes: set[str]) -> tuple[bool, str]:
    code = str(edit.get("code", ""))
    field = str(edit.get("field", ""))
    value = edit.get("value")
    quote = str(edit.get("quote", ""))

    if code not in codes:
        return False, f"no record for {code!r}"
    if code not in by_code:
        return False, f"{code} was not one of the courses reported to the model"
    if field not in FIELDS:
        return False, f"field {field!r} is not one of {sorted(FIELDS)}"

    if field == "prereqTree":
        if not isinstance(value, dict) or len(value) != 1 or set(value) - {"and", "or"}:
            return False, "prereqTree must be a single {'and': [...]} or {'or': [...]}"
        items = next(iter(value.values()))
        # A FLAT LIST OF CODES CANNOT SAY WHAT A SCOPED TREE SAYS. 50.001's tree
        # is {"or": [{"code": "10.014", "cohort": ["ay2024"]},
        #            {"code": "10.025", "cohort": ["ay2025", "ay2026"]}]},
        # and accepting {"or": ["10.014", "10.025"]} over it deletes the cohort
        # scoping: every student would then satisfy the prerequisite with either
        # course, which is exactly what the scoping exists to prevent. 11 course
        # records carry scoping like that. Nested groups have the same problem.
        # Replacing one is a human's edit, so this refuses and says why.
        # TOP LEVEL ONLY, deliberately. flatten_tree recurses through and/or,
        # so a nested group was unwrapped into its plain string leaves and the
        # guard saw no dicts at all: 50.055's {"and": ["50.007", {"or":
        # ["50.039", "60.001"]}]} flattened to three strings, and a flat
        # {"or": [...]} over it would have deleted the AND, letting 50.039
        # alone satisfy a prerequisite that also needs 50.007. Unwrapping one
        # level keeps a nested group visible AS a dict.
        current = load_record(code).get("prereqTree")
        if any(isinstance(x, dict) for x in top_level(current)):
            return False, ("the existing prereqTree has scoped or nested leaves "
                           "(cohort, nOf, a nested and/or); a flat code list would "
                           "delete them")
    else:
        items = value
    if not isinstance(items, list) or not items or not all(isinstance(c, str) for c in items):
        return False, "value must be a non-empty list of course codes"
    for c in items:
        if not CODE_RE.match(c):
            return False, f"{c!r} is not a course code"
        if c not in codes:
            return False, f"{c} has no record in data/courses"
    if code in items:
        return False, "a course cannot be its own prerequisite"

    thin = quote_is_substantial(quote) or quote_supports(quote, list(items))
    if thin:
        return False, thin
    if norm(quote) not in norm(by_code[code].get("listed", "")):
        return False, "quote is not in the page text this course was reported with"
    return True, ""


def apply(edit: dict, dry_run: bool) -> str:
    path = COURSES / f"{edit['code'].replace('.', '_')}.json"
    d = json.loads(path.read_text(encoding="utf-8"))
    if d.get(edit["field"]) == edit["value"]:
        return "already matched"
    if dry_run:
        return "would write"
    d[edit["field"]] = edit["value"]
    path.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return "written"


def emit(report: list[str], out: str) -> int:
    text = "\n".join(report)
    if out:
        pathlib.Path(out).write_text(text, encoding="utf-8")
    print(text)
    return 0


# (edit, should_pass). The validator is the only thing standing between a model
# and /data, so it gets checked without a network call or a test framework:
# `python propose_edits.py --self-check`.
SELF_CHECK: list[tuple[dict, bool]] = [
    # WAS True. A quote saying "helpful but not required" is evidence AGAINST
    # the edit, and this table asserting otherwise is how the hole stayed open.
    ({"code": "50.037", "field": "prerequisites", "value": ["50.004"],
      "quote": "These courses are helpful but not required"}, False),
    ({"code": "50.037", "field": "prerequisites", "value": ["50.004"],
      "quote": "Students must have completed 50.004 before taking this"}, True),
    # Names the code AND hedges. Without this the HEDGES list has no case of
    # its own: the quote-names-its-codes check happens to catch the shorter
    # hedge quotes, so removing HEDGES left the table still green.
    ({"code": "50.037", "field": "prerequisites", "value": ["50.012"],
      "quote": "50.012 Networks is helpful but not required for this"}, False),
    # a run of words lifted out of a sentence, naming nothing it adds
    ({"code": "50.037", "field": "prerequisites", "value": ["50.005"],
      "quote": "50.012 Networks , 50.020 Security , and more"}, False),
    # 50.055's tree nests a group; a flat list would delete the AND
    ({"code": "50.055", "field": "prereqTree", "value": {"or": ["50.007", "50.039"]},
      "quote": "Students must have completed 50.007 and 50.039 first"}, False),
    ({"code": "50.037", "field": "prerequisites", "value": ["50.004"],
      "quote": "this whole sentence is nowhere on the page"}, False),
    ({"code": "50.037", "field": "prerequisites", "value": ["99.123"],
      "quote": "These courses are helpful but not required"}, False),
    ({"code": "50.037", "field": "description", "value": ["50.004"],
      "quote": "These courses are helpful but not required"}, False),
    ({"code": "50.037", "field": "prerequisites", "value": ["50.037"],
      "quote": "These courses are helpful but not required"}, False),
    ({"code": "50.037", "field": "prerequisites", "value": [],
      "quote": "These courses are helpful but not required"}, False),
    ({"code": "50.037", "field": "prereqTree", "value": {"or": ["50.004"]},
      "quote": "Students must have completed 50.004 before taking this"}, True),
    ({"code": "50.037", "field": "prereqTree", "value": {"or": ["50.004"], "and": ["50.005"]},
      "quote": "These courses are helpful but not required"}, False),
    # 50.001's real tree is cohort-scoped, so a flat list may not replace it
    ({"code": "50.001", "field": "prereqTree", "value": {"or": ["10.014", "10.025"]},
      "quote": "Students must have completed 10.014 or 10.025 first"}, False),
    ({"code": "00.000", "field": "prerequisites", "value": ["50.004"],
      "quote": "These courses are helpful but not required"}, False),
]


# The same, for minors. A group index is the part a model gets wrong quietly:
# an off-by-one puts a core course into the electives list and the diff looks
# plausible.
SELF_CHECK_MINORS: list[tuple[dict, bool]] = [
    ({"minor": "_m", "requirement": 0, "add": ["50.001"], "quote": "Students must take 50.001 in term four"}, True),
    ({"minor": "_m", "requirement": 0, "add": ["50.001"], "quote": "this whole sentence is not on the page at all"}, False),
    ({"minor": "_m", "requirement": 9, "add": ["50.001"], "quote": "Students must take 50.001 in term four"}, False),
    ({"minor": "_m", "requirement": 0, "add": ["50.002"], "quote": "Students must take 50.001 in term four"}, False),
    ({"minor": "_m", "requirement": 0, "add": ["99.123"], "quote": "Students must take 50.001 in term four"}, False),
    ({"minor": "_m", "requirement": 0, "add": [], "quote": "Students must take 50.001 in term four"}, False),
    ({"minor": "_nope", "requirement": 0, "add": ["50.001"], "quote": "Students must take 50.001 in term four"}, False),
    # all-mandatory group: adding to it would let a student skip 50.005
    ({"minor": "_m", "requirement": 1, "add": ["50.001"], "quote": "Students must take 50.001 in term four"}, False),
    # a bare code is not a quote, however true it is
    ({"minor": "_m", "requirement": 0, "add": ["50.001"], "quote": "50.001"}, False),
]


def self_check() -> int:
    codes = known_codes()
    bad = 0

    by_code = {
        "50.037": {"listed": "Students must have completed 50.004 before taking this. 50.012 Networks is helpful but not required for this. 50.012 Networks , 50.020 Security , and more. These courses are   HELPFUL but not required for 50.037."},
        "50.001": {"listed": "Students must have completed 10.014 or 10.025 first."},
        "50.055": {"listed": "Students must have completed 50.007 and 50.039 first."},
    }
    for edit, want in SELF_CHECK:
        got, why = validate(edit, by_code, codes)
        if got != want:
            bad += 1
            print(f"FAIL {edit} -> {got} ({why or 'accepted'}), wanted {want}")

    # 50.002 is already in the group, which is why proposing it must be refused.
    # Group 0 is a choice (1 of 2) so ordinary cases can pass; group 1 is
    # all-mandatory, which nothing may add to.
    book_ids = {"_m": {"id": "_m", "requirements": [
        {"label": "electives", "count": 1, "anyOf": ["50.002", "50.003"]},
        {"label": "core", "count": 1, "anyOf": ["50.005"]},
    ]}}
    by_id = {"_m": {"id": "_m", "page_text": "Students   MUST take 50.001 in term four, and then one elective."}}
    for edit, want in SELF_CHECK_MINORS:
        got, why = validate_minor(edit, by_id, book_ids, codes)
        if got != want:
            bad += 1
            print(f"FAIL {edit} -> {got} ({why or 'accepted'}), wanted {want}")

    total = len(SELF_CHECK) + len(SELF_CHECK_MINORS)
    print(f"{total - bad}/{total} validator cases ok")
    return 1 if bad else 0


def run_prereqs(path, report, args, codes):
    """Course records against their own pages. Returns (accepted, rejected, skipped, providers)."""
    rows = candidates(json.loads(pathlib.Path(path).read_text(encoding="utf-8")))
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        report += ["### prerequisites", "",
                   "Nothing to propose: no course record disagrees with its page.", ""]
        return [], [], [], set()

    by_code = {r["code"]: r for r in rows}
    accepted, rejected, skipped, providers = [], [], [], set()
    for i in range(0, len(rows), BATCH):
        batch = rows[i : i + BATCH]
        answer = llm.chat(SYSTEM, payload(batch), timeout=120.0)
        if answer is None:
            # One batch failing is not the run failing. The others still have
            # their evidence, and a partial set of proposals is reviewable.
            report.append(f"- no provider answered for {', '.join(r['code'] for r in batch)}")
            continue
        provider, parsed = answer
        providers.add(provider)
        for edit in parsed.get("edits") or []:
            ok, why = validate(edit, by_code, codes)
            if ok:
                accepted.append((edit, apply(edit, args.dry_run)))
            else:
                rejected.append((edit, why))
        skipped += parsed.get("skipped") or []

    report += ["### prerequisites", "",
               f"{len(rows)} course record(s) disagreed with their page.", ""]
    for edit, outcome in accepted:
        report += [
            f"**{edit['code']}** `{edit['field']}` -> "
            f"`{json.dumps(edit['value'], ensure_ascii=False)}` ({outcome})",
            "", f"> {str(edit.get('quote', '')).strip()}",
            "", str(edit.get("why", "")).strip(), "",
        ]
    if rejected:
        report += ["dropped by validation:", "", "| course | field | why |", "|---|---|---|"]
        report += [f"| {e.get('code', '?')} | {e.get('field', '?')} | {why} |"
                   for e, why in rejected]
        report.append("")
    if skipped:
        report += ["read and left alone:", "", "| course | why |", "|---|---|"]
        report += [f"| {s.get('code', '?')} | {str(s.get('why', '')).strip()} |"
                   for s in skipped[:40]]
        report.append("")
    return accepted, rejected, skipped, providers


def run_minors(path, report, args, codes):
    """Minor requirement groups against their own pages."""
    rows = minor_candidates(json.loads(pathlib.Path(path).read_text(encoding="utf-8")))
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        report += ["### minors", "",
                   "Nothing to propose: no minor page names a code its record lacks.", ""]
        return [], [], [], set()

    book = json.loads(MINORS.read_text(encoding="utf-8"))
    book_ids = {m.get("id"): m for m in book.get("minors") or []}
    by_id = {r["id"]: r for r in rows}
    accepted, rejected, skipped, providers = [], [], [], set()

    for i in range(0, len(rows), BATCH):
        batch = rows[i : i + BATCH]
        answer = llm.chat(MINOR_SYSTEM, minor_payload(batch, book), timeout=120.0)
        if answer is None:
            report.append(f"- no provider answered for {', '.join(r['id'] for r in batch)}")
            continue
        provider, parsed = answer
        providers.add(provider)
        for edit in parsed.get("edits") or []:
            ok, why = validate_minor(edit, by_id, book_ids, codes)
            if ok:
                accepted.append((edit, "would write" if args.dry_run else apply_minor(edit, book)))
            else:
                rejected.append((edit, why))
        skipped += parsed.get("skipped") or []

    # One write, after every edit. data/minors.json holds all of them, so a
    # write per edit would reread a file the previous edit had already changed.
    if accepted and not args.dry_run:
        MINORS.write_text(json.dumps(book, indent=2, ensure_ascii=False) + "\n",
                          encoding="utf-8")

    report += ["### minors", "",
               f"{len(rows)} minor page(s) name a code their record lacks.", ""]
    for edit, outcome in accepted:
        group = (book_ids.get(edit["minor"], {}).get("requirements") or [{}])[edit["requirement"]]
        report += [
            f"**{edit['minor']}** + `{', '.join(edit['add'])}` "
            f"to \"{group.get('label', edit['requirement'])}\" ({outcome})",
            "", f"> {str(edit.get('quote', '')).strip()}",
            "", str(edit.get("why", "")).strip(), "",
        ]
    if rejected:
        report += ["dropped by validation:", "", "| minor | add | why |", "|---|---|---|"]
        report += [f"| {e.get('minor', '?')} | {', '.join(e.get('add') or []) or '?'} | {why} |"
                   for e, why in rejected]
        report.append("")
    if skipped:
        report += ["read and left alone:", "", "| minor | why |", "|---|---|"]
        report += [f"| {s.get('minor', '?')} | {str(s.get('why', '')).strip()} |"
                   for s in skipped[:40]]
        report.append("")
    return accepted, rejected, skipped, providers


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--self-check", action="store_true",
                    help="run the validators against known-good and known-bad edits")
    ap.add_argument("--prereqs", help="audit_prereqs.py --json output")
    ap.add_argument("--minors", help="gather_minors.py --json output")
    ap.add_argument("--report-out", default="")
    ap.add_argument("--dry-run", action="store_true", help="decide, write nothing")
    ap.add_argument("--limit", type=int, default=0, help="candidates per report, not requests")
    args = ap.parse_args()

    if args.self_check:
        return self_check()

    report = ["## proposed edits", ""]

    if not llm.configured():
        return emit(report + [
            "No model token is set, so nothing was proposed. The drift reports "
            "above still say what changed, and applying them stays a human job "
            "until one of `GEMINI_TOKEN`, `GROQ_TOKEN` or `OPENAI_TOKEN` exists. "
            "`.env.example` says where each goes.", "",
        ], args.report_out)

    codes = known_codes()
    accepted, providers = [], set()
    for flag, runner in ((args.prereqs, run_prereqs), (args.minors, run_minors)):
        if flag and pathlib.Path(flag).exists():
            a, _r, _s, pv = runner(flag, report, args, codes)
            accepted += a
            providers |= pv

    report[1:1] = ["", f"Read by {', '.join(sorted(providers)) or 'nothing'}."]
    if accepted:
        report += [
            "Each edit above is a proposal a model made from the page text, checked "
            "against that text before it was written. Read the quote before merging: "
            "it is copied from the page, and the page is what the record has to "
            "match.", "",
        ]
    return emit(report, args.report_out)



if __name__ == "__main__":
    raise SystemExit(main())
