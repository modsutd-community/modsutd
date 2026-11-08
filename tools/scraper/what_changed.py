#!/usr/bin/env python3
"""Every change under /data, one row per record, with that record's own source link.

    python tools/scraper/what_changed.py                    # working tree against HEAD
    python tools/scraper/what_changed.py --base A --head B  # two refs
    python tools/scraper/what_changed.py --out changes.md   # also write the table here
    python tools/scraper/what_changed.py --self-check       # no git, no network

BY RECORD, NOT BY HUNK. A hunk in data/specializations.json reading
`+ "50.057"` sits in one of 21 tracks and the diff does not say which, and the
nearest "id" line above it is often a different record. So both documents are
walked, and a change is filed under the record it landed in. Lists of records
are matched on id/code/name/label rather than index, because inserting one
record makes every later index look changed.

ONE ROW PER RECORD. The refresh PR body pastes this table first and outside any
fold, because it is the part a reviewer acts on: a new mod, a tag edit, a term
change, a re-title and a track note are each a row, and a reviewer keeps or
reverts a record, not a field. A new record is named from its own file, with
the link it carries, so a new mod is not a bare path.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]

KEYS = ("id", "code", "name", "label")
NAME_KEYS = ("name", "title", "label")
SOURCE_FIELDS = ("source", "sourceUrl", "url")
# A tag coming OFF a record is the change that can take a mod out of a pillar
# or out of the core list, so those are the removals worth bold.
IMPORTANT_TAGS = {"core", "freshmore core", "smt", "hass", "epd", "esd", "csd", "dai", "asd"}
# Past this a value is prose, and printing both sides drowns the table.
LONG = 120
# Whether a mod's page offers a batch chat. A flip here changes what every
# student taking it sees, so it is not left as one row among the tag edits.
CHAT_FIELDS = ("noBatchChat", "noBatchChatReason")


def key_of(item: object, index: int) -> str:
    if isinstance(item, dict):
        for k in KEYS:
            v = item.get(k)
            if isinstance(v, str) and v:
                return v
    return f"[{index}]"


def name_of(item: object) -> str:
    if isinstance(item, dict):
        for k in NAME_KEYS:
            v = item.get(k)
            if isinstance(v, str) and v:
                return v
    return ""


def source_of(node: object) -> str:
    if isinstance(node, dict):
        for f in SOURCE_FIELDS:
            v = node.get(f)
            if isinstance(v, str) and v.startswith("http"):
                return v
    return ""


def clean_cell(text: str) -> str:
    s = (text or "").strip()
    if not s:
        return "-"
    return s.replace("|", "\\|").replace("\n", "<br>")


def dump(v: object) -> str:
    return json.dumps(v, ensure_ascii=False)


def list_change(field: str, came: list, gone: list) -> str:
    """A scalar list's edit, rendered from the two lists themselves.

    This used to be a string `+ "A"  - "B"` that a second function split back
    apart on the first + and the first -, so a hyphenated tag like
    "Half-term" broke in two and landed half in each column. Nothing is
    re-parsed now: the lists go straight to backticks.
    """
    def tick(x: object, removed: bool) -> str:
        s = x if isinstance(x, str) else dump(x)
        t = f"`{s}`"
        return f"**{t}**" if removed and s.lower() in IMPORTANT_TAGS else t

    bits = []
    if came:
        bits.append("+ " + ", ".join(tick(x, False) for x in came))
    if gone:
        bits.append("- " + ", ".join(tick(x, True) for x in gone))
    return f"{field}: " + "; ".join(bits)


def scalar_change(field: str, old: object, new: object) -> str:
    if field.split(" / ")[-1] in SOURCE_FIELDS:
        if old is None:
            return f"{field} added"
        if new is None:
            return f"{field} removed"
        return f"{field} changed, was {old}"
    if old is None:
        return f"{field}: added {dump(new)}"
    if new is None:
        return f"{field}: removed {dump(old)}"
    a, b = dump(old), dump(new)
    if len(a) > LONG or len(b) > LONG:
        return f"{field}: text changed ({len(a)} -> {len(b)} chars)"
    return f"{field}: {a} -> {b}"


# A record is (code, name, source, depth): depth is how far down the path the
# record sits, so a field is named relative to it ("notes", not
# "tracks / esd-aviation-systems / notes").
Rec = tuple


def walk(old: object, new: object, path: list[str], rec: Rec | None,
         out: list[tuple[Rec | None, str]]) -> None:
    def field() -> str:
        return " / ".join(path[rec[3]:] if rec else path) or "(root)"

    if isinstance(old, dict) and isinstance(new, dict):
        for k in sorted(set(old) | set(new)):
            walk(old.get(k), new.get(k), path + [k], rec, out)
        return

    if isinstance(old, list) and isinstance(new, list):
        if all(not isinstance(x, (dict, list)) for x in old + new):
            came = [x for x in new if x not in old]
            gone = [x for x in old if x not in new]
            if came or gone:
                out.append((rec, list_change(field(), came, gone)))
            return
        o = {key_of(x, i): x for i, x in enumerate(old)}
        n = {key_of(x, i): x for i, x in enumerate(new)}
        for k in sorted(set(o) | set(n)):
            item = n.get(k, o.get(k))
            # The outermost keyed item is the record. A holiday inside a term
            # is a change TO the term, not a record of its own.
            sub = rec or (k, name_of(item), source_of(item), len(path) + 1)
            here = " / ".join((path + [k])[sub[3]:])
            if k not in o:
                out.append((sub, f"{here}: added" if here else "new record"))
            elif k not in n:
                out.append((sub, f"{here}: removed" if here else "removed record"))
            else:
                walk(o[k], n[k], path + [k], sub, out)
        return

    if old != new:
        out.append((rec, scalar_change(field(), old, new)))


def is_record(doc: object) -> bool:
    """A file that IS one record: a mod or a venue, keyed by its code."""
    return isinstance(doc, dict) and isinstance(doc.get("code"), str) and bool(doc["code"])


def rows_for(rel: str, old: object, new: object) -> list[dict]:
    """The table rows one changed file contributes. Pure: no git, no disk."""
    fname = rel.rsplit("/", 1)[-1]
    if old is None and new is None:
        return []
    if old is None or new is None:
        doc = new if old is None else old
        what = ("new record" if old is None else "removed record") if is_record(doc) \
            else ("new file" if old is None else "removed file")
        changes = [what]
        # The term and tags are what decide where a new mod shows up in the
        # app, and a new file is otherwise a diff nobody expands.
        if old is None and is_record(doc):
            if doc.get("term"):
                changes.append(f"term {dump(doc['term'])}")
            if isinstance(doc.get("tags"), list) and doc["tags"]:
                changes.append("tags: " + ", ".join(f"`{t}`" for t in doc["tags"]))
            if doc.get("noBatchChat"):
                changes.append("noBatchChat: true")
        code = doc["code"] if is_record(doc) else fname
        return [flag_chat({"code": code, "name": name_of(doc) if is_record(doc) else "",
                           "changes": changes, "src": source_of(doc),
                           "rank": 0 if old is None else 1})]

    top: Rec | None = None
    if is_record(new) or is_record(old):
        top = ((new if is_record(new) else old)["code"], name_of(new) or name_of(old),
               source_of(new) or source_of(old), 0)
    found: list[tuple[Rec | None, str]] = []
    walk(old, new, [], top, found)

    rows: dict[str, dict] = {}
    for rec, text in found:
        code = rec[0] if rec else fname
        row = rows.setdefault(code, {
            "code": code, "name": rec[1] if rec else "", "changes": [],
            "src": rec[2] if rec else "", "rank": 2,
        })
        if text in ("new record", "removed record"):
            row["rank"] = 0 if text == "new record" else 1
        row["changes"].append(text)
    return [flag_chat(r) for r in rows.values()]


def flag_chat(row: dict) -> dict:
    """Sort a batch-chat flip above everything, and mark it for the callout."""
    if any(c.startswith(CHAT_FIELDS) for c in row["changes"]):
        row["rank"] = -1
        row["chat"] = True
    return row


def render(rows: list[dict]) -> str:
    if not rows:
        return "No JSON under `data/` changed."
    lines = []
    chat = sorted(r["code"] for r in rows if r.get("chat"))
    if chat:
        lines += ["> [!WARNING]",
                  "> The batch-chat flag changed on " + ", ".join(f"`{c}`" for c in chat)
                  + ". It decides whether that mod's page offers a batch chat; the rows are "
                  "first in the table.", ""]
    lines += ["| code | name | change | source |", "|---|---|---|---|"]
    for r in sorted(rows, key=lambda r: (r["rank"], r.get("file", ""), r["code"])):
        link = f"[page]({r['src']})" if r["src"] else "-"
        lines.append(
            f"| {clean_cell('`' + r['code'] + '`')} | {clean_cell(r['name'])} "
            f"| {clean_cell('<br>'.join(r['changes']))} | {link} |"
        )
    return "\n".join(lines)


def at_ref(ref: str, rel: str) -> object | None:
    p = subprocess.run(["git", "show", f"{ref}:{rel}"], cwd=ROOT,
                       capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0:
        return None
    try:
        return json.loads(p.stdout)
    except ValueError:
        return None


def changed_files(base_ref: str, head_ref: str | None) -> list[str]:
    if head_ref is None and base_ref == "HEAD":
        # --untracked-files=all, because a new mod is a new file, and porcelain
        # otherwise reports a whole new directory as one line.
        p = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all", "--", "data"],
                           cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        return [ln[3:].strip().strip('"') for ln in p.stdout.splitlines() if ln.strip()]
    spec = base_ref if head_ref is None else f"{base_ref}..{head_ref}"
    p = subprocess.run(["git", "diff", "--name-only", spec, "--", "data"],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    return [ln.strip() for ln in p.stdout.splitlines() if ln.strip()]


def build_markdown_report(base_ref: str, head_ref: str | None = None) -> str:
    rows: list[dict] = []
    for rel in sorted(f for f in changed_files(base_ref, head_ref) if f.endswith(".json")):
        old = at_ref(base_ref, rel)
        if head_ref is None:
            path = ROOT / rel
            new = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        else:
            new = at_ref(head_ref, rel)
        for r in rows_for(rel, old, new):
            r["file"] = rel
            rows.append(r)
    return render(rows)


def self_check() -> int:
    bad = 0
    total = 0

    def check(what: str, ok: bool, got: object) -> None:
        nonlocal bad, total
        total += 1
        if not ok:
            bad += 1
            print(f"FAIL {what}: got {got!r}")

    check("module has a docstring, so --help has a description", bool(__doc__), __doc__)

    new_mod = {"code": "02.184", "name": "Minds, Machines, and Design",
               "sourceUrl": "https://www.sutd.edu.sg/course/02-184dh-minds/"}
    r = rows_for("data/mods/02_184.json", None, new_mod)
    check("a new mod is named from its own file, with its link",
          len(r) == 1 and r[0]["name"] == new_mod["name"] and r[0]["src"] == new_mod["sourceUrl"]
          and r[0]["changes"][0] == "new record", r)

    bare = {"code": "10.028", "name": "Something New"}
    r = rows_for("data/mods/10_028.json", None, bare)
    table = render(r)
    check("a new mod without sourceUrl gets no link and does not crash",
          r[0]["src"] == "" and table.rstrip().endswith("| - |"), table)

    old = {"code": "02.208", "name": "Microeconomics", "term": "7", "tags": ["HASS", "Term 7"]}
    new = dict(old, term="8", tags=["HASS", "Term 8", "Half-term"])
    r = rows_for("data/mods/02_208.json", old, new)
    joined = "<br>".join(r[0]["changes"]) if r else ""
    check("tags and term on one mod make ONE row", len(r) == 1, r)
    check("a hyphenated tag stays whole, on the added side",
          "+ `Term 8`, `Half-term`; - `Term 7`" in joined, joined)
    check("a term change is shown as itself", 'term: "7" -> "8"' in joined, joined)

    spec_old = {"scrapedAt": "2026-10-02", "tracks": [
        {"id": "esd-aviation-systems", "name": "Aviation Systems",
         "source": "https://www.sutd.edu.sg/esd/aviation/", "notes": "take 3 mods"},
        {"id": "csd-security", "name": "Security", "notes": "x"}]}
    spec_new = json.loads(json.dumps(spec_old))
    spec_new["tracks"][0]["notes"] = "take 4 mods"
    spec_new["scrapedAt"] = "2026-11-06"
    r = rows_for("data/specializations.json", spec_old, spec_new)
    track = [x for x in r if x["code"] == "esd-aviation-systems"]
    check("a track note edit is a row under that track, with the track's link",
          len(track) == 1 and track[0]["name"] == "Aviation Systems"
          and track[0]["src"] == "https://www.sutd.edu.sg/esd/aviation/"
          and track[0]["changes"] == ['notes: "take 3 mods" -> "take 4 mods"'], r)
    check("an untouched track is not a row", not [x for x in r if x["code"] == "csd-security"], r)

    piped = rows_for("data/mods/01_001.json", None, {"code": "01.001", "name": "A | B"})
    check("a pipe in a name is escaped, not a new column", "A \\| B" in render(piped), render(piped))

    core_old = {"code": "60.010", "name": "Some Core", "tags": ["Core"]}
    core_new = dict(core_old, noBatchChat=True, noBatchChatReason="pillar core")
    tag_only = rows_for("data/mods/10_001.json", {"code": "10.001", "tags": ["A"]},
                        {"code": "10.001", "tags": ["B"]})
    flipped = rows_for("data/mods/60_010.json", core_old, core_new)
    table = render(tag_only + flipped)
    lines = table.split("\n")
    first_row = next((ln for ln in lines if ln.startswith("| `")), "")
    check("a batch-chat flip sorts first and raises the callout",
          "`60.010`" in first_row and lines[0] == "> [!WARNING]" and "`60.010`" in lines[1], table)
    fresh_core = rows_for("data/mods/60_011.json", None, dict(core_new, code="60.011"))
    check("a new record already flagged is in the callout too",
          "`60.011`" in render(fresh_core).split("\n")[1], render(fresh_core))

    print(f"{total - bad}/{total} what_changed cases ok")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", default="HEAD", help="compare the working tree against this git ref")
    ap.add_argument("--base", default=None, help="base git ref when comparing two refs")
    ap.add_argument("--head", default=None, help="head git ref when comparing two refs")
    ap.add_argument("--out", default="", help="write the markdown here as well as stdout")
    ap.add_argument("--self-check", action="store_true", help="run the row cases, no git")
    args = ap.parse_args()

    if args.self_check:
        return self_check()

    if args.base and args.head:
        text = build_markdown_report(args.base, args.head)
    else:
        text = build_markdown_report(args.ref, None)

    if args.out:
        pathlib.Path(args.out).write_text(text, encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")  # a mod name is not always ASCII
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
