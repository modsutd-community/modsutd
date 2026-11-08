#!/usr/bin/env python3
"""Turn the drift reports into proposed edits to data/mods/*.json.

    python tools/scraper/propose_edits.py --prereqs pre.json --minors min.json \
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

  * the mod record has to exist
  * the field has to be `prerequisites`, `corequisites` or a one-level
    `prereqTree`, whose leaves may carry a `cohort`. A record already scoped
    by cohort only takes a scoped tree, and a record with a nested group takes
    none
  * an empty list is allowed only on a quote that disowns: "None", or a hedge
    naming every code the record would lose. It takes the tree with it
  * every code has to have a file in data/mods/
  * `quote` has to appear in the page text the report captured, compared with
    whitespace flattened. This is the gate against invention: a proposal the
    page does not support is dropped and listed as dropped, never applied

Anything that fails is in the report with its reason, so a rule that is too
strict shows up as a pattern rather than as silence.

WHAT COMES OUT is an edited working tree and a markdown report. The workflow
commits both into a pull request. Nothing here pushes and nothing here writes to
main: /data is human-reviewed, and a model proposing an edit does not change
that.

BOTH REPORTS, not just prerequisites. `audit_prereqs.py` asks whether a mod
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
MODS = ROOT / "data" / "mods" if (ROOT / "data" / "mods").exists() else ROOT / "data" / "courses"

FIELDS = {"prerequisites", "corequisites", "prereqTree"}
MINORS = ROOT / "data" / "minors.json"
CODE_RE = re.compile(r"^\d{2}\.\d{3}[A-Za-z]?$")
# audit_prereqs.BULLET, the mark starting each <li> of a page's block. Copied,
# not imported: that module pulls in the HTTP stack and bs4 at import time.
BULLET = "\u2022"

# Five, not one and not fifty. One per request is forty round trips for a
# monthly job; a batch big enough to matter is a batch where one malformed reply
# loses every case in it.
BATCH = 5

SYSTEM = """You reconcile a university's mod records against its own web pages.

You are given, per mod, the prerequisite text printed on the page and the
codes the repository record holds. Decide whether the record should change.

A code appearing on a page is NOT automatically a requirement. Pages say things
like "helpful but not required", "recommended", "or equivalent experience", and
name a code inside an example or inside another mod's description. Propose an
edit only when the sentence says the mod requires it.

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
  one level deep. Use it only when the page joins the codes with "or".
- When the page gives each code to a different intake ("For AY2025",
  "For AY2026 and subsequent batches"), a leaf is
  {"code": "10.027", "cohort": ["ay2026"]}. The only cohorts are ay2024
  (AY2024 and every earlier batch), ay2025 and ay2026 (AY2026 onwards). If
  `record_prereq_tree` already scopes leaves by cohort, your tree must too.
- Page text marks each bullet of a list with •. A sentence in one bullet says
  nothing about a code in another: "• 50.004 Algorithms • 50.012 Networks are
  helpful but not required" requires 50.004 and disowns only 50.012.
- When the page says the mod needs nothing ("None", or every code the record
  holds is "helpful but not required" in its own bullet), `value` is [] for
  prerequisites, and `quote` is the sentence that says so.
- `quote` MUST be copied character for character from the page text you were
  given for that mod. If you cannot quote the page, put the mod in
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

# The phrases a SUTD page uses to name a mod and then disown it. A quote
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
      mods it disowns.

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
    return {p.stem.replace("_", ".") for p in MODS.glob("*.json")}


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
                # The tree itself, not a flag: a model told only that a tree
                # exists proposes a flat list over 50.001's cohort scoping.
                "record_prereq_tree": load_record(r["code"]).get("prereqTree"),
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
    # every mod in the list is required; append one and it silently becomes
    # "choose count of len+1", so a student may now skip a mod the page says
    # they must take. minor-aai's first group is count 1 over ["10.022"], a
    # single mandatory mod, and 16 of the 37 groups in data/minors.json have
    # this shape. Whether a new code is also mandatory (count goes up) or an
    # alternative (count stays) is exactly the thing the page rarely says, so it
    # is refused and reported rather than guessed.
    group = reqs[idx]
    if group.get("count") == len(group.get("anyOf") or []):
        return False, (f"group {idx} on {mid} is all-mandatory "
                       f"(count {group.get('count')} of {len(group.get('anyOf') or [])}); "
                       "adding to it would turn a required mod into a choice")
    if not isinstance(add, list) or not add or not all(isinstance(c, str) for c in add):
        return False, "add must be a non-empty list of mod codes"
    for c in add:
        if not CODE_RE.match(c):
            return False, f"{c!r} is not a mod code"
        if c not in codes:
            return False, f"{c} has no record in data/mods"
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
    path = MODS / f"{code.replace('.', '_')}.json"
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


COHORTS = {"ay2024", "ay2025", "ay2026"}
LEAF_KEYS = {"code", "cohort", "name"}

# What a page prints when the mod needs nothing at all. Clearing a field is the
# one edit a hedge SUPPORTS: 50.037 names five mods and calls every one
# "helpful but not required", so its record's two prerequisites are wrong.
NONE_RE = re.compile(r"\bnone\b|\bnil\b|\bno pre-?requisites?\b")


def leaf_problem(leaf: object, codes: set[str]) -> str:
    """Empty when a proposed prereqTree leaf is a code or a cohort-scoped code."""
    if isinstance(leaf, str):
        code = leaf
    elif isinstance(leaf, dict):
        if set(leaf) - LEAF_KEYS or "code" not in leaf:
            return (f"leaf {json.dumps(leaf, ensure_ascii=False)} is not a code or "
                    "{code, cohort}: a nested group is a human's edit")
        cohort = leaf.get("cohort")
        if cohort is not None and (not isinstance(cohort, list) or not cohort
                                   or set(map(str, cohort)) - COHORTS):
            return f"cohort {cohort!r} is not a list drawn from {sorted(COHORTS)}"
        code = leaf["code"]
    else:
        return f"leaf {leaf!r} is not a code"
    if not isinstance(code, str) or not CODE_RE.match(code):
        return f"{code!r} is not a mod code"
    if code not in codes:
        return f"{code} has no record in data/mods"
    return ""


def leaf_code(leaf: object) -> str:
    return leaf if isinstance(leaf, str) else str(leaf.get("code", ""))


def is_scoped(leaf: object) -> bool:
    return isinstance(leaf, dict) and bool(leaf.get("cohort"))


def validate(edit: dict, by_code: dict[str, dict], codes: set[str],
             record: dict | None = None) -> tuple[bool, str]:
    """`record` is the mod as it stands; the self-check passes a fixture so its
    cases do not change verdict when /data does."""
    code = str(edit.get("code", ""))
    field = str(edit.get("field", ""))
    value = edit.get("value")
    quote = str(edit.get("quote", ""))

    if code not in codes:
        return False, f"no record for {code!r}"
    if code not in by_code:
        return False, f"{code} was not one of the mods reported to the model"
    if field not in FIELDS:
        return False, f"field {field!r} is not one of {sorted(FIELDS)}"
    if record is None:
        record = load_record(code)
    page = by_code[code].get("listed", "")

    if field != "prereqTree" and value == []:
        return validate_clear(code, field, quote, record, page)

    if field == "prereqTree":
        if not isinstance(value, dict) or len(value) != 1 or set(value) - {"and", "or"}:
            return False, "prereqTree must be a single {'and': [...]} or {'or': [...]}"
        items = next(iter(value.values()))
        if not isinstance(items, list) or not items:
            return False, "prereqTree must hold at least one leaf"
        for leaf in items:
            problem = leaf_problem(leaf, codes)
            if problem:
                return False, problem
        current = top_level(record.get("prereqTree"))
        # A NESTED GROUP CANNOT BE REPLACED BY ONE LEVEL. 50.055's
        # {"and": ["50.007", {"or": ["50.039", "60.001"]}]} under a flat
        # {"or": [...]} would let 50.039 alone satisfy a prerequisite that also
        # needs 50.007. TOP LEVEL ONLY: flatten_tree recurses through and/or and
        # would hand back three plain strings, hiding the group this looks for.
        if any(isinstance(x, dict) and set(x) & {"and", "or", "nOf"} for x in current):
            return False, ("the record's prereqTree nests a group inside it "
                           f"({json.dumps(record.get('prereqTree'), ensure_ascii=False)}); "
                           "a one-level tree would delete it, so this is a human's edit")
        # A FLAT TREE CANNOT SAY WHAT A SCOPED ONE SAYS. 50.001 gives AY2024
        # 10.014 and AY2026 10.027; {"or": ["10.014", "10.025", "10.027"]} over
        # that lets every student satisfy it with any of the three, which is
        # what the scoping exists to prevent. A scoped proposal is fine: the
        # page names the batch beside each code, and the quote has to carry it.
        if any(is_scoped(x) for x in current) and not any(is_scoped(x) for x in items):
            return False, ("the record scopes leaves by cohort and the proposal does not, "
                           "so every intake could take any of the codes")
        listed = [leaf_code(x) for x in items]
    else:
        listed = value
        if not isinstance(listed, list) or not all(isinstance(c, str) for c in listed):
            return False, "value must be a list of mod codes"
        for c in listed:
            problem = leaf_problem(c, codes)
            if problem:
                return False, problem
    if code in listed:
        return False, "a mod cannot be its own prerequisite"

    thin = quote_is_substantial(quote) or quote_supports(quote, list(listed))
    if thin:
        return False, thin
    if norm(quote) not in norm(page):
        return False, "quote is not in the page text this mod was reported with"
    return True, ""


def validate_clear(code: str, field: str, quote: str, record: dict,
                   page: str) -> tuple[bool, str]:
    """An empty list: the page has to SAY the mod needs nothing.

    The quote must disown, by a hedge or a "None", and when it disowns by hedge
    it must name every code it takes away. "helpful but not required" on its own
    could be about one mod of three.
    """
    current = [c for c in record.get(field) or [] if isinstance(c, str)]
    if not current:
        return False, f"{field} is already empty"
    thin = quote_is_substantial(quote)
    if thin:
        return False, thin
    q = norm(quote)
    says_none = bool(NONE_RE.search(q))
    if not says_none and not any(h in q for h in HEDGES):
        return False, "an empty list needs a quote saying the mod requires nothing"
    missing = [c for c in current if c.lower() not in q]
    if missing and not says_none:
        return False, f"quote does not disown {', '.join(missing)}"
    if not says_none:
        kept = [c for c in current if not hedged_in_own_bullet(c, page)]
        if kept:
            return False, (f"{', '.join(kept)} sits in a bullet with no hedge; the hedge "
                           "is in another bullet and disowns only that one")
    if q not in norm(page):
        return False, "quote is not in the page text this mod was reported with"
    return True, ""


def hedged_in_own_bullet(code: str, page: str) -> bool:
    """True when some bullet of the page names `code` AND disowns it.

    audit_prereqs.py starts each <li> with BULLET. On 50.037 the hedge closes
    the third bullet, so 50.004 and 50.005 in the first two stay required
    however a quote spanning all three is cut. Prose with no bullets is one
    segment, which is the old reading.
    """
    for part in norm(page).split(BULLET):
        if code.lower() in part and any(h in part for h in HEDGES):
            return True
    return False


def applied(record: dict, edit: dict) -> dict:
    """The record after the edit, without touching a file.

    Two fields describe one requirement, so an edit to either moves both:
    cleared prerequisites take the tree with them, or the tree keeps gating a
    mod the page says needs nothing; a tree rewrites `prerequisites` to its
    codes, the way the hand-written records list every code an "or" names. A
    leaf the model left unnamed takes the name its own record carries, as every
    hand-written scoped leaf does.
    """
    d = dict(record)
    field, value = edit["field"], edit["value"]
    if field == "prereqTree":
        op, items = next(iter(value.items()))
        leaves = []
        for leaf in items:
            if isinstance(leaf, dict) and "name" not in leaf:
                name = load_record(leaf["code"]).get("name")
                leaf = {"code": leaf["code"], **({"name": name} if name else {}),
                        **{k: v for k, v in leaf.items() if k != "code"}}
            leaves.append(leaf)
        d["prereqTree"] = {op: leaves}
        d["prerequisites"] = list(dict.fromkeys(leaf_code(x) for x in leaves))
    else:
        d[field] = value
        if field == "prerequisites" and value == []:
            d.pop("prereqTree", None)
    return d


def apply(edit: dict, dry_run: bool) -> str:
    path = MODS / f"{edit['code'].replace('.', '_')}.json"
    d = json.loads(path.read_text(encoding="utf-8"))
    new = applied(d, edit)
    if new == d:
        return "already matched"
    if dry_run:
        return "would write"
    path.write_text(json.dumps(new, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return "written"


def verdicts(skipped: list, sent: list[str], answered: set[str],
             unanswered: set[str], key: str) -> list[dict]:
    """One verdict per record, checked against the records actually sent.

    A model's `skipped` list is its own say-so. Printed as it came, it can
    repeat one id and leave another out, and a reader counting one verdict per
    record cannot tell that a record went unread. So an id is
    printed once, an id that was never sent is shown as such, and a record
    that was sent and drew neither an edit nor a skip is listed as having no
    verdict rather than left out.
    """
    out: list[dict] = []
    seen: set[str] = set()
    for s in skipped:
        if not isinstance(s, dict):
            continue
        rid = str(s.get(key, "")).strip()
        if not rid or rid in seen:
            continue
        seen.add(rid)
        out.append({"id": rid, "why": str(s.get("why", "")).strip(),
                    "status": "left alone" if rid in sent else "not sent to the model"})
    for rid in sent:
        if rid in seen or rid in answered:
            continue
        out.append({"id": rid, "why": "",
                    "status": "no provider answered" if rid in unanswered else "no verdict"})
    return out


# Not "read and left alone": in a provider outage every row here is "no
# provider answered", and that heading said a model read records none saw.
VERDICT_HEADING = "changed nothing (the verdict says whether a model read it):"


def verdict_table(rows: list[dict], label: str) -> list[str]:
    if not rows:
        return []
    out = [VERDICT_HEADING, "", f"| {label} | verdict | why |", "|---|---|---|"]
    out += [f"| {v['id']} | {v['status']} | {v['why'] or '-'} |" for v in rows]
    return out + [""]


def emit(report: list[str], out: str, json_out: str = "", summary: dict | None = None) -> int:
    text = "\n".join(report)
    if out:
        pathlib.Path(out).write_text(text, encoding="utf-8")
    # The PR body is assembled from this, not from the markdown above, so
    # mods_refresh.py never has to parse a table this file happened to print.
    if json_out:
        pathlib.Path(json_out).write_text(
            json.dumps(summary or {}, indent=1, ensure_ascii=False), encoding="utf-8")
    print(text)
    return 0


# (edit, should_pass). The validator is the only thing standing between a model
# and /data, so it gets checked without a network call or a test framework:
# `python propose_edits.py --self-check`.
# The page sentences are the live pages' own, so the accepted cases are the
# edits the November refresh should have been allowed to make.
QUOTE_001 = ("10.014 Computational Thinking for Design (For AY2020 to AY2024) or 10.025 "
             "Computational Thinking for Design (For AY2025) or 10.027 Algorithmic Thinking "
             "and Object-Based Abstraction (For AY2026 and subsequent batches)")
SCOPED_001 = {"or": [{"code": "10.014", "cohort": ["ay2024"]},
                     {"code": "10.025", "cohort": ["ay2025"]},
                     {"code": "10.027", "cohort": ["ay2026"]}]}
# 50.037's block as audit_prereqs.py reads it. 50.004 and 50.005 are bullets
# of their own; only the third bullet is helpful but not required.
PAGE_037 = ("The course assumes a basic familiarity with computer programming and "
            "knowledge of the Python language. \u2022 50.004 Algorithms \u2022 50.005 "
            "Computer System Engineering \u2022 50.012 Networks , 50.020 Security , and "
            "50.043 Database Systems are helpful but not required.")
SPAN_037 = ("\u2022 50.004 Algorithms \u2022 50.005 Computer System Engineering \u2022 "
            "50.012 Networks , 50.020 Security , and 50.043 Database Systems are "
            "helpful but not required")
# A page that really disowns both, in one bullet. Its own record, 50.038,
# so it cannot lend 50.037's block the hedge that block lacks.
CLEAR_038 = ("\u2022 50.004 Algorithms and 50.005 Computer System Engineering are "
             "helpful but not required")
# The records as they stood, so a case keeps its verdict after /data moves on.
FIXTURE_RECORDS = {
    "50.037": {"prerequisites": ["50.004", "50.005"]},
    "50.038": {"prerequisites": ["50.004", "50.005"]},
    "50.001": {"prerequisites": ["10.014", "10.025"],
               "prereqTree": {"or": [{"code": "10.014", "cohort": ["ay2024"]},
                                     {"code": "10.025", "cohort": ["ay2025", "ay2026"]}]}},
    "50.055": {"prerequisites": ["50.007", "50.039", "60.001"],
               "prereqTree": {"and": ["50.007", {"or": ["50.039", "60.001"]}]}},
}
SELF_CHECK: list[tuple[dict, bool]] = [
    # WAS True. A quote saying "helpful but not required" is evidence AGAINST
    # the edit, and this table asserting otherwise is how the hole stayed open.
    ({"code": "50.037", "field": "prerequisites", "value": ["50.004"],
      "quote": "These mods are helpful but not required"}, False),
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
      "quote": "These mods are helpful but not required"}, False),
    ({"code": "50.037", "field": "description", "value": ["50.004"],
      "quote": "These mods are helpful but not required"}, False),
    ({"code": "50.037", "field": "prerequisites", "value": ["50.037"],
      "quote": "These mods are helpful but not required"}, False),
    # disowns, but names neither of the two codes it would take away
    ({"code": "50.037", "field": "prerequisites", "value": [],
      "quote": "These mods are helpful but not required"}, False),
    # 50.037's real block, quoted across its bullets: the hedge is in the
    # third, so 50.004 and 50.005 stay
    ({"code": "50.037", "field": "prerequisites", "value": [],
      "quote": SPAN_037}, False),
    ({"code": "50.038", "field": "prerequisites", "value": [],
      "quote": CLEAR_038}, True),
    # The page disowns both in-bullet, but the QUOTE has to carry the evidence:
    # one naming neither code, and one naming both with no hedge, are refused.
    ({"code": "50.038", "field": "prerequisites", "value": [],
      "quote": "Computer System Engineering are helpful but not required"}, False),
    ({"code": "50.038", "field": "prerequisites", "value": [],
      "quote": "50.004 Algorithms and 50.005 Computer System Engineering"}, False),
    # disowns one of the two the record holds
    ({"code": "50.037", "field": "prerequisites", "value": [],
      "quote": "50.012 Networks is helpful but not required for this"}, False),
    # names the codes and REQUIRES them: no ground for clearing
    ({"code": "50.037", "field": "prerequisites", "value": [],
      "quote": "Students must have completed 50.004 and 50.005 first"}, False),
    ({"code": "50.037", "field": "prerequisites", "value": [],
      "quote": "Prerequisite: None, open to every student."}, True),
    ({"code": "50.037", "field": "prereqTree", "value": {"or": ["50.004"]},
      "quote": "Students must have completed 50.004 before taking this"}, True),
    ({"code": "50.037", "field": "prereqTree", "value": {"or": ["50.004"], "and": ["50.005"]},
      "quote": "These mods are helpful but not required"}, False),
    # 50.001's real tree is cohort-scoped, so a flat list may not replace it
    ({"code": "50.001", "field": "prereqTree", "value": {"or": ["10.014", "10.025"]},
      "quote": "Students must have completed 10.014 or 10.025 first"}, False),
    ({"code": "50.001", "field": "prereqTree", "value": {"or": ["10.014", "10.025", "10.027"]},
      "quote": QUOTE_001}, False),
    # the same three codes, each with the intake the page gives it
    ({"code": "50.001", "field": "prereqTree", "value": SCOPED_001, "quote": QUOTE_001}, True),
    ({"code": "50.001", "field": "prereqTree",
      "value": {"or": [{"code": "10.014", "cohort": ["ay2020"]}, "10.027"]},
      "quote": QUOTE_001}, False),
    ({"code": "50.001", "field": "prereqTree",
      "value": {"or": [{"code": "10.014", "cohort": ["ay2024"], "or": ["10.025"]}, "10.027"]},
      "quote": QUOTE_001}, False),
    ({"code": "00.000", "field": "prerequisites", "value": ["50.004"],
      "quote": "These mods are helpful but not required"}, False),
]


# The same, for minors. A group index is the part a model gets wrong quietly:
# an off-by-one puts a core mod into the electives list and the diff looks
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
        # One bullet per sentence, so no hedge shares a bullet with a code it
        # does not disown, and the real block after them.
        "50.037": {"listed": " \u2022 ".join([
            "Students must have completed 50.004 before taking this.",
            "50.012 Networks is helpful but not required for this.",
            "50.012 Networks , 50.020 Security , and more.",
            "These mods are   HELPFUL but not required for 50.037.",
            "Prerequisite: None, open to every student.",
            "Students must have completed 50.004 and 50.005 first.",
        ]) + " " + PAGE_037},
        "50.038": {"listed": CLEAR_038},
        "50.001": {"listed": "Students must have completed 10.014 or 10.025 first. " + QUOTE_001},
        "50.055": {"listed": "Students must have completed 50.007 and 50.039 first."},
    }
    for edit, want in SELF_CHECK:
        got, why = validate(edit, by_code, codes, FIXTURE_RECORDS.get(str(edit.get("code")), {}))
        if got != want:
            bad += 1
            print(f"FAIL {edit} -> {got} ({why or 'accepted'}), wanted {want}")

    # What an accepted edit writes. Each check is one half of a pair the
    # validator cannot see: the field the edit names, and the one beside it.
    acases = 3
    cleared = applied(dict(FIXTURE_RECORDS["50.055"]),
                      {"field": "prerequisites", "value": []})
    if "prereqTree" in cleared:
        bad += 1
        print("FAIL clearing prerequisites left the prereqTree gating the mod")
    tree = applied(dict(FIXTURE_RECORDS["50.001"]), {"field": "prereqTree", "value": SCOPED_001})
    if tree["prerequisites"] != ["10.014", "10.025", "10.027"]:
        bad += 1
        print(f"FAIL a new tree left prerequisites at {tree['prerequisites']}")
    if not all(leaf.get("name") for leaf in tree["prereqTree"]["or"]):
        bad += 1
        print(f"FAIL a scoped leaf was written without its name: {tree['prereqTree']}")

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

    # The shape a real refresh returned: one id repeated, one sent id never
    # answered, plus an id nobody sent.
    got = verdicts(
        [{"minor": "minor-ai", "why": "a"}, {"minor": "minor-ai", "why": "a"},
         {"minor": "minor-dai", "why": "b"}, {"minor": "minor-zz", "why": "c"}],
        ["minor-aai", "minor-ai", "minor-dai", "minor-hcd"], set(), {"minor-hcd"}, "minor")
    want = [("minor-ai", "left alone"), ("minor-dai", "left alone"),
            ("minor-zz", "not sent to the model"), ("minor-aai", "no verdict"),
            ("minor-hcd", "no provider answered")]
    vcases = 1
    if [(v["id"], v["status"]) for v in got] != want:
        bad += 1
        print(f"FAIL verdicts -> {[(v['id'], v['status']) for v in got]}, wanted {want}")
    # an id that drew an edit has its verdict in the edit, not here
    vcases += 1
    if verdicts([], ["50.037"], {"50.037"}, set(), "code"):
        bad += 1
        print("FAIL verdicts listed 50.037 as unanswered though it drew an edit")

    # the heading must not claim a read the rows deny
    vcases += 1
    outage = verdict_table([{"id": "50.037", "status": "no provider answered", "why": ""}], "mod")
    if "read" in outage[0] and "left alone" in outage[0]:
        bad += 1
        print(f"FAIL verdict_table heads an outage with {outage[0]!r}")

    total = len(SELF_CHECK) + len(SELF_CHECK_MINORS) + vcases + acases
    print(f"{total - bad}/{total} validator cases ok")
    return 1 if bad else 0


def section(accepted, rejected, judged, providers) -> dict:
    return {
        "accepted": [dict(e, outcome=o) for e, o in accepted],
        "rejected": [{"edit": e, "why": w} for e, w in rejected],
        "verdicts": judged,
        "providers": sorted(providers),
    }


def run_prereqs(path, report, args, codes):
    """Mod records against their own pages. Returns (accepted, summary dict)."""
    rows = candidates(json.loads(pathlib.Path(path).read_text(encoding="utf-8")))
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        report += ["### prerequisites", "",
                   "Nothing to propose: no mod record disagrees with its page.", ""]
        return [], section([], [], [], set())

    by_code = {r["code"]: r for r in rows}
    accepted, rejected, skipped, providers = [], [], [], set()
    answered, unanswered = set(), set()
    for i in range(0, len(rows), BATCH):
        batch = rows[i : i + BATCH]
        answer = llm.chat(SYSTEM, payload(batch), timeout=120.0)
        if answer is None:
            # One batch failing is not the run failing. The others still have
            # their evidence, and a partial set of proposals is reviewable.
            # verdicts() names each of these mods, under its own heading.
            unanswered |= {r["code"] for r in batch}
            continue
        provider, parsed = answer
        providers.add(provider)
        for edit in parsed.get("edits") or []:
            answered.add(str(edit.get("code", "")))
            ok, why = validate(edit, by_code, codes)
            # Read before apply() rewrites it. A proposal shown without the
            # value it would replace cannot be judged without opening the file.
            edit = dict(edit, was=load_record(str(edit.get("code", ""))).get(str(edit.get("field", ""))))
            if ok:
                accepted.append((edit, apply(edit, args.dry_run)))
            else:
                rejected.append((edit, why))
        skipped += parsed.get("skipped") or []
    judged = verdicts(skipped, list(by_code), answered, unanswered, "code")

    report += ["### prerequisites", "",
               f"{len(rows)} mod record(s) disagreed with their page.", ""]
    for edit, outcome in accepted:
        report += [
            f"**{edit['code']}** `{edit['field']}`: "
            f"`{json.dumps(edit.get('was'), ensure_ascii=False)}` -> "
            f"`{json.dumps(edit['value'], ensure_ascii=False)}` ({outcome})",
            "", f"> {str(edit.get('quote', '')).strip()}",
            "", str(edit.get("why", "")).strip(), "",
        ]
    if rejected:
        report += ["dropped by validation:", "",
                   "| mod | field | record now | proposed | why |", "|---|---|---|---|---|"]
        report += [f"| {e.get('code', '?')} | {e.get('field', '?')} "
                   f"| `{json.dumps(e.get('was'), ensure_ascii=False)}` "
                   f"| `{json.dumps(e.get('value'), ensure_ascii=False)}` | {why} |"
                   for e, why in rejected]
        report.append("")
    report += verdict_table(judged, "mod")
    return accepted, section(accepted, rejected, judged, providers)


def run_minors(path, report, args, codes):
    """Minor requirement groups against their own pages."""
    rows = minor_candidates(json.loads(pathlib.Path(path).read_text(encoding="utf-8")))
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        report += ["### minors", "",
                   "Nothing to propose: no minor page names a code its record lacks.", ""]
        return [], section([], [], [], set())

    book = json.loads(MINORS.read_text(encoding="utf-8"))
    book_ids = {m.get("id"): m for m in book.get("minors") or []}
    by_id = {r["id"]: r for r in rows}
    accepted, rejected, skipped, providers = [], [], [], set()
    answered, unanswered = set(), set()

    for i in range(0, len(rows), BATCH):
        batch = rows[i : i + BATCH]
        answer = llm.chat(MINOR_SYSTEM, minor_payload(batch, book), timeout=120.0)
        if answer is None:
            unanswered |= {r["id"] for r in batch}
            continue
        provider, parsed = answer
        providers.add(provider)
        for edit in parsed.get("edits") or []:
            answered.add(str(edit.get("minor", "")))
            ok, why = validate_minor(edit, by_id, book_ids, codes)
            if ok:
                accepted.append((edit, "would write" if args.dry_run else apply_minor(edit, book)))
            else:
                rejected.append((edit, why))
        skipped += parsed.get("skipped") or []
    judged = verdicts(skipped, list(by_id), answered, unanswered, "minor")

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
    report += verdict_table(judged, "minor")
    return accepted, section(accepted, rejected, judged, providers)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--self-check", action="store_true",
                    help="run the validators against known-good and known-bad edits")
    ap.add_argument("--prereqs", help="audit_prereqs.py --json output")
    ap.add_argument("--minors", help="gather_minors.py --json output")
    ap.add_argument("--report-out", default="")
    ap.add_argument("--json-out", default="",
                    help="the same findings as JSON, which is what the refresh PR body reads")
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
        ], args.report_out, args.json_out, {"configured": False})

    codes = known_codes()
    accepted, providers = [], set()
    summary: dict = {"configured": True}
    for name, flag, runner in (("prereqs", args.prereqs, run_prereqs),
                               ("minors", args.minors, run_minors)):
        if flag and pathlib.Path(flag).exists():
            a, part = runner(flag, report, args, codes)
            accepted += a
            providers |= set(part["providers"])
            summary[name] = part

    report[1:1] = ["", f"Read by {', '.join(sorted(providers)) or 'nothing'}."]
    if accepted:
        report += [
            "Each edit above is a proposal a model made from the page text, checked "
            "against that text before it was written. Read the quote before merging: "
            "it is copied from the page, and the page is what the record has to "
            "match.", "",
        ]
    summary["providers"] = sorted(providers)
    return emit(report, args.report_out, args.json_out, summary)



if __name__ == "__main__":
    raise SystemExit(main())
