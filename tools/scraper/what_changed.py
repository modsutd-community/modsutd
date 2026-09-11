#!/usr/bin/env python3
"""What a refresh changed in /data, named by record rather than by line.

    python tools/scraper/what_changed.py            # working tree vs HEAD
    python tools/scraper/what_changed.py --ref main

WHY THIS EXISTS
A diff hunk in a large JSON file carries no object context. `data/specializations.json`
holds 21 tracks; a hunk reading `+ "50.057"` sits in one of them and the diff
does not say which, and the nearest `"id"` line ABOVE the hunk frequently
belongs to a different record than the one being changed. Citing a change from
the hunk alone produced a PR body that named the wrong track, for a change that
was correct. A reviewer checking that citation against the page would have found
nothing and either rejected a good change or stopped trusting the citations.

So this walks the two JSON documents and reports each change with the record it
happened in and the source URL that record itself carries:

    data/specializations.json
      csd-software-engineering / track core courses (choose 2) / anyOf
        + 50.057
        https://www.sutd.edu.sg/istd/education/undergraduate/specialisation-tracks/software-engineering/

The URL is read out of the record, never composed, so the line a reviewer opens
is the page the parser actually read.

LISTS OF RECORDS ARE KEYED, NOT INDEXED. `tracks[3]` is meaningless the moment a
track is inserted above it: every later record reads as changed. A list whose
items carry `id`, `code` or `name` is matched on that instead, so an insertion
shows up as one addition.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"

# In order of preference. `id` is the stable one; `code` is what course records
# use; `name` is a last resort and can collide, which is why it is last.
KEYS = ("id", "code", "name", "label")

# Fields a record uses to say where it was read from. Printed verbatim.
SOURCE_FIELDS = ("source", "sourceUrl", "url")


def key_of(item: object, index: int) -> str:
    if isinstance(item, dict):
        for k in KEYS:
            v = item.get(k)
            if isinstance(v, str) and v:
                return v
    return f"[{index}]"


def source_of(node: object) -> str:
    if isinstance(node, dict):
        for f in SOURCE_FIELDS:
            v = node.get(f)
            if isinstance(v, str) and v.startswith("http"):
                return v
    return ""


def walk(old: object, new: object, path: list[str], src: str, out: list[tuple[str, str, str]]) -> None:
    """Append (path, change, source) for every leaf that differs."""
    src = source_of(new) or source_of(old) or src

    if isinstance(old, dict) and isinstance(new, dict):
        for k in sorted(set(old) | set(new)):
            walk(old.get(k), new.get(k), path + [k], src, out)
        return

    if isinstance(old, list) and isinstance(new, list):
        # A list of scalars is a set of values; a list of records is keyed.
        if all(not isinstance(x, (dict, list)) for x in old + new):
            gone = [x for x in old if x not in new]
            came = [x for x in new if x not in old]
            if gone or came:
                bits = []
                if came:
                    bits.append("+ " + ", ".join(json.dumps(x, ensure_ascii=False) for x in came))
                if gone:
                    bits.append("- " + ", ".join(json.dumps(x, ensure_ascii=False) for x in gone))
                out.append((" / ".join(path), "  ".join(bits), src))
            return
        o = {key_of(x, i): x for i, x in enumerate(old)}
        n = {key_of(x, i): x for i, x in enumerate(new)}
        for k in sorted(set(o) | set(n)):
            if k not in o:
                out.append((" / ".join(path + [k]), "NEW record", source_of(n[k]) or src))
            elif k not in n:
                out.append((" / ".join(path + [k]), "REMOVED record", source_of(o[k]) or src))
            else:
                walk(o[k], n[k], path + [k], src, out)
        return

    if old != new:
        if old is None:
            out.append((" / ".join(path), f"set to {json.dumps(new, ensure_ascii=False)[:120]}", src))
        elif new is None:
            out.append((" / ".join(path), "removed", src))
        else:
            a = json.dumps(old, ensure_ascii=False)
            b = json.dumps(new, ensure_ascii=False)
            if len(a) > 90 or len(b) > 90:
                out.append((" / ".join(path), "text changed", src))
            else:
                out.append((" / ".join(path), f"{a} -> {b}", src))


def at_ref(ref: str, rel: str) -> object | None:
    p = subprocess.run(["git", "show", f"{ref}:{rel}"], cwd=ROOT,
                       capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0:
        return None
    try:
        return json.loads(p.stdout)
    except ValueError:
        return None


def changed(ref: str) -> list[str]:
    p = subprocess.run(["git", "status", "--porcelain", "--", "data"] if ref == "HEAD"
                       else ["git", "diff", "--name-only", ref, "--", "data"],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if ref == "HEAD":
        return [ln[3:].strip() for ln in p.stdout.splitlines() if ln.strip()]
    return [ln.strip() for ln in p.stdout.splitlines() if ln.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ref", default="HEAD", help="compare against this git ref")
    ap.add_argument("--out", default="", help="write the markdown here as well as stdout")
    args = ap.parse_args()

    files = [f for f in changed(args.ref) if f.endswith(".json")]
    lines: list[str] = []
    if not files:
        lines.append("No JSON under `data/` changed.")
    for rel in sorted(files):
        path = ROOT / rel
        new = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        old = at_ref(args.ref, rel)
        if new is None:
            lines += [f"### {rel}", "", "file removed", ""]
            continue
        if old is None:
            lines += [f"### {rel}", "", "NEW FILE", f"source: {source_of(new) or 'none in the record'}", ""]
            continue
        out: list[tuple[str, str, str]] = []
        walk(old, new, [], "", out)
        if not out:
            continue
        lines += [f"### {rel}", ""]
        for where, change, src in out:
            lines.append(f"- **{where or '(root)'}** {change}")
            if src:
                lines.append(f"  - {src}")
        lines.append("")

    text = "\n".join(lines)
    if args.out:
        pathlib.Path(args.out).write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
