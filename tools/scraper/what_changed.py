import argparse
import html
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "data"

KEYS = ("id", "code", "name", "label")
SOURCE_FIELDS = ("source", "sourceUrl", "url")
IMPORTANT_TAGS = {"core", "freshmore core", "smt", "hass", "epd", "esd", "csd", "dai", "asd"}


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


def clean_cell(text: str) -> str:
    """Escape pipes and format markdown table cell, replacing empty/(none) with hyphen."""
    s = text.strip()
    if not s or s == "(none)":
        return "-"
    return s.replace("|", "\\|").replace("\n", "<br>")


def walk(old: object, new: object, path: list[str], src: str, out: list[tuple[str, str, str]]) -> None:
    src = source_of(new) or source_of(old) or src

    if isinstance(old, dict) and isinstance(new, dict):
        for k in sorted(set(old) | set(new)):
            walk(old.get(k), new.get(k), path + [k], src, out)
        return

    if isinstance(old, list) and isinstance(new, list):
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
                out.append((" / ".join(path + [k]), "(none) -> NEW record", source_of(n[k]) or src))
            elif k not in n:
                out.append((" / ".join(path + [k]), "REMOVED record -> (none)", source_of(o[k]) or src))
            else:
                walk(o[k], n[k], path + [k], src, out)
        return

    if old != new:
        if old is None:
            out.append((" / ".join(path), f"(none) -> {json.dumps(new, ensure_ascii=False)}", src))
        elif new is None:
            out.append((" / ".join(path), f"{json.dumps(old, ensure_ascii=False)} -> (none)", src))
        else:
            a = json.dumps(old, ensure_ascii=False)
            b = json.dumps(new, ensure_ascii=False)
            if len(a) > 120 or len(b) > 120:
                out.append((" / ".join(path), f"text changed ({len(a)} -> {len(b)} chars)", src))
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


def changed_files(base_ref: str, head_ref: str | None) -> list[str]:
    if head_ref is None:
        p = subprocess.run(["git", "status", "--porcelain", "--", "data"] if base_ref == "HEAD"
                           else ["git", "diff", "--name-only", base_ref, "--", "data"],
                           cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        if base_ref == "HEAD":
            return [ln[3:].strip() for ln in p.stdout.splitlines() if ln.strip()]
        return [ln.strip() for ln in p.stdout.splitlines() if ln.strip()]
    p = subprocess.run(["git", "diff", "--name-only", f"{base_ref}..{head_ref}", "--", "data"],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    return [ln.strip() for ln in p.stdout.splitlines() if ln.strip()]


def format_tag_diff(tag_str: str) -> tuple[str, str]:
    """Parse '+ "A", "B"  - "C"' into clean (added, removed) columns."""
    added_part, removed_part = "", ""
    if "+" in tag_str:
        rest = tag_str.split("+", 1)[1]
        if "-" in rest:
            added_part, removed_part = rest.split("-", 1)
        else:
            added_part = rest
    elif "-" in tag_str:
        removed_part = tag_str.split("-", 1)[1]

    def style_tags(raw: str, is_removed: bool = False) -> str:
        items = [t.strip().strip('"') for t in raw.split(",") if t.strip()]
        out = []
        for it in items:
            if is_removed and it.lower() in IMPORTANT_TAGS:
                out.append(f"**`{it}`**")
            else:
                out.append(f"`{it}`")
        return ", ".join(out) if out else "-"

    return style_tags(added_part), style_tags(removed_part, is_removed=True)


def build_markdown_report(base_ref: str, head_ref: str | None = None) -> str:
    files = [f for f in changed_files(base_ref, head_ref) if f.endswith(".json")]
    if not files:
        return "No JSON under `data/` changed."

    new_files: list[str] = []
    removed_files: list[str] = []
    chat_warnings: list[dict] = []
    course_updates: list[dict] = []
    new_urls_only: list[tuple[str, str]] = []  # (code, url)
    other_files: list[tuple[str, list[tuple[str, str, str]]]] = []

    for rel in sorted(files):
        old = at_ref(base_ref, rel)
        if head_ref is None:
            path = ROOT / rel
            new = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        else:
            new = at_ref(head_ref, rel)

        if new is None:
            removed_files.append(rel)
            continue
        if old is None:
            new_files.append(rel)
            continue

        out: list[tuple[str, str, str]] = []
        walk(old, new, [], "", out)
        if not out:
            continue

        if rel.startswith("data/courses/"):
            code = (new.get("code") if isinstance(new, dict) else None) or rel.replace("data/courses/", "").replace(".json", "").replace("_", ".")
            fields = {w for w, _, _ in out}

            chat_diffs = [(w, c, s) for w, c, s in out if w in ("noBatchChat", "noBatchChatReason")]
            if chat_diffs:
                src = source_of(new) or source_of(old)
                chat_warnings.append({"code": code, "rel": rel, "diffs": chat_diffs, "src": src})

            # When only sourceUrl was backfilled, collapse into summary to keep the main table scannable.
            if fields == {"sourceUrl"}:
                old_url = old.get("sourceUrl") if isinstance(old, dict) else None
                new_url = new.get("sourceUrl") if isinstance(new, dict) else None
                if old_url is None and new_url:
                    new_urls_only.append((code, new_url))
                    continue

            tag_diff = next((c for w, c, _ in out if w == "tags"), None)
            added_tags, removed_tags = format_tag_diff(tag_diff) if tag_diff else ("-", "-")
            other_diffs = [f"{w}: {c}" for w, c, _ in out if w != "tags"]
            src = source_of(new) or source_of(old)
            course_updates.append({
                "code": code,
                "rel": rel,
                "added_tags": added_tags,
                "removed_tags": removed_tags,
                "other": "<br>".join(other_diffs) if other_diffs else "-",
                "src": src,
            })
        else:
            other_files.append((rel, out))

    lines: list[str] = []
    lines.append("## Summary of Changes in `/data`\n")
    lines.append(f"- **Total files changed**: {len(files)}")
    if chat_warnings:
        lines.append(f"- **Batch chat flags modified**: {len(chat_warnings)}")
    if new_files:
        lines.append(f"- **New courses added**: {len(new_files)} ({', '.join(f'`{p}`' for p in new_files)})")
    if removed_files:
        lines.append(f"- **Courses removed**: {len(removed_files)} ({', '.join(f'`{p}`' for p in removed_files)})")
    if course_updates:
        lines.append(f"- **Course catalog updates**: {len(course_updates)}")
    if new_urls_only:
        lines.append(f"- **Only sourceUrl backfilled**: {len(new_urls_only)}")
    if other_files:
        lines.append(f"- **Other data files updated**: {len(other_files)} ({', '.join(f'`{p}`' for p, _ in other_files)})")

    if chat_warnings:
        lines.append("\n> [!WARNING]")
        lines.append("> ### Batch Chat Policy Changes")
        for item in chat_warnings:
            lines.append(f"> - `{item['code']}` (`{item['rel']}`):")
            for w, c, _ in item["diffs"]:
                lines.append(f">   - **{w}**: {c}")
            if item["src"]:
                lines.append(f">   - [source]({item['src']})")

    if new_files:
        lines.append("\n### New Files\n")
        for p in new_files:
            lines.append(f"- `{p}`")

    if removed_files:
        lines.append("\n### Removed Files\n")
        for p in removed_files:
            lines.append(f"- `{p}`")

    if course_updates:
        lines.append("\n### Course Updates\n")
        lines.append("| Course | Tags Added | Tags Removed | Other Changes | Source |")
        lines.append("| :--- | :--- | :--- | :--- | :--- |")
        for item in course_updates:
            src_link = f"[source]({item['src']})" if item["src"] else "-"
            c_code = clean_cell(f"`{item['code']}`")
            c_add = clean_cell(item["added_tags"])
            c_rem = clean_cell(item["removed_tags"])
            c_oth = clean_cell(item["other"])
            lines.append(f"| {c_code} | {c_add} | {c_rem} | {c_oth} | {src_link} |")

    if new_urls_only:
        lines.append(f"\n<details>\n<summary><b>Only sourceUrl backfilled ({len(new_urls_only)} courses)</b> - Click to expand</summary>\n")
        for code, url in new_urls_only:
            lines.append(f"- `{code}`: {url}")
        lines.append("\n</details>\n")

    if other_files:
        lines.append("\n### Other Data Files\n")
        for rel, out in other_files:
            lines.append(f"#### `{rel}`\n")
            for where, change, src in out:
                lines.append(f"- **{where or '(root)'}**: {change}")
                if src and where not in ("sourceUrl", "url") and src not in change:
                    lines.append(f"  - source: {src}")

    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ref", default="HEAD", help="compare against this git ref")
    ap.add_argument("--base", default=None, help="base git ref when comparing two refs")
    ap.add_argument("--head", default=None, help="head git ref when comparing two refs")
    ap.add_argument("--out", default="", help="write the markdown here as well as stdout")
    args = ap.parse_args()

    if args.base and args.head:
        text = build_markdown_report(args.base, args.head)
    else:
        text = build_markdown_report(args.ref, None)

    if args.out:
        pathlib.Path(args.out).write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
