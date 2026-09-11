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

Minors are reported and never proposed. `data/minors.json` states requirements
as prose the repo expands by hand, so there is no single field to replace and
the report is the deliverable.
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

    if not quote:
        return False, "no quote"
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
    ({"code": "50.037", "field": "prerequisites", "value": ["50.004"],
      "quote": "helpful but not required"}, True),
    ({"code": "50.037", "field": "prerequisites", "value": ["50.004"],
      "quote": "this sentence is not on the page"}, False),
    ({"code": "50.037", "field": "prerequisites", "value": ["99.123"],
      "quote": "helpful but not required"}, False),
    ({"code": "50.037", "field": "description", "value": ["50.004"],
      "quote": "helpful but not required"}, False),
    ({"code": "50.037", "field": "prerequisites", "value": ["50.037"],
      "quote": "helpful but not required"}, False),
    ({"code": "50.037", "field": "prerequisites", "value": [],
      "quote": "helpful but not required"}, False),
    ({"code": "50.037", "field": "prereqTree", "value": {"or": ["50.004"]},
      "quote": "helpful but not required"}, True),
    ({"code": "50.037", "field": "prereqTree", "value": {"or": ["50.004"], "and": ["50.005"]},
      "quote": "helpful but not required"}, False),
    ({"code": "00.000", "field": "prerequisites", "value": ["50.004"],
      "quote": "helpful but not required"}, False),
]


def self_check() -> int:
    by_code = {"50.037": {"listed": "These courses are   HELPFUL but not required for 50.037."}}
    codes = known_codes()
    bad = 0
    for edit, want in SELF_CHECK:
        got, why = validate(edit, by_code, codes)
        if got != want:
            bad += 1
            print(f"FAIL {edit} -> {got} ({why or 'accepted'}), wanted {want}")
    print(f"{len(SELF_CHECK) - bad}/{len(SELF_CHECK)} validator cases ok")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--self-check", action="store_true",
                    help="run the validator against known-good and known-bad edits")
    ap.add_argument("--prereqs", help="audit_prereqs.py --json output")
    ap.add_argument("--minors", help="gather_minors.py --json output, reported not proposed")
    ap.add_argument("--report-out", default="")
    ap.add_argument("--dry-run", action="store_true", help="decide, write nothing")
    ap.add_argument("--limit", type=int, default=0, help="candidates, not requests")
    args = ap.parse_args()

    if args.self_check:
        return self_check()

    report = ["## proposed edits", ""]

    if not llm.configured():
        return emit(
            report
            + [
                "No model token is set, so nothing was proposed. The drift reports "
                "above still say what changed, and applying them stays a human job "
                "until one of `GEMINI_TOKEN`, `GROQ_TOKEN` or `OPENAI_TOKEN` exists. "
                "`.env.example` says where each goes.",
                "",
            ],
            args.report_out,
        )

    rows: list[dict] = []
    if args.prereqs and pathlib.Path(args.prereqs).exists():
        rows = candidates(json.loads(pathlib.Path(args.prereqs).read_text(encoding="utf-8")))
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        return emit(
            report + ["Nothing to propose: no course record disagrees with its page.", ""],
            args.report_out,
        )

    by_code = {r["code"]: r for r in rows}
    codes = known_codes()

    accepted: list[tuple[dict, str]] = []
    rejected: list[tuple[dict, str]] = []
    skipped: list[dict] = []
    providers: set[str] = set()

    for i in range(0, len(rows), BATCH):
        batch = rows[i : i + BATCH]
        answer = llm.chat(SYSTEM, payload(batch), timeout=120.0)
        if answer is None:
            # One batch failing is not the run failing. The others still have
            # their evidence, and a partial set of proposals is reviewable.
            report.append(
                f"- no provider answered for {', '.join(r['code'] for r in batch)}"
            )
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

    report[1:1] = [
        "",
        f"{len(rows)} course record(s) disagreed with their page. "
        f"Read by {', '.join(sorted(providers)) or 'nothing'}.",
    ]

    if accepted:
        report += ["", "### applied", ""]
        for edit, outcome in accepted:
            report += [
                f"**{edit['code']}** `{edit['field']}` -> "
                f"`{json.dumps(edit['value'], ensure_ascii=False)}` ({outcome})",
                "",
                f"> {str(edit.get('quote', '')).strip()}",
                "",
                str(edit.get("why", "")).strip(),
                "",
            ]
    if rejected:
        report += ["### dropped by validation", "", "| course | field | why |", "|---|---|---|"]
        report += [
            f"| {e.get('code', '?')} | {e.get('field', '?')} | {why} |" for e, why in rejected
        ]
        report.append("")
    if skipped:
        report += ["### read and left alone", "", "| course | why |", "|---|---|"]
        report += [f"| {s.get('code', '?')} | {str(s.get('why', '')).strip()} |" for s in skipped[:40]]
        report.append("")

    if accepted:
        report += [
            "Each edit above is a proposal a model made from the page text, checked "
            "against that text before it was written. Read the quote before merging: "
            "it is copied from the page, and the page is what the record has to "
            "match.",
            "",
        ]
    return emit(report, args.report_out)


if __name__ == "__main__":
    raise SystemExit(main())
