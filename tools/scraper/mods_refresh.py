#!/usr/bin/env python3
"""Everything a mod record is made of, refreshed in one run.

    python tools/scraper/mods_refresh.py              # refresh, then report
    python tools/scraper/mods_refresh.py --dry-run    # report, write nothing
    python tools/scraper/mods_refresh.py --only mods,tracks
    python tools/scraper/mods_refresh.py --body-out body.md   # also write the PR body
    python tools/scraper/mods_refresh.py --self-check         # no network

WHY THIS EXISTS
The pieces of a mod are refreshed by separate scripts, and the monthly job
called two of them. The walk over all 389 mod pages, the one that finds new
mods, tags, descriptions and source URLs, was a command a maintainer had to
remember, and a scheduled job is the only thing here that gets remembered. One
entry point, so "refresh the mods" is one thing to schedule.

It ORCHESTRATES rather than merges: each parser stays in its own file, because
they break independently when SUTD redesigns one page and not another, and a
single 2000-line script would make that one failure look like five.

EVERY STEP IS ISOLATED. One SUTD page being redesigned must not stop the
term dates being read, so a step that raises is recorded and the rest continue.
The exit code is 1 only if EVERY step failed, which means the network or the
environment rather than one page.

WAVES, NOT A QUEUE. Most of the wall clock is waiting on sutd.edu.sg, so steps
that touch different files run together. What forces an order is only ever a
shared file:
  wave 1  mods, tracks, minors, terms         - four different outputs
  wave 2  hass                                - writes data/mods too, so
                                                it must not race mods
  wave 3  cores                               - writes data/mods as well
  wave 4  prereqs                             - reads what the three above wrote

STEP NAMES. Five of the six steps read www.sutd.edu.sg, so a name after the
host tells a reader nothing. They are named after what they produce instead,
except `hass`, which is the one on another host.

`mods` and `prereqs` read the SAME 389 mod pages; the difference is that one
writes records and the other reports on them. That pair is the reason the naming
is worth caring about.

THE PR BODY is built here, by build_body(), and the workflow only pastes it.
It is built from the steps' JSON and their own summary lines, never from a tail
of their output, in the order a reviewer acts: what changed in /data, what
needs a decision, what was checked and was fine, and only then the model's
non-verdicts and the raw output, folded. The whole order and why is in
docs/scraper.md.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

# Machine-readable step output, gitignored. The reports write here so the
# proposal step can read them without either one parsing the other's prose.
SCRATCH = HERE / ".reports"
RENAMES = SCRATCH / "renames.json"
# gather_mods.py's own markdown of the re-titles and term moves a reviewer
# decides on, pasted as it stands.
REVIEW = SCRATCH / "mods-review.md"
PROPOSED = SCRATCH / "proposed.json"
CHANGES = SCRATCH / "changes.md"

# The one tracked artefact. Written only when a report has something to act on
# and deleted when it does not, so its own diff is what opens the monthly pull
# request: a month with the same drift as the last produces no file change and
# no PR, which is the honest signal. A timestamp in here would open one every
# month and teach the reviewer to skim.
DRIFT = ROOT / "tools" / "scraper" / "reports" / "drift.md"

# GitHub refuses a pull request body over this many characters, and
# create-pull-request fails the job rather than trimming it.
BODY_LIMIT = 65536

# (name, argv, what it does). This list is not the order - WAVES is.
STEPS: list[tuple[str, list[str], str]] = [
    (
        "mods",
        ["gather_mods.py", "--review-out", str(SCRATCH / "mods-review.md")],
        "every mod on sutd.edu.sg, walked from the two mod sitemaps: new "
        "mods, tags, descriptions, source URLs, grading and workload",
    ),
    (
        "hass",
        ["scrape.py"],
        "hass.sutd.edu.sg's freshmore and elective subject listings. The only "
        "step on a host other than www.sutd.edu.sg",
    ),
    (
        "tracks",
        ["gather_specialisations.py"],
        "specialisation-track criteria -> data/specializations.json",
    ),
    (
        "terms",
        ["gather_terms.py"],
        "term dates from sutd.edu.sg's academic calendar, plus the Singapore "
        "public holidays inside each term from data.gov.sg "
        "-> data/term-calendar.json",
    ),
    (
        "canaries",
        ["canaries.py"],
        "the SUTD hosts nothing else in this run fetches. Every other step is "
        "a canary for its own host and fails loudly when it goes; this covers "
        "what is left, which is virtualtour.sutd.edu.sg - asked for every tile "
        "data/venues names, not its front page. REPORTS ONLY, and never fails "
        "the run",
    ),
    (
        "minors",
        ["gather_minors.py", "--json", str(SCRATCH / "minors.json")],
        "each minor against its own page. REPORTS ONLY - the requirements are "
        "prose, and the repo expands 'any HASS elective' into a real list",
    ),
    (
        "cores",
        ["gather_cores.py"],
        "every core mod -> noBatchChat, because a chat for a mod "
        "everybody takes has the same membership as the cohort chat they "
        "already have. Two halves: each pillar's own core read off its "
        "published listing, and anything the catalogue already tags Freshmore "
        "Core or Core. Runs AFTER `mods`, so a mod added in this same run "
        "is flagged in this same run",
    ),
    (
        "prereqs",
        ["audit_prereqs.py", "--json", str(SCRATCH / "prereqs.json")],
        "prerequisites against each mod's own page. Reports; `propose` is what "
        "acts on it",
    ),
    (
        "propose",
        [
            "propose_edits.py",
            "--prereqs", str(SCRATCH / "prereqs.json"),
            "--minors", str(SCRATCH / "minors.json"),
            "--report-out", str(SCRATCH / "proposed.md"),
            "--json-out", str(PROPOSED),
        ],
        "reads the two reports with a model and edits data/mods where the "
        "page supports it. Every proposal is validated against the quoted page "
        "text before it is written",
    ),
]

# Steps in the same wave run together; a wave finishes before the next starts.
WAVES: list[list[str]] = [
    ["mods", "tracks", "minors", "terms", "canaries"],
    ["hass"],
    # Its own wave, and it has to be AFTER `mods`: that is the step that
    # creates a record for a mod SUTD has just added, and this is the step
    # that decides whether the new mod gets a batch chat. Before it, a new
    # core would go a month offering one.
    #
    # It writes data/mods, so it cannot run beside `mods` or `hass`, and
    # `prereqs` READS those records so it cannot run beside this.
    ["cores"],
    ["prereqs"],
    ["propose"],
]


# Every script here writes under /data. WRITERS is the subset that accepts
# --dry-run, and the two lists being equal is what the run() check enforces.
WRITES_DATA = {
    "gather_mods.py",
    "gather_cores.py",
    "scrape.py",
    "gather_specialisations.py",
    "gather_terms.py",
    "propose_edits.py",
}


@dataclass
class Step:
    name: str
    ok: bool
    out: str
    err: str
    secs: float


def accepts(script: str, flag: str) -> bool:
    """Whether the script really has `flag`, asked rather than assumed.

    This used to be `WRITERS = WRITES_DATA`, which made the --dry-run check in
    run() a tautology: the same set on both sides of an if/elif means the elif
    can never run, so the guard that was supposed to fail a run rather than
    write could not fire. Reading --help costs one subprocess per writer and is
    the only version that can observe a new writer arriving without the flag.
    The same question decides whether `mods` is asked for its renames file, so
    a gather_mods.py without --renames-out still runs instead of dying on an
    unknown argument.
    """
    try:
        out = subprocess.run(
            [sys.executable, script, "--help"], cwd=HERE, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=60,
        )
    except Exception:  # noqa: BLE001
        return False
    return flag in (out.stdout or "")


# (flag, where it writes). Whichever of these gather_mods.py has, it is asked for.
MODS_REPORTS = (("--renames-out", RENAMES), ("--review-out", REVIEW))


def with_mods_reports(argv: list[str], has_flag) -> list[str]:
    """`mods`'s argv, asking for each report file once and only if it can.

    Asked, not assumed: the flags arrive in their own pull request, and passing
    one to a gather_mods.py without it fails the whole step. Not added when the
    argv already names it, so STEPS carrying it too gives one copy, not two.
    """
    out = list(argv)
    for flag, path in MODS_REPORTS:
        if flag not in out and has_flag(argv[0], flag):
            out += [flag, str(path)]
    return out


def run(script: list[str], dry_run: bool) -> tuple[bool, str, str]:
    """Run one step. Returns (ok, stdout, stderr), both whole.

    Both streams, because the scripts here print their summary to stdout and
    their warnings to stderr: keeping only one, as `stdout or stderr` did, threw
    away every `[!]` line from a step that also printed a summary.
    """
    cmd = [sys.executable, *script]
    # A WRITER THAT CANNOT BE TOLD "DRY" IS NOT RUN. This list used to name
    # three scripts, and the two writers missing from it, gather_terms.py and
    # gather_specialisations.py, rewrote data/term-calendar.json and
    # data/specializations.json on a run documented as writing nothing. A flag
    # that silently writes to the source of truth is worse than no flag.
    #
    # So membership is declared, not inferred: WRITERS is every step that
    # touches /data, and every one of them has to accept --dry-run. Adding a
    # writer without the flag fails the run instead of writing.
    if dry_run:
        if script[0] in WRITES_DATA and accepts(script[0], "--dry-run"):
            cmd.append("--dry-run")
        elif script[0] in WRITES_DATA:
            return False, "", (f"{script[0]} writes to /data and has no --dry-run. "
                               "Add one, or take it out of WRITES_DATA.")
    try:
        p = subprocess.run(
            cmd, cwd=HERE, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=1800,
        )
    except subprocess.TimeoutExpired:
        return False, "", "timed out after 30 minutes"
    return p.returncode == 0, (p.stdout or "").strip(), (p.stderr or "").strip()


def timed(name: str, script: list[str], dry_run: bool) -> Step:
    t0 = time.time()
    ok, out, err = run(script, dry_run)
    return Step(name, ok, out, err, time.time() - t0)


def step_log(s: Step) -> str:
    """A step's whole output, stdout then stderr. Never a tail.

    A tail of the last few lines is how a PR body came to show the renames and
    not the line saying none of them was written, and a minors list that
    started halfway down.
    """
    parts = [s.out] if s.out else []
    if s.err:
        parts.append("--- stderr ---\n" + s.err)
    return "\n".join(parts) or "(no output)"


# Steps whose FINDINGS have no other home. A run that changes no file opens no
# pull request, so what these say would reach a run summary and stop there.
# Everything else in WAVES writes /data and its finding IS the diff.
#
# `propose` is here despite writing, because the half of it worth reading is
# the half that did not: a proposal dropped for failing validation changes no
# file and is exactly what a person needs to see.
REPORTING = ("canaries", "minors", "prereqs", "propose")


def split_sections(text: str) -> dict[str, str]:
    """A drift file back into {step: its whole section}, preamble under "".

    Sections are `## <step>` headings, which is what drift_text emits. A
    heading INSIDE a code fence is a step's own output and not a section:
    propose prints `## proposed edits`, and splitting on it cut the propose
    section in two and filed its tail under a name no step owns, where it was
    carried forward forever.
    """
    out: dict[str, str] = {}
    key = ""
    buf: list[str] = []
    fenced = False
    for line in text.split("\n"):
        if line.startswith("```"):
            fenced = not fenced
        if line.startswith("## ") and not fenced:
            out[key] = "\n".join(buf)
            key = line[3:].strip()
            buf = [line]
        else:
            buf.append(line)
    out[key] = "\n".join(buf)
    return out


DRIFT_HEAD = [
    "# drift",
    "",
    "Written by `tools/scraper/mods_refresh.py`. Do not edit it by hand: the",
    "next refresh overwrites the sections it ran, and deletes the file when",
    "there is nothing left to say. It carries no timestamp on purpose, so a",
    "month that finds the same drift as the last changes no file and opens no",
    "pull request.",
    "",
]


def drift_text(existing: str, ran: list[Step], what: dict[str, str]) -> str | None:
    """The new drift file from the old one and this run, or None to delete it.

    A RUN OWNS ONLY THE SECTIONS IT RAN. `--only propose` used to rewrite the
    whole file from that one step, which deleted the prereq and minor findings
    without looking at them - a green diff saying the drift went away, produced
    by not checking. Sections for steps that did not run this time are carried
    through as they stand.

    Only stdout goes in. stderr carries fetch noise that differs run to run,
    and a section that changes every month opens a PR every month.
    """
    order = {n: i for i, n in enumerate(REPORTING)}
    # A section no step owns is a leftover by definition; nothing will ever
    # rewrite it, so it is dropped rather than carried.
    kept = {k: v for k, v in split_sections(existing).items() if k in order}
    for s in ran:
        if s.name not in order:
            continue
        if not s.ok or not s.out.strip():
            # A step that ran and found nothing retires its section. A step that
            # FAILED keeps whatever it last said, because "the parser broke" is
            # not evidence that the drift it reported is gone.
            if s.ok:
                kept.pop(s.name, None)
            continue
        kept[s.name] = "\n".join(
            [f"## {s.name}", "", what.get(s.name, ""), "", "```", s.out.strip(), "```", ""]
        )
    body = [kept[k] for k in sorted(kept, key=lambda k: order[k]) if kept[k].strip()]
    return "\n".join(DRIFT_HEAD + body) if body else None


def write_drift(results: list[Step], by_name: dict) -> None:
    """The tracked report, or nothing.

    A run that changes no file opens no pull request, and the prereq and minor
    checks change no file by design. Writing what they said into a tracked path
    gives them a diff of their own, so a finding reaches a reviewer instead of
    sitting on a run summary nobody opens.
    """
    if not any(s.name in REPORTING for s in results):
        return
    existing = DRIFT.read_text(encoding="utf-8") if DRIFT.exists() else ""
    text = drift_text(existing, results, {n: v[1] for n, v in by_name.items()})
    DRIFT.parent.mkdir(parents=True, exist_ok=True)
    if text is None:
        DRIFT.unlink(missing_ok=True)
    else:
        DRIFT.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------------------
# The PR body.

# (pattern, template) per step, matched against lines the step itself prints
# as its own summary. Every match is kept, in this order, and joined. A step
# that prints none of them is "ok in Ns": a reworded summary line costs a
# headline, never the body.
HEADLINES: dict[str, list[tuple[str, str]]] = {
    "terms": [(r"(\d+ terms, \d+ in-term holidays)", "{0}")],
    "canaries": [(r"(\d+/\d+ panorama tiles still served)", "{0}"),
                 (r"(no panoScenes in data/venues)", "{0}")],
    "tracks": [(r"\((\d+) tracks\)", "{0} tracks"),
               (r"\[dry-run\] (\d+) track\(s\)", "{0} tracks")],
    "mods": [(r"^new mods written\s*:\s*(\d+)", "{0} new"),
             (r"^existing mods tag-updated\s*:\s*(\d+)", "{0} tag-updated"),
             (r"^re-titled by their page\s*:\s*(\d+)(.*)", "{0} re-titled {1}"),
             (r"^failed to parse\s*:\s*(\d+)", "{0} failed to parse")],
    "hass": [(r"\[hass\] returned no mods", "returned nothing, data left untouched"),
             (r"\[hass\] (\{.*\})", "{0}")],
    "cores": [(r"(\d+ core mod\(s\) across \d+ listings)", "{0}"),
              (r"(flagged: .+)", "{0}"),
              (r"(no longer a core, flag removed: .+)", "{0}"),
              (r"(nothing to change)", "{0}")],
    "minors": [(r"^(\d+) thing\(s\) need a look", "{0} need a look")],
    "prereqs": [(r"^AGREES\s+(\d+)", "{0} agree"),
                (r"^DIFFERS \((\d+)\)", "{0} differ")],
    "propose": [(r"^Read by (.+)\.$", "read by {0}"),
                (r"^(No model token is set)", "no model token, nothing proposed")],
}


def headline(s: Step) -> str:
    lines = [ln.strip() for ln in step_log(s).splitlines()]
    bits: list[str] = []
    for pat, tpl in HEADLINES.get(s.name, []):
        rx = re.compile(pat)
        for ln in lines:
            m = rx.search(ln)
            if m:
                bits.append(tpl.format(*(g.strip() if g else "" for g in m.groups())).strip())
                break
    return ", ".join(b for b in bits if b) or f"ok in {s.secs:.0f}s"


def read_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        print(f"[!] {path.name} is unreadable, its section is left out: {exc}", file=sys.stderr)
        return None


def read_renames(path: Path) -> dict | None:
    """gather_mods.py's --renames-out, read without trusting its shape.

    A list of {code, old, new, url}, each possibly with `written`, or the
    same list under "renames" in an object that may carry `written` and `cap`.
    Missing file: None, and the section is left out. Keys this does not know
    are ignored, and an item without a code or a new title is skipped.
    """
    raw = read_json(path)
    if raw is None:
        return None
    written = cap = count = None
    items = raw
    if isinstance(raw, dict):
        items = raw.get("renames") or raw.get("items") or []
        written = raw.get("written")
        cap = raw.get("cap")
        count = raw.get("count")
    if not isinstance(items, list):
        return None
    out = []
    for it in items:
        if not isinstance(it, dict) or not it.get("code") or not it.get("new"):
            continue
        out.append({"code": str(it["code"]), "old": str(it.get("old") or ""),
                    "new": str(it["new"]), "url": str(it.get("url") or ""),
                    "written": it.get("written")})
    if written is None and out and all(isinstance(i["written"], bool) for i in out):
        written = any(i["written"] for i in out)
    return {"items": out, "written": written,
            "cap": cap if isinstance(cap, int) else None,
            "count": count if isinstance(count, int) and count >= len(out) else len(out)}


def cell(v: object) -> str:
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    s = " ".join(s.split())
    return s.replace("|", "\\|") or "-"


def link(url: str, text: str = "page") -> str:
    return f"[{text}]({url})" if url else "-"


def joined(v: object) -> str:
    """A list from a step's JSON, as text, whatever its items are.

    These lists come from another script's output. A list of ints joined with
    ', '.join raised TypeError, and an exception here costs the whole pull
    request rather than one row.
    """
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    return str(v) if v else ""


def renames_section(r: dict) -> list[str]:
    """The re-titles, worded from the numbers and never from `written` alone.

    `written` is false on a dry run and when every re-title was skipped as
    renamed mid-run, both under the cap, so reading false as "over the cap"
    told a reviewer to raise a cap that would change nothing.
    """
    items = r["items"]
    if not items:
        return []
    n = r.get("count") or len(items)
    cap = r.get("cap")
    over = isinstance(cap, int) and n > cap
    per_item = all(isinstance(i["written"], bool) for i in items)
    out = ["### Renames", ""]
    if over:
        out.append(f"SUTD re-titled {n} page(s). **None was written**: that is over the "
                   f"cap of {cap}, and the cap is all or none, so a site redesign cannot "
                   "rewrite the catalogue in one pull request.")
    elif r["written"] is True:
        out.append(f"SUTD re-titled {n} page(s), and the ones marked written are in this "
                   "diff. Edit back any that is a replacement rather than a rename before "
                   "merging.")
    elif r["written"] is False:
        out.append(f"SUTD re-titled {n} page(s) and none was written, though that is not "
                   "over the cap: a dry run writes nothing, and a record renamed while the "
                   "run was going is left alone. The `mods` output says which.")
    else:
        out.append(f"SUTD re-titled {n} page(s). Whether they were written is in the change "
                   "table above: a written one is a `name` row.")
    if per_item:
        out += ["", "| code | name in the record | title on the page | written | page |",
                "|---|---|---|---|---|"]
        out += [f"| `{i['code']}` | {cell(i['old'])} | {cell(i['new'])} "
                f"| {'yes' if i['written'] else 'no'} | {link(i['url'])} |" for i in items]
    else:
        out += ["", "| code | name in the record | title on the page | page |",
                "|---|---|---|---|"]
        out += [f"| `{i['code']}` | {cell(i['old'])} | {cell(i['new'])} | {link(i['url'])} |"
                for i in items]
    if over:
        out += ["", f"To accept them, run the `scrape` workflow by hand (Actions, scrape, "
                f"Run workflow) with `rename_cap` set to at least {n}, after checking each "
                "row is a rename and not a different mod."]
    return out + [""]


def proposal_sections(p: dict) -> list[str]:
    accepted, rejected = [], []
    for kind in ("prereqs", "minors"):
        part = p.get(kind) if isinstance(p.get(kind), dict) else {}
        accepted += [(kind, e) for e in part.get("accepted") or [] if isinstance(e, dict)]
        rejected += [(kind, e) for e in part.get("rejected") or [] if isinstance(e, dict)]
    out: list[str] = []
    if accepted:
        out += ["### Edits a model made", "",
                "Each is in the diff. Read the quote: it is copied from the page, and a "
                "page can name a code and then disown it.", ""]
        for kind, e in accepted:
            if kind == "prereqs":
                head = (f"**{e.get('code', '?')}** `{e.get('field', '?')}` -> "
                        f"`{json.dumps(e.get('value'), ensure_ascii=False)}`")
            else:
                head = (f"**{e.get('minor', '?')}** + `{joined(e.get('add'))}` "
                        f"to requirement group {e.get('requirement', '?')}")
            out += [f"{head} ({e.get('outcome', '?')})", "",
                    f"> {cell(e.get('quote', ''))}", "", cell(e.get("why", "")), ""]
    if rejected:
        out += ["### Proposals dropped by validation", "",
                "A model proposed these and the validator refused them, so nothing was "
                "written. A refusal that looks wrong is a rule in `propose_edits.py` "
                "that is too strict.", "",
                "| record | proposed | why it was refused |", "|---|---|---|"]
        for kind, r in rejected:
            e = r.get("edit") if isinstance(r.get("edit"), dict) else {}
            if kind == "prereqs":
                rec = e.get("code", "?")
                prop = str(e.get("field", "?"))
                if "value" in e:
                    prop += f" = {json.dumps(e['value'], ensure_ascii=False)}"
            else:
                rec = e.get("minor", "?")
                prop = f"add {joined(e.get('add')) or '?'} to group {e.get('requirement', '?')}"
            out.append(f"| {cell(rec)} | {cell(prop)} | {cell(r.get('why', ''))} |")
        out.append("")
    return out


def minors_section(rows: list) -> list[str]:
    looks = [r for r in rows if isinstance(r, dict) and r.get("id") != "_index"
             and r.get("status") not in ("ok", "", None)]
    index = next((r for r in rows if isinstance(r, dict) and r.get("id") == "_index"), {})
    unknown = [u for u in index.get("unknown") or [] if isinstance(u, dict)]
    # A minor SUTD retired shows up only here: its record's URL is gone from
    # the index, and gather_minors.py counts that as drift.
    unlinked = [str(u) for u in index.get("unlinked") or [] if u]
    if not looks and not unknown and not unlinked:
        return []
    out = ["### Minors whose page differs from the record", "",
           "Read the page before editing `data/minors.json`. A code on a page can be an "
           "example or a prerequisite of one, not a requirement.", ""]
    if looks:
        out += ["| minor | status | page names, record lacks | page |", "|---|---|---|---|"]
        out += [f"| {cell(r.get('id', '?'))} | {cell(r.get('status', ''))} "
                f"| {cell(joined(r.get('extra')))} | {link(r.get('url') or '')} |"
                for r in looks]
        out.append("")
    for u in unknown:
        out.append(f"- SUTD lists a minor the repo has no record of: "
                   f"{link(u.get('url') or '', cell(u.get('title') or 'untitled'))}")
    for mid in unlinked:
        out.append(f"- the repo has a record SUTD no longer lists: `{cell(mid)}`")
    return out + [""]


def model_read(proposed: object) -> set[str]:
    """The prereq records a model actually answered for: an edit or a skip.

    "A model is configured" is not the same set. propose never sends a row
    whose page text is too short to judge, and a provider outage leaves every
    sent row "no provider answered", so gating the gap table on `configured`
    hid exactly the rows nobody read.
    """
    if not isinstance(proposed, dict) or not isinstance(proposed.get("prereqs"), dict):
        return set()
    part = proposed["prereqs"]
    seen = {str(e.get("code")) for e in part.get("accepted") or [] if isinstance(e, dict)}
    seen |= {str(r["edit"].get("code")) for r in part.get("rejected") or []
             if isinstance(r, dict) and isinstance(r.get("edit"), dict)}
    seen |= {str(v.get("id")) for v in part.get("verdicts") or []
             if isinstance(v, dict) and v.get("status") == "left alone"}
    return seen


def prereqs_section(rows: list, read: set[str] = frozenset()) -> list[str]:
    """The differing rows no model answered for; the rest are in propose's own rows."""
    differs = [r for r in rows if isinstance(r, dict) and r.get("status") == "differs"
               and str(r.get("code")) not in read]
    if not differs:
        return []
    out = ["### Prerequisites that differ from the page", "",
           "No model read these this run, so each is a sentence for a person to read.", "",
           "| mod | page has, record lacks | record has, page lacks | page |", "|---|---|---|---|"]
    out += [f"| `{r.get('code', '?')}` | {cell(joined(r.get('gap')))} "
            f"| {cell(joined(r.get('extra')))} | {link(r.get('url') or '')} |"
            for r in differs]
    return out + [""]


# Per step. gather_mods prints a `[!]` per page that failed to fetch, so a bad
# network minute is hundreds of them, and this section is never folded.
FLAGGED_MAX = 30


def reported_section(steps: list[Step]) -> list[str]:
    """A step saying it refused or kept something, not changed it.

    `[!]` on stderr and `!!` indented on stdout are both that convention in
    gather_mods.py, and a record kept with a term its page stopped naming is
    only ever a `!!` line. Some `!!` lines repeat a `[!]` one; a decision shown
    twice costs a line, a decision shown nowhere costs the decision.
    """
    out: list[str] = []
    for s in steps:
        flagged = [ln.strip() for ln in step_log(s).splitlines()
                   if ln.strip().startswith(("[!]", "!!"))]
        if len(flagged) > FLAGGED_MAX:
            flagged = flagged[:FLAGGED_MAX] + [
                f"... and {len(flagged) - FLAGGED_MAX} more, in this run's step summary"]
        if flagged:
            out += [f"`{s.name}`:", "", "```", *flagged, "```", ""]
    if not out:
        return []
    return ["### Reported, not changed", "",
            "The refresh refused or skipped these and said why. Nothing in the diff "
            "covers them.", ""] + out


def verdict_rows(p: dict | None) -> list[str]:
    if not isinstance(p, dict):
        return []
    out: list[str] = []
    for kind, label in (("prereqs", "mod"), ("minors", "minor")):
        part = p.get(kind) if isinstance(p.get(kind), dict) else {}
        rows = [v for v in part.get("verdicts") or [] if isinstance(v, dict)]
        if rows:
            out += [f"**{kind}**", "", f"| {label} | verdict | why |", "|---|---|---|"]
            out += [f"| {cell(v.get('id', '?'))} | {cell(v.get('status', ''))} "
                    f"| {cell(v.get('why', ''))} |" for v in rows]
            out.append("")
    return out


def details(summary: str, inner: str) -> str:
    return f"<details><summary>{summary}</summary>\n\n{inner.strip()}\n\n</details>"


FENCE = "````"


def output_blocks(steps: list[Step], what: dict[str, str]) -> list[tuple[str, str]]:
    return [(f"**{s.name}** ({'ok' if s.ok else 'FAILED'} in {s.secs:.0f}s): "
             f"{what.get(s.name, '')}", step_log(s)) for s in steps]


CUT_NOTE = ("Cut here to fit GitHub's 65536-character limit on a pull request "
            "body. The whole output is in this run's step summary.")


def clip_output(blocks: list[tuple[str, str]], room: int) -> str:
    """The full-output section, cut at a line boundary to fit `room`.

    Whatever is cut is cut from the end, inside the step it falls in, and the
    fence is always closed, so a cut never swallows the markup after it.
    """
    parts: list[str] = []
    used = 0
    for head, text in blocks:
        whole = f"{head}\n\n{FENCE}\n{text}\n{FENCE}\n"
        if used + len(whole) <= room:
            parts.append(whole)
            used += len(whole)
            continue
        budget = room - used - len(head) - len(CUT_NOTE) - 3 * len(FENCE) - 16
        kept: list[str] = []
        size = 0
        for ln in text.splitlines():
            if size + len(ln) + 1 > budget:
                break
            kept.append(ln)
            size += len(ln) + 1
        if kept:
            parts.append(f"{head}\n\n{FENCE}\n" + "\n".join(kept) + f"\n{FENCE}\n")
        parts.append(CUT_NOTE)
        break
    return "\n".join(parts)


# What sections 1 to 4 leave for the two folds. Below this the folds collapse
# to their cut notes, so the head is held to the limit minus this.
FOLD_ROOM = 4000

# A changed-file list past this is a retag of the whole catalogue, and the
# names say nothing the count does not.
FILES_MAX = 40


def clip_lines(text: str, budget: int) -> tuple[str, list[str]]:
    """`text` cut at a line boundary to `budget` characters, and what was cut.

    A cut inside a code fence closes the fence, or everything after it in the
    body renders as one code block.
    """
    lines = text.split("\n")
    kept: list[str] = []
    size = 0
    for ln in lines:
        if size + len(ln) + 1 > budget:
            break
        kept.append(ln)
        size += len(ln) + 1
    rest = lines[len(kept):]
    if rest and sum(ln.startswith("```") for ln in kept) % 2:
        kept.append("```")
    return "\n".join(kept), rest


def changes_section(changes: str | None, changed: list[str]) -> list[str]:
    sec = ["## What changed in /data", ""]
    if changes and changes.strip() and changed:
        sec += ["One row per record. Check a row against its page link, not the diff hunk: "
                "a hunk in a 21-track file does not say which track it is in.", "",
                changes.strip()]
    elif changed:
        # what_changed.py failed. Saying "nothing changed" here, above a diff
        # that changes mod files, tells the reviewer to skip the part they most
        # need to read.
        shown = changed[:FILES_MAX]
        more = len(changed) - len(shown)
        sec += [f"{len(changed)} file(s) changed, but `what_changed.py` failed, so there "
                "is no table by record. Its error is in this run's step summary; read the "
                "diff file by file.", ""]
        sec += [f"- `{f}`" for f in shown]
        if more:
            sec.append(f"- ... and {more} more")
    else:
        sec.append("Nothing under `/data` changed. This pull request is here for the "
                   "findings below.")
    if any(f.endswith("term-calendar.json") for f in changed):
        sec += ["", "`data/term-calendar.json` changed. It decides where a weekly-view "
                "paste puts a term of classes, so check the dates against SUTD's "
                "academic calendar."]
    return sec


def build_body(steps: list[Step], what: dict[str, str], *, changes: str | None,
               changed: list[str], renames: dict | None, proposed: dict | None,
               minors: list | None, prereqs: list | None,
               review: str | None = None, limit: int = BODY_LIMIT) -> str:
    """The refresh pull request's body, in the order a reviewer acts on it.

    Sections 1 to 4 come first and unfolded: the banner, the change table,
    what needs a decision, and one line per step. The two folds after them
    give way first when GitHub's limit is near, the raw output before the
    verdicts. If the head alone is still too big, the change table loses rows
    from its end, then the head is cut, so the limit always holds: a body over
    it is refused, and the month's data never reaches a pull request.
    """
    # Run order is completion order, which changes run to run; the body reads
    # in the order the steps are declared.
    order = {n: i for i, n in enumerate(n for w in WAVES for n in w)}
    steps = sorted(steps, key=lambda s: order.get(s.name, 99))
    failed = [s.name for s in steps if not s.ok]
    top: list[str] = []
    if failed:
        top.append(f"> PARTIAL REFRESH. These steps failed and their part of the data is "
                   f"unchanged: {', '.join(failed)}.")
    top.append("Opened by `tools/scraper/mods_refresh.py`. SUTD's HTML changes without "
               "notice and a parser can pull in junk, so if a row below looks wrong, "
               "close this and patch the parser under `tools/scraper/`.")

    table_at = len(top)
    top.append("\n".join(changes_section(changes, changed)))

    need: list[str] = []
    # The markdown is gather_mods.py's own account of the same re-titles, plus
    # the term moves, so when it exists the table from renames.json would only
    # say half of it twice.
    if review and review.strip():
        need += [review.strip(), ""]
    elif renames:
        need += renames_section(renames)
    if isinstance(proposed, dict):
        need += proposal_sections(proposed)
    if minors:
        need += minors_section(minors)
    if prereqs:
        need += prereqs_section(prereqs, model_read(proposed))
    need += reported_section(steps)
    top.append("\n".join(["## Needs your decision", ""] + (need or ["Nothing this run."])).rstrip())

    checked = ["## Checked and fine", ""]
    for s in steps:
        if s.ok:
            checked.append(f"- **{s.name}**: {headline(s)} ({s.secs:.0f}s)")
        else:
            last = (s.err or s.out).strip().splitlines()[-1:] or ["no output"]
            checked.append(f"- **{s.name}**: FAILED in {s.secs:.0f}s, last line: {cell(last[0])}")
    top.append("\n".join(checked))

    head = "\n\n".join(top)
    head_max = limit - FOLD_ROOM
    if len(head) > head_max and changes and changes.strip() and changed:
        table = changes.strip()
        keep, rest = clip_lines(table, len(table) - (len(head) - head_max) - 300)
        rows = sum(1 for ln in rest if ln.startswith("|"))
        cut = (f"{keep}\n\n{rows} more row(s) cut here to fit GitHub's 65536-character "
               "limit on a pull request body. The whole table is in this run's step summary.")
        top[table_at] = "\n".join(changes_section(cut, changed))
        head = "\n\n".join(top)
    if len(head) > head_max:
        keep, _ = clip_lines(head, head_max - len(CUT_NOTE) - 8)
        head = f"{keep}\n\n{CUT_NOTE}"
    vrows = verdict_rows(proposed)
    verdicts = details("model verdicts that changed nothing", "\n".join(vrows)) if vrows else ""
    blocks = output_blocks(steps, what)

    wrap = len(details("full run output", "")) + 8
    room = limit - len(head) - len(verdicts) - wrap
    if verdicts and room < 2000:
        verdicts = details("model verdicts that changed nothing", CUT_NOTE)
        room = limit - len(head) - len(verdicts) - wrap
    output = details("full run output", clip_output(blocks, room)) if room > len(CUT_NOTE) + 64 \
        else details("full run output", CUT_NOTE)
    return "\n\n".join(p for p in (head, verdicts, output) if p) + "\n"


def fallback_body(steps: list[Step], changed: list[str], exc: BaseException) -> str:
    failed = [s.name for s in steps if not s.ok]
    out = []
    if failed:
        out.append(f"> PARTIAL REFRESH. These steps failed and their part of the data is "
                   f"unchanged: {', '.join(failed)}.")
    out.append(f"Opened by `tools/scraper/mods_refresh.py`. Building this body failed "
               f"(`{cell(f'{type(exc).__name__}: {exc}')}`), so it is the short form: the "
               "whole output, and the traceback, are in this run's step summary.")
    out.append("\n".join(changes_section(None, changed)))
    return "\n\n".join(out)[:BODY_LIMIT - 1] + "\n"


def changed_files() -> list[str]:
    """What this run actually altered, so the summary is about data not logs."""
    p = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all", "--", "data"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    return [ln[3:] for ln in p.stdout.splitlines() if ln.strip()]


def self_check() -> int:
    """No network, no model. Each case is a defect the PR body actually had."""
    bad = 0
    total = 0

    def check(what: str, ok: bool, got: object = "") -> None:
        nonlocal bad, total
        total += 1
        if not ok:
            bad += 1
            print(f"FAIL {what}: {str(got)[:400]!r}")

    old_drift = "\n".join(DRIFT_HEAD + [
        "## propose", "", "reads", "", "```", "## proposed edits", "", "Read by A.",
        "| minor-ai | old verdict |", "```", "",
        "## proposed edits", "", "Read by GROQ.", "| 50.037 | stale |", "```",
    ])
    secs = split_sections(old_drift)
    check("a ## line inside a fence stays in its section",
          "Read by A." in secs.get("propose", ""), secs.keys())
    fresh = Step("propose", True, "## proposed edits\n\nRead by B.", "", 1.0)
    text = drift_text(old_drift, [fresh], {"propose": "reads"}) or ""
    check("rerunning propose leaves no stale section behind",
          "Read by B." in text and "GROQ" not in text and "Read by A." not in text, text)
    check("a step that found nothing retires its section, and the file goes",
          drift_text(old_drift, [Step("propose", True, "", "", 1.0)], {}) is None)
    check("a step that failed keeps its last finding",
          "Read by A." in (drift_text(old_drift, [Step("propose", False, "", "x", 1)], {}) or ""))

    ok, out, err = run(["-c", "import sys; print('to-stdout'); print('to-stderr', file=sys.stderr)"], False)
    check("run keeps stdout AND stderr", ok and out == "to-stdout" and err == "to-stderr", (out, err))

    long = Step("minors", True, "\n".join(f"line {i}" for i in range(40)), "warn", 1.0)
    log = step_log(long)
    check("the full output is whole, not a 12-line tail",
          "line 0" in log and "line 39" in log and "warn" in log, log[:80])

    cases = [
        (Step("terms", True, "wrote data/term-calendar.json: 15 terms, 22 in-term holidays", "", 5),
         "15 terms, 22 in-term holidays"),
        (Step("canaries", True, "26/26 panorama tiles still served", "", 19),
         "26/26 panorama tiles still served"),
        (Step("tracks", True, "Wrote /x/data/specializations.json  (21 tracks)\npillar", "", 17),
         "21 tracks"),
        (Step("hass", True, "[hass] returned no mods - skipping (data left untouched)", "", 1),
         "returned nothing, data left untouched"),
        (Step("cores", True, "  ASD 10 20.099\n\n40 core mod(s) across 6 listings\nflagged: 60.010", "", 5),
         "40 core mod(s) across 6 listings, flagged: 60.010"),
        (Step("mods", True, "new mods written           : 3\nexisting mods tag-updated  : 22\n"
              "re-titled by their page    : 25 - over the cap of 10, none written\n"
              "failed to parse            : 0 []", "", 252),
         "3 new, 22 tag-updated, 25 re-titled - over the cap of 10, none written, 0 failed to parse"),
        (Step("prereqs", True, "something nobody planned for", "", 10), "ok in 10s"),
    ]
    for s, want in cases:
        got = headline(s)
        check(f"headline for {s.name}", got == want, got)

    tmp = SCRATCH / "_selfcheck_renames.json"
    SCRATCH.mkdir(parents=True, exist_ok=True)
    try:
        tmp.unlink(missing_ok=True)
        check("no renames file, no section", read_renames(tmp) is None)
        tmp.write_text(json.dumps([{"code": "50.001", "old": "A", "new": "B", "url": "u",
                                    "colour": "blue", "written": False}, {"old": "no code"}]),
                       encoding="utf-8")
        r = read_renames(tmp)
        check("a list is read, unknown keys ignored, a codeless item skipped",
              r is not None and len(r["items"]) == 1 and r["written"] is False, r)
        tmp.write_text(json.dumps({"renames": [{"code": "40.240", "new": "C"}],
                                   "written": True, "cap": 10}), encoding="utf-8")
        r = read_renames(tmp)
        check("an object with renames/written/cap is read",
              r is not None and r["written"] is True and r["cap"] == 10, r)
        tmp.write_text("{not json", encoding="utf-8")
        check("an unreadable renames file leaves the section out", read_renames(tmp) is None)
    finally:
        tmp.unlink(missing_ok=True)

    steps = [Step("mods", True, "new mods written           : 1\n" + "x" * 200 + "\n" * 1, "", 3),
             Step("hass", True, "y\n" * 60000, "", 1)]
    table = "| code | name | change | source |\n|---|---|---|---|\n| `02.184` | Minds | new record | - |"
    proposed = {"configured": True, "minors": {"verdicts": [
        {"id": "minor-ai", "status": "left alone", "why": "nothing to add here"},
        {"id": "minor-aai", "status": "no verdict", "why": ""}]}}
    renames = {"items": [{"code": "50.001", "old": "A", "new": "B", "url": "", "written": None}],
               "written": False, "cap": 10, "count": 25}
    body = build_body(steps, {}, changes=table, changed=["data/mods/02_184.json"],
                      renames=renames, proposed=proposed, minors=None, prereqs=None)
    check("the body fits GitHub's limit", len(body) <= BODY_LIMIT, len(body))
    check("the full output is what gets cut, with a note", CUT_NOTE in body, body[-300:])
    first_fold = body.find("<details>")
    for marker in ("## What changed in /data", "`02.184`", "## Needs your decision",
                   "rename_cap", "## Checked and fine", "**mods**: 1 new"):
        check(f"{marker!r} is in the body, above every fold",
              0 <= body.find(marker) < first_fold, body[:200])
    check("a model verdict is printed once", body.count("nothing to add here") == 1)
    check("a record sent and never answered is shown as such", "no verdict" in body)

    mods_file = ["data/mods/50_001.json"]

    def quick(**kw: object) -> str:
        args: dict = dict(changes=None, changed=[], renames=None, proposed=None,
                          minors=None, prereqs=None)
        args.update(kw)
        return build_body([Step("mods", True, "", "", 1)], {}, **args)

    failed_diff = quick(changed=mods_file)
    check("a failed what_changed.py is not reported as nothing changed",
          "Nothing under" not in failed_diff and "data/mods/50_001.json" in failed_diff,
          failed_diff[:400])

    bang = build_body([Step("mods", True, "    !! page stopped naming a term, kept : "
                            "['02.146 (term 7)']", "", 1)], {}, changes=None, changed=[],
                      renames=None, proposed=None, minors=None, prereqs=None)
    check("a !! line reaches Needs your decision",
          0 <= bang.find("02.146 (term 7)") < bang.find("## Checked and fine"), bang[:600])

    noisy = Step("mods", True, "", "\n".join(f"[!] 10.{i:03d} fetch failed" for i in range(300)), 1)
    noisy_body = build_body([noisy], {}, changes=None, changed=[], renames=None,
                            proposed=None, minors=None, prereqs=None)
    head_part = noisy_body[:noisy_body.find("## Checked and fine")]
    check("[!] lines are capped per step above the fold",
          "10.299" not in head_part and "270 more" in head_part, head_part[-300:])

    gap_rows = [{"code": "50.037", "status": "differs", "gap": ["50.001"], "extra": [], "url": ""},
                {"code": "50.038", "status": "differs", "gap": ["50.002"], "extra": [], "url": ""},
                {"code": "50.039", "status": "differs", "gap": ["50.003"], "extra": [], "url": ""}]
    outage = {"configured": True, "prereqs": {"accepted": [], "rejected": [], "providers": [],
              "verdicts": [{"id": "50.037", "status": "no provider answered", "why": ""},
                           {"id": "50.039", "status": "left alone", "why": "the page means it"}]}}
    gaps = quick(proposed=outage, prereqs=gap_rows)
    above = gaps[:gaps.find("## Checked and fine")]
    check("a gap no model answered for is shown though a model is configured",
          "50.001" in above and "50.002" in above, above[-600:])
    check("a gap a model did answer for is not shown twice", "50.003" not in above, above[-600:])

    dry = quick(renames={"items": [{"code": "50.001", "old": "A", "new": "B", "url": "",
                                    "written": False}], "written": False, "cap": 10, "count": 1})
    check("under the cap, written=false is not called over the cap",
          "over the cap of" not in dry and "rename_cap" not in dry, dry[:900])
    mixed = quick(renames={"items": [
        {"code": "50.001", "old": "A", "new": "B", "url": "", "written": True},
        {"code": "40.240", "old": "C", "new": "D", "url": "", "written": False}],
        "written": True, "cap": 10, "count": 2})
    check("a re-title that was not written says so in its row",
          "| `40.240` | C | D | no |" in mixed, mixed[:900])

    minors_gone = quick(minors=[{"id": "_index", "unknown": [], "unlinked": ["minor-x"]}])
    check("a minor SUTD stopped listing reaches Needs your decision",
          0 <= minors_gone.find("minor-x") < minors_gone.find("## Checked and fine"),
          minors_gone[:600])

    big = "| code | name | change | source |\n|---|---|---|---|\n" + "\n".join(
        f"| `10.{i:03d}` | Mod {i} | description: text changed (900 -> 1200 chars)<br>"
        f"tags: + `Term 8`; - `Term 7` | [page](https://www.sutd.edu.sg/course/10-{i:03d}/) |"
        for i in range(600))
    huge = build_body(steps, {}, changes=big, changed=mods_file * 600, renames=None,
                      proposed=None, minors=None, prereqs=None)
    check("a 600-row change table still fits GitHub's limit", len(huge) <= BODY_LIMIT, len(huge))
    check("a cut table says how many rows it dropped", "more row(s) cut here" in huge,
          huge[:200])

    redesign = {"items": [{"code": f"10.{i:03d}", "old": "o" * 90, "new": "n" * 90,
                           "url": f"https://www.sutd.edu.sg/course/10-{i:03d}/", "written": False}
                          for i in range(600)], "written": False, "cap": 10, "count": 600}
    flood = quick(renames=redesign)
    check("a head too big even without a table is cut to the limit",
          len(flood) <= BODY_LIMIT and CUT_NOTE in flood, len(flood))
    kept, _ = clip_lines("`mods`:\n\n```\n[!] one\n[!] two\n```", 20)
    check("a cut inside a code fence closes it", kept.count("```") == 2, kept)

    short = fallback_body([Step("mods", False, "", "x", 1)], mods_file, TypeError("boom"))
    check("a body that failed to build still names the changed files",
          "data/mods/50_001.json" in short and "boom" in short and "PARTIAL" in short, short)

    odd = {"minors": {"accepted": [], "rejected": [
        {"edit": {"minor": "minor-ai", "add": [50037], "requirement": 1}, "why": "x"}]}}
    check("a list of ints from a step's JSON does not raise",
          "50037" in quick(proposed=odd))

    has = lambda script, flag: True  # noqa: E731
    lacks = lambda script, flag: False  # noqa: E731
    argv = with_mods_reports(["gather_mods.py", "--review-out", "x.md"], has)
    check("a report flag is passed once when STEPS already carries it",
          argv.count("--review-out") == 1 and argv.count("--renames-out") == 1, argv)
    check("no report flag is passed to a gather_mods.py without it",
          with_mods_reports(["gather_mods.py"], lacks) == ["gather_mods.py"])

    review = ("### Terms\n\n- `02.146` kept at term 7: its page stopped naming any term. "
              "Read the page and set it by hand.\n")
    with_review = quick(review=review, renames=renames)
    check("gather_mods.py's review markdown is above the fold, in place of the renames table",
          0 <= with_review.find("`02.146` kept at term 7") < with_review.find("## Checked and fine")
          and "### Renames" not in with_review, with_review[:900])

    print(f"{total - bad}/{total} mods_refresh cases ok")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="write nothing")
    ap.add_argument(
        "--status-out",
        default="",
        help="append `failed=a,b` here. Point it at $GITHUB_OUTPUT and the job can say so on the PR, because a partial refresh still writes files and still opens one.",
    )
    ap.add_argument("--body-out", default="",
                    help="write the pull request body here. The workflow passes this to create-pull-request.")
    ap.add_argument(
        "--only",
        default="",
        help="comma-separated step names: " + ", ".join(n for n, _, _ in STEPS),
    )
    ap.add_argument("--self-check", action="store_true", help="run the report cases, no network")
    args = ap.parse_args()

    if args.self_check:
        return self_check()

    # The steps write their machine-readable output here and `propose`
    # reads it, so it has to exist before the first wave, not on demand
    # inside four scripts that would each have to remember.
    SCRATCH.mkdir(parents=True, exist_ok=True)

    wanted = {s.strip() for s in args.only.split(",") if s.strip()}
    steps = [s for s in STEPS if not wanted or s[0] in wanted]
    if wanted - {n for n, _, _ in STEPS}:
        print(f"unknown step(s): {sorted(wanted - {n for n, _, _ in STEPS})}", file=sys.stderr)
        return 2

    by_name = {n: (list(argv), what) for n, argv, what in steps}
    if "mods" in by_name:
        argv, what = by_name["mods"]
        by_name["mods"] = (with_mods_reports(argv, accepts), what)
    # A file left by an earlier run would be read as this run's finding.
    for name, path in (("mods", RENAMES), ("mods", REVIEW), ("propose", PROPOSED)):
        if name in by_name:
            path.unlink(missing_ok=True)
    CHANGES.unlink(missing_ok=True)

    sys.stdout.reconfigure(encoding="utf-8")  # step output carries mod names
    print(f"# mods refresh{' (dry run)' if args.dry_run else ''}\n")

    results: list[Step] = []
    started = time.time()
    for wave in WAVES:
        todo = [n for n in wave if n in by_name]
        if not todo:
            continue
        # Threads rather than processes: each one only waits on a subprocess,
        # so the GIL is never what holds them up.
        with ThreadPoolExecutor(max_workers=len(todo)) as pool:
            futures = [pool.submit(timed, n, by_name[n][0], args.dry_run) for n in todo]
            for fut in as_completed(futures):
                s = fut.result()
                results.append(s)
                print(f"## {s.name}\n{by_name[s.name][1]}\n")
                print(step_log(s))
                print(f"\n-> {'ok' if s.ok else 'FAILED'} in {s.secs:.0f}s\n", flush=True)

    write_drift(results, by_name)

    wall = time.time() - started
    print("## summary\n")
    for s in sorted(results, key=lambda r: -r.secs):
        print(f"  {'ok    ' if s.ok else 'FAILED'}  {s.name:<9} {s.secs:5.0f}s")
    print(f"\n  wall {wall:.0f}s, against {sum(r.secs for r in results):.0f}s one after another")

    touched = changed_files()
    print(f"\n{len(touched)} file(s) in /data changed")
    for f in touched:
        print(f"  {f}")

    # Named by record, not by line: what_changed.py's docstring says why.
    changes = None
    if touched:
        print("\n## what changed, by record\n")
        ok, out, err = run(["what_changed.py", "--out", str(CHANGES)], dry_run=False)
        print(out or err or "(could not diff)")
        changes = CHANGES.read_text(encoding="utf-8") if ok and CHANGES.exists() else None

    if args.body_out:
        ran = {s.name for s in results}
        try:
            body = build_body(
                results, {n: v[1] for n, v in by_name.items()},
                changes=changes, changed=touched,
                renames=read_renames(RENAMES) if "mods" in ran else None,
                review=(REVIEW.read_text(encoding="utf-8")
                        if "mods" in ran and REVIEW.exists() else None),
                proposed=read_json(PROPOSED) if "propose" in ran else None,
                minors=read_json(SCRATCH / "minors.json") if "minors" in ran else None,
                prereqs=read_json(SCRATCH / "prereqs.json") if "prereqs" in ran else None,
            )
        except Exception as exc:  # noqa: BLE001
            # The shell step this replaced could not fail. An odd JSON shape
            # from one step must cost a section, not the month's pull request,
            # which the workflow skips when this step exits non-zero.
            traceback.print_exc()
            body = fallback_body(results, touched, exc)
        Path(args.body_out).write_text(body, encoding="utf-8")

    failed = [s.name for s in results if not s.ok]
    # Appended, because $GITHUB_OUTPUT is a shared file the job writes to.
    if args.status_out:
        with open(args.status_out, "a", encoding="utf-8") as fh:
            print("failed=" + ",".join(failed), file=fh)

    if failed and len(failed) == len(results):
        print(f"\nEVERY step failed ({', '.join(failed)}) - this is the network "
              f"or the environment, not one page.", file=sys.stderr)
        return 1
    if failed:
        print(f"\n{len(failed)} step(s) failed: {', '.join(failed)}. The rest ran.",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
