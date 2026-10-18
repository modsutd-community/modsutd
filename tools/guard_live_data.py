#!/usr/bin/env python3
"""Refuse to publish a working tree that would drop what automation wrote.

    python tools/guard_live_data.py          # check, exit 1 if anything is at risk
    python tools/guard_live_data.py --take   # copy the live values in, then pass

WHY THIS EXISTS
Three files on main are written by workflows, not by a person: the batch-chat
registry, the term window, and the `schedules` inside each mod record. A
maintainer who publishes with `git reset --soft <root> && commit --amend &&
push --force` rebuilds main from their WORKING TREE, so anything a workflow
committed since their last checkout is simply gone - and `--force-with-lease`
does not catch it, because the lease only proves the remote has not moved since
the fetch, not that the tree still contains what the remote had.

That has now eaten crowdsourced slots and a Telegram registry entry, each of
which took a student's action to produce and cannot be regenerated.

Run this before publishing. `--take` is the fix in one command.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

# Each entry: the file, and how to count what it holds. Loss is any drop.
REGISTRY = "data/telegram-groups.json"
TERM_WINDOW = "data/term-window.json"


def live(path: str) -> str | None:
    """The file as origin/main has it, or None when it is absent there."""
    r = subprocess.run(
        ["git", "show", f"origin/main:{path}"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    return r.stdout if r.returncode == 0 else None


def mine(path: str) -> str | None:
    p = ROOT / path
    return p.read_text(encoding="utf-8") if p.exists() else None


def count(text: str | None, kind: str) -> int:
    if not text:
        return 0
    try:
        d = json.loads(text or "{}")
    except json.JSONDecodeError:
        return 0
    if kind == "keys":
        return len(d)
    if kind == "window":
        return 1 if d.get("end") else 0
    if kind == "schedules":
        return len(d.get("schedules") or [])
    return 0


def mod_files() -> list[str]:
    seen: set[str] = set()
    all_files: list[str] = []
    for dir_name in ("data/mods/", "data/courses/"):
        r = subprocess.run(
            ["git", "ls-tree", "--name-only", "origin/main", dir_name],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
        )
        for ln in r.stdout.splitlines():
            if ln.endswith(".json") and ln not in seen:
                seen.add(ln)
                all_files.append(ln)
    return all_files


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--take", action="store_true", help="copy the live values in and pass")
    args = ap.parse_args()

    subprocess.run(["git", "fetch", "origin", "-q"], cwd=ROOT, check=False)

    checks: list[tuple[str, str]] = [(REGISTRY, "keys"), (TERM_WINDOW, "window")]
    checks += [(f, "schedules") for f in mod_files()]

    losses: list[str] = []
    for path, kind in checks:
        local_path = path.replace("data/courses/", "data/mods/") if (ROOT / "data/mods").exists() else path
        there, here = count(live(path), kind), count(mine(local_path), kind)
        if there > here:
            losses.append(f"  {local_path}: main has {there}, this tree has {here}")
            if args.take:
                text = live(path)
                if text is not None:
                    (ROOT / local_path).write_text(text, encoding="utf-8")

    if not losses:
        print("live data intact: nothing on main would be dropped")
        return 0

    if args.take:
        print(f"took {len(losses)} file(s) back from origin/main:")
        print("\n".join(losses))
        return 0

    print("REFUSING: publishing this tree would drop what automation wrote.\n", file=sys.stderr)
    print("\n".join(losses), file=sys.stderr)
    print(
        "\nThese are crowdsourced slots, a chat registry entry, or the term window -"
        "\neach took a student's action and cannot be regenerated."
        "\nRun: python tools/guard_live_data.py --take",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
