"""Run the vendored gemini-web2api with the repairs a tool-driven client needs.

    python tools/ci/web2api_reviewer.py            # same flags as the vendored file
    python tools/ci/web2api_reviewer.py --self-check

The vendored proxy (gemini_web2api.py, beside this) has no function calling to
offer: Gemini's web endpoint returns text, so it asks the model to write a
fenced `tool_call` JSON block and scrapes that back out. A reviewer records a
finding ONLY through a tool call, and three things between the model and the
scrape lose it. Each was read off a real review replayed through a capturing
copy, and each ends the same way: "Review complete: 0 finding(s)", exit 0.

1. The block is the wrong shape. The model writes `{"state": "DONE"}` with no
   name, or `{"name": "task_done", "state": "DONE"}` with the parameters beside
   the name instead of under "arguments". Upstream drops the first on KeyError
   and turns the second into `{}`, which is how a `code_comment` carrying real
   findings arrived as "'comments' array is required. Got args: {}".
2. The findings are prose. On a long prompt the model analyses the diff in
   paragraphs and never writes a block at all, so the client sees a turn with
   no tool call and nothing to record.
3. Gemini's own failure page is the answer. "Sorry, something went wrong" comes
   back as an ordinary 200 and is handed over as the model's reply. Repaired on
   the path every caller here uses (non-streaming, and streaming with tools);
   a streaming request with NO tools bypasses `_call_gemini` and is untouched.

All of it is patched from outside, by replacing module attributes at import.
The vendored file stays byte-identical to upstream below its header, so a
refresh is still "replace the file whole"; if upstream renames one of the
names patched here, `install()` fails loudly at startup rather than running
the unpatched proxy and returning empty reviews again.

One request never reaches Gemini: the reviewer's grouping request is answered
here, so every file is reviewed in a prompt of its own. GROUPING_REQUEST says
why. A file whose diff is too big for one prompt even then is reviewed in
pieces, asked in parallel and merged into one answer; SPLIT_NOTE says how.

What the scrape could not save is counted, in the file WEB2API_STATS names.
The client cannot report a call it never received, so that file is the only
place a dropped finding leaves a trace, and the review workflow reads it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gemini_web2api as upstream  # noqa: E402

# What Gemini's web app says in place of an answer when a request fails on its
# side. Whole-reply and short, and each alternative runs to the end of its
# sentence: "Something went wrong with the build on line 3" is a reviewer
# talking, and matching it would throw a real answer away.
UPSTREAM_FAILURE = re.compile(
    r"^\s*(sorry, something went wrong[.!]?\s*(please try\b.*)?"
    r"|i encountered an error doing what you asked[.!]?\s*(could you try\b.*)?"
    r"|something went wrong[.!]?\s*(please try\b.*)?)\s*$",
    re.IGNORECASE | re.DOTALL,
)
UPSTREAM_FAILURE_MAX_CHARS = 200
FAILURE_ATTEMPTS = 3
FAILURE_PAUSE_S = 3

# The keys a model reaches for when it means "the tool" and "its parameters",
# and the wrappers it puts a whole call inside.
NAME_KEYS = ("name", "tool", "tool_name", "function")
ARGUMENT_KEYS = ("arguments", "parameters", "args", "input")
WRAPPER_KEYS = ("function", "tool_call", "tool")

FENCE = re.compile(r"```([A-Za-z_]*)[ \t]*\r?\n?")
# A turn the model invented: only at the start of a line, and (in the caller)
# only outside every decoded block, because a finding ABOUT this file quotes
# these labels inside its body.
SPEAKER = re.compile(r"(?m)^[ \t]*\[(?:Assistant|Tool result[^\]\n]*)\]:")

# A reply this long with no tool call is findings written as prose, not a
# model pausing to think. Shorter ones are left out of the lost-work count.
PROSE_MIN_CHARS = 400

# Gemini's web endpoint reads a prompt up to about here and silently drops the
# END of anything longer. Measured from a runner with a word planted at each
# end of a growing prompt: both read back at every size to 49 KB, the second
# was lost or invented at 54 KB, and from 67 KB the reply says the message
# "got cut off". Nothing errors, so a long review turn simply loses its newest
# messages, which are the tool results the model asked for last.
# It is the endpoint's limit and not ours to raise: upstream's own
# PROMPT_MAX_BYTES only decides when to drop tool schemas, and truncates
# nothing.
SAFE_PROMPT_BYTES = 46000
# The reviewer's request to split a pull request into review groups, which the
# proxy answers itself and never sends to Gemini. A group is reviewed in one
# prompt carrying every file in it, and nothing in that request can keep the
# prompt under SAFE_PROMPT_BYTES: it lists each file with its changed-line
# count, and line counts do not predict bytes (a rule file with four changed
# lines put 27 KB into its prompt). The model groups by theme, so a large pull
# request comes back as groups past what the endpoint reads, and the whole
# review falls through to the next provider. The reviewer's own group-size
# limit (max_tokens) cannot fix it: it counts the diff alone when it splits a
# group and the whole prompt when it checks one, so some group always lands in
# between and fails. Answering `[]` assigns no file to any group, and the
# reviewer gives every unassigned file a group of its own (grouping.go,
# open-code-review v1.13.1). One file's diff fits where a theme's does not; a
# single file too big even alone is split into pieces (SPLIT_NOTE). Matched on
# the reviewer's own wording: if it is reworded, grouping goes back to Gemini
# and an oversized group is counted, so the failure is a fallback, not a
# silent half-read review.
# Anchored to the START of the flattened prompt, which is where its system
# message lands. The reviewer sends other requests without tools - re-locating
# a comment, compressing a long conversation - and those quote a diff or a file
# read, so a review of THIS file carries the sentence in their middle. A loose
# match answered them `[]`: the comment lost its line and the conversation
# lost its summary.
GROUPING_REQUEST = re.compile(
    r"\A\[System instruction\]: You are a file grouping assistant for code review\.")
GROUPING_ANSWER = "[]"
# A tool result older than the newest few is replaced by this when a prompt
# would not fit. The model can ask for the file again; it cannot ask for the
# end of a prompt it never saw.
KEEP_RECENT_RESULTS = 2
# The most one entry in .opencodereview/rule.json may weigh. A file's rule is
# sent on every turn about that file, beside about 8 KB of tool definitions
# and 3 KB of the reviewer's own instructions, so this leaves some 28 KB of the
# 46 for the diff and what the model reads. Enforced by --self-check, in CI:
# the rules file is told to grow whenever CLAUDE.md does, and without a ceiling
# that growth is paid for out of the diff's room, one sentence at a time, with
# nothing failing. A rule at the cap is split by path, not lengthened.
RULE_MAX_BYTES = 6500
ELIDED = "[elided to fit the prompt: an older tool result. Call the tool again if you need it.]"
# The NEWEST tool results are kept, and one of them alone can be what pushes a
# turn over: a file_read returns up to 500 lines, about 22 KB of a 2000-line
# file, beside some 19 KB the reviewer sends on every turn. So when eliding
# the older ones is not enough, the newest are cut from the end, keeping whole
# lines, with this marker saying how much went. Cut only as far as leaves the
# diff PIECE_ROOM_MIN of room (or all of it, when it is smaller): a turn whose
# diff has to be split anyway gains nothing from a tool result cut to nothing.
TRUNCATED = ("[cut to fit the prompt: the last {cut} of {total} lines of this result "
             "were dropped. Ask for them again with a narrower range if you need them.]")
PIECE_ROOM_MIN = 12000

# A diff too big for one prompt, even alone, is split and reviewed in pieces.
# The reviewer cannot do it: max_tokens counts the diff alone when it splits a
# group and the whole prompt when it checks one, and one file is the smallest
# group it makes, so a single file whose diff is past what the endpoint reads
# went to the next provider whole (gather_mods.py: a 39 KB diff in a 56 KB
# prompt). Here the file's hunks are packed into pieces that each fit, every
# piece is asked in parallel with the rest of the prompt unchanged, and the
# replies are merged into the one turn the reviewer is waiting for. A hunk
# bigger than a piece is cut at a line boundary and each part gets an @@ line
# of its own, recomputed, so a comment still lands on the right line.
# What a split costs: a defect whose two halves sit in different pieces is
# seen by neither. The pieces are told they are partial so none of them
# reports a hunk it cannot see as missing.
SPLIT_CONCURRENCY = 2
# Below this, a piece holds a hunk or two and the review reads as noise; the
# turn is counted as oversized instead and the verdict falls back.
SPLIT_MIN_ROOM = 4000
# A hunk longer than this is cut into parts of at most this. Fixed rather than
# "whatever room this turn has", so the parts come out the same on every turn
# of a review and the ones already reviewed can be recognised and skipped.
HUNK_PART_MAX = 8000
SPLIT_NOTE = ("[System instruction]: This diff is too long for one prompt, so it is "
              "reviewed in {n} parts and this is part {k}. Review only the hunks shown "
              "here; the others are reviewed separately, so do not report anything as "
              "missing because it is not in this part. A hunk too long for one part is "
              "cut at a line boundary, and each part of it carries its own @@ line "
              "numbers. Call task_done when this part is reviewed.")
# The reviewer's planning request (open-code-review v1.13.6): no tools, the
# same diff, and a plain-text plan back that it pastes into every review turn.
# Split the same way, and the plans are merged into one.
PLAN_REQUEST = re.compile(
    r"\A\[System instruction\]: You are an expert in code review task planning\.")
# A file block in the reviewer's prompt. Unambiguous at line start: every line
# of a unified diff body begins with a space, +, -, @ or backslash, so a diff
# of a file that itself contains "<file path=" or "</file>" cannot fake one.
FILE_OPEN = re.compile(r'(?m)^<file path="[^"\n]*">\n(?=diff --git )')
HUNK_HEAD = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")
# How long a split review's state is kept. A later turn of the same review
# needs to know which pieces already finished; a review that died is forgotten.
SPLIT_STATE_TTL_S = 3600

# Appended to upstream's own instruction, which says only "respond with a
# tool_call block" and "only when needed". The second half is what licenses a
# page of prose in place of the call the client is waiting for.
STRICT_RULES = (
    "RULES FOR TOOL CALLS. These override anything above that conflicts.\n"
    "- Whenever you act, report or finish, your reply must contain a tool_call "
    "block. Text outside a block is discarded and never reaches anyone.\n"
    '- The block is exactly {"name": "<tool>", "arguments": {<every parameter>}}. '
    'Parameters go INSIDE "arguments", never beside "name". One call per block.\n'
    "- Never describe a problem in prose. If a tool exists for reporting it, "
    "call that tool; a finding written as a paragraph is lost.\n"
    "- Do not write the next speaker's turn. Stop after your blocks."
)

NUDGE = (
    "[System instruction]: Your last reply contained no usable tool_call block, "
    "so nothing in it was recorded. Reply again with tool_call blocks ONLY, each "
    'exactly {"name": "<tool>", "arguments": {...}} with every required '
    "parameter inside \"arguments\". If your last reply described any defect, "
    "you MUST report each one through the tool meant for reporting before you "
    "do anything else. Only if it described none, call the tool that ends the task."
)

# ---------------------------------------------------------------------------
# What was lost, for the workflow to read

_stats_lock = threading.Lock()
STATS = {
    "blocks_lost": 0,         # a tool_call block, in the reply that was USED, that
                              # could not be made into a call: a finding that is gone
    "prose_unrecovered": 0,   # long prose, asked again, still no call: findings lost
    "nudged": 0,              # a reply with no usable call was asked again
    "nudge_recovered": 0,     # ...and the second reply had one
    "failure_pages": 0,       # Gemini's failure page, retried
    "results_elided": 0,      # an older tool result dropped so the prompt fits
    "results_truncated": 0,   # a newest tool result cut from its end so the prompt fits
    "split_turns": 0,         # a turn whose diff was reviewed in pieces
    "split_pieces": 0,        # ...and how many pieces were sent for them
    "oversized": 0,           # a prompt past the limit even so: its end was not read
    "grouping_answered": 0,   # a grouping request answered here, one file per group
}

# How many tool_call blocks the last parse on this thread refused. Per thread
# because the handler is threaded and two reviews' turns interleave; a global
# would charge one turn with another's refusals.
_turn = threading.local()

# Which diff units each split review has finished, by review key. See _split_done.
_split_lock = threading.Lock()
_split_state: dict[str, dict] = {}


def bump(key: str, by: int = 1) -> None:
    """Count, and rewrite the file. Never raises: a full disk must not be the
    reason a review failed."""
    if by <= 0:
        return
    with _stats_lock:
        STATS[key] += by
        path = os.environ.get("WEB2API_STATS", "").strip()
        if not path:
            return
        try:
            tmp = f"{path}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(STATS, fh)
            os.replace(tmp, path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# The scrape


def tool_specs(tools: list | None) -> dict[str, dict]:
    """name -> {"required": set, "properties": set}, from OpenAI-shaped tools."""
    specs: dict[str, dict] = {}
    for tool in tools or []:
        fn = tool.get("function", tool) if tool.get("type") == "function" else tool
        params = fn.get("parameters") or {}
        name = fn.get("name")
        if name:
            specs[name] = {
                "required": set(params.get("required") or []),
                "properties": set((params.get("properties") or {}).keys()),
            }
    return specs


def fenced_blocks(text: str) -> list[dict]:
    """Every fenced block, as {"tag", "start", "end", "values"}.

    Fences are PAIRED, walking left to right, so a closing fence is never read
    as the opening of the next block: an unpaired reader took the brace after
    any closing fence as a tool call. `values` is every JSON object the block
    opens with, read by a real decoder from the brace rather than cut out
    fence-to-fence: a finding's body is exactly the string that contains three
    backticks, and a non-greedy regex ends inside it. strict=False because a
    model writing a two-paragraph comment by hand puts a real line break in the
    string, which strict JSON refuses.
    """
    decoder = json.JSONDecoder(strict=False)
    blocks, pos = [], 0
    while True:
        m = FENCE.search(text, pos)
        if not m:
            return blocks
        i, values = m.end(), []
        while True:
            while i < len(text) and text[i] in " \t\r\n,":
                i += 1
            if i >= len(text) or text[i] not in "{[":
                break
            try:
                value, i = decoder.raw_decode(text, i)
            except ValueError:
                break
            values.extend(v for v in (value if isinstance(value, list) else [value])
                          if isinstance(v, dict))
        # The closer is the first fence after what was decoded, which is the
        # block's real end even when a string inside it held a fence.
        close = text.find("```", i)
        end = len(text) if close < 0 else close + 3
        blocks.append({"tag": m.group(1).lower(), "start": m.start(), "end": end,
                       "values": values})
        pos = end


def _unwrap(data: dict) -> dict:
    """{"function": {"name": ..., "arguments": ...}} and its cousins, opened."""
    for key in WRAPPER_KEYS:
        inner = data.get(key)
        if isinstance(inner, dict) and any(isinstance(inner.get(k), str) for k in NAME_KEYS):
            return _unwrap(inner)
    return data


def normalise_call(data: dict, specs: dict[str, dict], lenient: bool) -> tuple[str, dict] | None:
    """(tool name, arguments) for one scraped object, or None when it is not a call.

    `lenient` is whether the block was tagged tool_call. Only there may a call
    be inferred from its shape. A ```json or untagged block is where a model
    puts EXAMPLE data, and an example that happens to fit a tool - a quoted
    `{"state": "DONE"}` - would otherwise end the review mid-sentence. Such a
    block counts only when it says outright that it is a call.

    Refuses rather than guesses at the two points a guess would be invisible:
    a name that matches no tool, and arguments missing something the tool
    requires.
    """
    data = _unwrap(data)

    def real(name):
        if not specs:
            return name
        if name in specs:
            return name
        tail = name.rsplit(".", 1)[-1]          # "default_api.task_done"
        return tail if tail in specs else None

    name, name_key = None, None
    for k in NAME_KEYS:
        if isinstance(data.get(k), str) and real(data[k]):
            name, name_key = real(data[k]), k
            break
    if name is None and any(isinstance(data.get(k), str) for k in NAME_KEYS) and specs:
        return None                              # it names something, and not a tool of ours

    arg_key = next((k for k in ARGUMENT_KEYS if k in data), None)
    args = data.get(arg_key) if arg_key else None
    if isinstance(args, str):
        try:
            args = json.loads(args, strict=False)
        except ValueError:
            args = None
    explicit = isinstance(args, dict)
    if not explicit:
        args = {}
    if not lenient and not (name and explicit):
        return None

    props = specs[name]["properties"] if (specs and name) else None
    # Parameters written beside the name. With a schema, only keys the tool
    # really takes are lifted, so a parameter that happens to be called "name"
    # or "input" survives and stray keys do not become arguments.
    for k, v in data.items():
        if k == name_key or k == arg_key or k in args:
            continue
        if props is None:
            if k not in NAME_KEYS and k not in ARGUMENT_KEYS:
                args[k] = v
        elif k in props:
            args[k] = v

    if name is None:
        if not specs:
            return None
        loose = {k: v for k, v in data.items() if k not in ARGUMENT_KEYS} if not explicit else args
        # Unnamed. Only one tool may fit, or it is dropped: two candidates is
        # a coin toss about which side effect to run.
        fits = [n for n, s in specs.items()
                if s["required"] and s["required"] <= set(loose) and set(loose) <= s["properties"]]
        if len(fits) != 1:
            return None
        name, args = fits[0], dict(loose)
    if specs and not specs[name]["required"] <= set(args):
        return None
    return name, args


def parse_tool_calls(text: str, tools: list | None = None) -> tuple[str, list]:
    """Upstream's contract - (text without the blocks, OpenAI tool_calls) - repaired."""
    specs = tool_specs(tools)
    blocks = fenced_blocks(text)

    # A model that keeps going writes the next turns of the transcript itself.
    # Whatever follows its first invented speaker label is fiction, including
    # any tool call in it. The label only counts OUTSIDE every block.
    cut = len(text)
    for m in SPEAKER.finditer(text):
        if not any(b["start"] <= m.start() < b["end"] for b in blocks):
            if any(b["end"] <= m.start() for b in blocks):
                cut = m.start()
            break

    calls, seen, spans, refused = [], set(), [], 0
    for block in blocks:
        if block["start"] >= cut:
            break
        lenient = block["tag"] == "tool_call"
        made = False
        for obj in block["values"]:
            call = normalise_call(obj, specs, lenient)
            if call is None:
                refused += lenient
                continue
            made = True
            name, args = call
            arguments = json.dumps(args, ensure_ascii=False)
            if (name, arguments) in seen:
                continue
            seen.add((name, arguments))
            calls.append({
                "id": f"call_{uuid.uuid4().hex[:8]}",
                "type": "function",
                "function": {"name": name, "arguments": arguments},
            })
        if lenient and not block["values"]:
            refused += 1
        if made:
            spans.append((block["start"], block["end"]))

    # Cut out exactly the blocks that became calls, by the spans they were
    # found at. A second regex here once left an executed block in the text,
    # which upstream then replays to the model as something it said.
    clean, last = [], 0
    for start, end in spans:
        clean.append(text[last:start])
        last = end
    clean.append(text[last:cut] if last <= cut else "")
    _turn.refused = refused
    return "".join(clean).strip(), calls


def is_upstream_failure(text: str) -> bool:
    return (len(text) <= UPSTREAM_FAILURE_MAX_CHARS and "```" not in text
            and bool(UPSTREAM_FAILURE.match(text)))


# ---------------------------------------------------------------------------
# The seams

_orig_messages_to_prompt = None


def _size(text: str) -> int:
    return len(text.encode("utf-8"))


def _compact_tools(prompt: str, tools: list) -> str:
    """The tool definitions, re-serialised without indentation.

    Upstream pretty-prints them, and they are the largest fixed thing in every
    turn: about a fifth of the block is spaces. Same definitions, same order,
    nothing reworded. Rebuilt exactly as upstream builds them so the block can
    be found by value; if a refresh changes how it is built the prompt is
    returned untouched, which costs bytes and breaks nothing.
    """
    defs = []
    for tool in tools:
        fn = tool.get("function", tool) if tool.get("type") == "function" else tool
        defs.append({
            "name": fn.get("name", tool.get("name", "")),
            "description": fn.get("description", tool.get("description", "")),
            "parameters": fn.get("parameters", tool.get("parameters", {})),
        })
    pretty = json.dumps(defs, indent=2)
    if pretty not in prompt:
        return prompt
    return prompt.replace(pretty, json.dumps(defs, separators=(",", ":"), ensure_ascii=False), 1)


def messages_to_prompt(messages: list, tools: list | None = None) -> tuple:
    """Upstream's flattening, kept under what the endpoint actually reads.

    The rules go at the FRONT. They were appended once, and the end of a long
    prompt is the part that is dropped, so the turns that most needed them
    never saw them.

    A review turn grows with every file the model reads, because the whole
    conversation is re-sent as one prompt. When it would not fit, the oldest
    tool results go first and the newest stay: what the model asked for last is
    what it is about to reason about. Still too long, the newest are cut from
    their end. Still too long, the diff itself is: it is split into pieces that
    each fit, registered on this thread for _call_gemini to fan out. Only a
    prompt none of that can bring under the limit is counted, because its tail
    was not read and the review of that group is not one to trust.
    """
    def build(msgs):
        prompt, images = _orig_messages_to_prompt(msgs, tools)
        if tools:
            prompt = _compact_tools(prompt, tools)
            prompt = f"[System instruction]: {STRICT_RULES}\n\n{prompt}"
        return prompt, images

    _turn.split = None
    prompt, images = build(messages)
    if _size(prompt) <= SAFE_PROMPT_BYTES:
        return prompt, images

    trimmed = [dict(m) for m in messages]
    results = [i for i, m in enumerate(trimmed)
               if m.get("role") == "tool" and isinstance(m.get("content"), str)]
    for i in results[:-KEEP_RECENT_RESULTS] if KEEP_RECENT_RESULTS else results:
        if len(trimmed[i]["content"]) <= len(ELIDED):
            continue
        trimmed[i]["content"] = ELIDED
        bump("results_elided")
        prompt, images = build(trimmed)
        if _size(prompt) <= SAFE_PROMPT_BYTES:
            return prompt, images

    # The newest results, cut from the end, newest first.
    region = diff_region(prompt)
    diff = _size(prompt[region[0]:region[1]]) if region else 0
    target = SAFE_PROMPT_BYTES - min(diff, PIECE_ROOM_MIN)
    for i in reversed(results):
        excess = _size(prompt) - diff - target
        if excess <= 0:
            break
        cut = truncate_result(trimmed[i]["content"], excess)
        if cut is None:
            continue
        trimmed[i]["content"] = cut
        bump("results_truncated")
        prompt, images = build(trimmed)
        region = diff_region(prompt)
        diff = _size(prompt[region[0]:region[1]]) if region else 0
    if _size(prompt) <= SAFE_PROMPT_BYTES:
        return prompt, images

    if region:
        key, done = _split_done(prompt, region, reviewing=bool(tools))
        pieces = split_prompt(prompt, region, done)
        if pieces is not None:
            _turn.split = (prompt, key, pieces)
            biggest = max((_size(p) for p, _ in pieces), default=0)
            upstream.log(f"prompt is {_size(prompt)} bytes; {len(pieces)} piece(s) of its "
                         f"diff still to review, the largest {biggest} bytes")
            return prompt, images
    bump("oversized")
    upstream.log(f"prompt is {_size(prompt)} bytes after eliding, past the "
                 f"{SAFE_PROMPT_BYTES} the endpoint reads: its end will be dropped")
    return prompt, images


def truncate_result(content: str, excess: int) -> str | None:
    """`content` shortened by at least `excess` bytes, whole lines kept from
    the top, with a marker saying how many went. None when nothing can go."""
    lines = content.split("\n")
    total = len(lines)
    budget = _size(content) - excess
    kept, used = [], 0
    for line in lines:
        cost = _size(line) + 1
        # The marker is paid for out of the same budget, sized for the worst
        # case so the result never ends up longer than asked.
        if used + cost + _size(TRUNCATED.format(cut=total, total=total)) > budget:
            break
        kept.append(line)
        used += cost
    if len(kept) == total:
        return None
    marker = TRUNCATED.format(cut=total - len(kept), total=total)
    out = "\n".join(kept + [marker])
    return out if _size(out) < _size(content) else None


def diff_region(prompt: str) -> tuple[int, int] | None:
    """(start, end) of the run of <file> blocks holding the diff, or None.

    Only in the two requests that carry the diff as the subject: a review turn,
    inside <review_files>, and the planning request. Anywhere else a <file>
    line is something the model read, not the thing under review.
    """
    if PLAN_REQUEST.match(prompt):
        m = FILE_OPEN.search(prompt)
    else:
        rf = re.search(r"(?m)^<review_files>\n", prompt)
        m = FILE_OPEN.match(prompt, rf.end()) if rf else None
    if not m:
        return None
    start = pos = m.start()
    while True:
        close = re.compile(r"(?m)^</file>\n").search(prompt, pos)
        if not close:
            return None
        pos = close.end()
        nxt = FILE_OPEN.match(prompt, pos)
        if not nxt:
            return start, pos
        pos = nxt.start()


def _files(region: str) -> list[tuple[str, str, list[str]]]:
    """(open line, header, hunks) per <file> block. A file with no hunk (a
    binary, a pure rename) is one header-only unit."""
    out = []
    for block in re.findall(r'(?ms)^(<file path="[^"\n]*">\n)(.*?)^</file>\n', region):
        opener, body = block
        parts = re.split(r"(?m)^(?=@@ )", body)
        out.append((opener, parts[0], parts[1:]))
    return out


def _cut_hunk(hunk: str, limit: int) -> list[str]:
    """One hunk as several, each at most `limit` bytes, each with a correct @@.

    The old and new positions are walked line by line: a context line moves
    both, a removal only the old, an addition only the new. That is what lets
    a comment on a line in the second part still name the real line number.
    """
    lines = hunk.split("\n")
    head = HUNK_HEAD.match(lines[0])
    body = lines[1:]
    if body and body[-1] == "":
        body.pop()
    if not head:
        return [hunk]
    old, new, tail = int(head[1]), int(head[3]), head[5]
    parts, cur, o_n, n_n, o0, n0 = [], [], 0, 0, old, new

    def flush():
        if cur:
            parts.append(f"@@ -{o0},{o_n} +{n0},{n_n} @@{tail}\n" + "\n".join(cur) + "\n")

    for ln in body:
        head_cost = len(f"@@ -{old},{o_n} +{new},{n_n} @@{tail}\n") + 24
        if cur and head_cost + sum(_size(x) + 1 for x in cur) + _size(ln) + 1 > limit:
            flush()
            cur, o_n, n_n, o0, n0 = [], 0, 0, old, new
        cur.append(ln)
        tag = ln[:1]
        if tag in (" ", ""):
            old, new, o_n, n_n = old + 1, new + 1, o_n + 1, n_n + 1
        elif tag == "-":
            old, o_n = old + 1, o_n + 1
        elif tag == "+":
            new, n_n = new + 1, n_n + 1
    flush()
    return parts


def _unit_key(opener: str, part: str) -> str:
    return hashlib.sha1((opener + part).encode("utf-8")).hexdigest()[:16]


def _split_done(prompt: str, region: tuple[int, int], reviewing: bool) -> tuple[str, set]:
    """(review key, the diff units already reviewed in this review).

    A review is several turns, each a whole new request, and the pieces of a
    split diff finish at different turns. A piece that called task_done must
    not be asked again, or it reports its findings a second time and never
    lets the review end. So what finished is remembered across requests, keyed
    on everything up to the end of the diff, which is the same on every turn
    of one review. A turn with no history yet is a review starting over (a
    retry included), and starts with nothing done. The planning request is
    one shot and keeps nothing.
    """
    if not reviewing:
        return "", set()
    key = hashlib.sha1(prompt[:region[1]].encode("utf-8")).hexdigest()
    first = not SPEAKER.search(prompt, region[1])
    now = time.time()
    with _split_lock:
        for k in [k for k, v in _split_state.items() if now - v["t"] > SPLIT_STATE_TTL_S]:
            del _split_state[k]
        if first or key not in _split_state:
            _split_state[key] = {"done": set(), "t": now}
        _split_state[key]["t"] = now
        return key, set(_split_state[key]["done"])


def split_prompt(prompt: str, region: tuple[int, int],
                 done: set | frozenset = frozenset()) -> list[tuple[str, list[str]]] | None:
    """The prompt as several, each holding part of the diff and fitting, with
    the keys of the diff units each one carries. Units in `done` are left out;
    an empty list means every unit is done.

    None when it cannot be done usefully: too little room left beside the
    rest of the prompt, or one file header alone does not fit.
    """
    start, end = region
    before, after = prompt[:start], prompt[end:]
    note = SPLIT_NOTE.format(n=99, k=99) + "\n\n"
    room = SAFE_PROMPT_BYTES - _size(before) - _size(after) - _size(note) - 64
    if room < SPLIT_MIN_ROOM:
        return None

    # Units in diff order, each tagged with its file so a piece can reopen it.
    # A long hunk is cut at HUNK_PART_MAX and not at the room this turn has, so
    # its parts, and their keys, are the same on every turn of the review.
    units: list[tuple[int, str]] = []
    files = _files(prompt[start:end])
    for f, (opener, header, hunks) in enumerate(files):
        overhead = _size(opener) + _size(header) + len("</file>\n")
        if overhead >= room:
            return None
        if not hunks:
            units.append((f, ""))
        for h in hunks:
            if overhead + _size(h) <= min(room, HUNK_PART_MAX):
                units.append((f, h))
            else:
                units += [(f, part) for part in
                          _cut_hunk(h, min(room, HUNK_PART_MAX) - overhead)]
    units = [u for u in units if _unit_key(files[u[0]][0], u[1]) not in done]
    if not units:
        return []

    pieces: list[list[tuple[int, str]]] = [[]]

    def render(piece):
        out, last = [], None
        for f, h in piece:
            if f != last:
                if last is not None:
                    out.append("</file>\n")
                out += [files[f][0], files[f][1]]
                last = f
            out.append(h)
        if last is not None:
            out.append("</file>\n")
        return "".join(out)

    for u in units:
        if pieces[-1] and _size(render(pieces[-1] + [u])) > room:
            pieces.append([])
        pieces[-1].append(u)
    n = len(pieces)
    # The note goes at the very front, where a long prompt keeps it.
    out = [(SPLIT_NOTE.format(n=n, k=k + 1) + "\n\n" + before + render(p) + after,
            [_unit_key(files[f][0], h) for f, h in p])
           for k, p in enumerate(pieces)]
    # A single line longer than a piece (minified code, a lockfile) cannot be
    # cut at a line boundary. Better counted as oversized than sent over.
    if any(_size(p) > SAFE_PROMPT_BYTES for p, _ in out):
        return None
    return out


def _ask(prompt, model_id, think_mode, file_refs, must_answer: bool):
    """One answer from Gemini, with its failure page retried.

    `must_answer` is whether a failure page on every attempt is raised or
    handed back. A tool-driven client gets the raise: the handler answers 5xx
    and the client counts a failed request, where the page as text would be a
    completed turn that found nothing. A caller with no tools gets the text,
    because the scraper's JSON reader already rejects it per call, and a raise
    there would latch the whole web route off for the rest of a refresh.
    """
    text = ""
    for attempt in range(FAILURE_ATTEMPTS):
        text = upstream.extract_response_text(
            upstream.gemini_stream_generate(prompt, model_id, think_mode, file_refs)) or ""
        if not is_upstream_failure(text):
            return text
        bump("failure_pages")
        upstream.log(f"Gemini answered with its failure page "
                     f"({attempt + 1}/{FAILURE_ATTEMPTS}): {text.strip()[:80]!r}")
        if attempt < FAILURE_ATTEMPTS - 1:
            time.sleep(FAILURE_PAUSE_S)
    if must_answer:
        raise RuntimeError("Gemini answered with its failure page on every attempt")
    return text


def _call_gemini(self, prompt, model_id, think_mode, tools, file_refs=None):
    if not tools and GROUPING_REQUEST.search(prompt):
        bump("grouping_answered")
        return GROUPING_ANSWER, None
    # Registered by messages_to_prompt on this same thread, for this prompt.
    split, _turn.split = getattr(_turn, "split", None), None
    if split and split[0] == prompt:
        return _call_split(split[1], split[2], model_id, think_mode, tools, file_refs)
    return _answer(prompt, model_id, think_mode, tools, file_refs)


TASK_DONE = "task_done"


def _done_call() -> dict:
    return {"id": f"call_{uuid.uuid4().hex[:8]}", "type": "function",
            "function": {"name": TASK_DONE, "arguments": json.dumps({"state": "DONE"})}}


def merge_plans(texts: list[str]) -> str:
    """The planning replies for each piece, as the one plan the reviewer expects.

    Its format is a "Summary:" line, an "Issues" line, then numbered issues or
    "(none)". The summaries are joined, the issues renumbered in piece order.
    A reply that does not follow the format is kept whole rather than lost.
    """
    summaries, issues, loose = [], [], []
    for text in texts:
        m = re.search(r"(?m)^Issues\s*$", text or "")
        if not m:
            if (text or "").strip():
                loose.append(text.strip())
            continue
        head = text[:m.start()].strip()
        summaries.append(re.sub(r"^Summary:\s*", "", head))
        for item in re.split(r"(?m)^(?=\d+\.\s)", text[m.end():]):
            item = item.strip()
            if re.match(r"\d+\.\s", item):
                issues.append(re.sub(r"^\d+\.", "", item, count=1).strip())
    if not summaries:
        return "\n\n".join(loose)
    out = ["Summary: " + " ".join(s for s in summaries if s), "", "Issues", ""]
    out += [f"{n}. {item}" for n, item in enumerate(issues, 1)] or ["(none)"]
    return "\n".join(out + ([""] + loose if loose else []))


def _call_split(key, pieces, model_id, think_mode, tools, file_refs):
    """One turn of a split diff: every piece still to review, asked in parallel,
    answered as one turn.

    Calls from all pieces are returned together and task_done is held back
    until every piece has called it, because the reviewer ends the review on
    the first task_done it sees. A piece that answered with no usable call even
    after the nudge counts as finished: asking it again every turn would keep
    the review from ending, and its loss is already counted by _answer.
    A piece that raises raises the turn, so the reviewer sees a failed request
    and falls back, rather than a review with a part silently missing.
    """
    if not pieces:
        return "", [_done_call()]
    bump("split_turns")
    bump("split_pieces", len(pieces))
    with ThreadPoolExecutor(max_workers=SPLIT_CONCURRENCY) as pool:
        if not tools:
            texts = list(pool.map(lambda p: _ask(p[0], model_id, think_mode, file_refs,
                                                 must_answer=False), pieces))
            return merge_plans(texts), None
        replies = list(pool.map(lambda p: _answer(p[0], model_id, think_mode, tools,
                                                  file_refs), pieces))
    texts, calls, seen, finished = [], [], set(), []
    for (_, keys), (text, got) in zip(pieces, replies):
        got = got or []
        if text:
            texts.append(text)
        if not got or any(c["function"]["name"] == TASK_DONE for c in got):
            finished += keys
        for c in got:
            sig = (c["function"]["name"], c["function"]["arguments"])
            if c["function"]["name"] == TASK_DONE or sig in seen:
                continue
            seen.add(sig)
            calls.append(c)
    with _split_lock:
        state = _split_state.get(key)
        if state is not None:
            state["done"].update(finished)
            all_done = len(finished) == sum(len(k) for _, k in pieces)
        else:
            all_done = True
    if calls:
        return "\n\n".join(texts), calls
    if all_done:
        return "\n\n".join(texts), [_done_call()]
    return "\n\n".join(texts), None


def _answer(prompt, model_id, think_mode, tools, file_refs=None):
    """One prompt, one answer: the scrape and the nudge."""
    text = _ask(prompt, model_id, think_mode, file_refs, must_answer=bool(tools))
    if not tools or not text:
        return text, None
    clean, calls = parse_tool_calls(text, tools)
    refused_first = getattr(_turn, "refused", 0)
    if calls:
        # Counted even though the turn succeeded: a block refused BESIDE an
        # accepted call is the silent case, where nothing asks again.
        bump("blocks_lost", refused_first)
        return clean, calls
    # One nudge, never a loop. A turn with no call is sometimes legitimate
    # thinking, and the client asks again on its own; the nudge exists for the
    # reply that spent its whole answer on prose findings, which the client
    # would read as "nothing to report". The first reply is already in hand,
    # so nothing the second request does - a network error included - may lose
    # it: every way out of here that is not a recovered call returns it.
    bump("nudged")
    upstream.log(f"no usable tool_call in a {len(text)}-char reply, asking once more")
    calls_again, clean_again = [], ""
    # The nudge must fit the same budget the first prompt did, or the
    # endpoint drops its end, which is the nudge itself.
    room = SAFE_PROMPT_BYTES - _size(prompt) - len(NUDGE) - 64
    if room > 200:
        try:
            again = _ask(f"{prompt}\n\n[Assistant]: {text[:room]}\n\n{NUDGE}",
                         model_id, think_mode, file_refs, must_answer=False)
            clean_again, calls_again = parse_tool_calls(again, tools)
        except Exception as exc:  # noqa: BLE001 - see the comment above
            upstream.log(f"the nudge failed ({type(exc).__name__}: {exc}), keeping the first reply")
    if calls_again:
        bump("nudge_recovered")
        bump("blocks_lost", getattr(_turn, "refused", 0))
        return clean_again, calls_again
    bump("blocks_lost", refused_first)
    if len(text) >= PROSE_MIN_CHARS:
        bump("prose_unrecovered")
    return text, None


def install() -> None:
    """Swap the seams in, or refuse to start.

    getattr with no default on purpose: a refresh of the vendored file that
    renames one of these raises here, at startup, where the workflow's
    readiness check sees a proxy that never came up and the review falls
    through to the next provider. The alternative is a proxy that starts fine
    and quietly runs upstream's parser.
    """
    global _orig_messages_to_prompt
    if _orig_messages_to_prompt is not None:
        return
    for name in ("messages_to_prompt", "parse_tool_calls", "extract_response_text",
                 "gemini_stream_generate", "gemini_stream_generate_iter", "log", "main",
                 "PROMPT_MAX_BYTES"):
        getattr(upstream, name)
    getattr(upstream.GeminiHandler, "_call_gemini")
    _orig_messages_to_prompt = upstream.messages_to_prompt
    _orig_stream_iter = upstream.gemini_stream_generate_iter
    upstream.messages_to_prompt = messages_to_prompt
    upstream.parse_tool_calls = parse_tool_calls
    upstream.GeminiHandler._call_gemini = _call_gemini

    # A streamed request with no tools skips _call_gemini. The reviewer does
    # not stream unless its extra_body asks, and ours does not, but a grouping
    # answer that depended on that would stop working the day someone does.
    def stream_iter(prompt, *args, **kwargs):
        if GROUPING_REQUEST.search(prompt):
            bump("grouping_answered")
            yield GROUPING_ANSWER
            return
        # Same reason for a split planning request: streamed, it would go out
        # whole and past the limit, and nothing would count it.
        split, _turn.split = getattr(_turn, "split", None), None
        if split and split[0] == prompt:
            model_id, think_mode = (list(args) + [None, None])[:2]
            yield _call_split(split[1], split[2], model_id, think_mode, None,
                              args[2] if len(args) > 2 else kwargs.get("file_refs"))[0]
            return
        yield from _orig_stream_iter(prompt, *args, **kwargs)
    upstream.gemini_stream_generate_iter = stream_iter


# ---------------------------------------------------------------------------


def _split_checks(tools: list, block) -> list[str]:
    """The newest-result cut and the diff split, offline. Sizes are literal:
    the fixed part of a real review turn is about 19 KB and gather_mods.py's
    diff was 39 KB, so these prompts are past the limit the same way."""
    fails: list[str] = []
    path = "tools/scraper/gather_mods.py"

    def hunk(i, ctx):
        lines = [f" context HUNK{i:02d} {j} " + "c" * 50 for j in range(ctx)]
        lines[ctx // 2:ctx // 2] = [f"-old HUNK{i:02d}", f"+new HUNK{i:02d} a", f"+new HUNK{i:02d} b"]
        start = 10 + i * 400
        return f"@@ -{start},{ctx + 1} +{start},{ctx + 2} @@ def f{i}():\n" + "\n".join(lines) + "\n"

    def review_files(hunks):
        return (f'<review_files>\n<file path="{path}">\ndiff --git a/{path} b/{path}\n'
                f"index 1111111..2222222 100644\n--- a/{path}\n+++ b/{path}\n"
                + "".join(hunks) + "</file>\n</review_files>\n")

    def body_lines(text):
        region = diff_region(text)
        if not region:
            return []
        return [ln for ln in text[region[0]:region[1]].split("\n")
                if ln[:1] in (" ", "+", "-") and not ln.startswith(("+++", "---"))]

    # 24 ordinary hunks and one of 160 lines, past HUNK_PART_MAX, so it is cut.
    hunks = [hunk(i, 18) for i in range(24)] + [hunk(99, 160)]
    pad = {"role": "system", "content": "You review code. " + "s" * 17000}
    convo = [pad, {"role": "user", "content": review_files(hunks) + "\nNow review."}]

    before = dict(STATS)
    prompt, _ = upstream.messages_to_prompt(convo, tools)
    split = getattr(_turn, "split", None)
    if _size(prompt) <= SAFE_PROMPT_BYTES:
        fails.append(f"the split fixture is only {_size(prompt)} bytes and tests nothing")
    if not split or split[0] != prompt:
        fails.append("a review turn whose diff alone is past the limit was not split")
        return fails
    pieces = split[2]
    if len(pieces) < 2:
        fails.append(f"a {_size(prompt)}-byte prompt went out as {len(pieces)} piece")
    over = [_size(p) for p, _ in pieces if _size(p) > SAFE_PROMPT_BYTES]
    if over:
        fails.append(f"split pieces past the limit: {over}")
    if STATS["oversized"] != before["oversized"]:
        fails.append("a prompt that was split was still counted as oversized")
    if sorted(body_lines(prompt)) != sorted(x for p, _ in pieces for x in body_lines(p)):
        fails.append("the pieces do not carry every diff line exactly once")
    if not all(p.startswith("[System instruction]: This diff is too long") for p, _ in pieces):
        fails.append("a piece is not told it is a part, at the front where it is kept")
    # The cut hunk's parts must carry @@ lines that count their own lines and
    # continue one another, or a comment on the second part lands off by the
    # length of the first.
    parts = []
    for p, _ in pieces:
        for h in re.split(r"(?m)^(?=@@ )", p[diff_region(p)[0]:diff_region(p)[1]])[1:]:
            if "HUNK99" not in h:
                continue
            m = HUNK_HEAD.match(h.split("\n", 1)[0])
            rows = [ln for ln in h.split("\n")[1:] if ln[:1] in (" ", "+", "-")]
            o_n = sum(ln[:1] in (" ", "-") for ln in rows)
            n_n = sum(ln[:1] in (" ", "+") for ln in rows)
            if (int(m[2]), int(m[4])) != (o_n, n_n):
                fails.append(f"a cut hunk's @@ counts {m[2]},{m[4]} but carries {o_n},{n_n}")
            parts.append((int(m[1]), o_n, int(m[3]), n_n))
    parts.sort()
    if len(parts) < 2:
        fails.append("the 160-line hunk was not cut")
    for a, b in zip(parts, parts[1:]):
        if (b[0], b[2]) != (a[0] + a[1], a[2] + a[3]):
            fails.append(f"a cut hunk's parts do not continue one another: {a} then {b}")

    # One review, three turns, Gemini scripted per piece: the piece holding
    # HUNK00 reports and finishes at once, the other reads a file first.
    real_generate, real_extract = upstream.gemini_stream_generate, upstream.extract_response_text
    upstream.extract_response_text = lambda raw: raw
    sent: list[str] = []
    comment = {"name": "code_comment", "arguments": {"comments": [{"path": path, "body": "b"}]}}
    read = {"name": "file_read", "arguments": {"file_path": path}}
    done = {"name": "task_done", "arguments": {"state": "DONE"}}

    def fake(p, *_a, **_k):
        sent.append(p)
        if "HUNK00" in p:
            return block(comment) + "\n" + block(done)
        if "[Tool result for file_read]" in p:
            return block(done)
        return block(read)

    def turn(msgs):
        sent.clear()
        p, _ = upstream.messages_to_prompt(msgs, tools)
        _, calls = _call_gemini(None, p, 1, 0, tools)
        return sorted(c["function"]["name"] for c in calls or [])

    upstream.gemini_stream_generate = fake
    try:
        got = turn(convo)
        if got != ["code_comment", "file_read"]:
            fails.append(f"turn 1 of a split review returned {got}, want the comment and "
                         f"the read with task_done held back")
        if any(_size(p) > SAFE_PROMPT_BYTES for p in sent):
            fails.append("a piece sent to Gemini was past the limit")
        history = convo + [
            {"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": "code_comment", "arguments": json.dumps(comment["arguments"])}},
                {"function": {"name": "file_read", "arguments": json.dumps(read["arguments"])}}]},
            {"role": "tool", "name": "code_comment", "content": "recorded"},
            {"role": "tool", "name": "file_read", "content": "1| import os"}]
        got = turn(history)
        if got != ["task_done"] or any("HUNK00" in p for p in sent) or not sent:
            fails.append(f"turn 2 asked {len(sent)} piece(s), one finished already "
                         f"{'included' if any('HUNK00' in p for p in sent) else 'skipped'}, "
                         f"returned {got}; want only the unfinished piece and task_done")
        got = turn(history + [{"role": "assistant", "content": "ok"}])
        if got != ["task_done"] or sent:
            fails.append(f"a turn after every piece finished asked Gemini {len(sent)} time(s)")
        turn(convo)
        if not any("HUNK00" in p for p in sent):
            fails.append("a review starting over did not ask every piece again")

        # The planning request: no tools, split the same way, one plan back.
        plan = [{"role": "system", "content": "You are an expert in code review task "
                                              "planning. " + "s" * 17000},
                {"role": "user", "content": review_files(hunks)[len("<review_files>\n"):]
                 .replace("</review_files>\n", "") + "\n### Task\nPlan it."}]
        upstream.gemini_stream_generate = lambda p, *_a, **_k: (
            sent.append(p) or "Summary: part\n\nIssues\n\n1. [low] thing\n")
        sent.clear()
        p, _ = upstream.messages_to_prompt(plan, None)
        text, _ = _call_gemini(None, p, 1, 0, None)
        if len(sent) < 2 or text.count("[low] thing") != len(sent) or "2. [low]" not in text:
            fails.append(f"the planning request went out as {len(sent)} prompt(s) and "
                         f"merged to {text[:120]!r}")
        sent.clear()
        p, _ = upstream.messages_to_prompt(plan, None)
        streamed = "".join(upstream.gemini_stream_generate_iter(p, 1, 0, None))
        if len(sent) < 2 or "2. [low]" not in streamed:
            fails.append(f"a streamed planning request went out as {len(sent)} prompt(s)")
    finally:
        upstream.gemini_stream_generate, upstream.extract_response_text = real_generate, real_extract

    merged = merge_plans(["Summary: A\n\nIssues\n\n1. [high] x\n   -> file_read a\n2. [low] y\n",
                          "Summary: B\n\nIssues\n\n(none)\n", "not a plan"])
    for want in ("Summary: A B", "1. [high] x", "-> file_read a", "2. [low] y", "not a plan"):
        if want not in merged:
            fails.append(f"merge_plans lost {want!r}: {merged!r}")

    # A newest tool result too big to keep whole, beside a diff that fits:
    # cut from its end, the prompt fits, and nothing is split.
    read_out = "\n".join(f"{n:4d}| line {n} " + "r" * 30 for n in range(1, 501))
    small = [{"role": "system", "content": "You review code. " + "s" * 26000},
             {"role": "user", "content": review_files([hunk(1, 18)])},
             {"role": "assistant", "content": "", "tool_calls": [
                 {"function": {"name": "file_read", "arguments": '{"file_path": "x"}'}}]},
             {"role": "tool", "name": "file_read", "content": read_out}]
    before = dict(STATS)
    p, _ = upstream.messages_to_prompt(small, tools)
    if _size(read_out) < 20000:
        fails.append(f"the file_read fixture is only {_size(read_out)} bytes")
    if _size(p) > SAFE_PROMPT_BYTES:
        fails.append(f"a turn with a 22 KB file_read is still {_size(p)} bytes")
    if "[cut to fit the prompt: the last" not in p or "   1| line 1 " not in p:
        fails.append("the newest tool result was not cut from its end with a marker")
    if getattr(_turn, "split", None) or STATS["oversized"] != before["oversized"]:
        fails.append("a turn that fits after cutting a tool result was split or counted")
    if small[3]["content"] != read_out:
        fails.append("cutting the tool result edited the caller's own message")

    # One line longer than any piece (a minified bundle) cannot be cut at a
    # line boundary: not split, counted as oversized, so the verdict falls back.
    minified = "@@ -1,1 +1,1 @@\n-a\n+" + "m" * 40000 + "\n"
    before = dict(STATS)
    upstream.messages_to_prompt([pad, {"role": "user", "content": review_files([minified])}], tools)
    if getattr(_turn, "split", None) or STATS["oversized"] != before["oversized"] + 1:
        fails.append("a diff line longer than any piece was split instead of counted as oversized")

    # Under the limit: nothing cut, nothing split, nothing counted.
    before = dict(STATS)
    p, _ = upstream.messages_to_prompt(small[:2], tools)
    if (getattr(_turn, "split", None) or _size(p) > SAFE_PROMPT_BYTES
            or hunk(1, 18) not in p
            or any(STATS[k] != before[k] for k in ("results_truncated", "split_turns", "oversized"))):
        fails.append("a prompt under the limit was changed")
    return fails


def self_check() -> int:
    """The scrape and the retry logic, against replies captured from real
    reviews and the shapes a review of this file turned up. No network."""
    tools = [
        {"type": "function", "function": {"name": "task_done", "parameters": {
            "properties": {"state": {}}, "required": ["state"]}}},
        {"type": "function", "function": {"name": "code_comment", "parameters": {
            "properties": {"comments": {}}, "required": ["comments"]}}},
        {"type": "function", "function": {"name": "file_read", "parameters": {
            "properties": {"file_path": {}, "start_line": {}, "end_line": {}},
            "required": ["file_path"]}}},
        {"type": "function", "function": {"name": "file_find", "parameters": {
            "properties": {"name": {}, "case_sensitive": {}}, "required": ["name"]}}},
    ]

    def block(obj, tag="tool_call"):
        return f"```{tag}\n{obj if isinstance(obj, str) else json.dumps(obj)}\n```"

    def finding(body):
        return {"comments": [{"path": "a.py", "body": body}]}

    done = ("task_done", {"state": "DONE"})
    cases = [
        ("the documented shape",
         block({"name": "task_done", "arguments": {"state": "DONE"}}), [done]),
        ("no name at all, one tool fits", block({"state": "DONE"}), [done]),
        ("parameters beside the name", block({"name": "task_done", "state": "DONE"}), [done]),
        ("a body containing three backticks",
         block({"name": "code_comment", "arguments": finding("use ```shlex.split``` here")}),
         [("code_comment", finding("use ```shlex.split``` here"))]),
        ("a body that quotes a speaker label",
         block({"name": "code_comment", "arguments": finding("the cut on [Assistant]: fires here")}),
         [("code_comment", finding("the cut on [Assistant]: fires here"))]),
        ("a body with a real line break in the string",
         block('{"name": "code_comment", "arguments": {"comments": '
               '[{"path": "a.py", "body": "Line one.\nLine two."}]}}'),
         [("code_comment", finding("Line one.\nLine two."))]),
        ("two calls in one block",
         block(json.dumps({"name": "file_read", "arguments": {"file_path": "a.py"}}) + "\n"
               + json.dumps({"name": "task_done", "arguments": {"state": "DONE"}})),
         [("file_read", {"file_path": "a.py"}), done]),
        ("an array of calls",
         block([{"name": "file_read", "arguments": {"file_path": "a.py"}},
                {"name": "task_done", "arguments": {"state": "DONE"}}]),
         [("file_read", {"file_path": "a.py"}), done]),
        ("OpenAI's nested function shape",
         block({"type": "function", "function": {"name": "task_done",
                                                 "arguments": "{\"state\": \"DONE\"}"}}), [done]),
        ("a namespaced tool name",
         block({"name": "default_api.task_done", "arguments": {"state": "DONE"}}), [done]),
        ("a parameter that is itself called name",
         block({"tool": "file_find", "name": "stats.py"}), [("file_find", {"name": "stats.py"})]),
        ("arguments missing what the tool requires",
         block({"name": "code_comment", "arguments": {}}), []),
        ("a tool that does not exist",
         block({"name": "delete_repo", "arguments": {"state": "DONE"}}), []),
        ("prose and nothing else", "The path is hardcoded on line 12, which breaks CI.", []),
        ("an example in a json block is not a call",
         "For example:\n" + block({"file_path": "data/venues/1.508.json"}, "json")
         + "\nI have not finished reading.", []),
        ("a quoted call in a bare block is not a call",
         "The docstring's example is\n" + block({"name": "task_done", "state": "DONE"}, "")
         + "\nNext I will read the parser.", []),
        ("a closing fence is not an opening one",
         "```text\nnotes\n```\n{\"state\": \"DONE\"} is what upstream drops.", []),
        ("a json block that says outright it is a call",
         block({"name": "task_done", "arguments": {"state": "DONE"}}, "json"), [done]),
        ("an invented next turn is not acted on",
         block({"state": "DONE"}) + "\n[Assistant]:\n"
         + block({"name": "file_read", "arguments": {"file_path": "x"}}), [done]),
        ("the same call twice is one call",
         block({"state": "DONE"}) + "\n" + block({"state": "DONE"}), [done]),
    ]
    fails = []
    for why, text, want in cases:
        _, calls = parse_tool_calls(text, tools)
        got = [(c["function"]["name"], json.loads(c["function"]["arguments"])) for c in calls]
        if got != want:
            fails.append(f"{why}: got {got!r}, want {want!r}")

    clean, _ = parse_tool_calls("Done. " + block({"state": "DONE"}) + " Bye.", tools)
    if "```" in clean or "DONE" in clean:
        fails.append(f"an executed block is left in the text: {clean!r}")

    for text, want, why in [
        ("Sorry, something went wrong. Please try your request again.", True,
         "Gemini's failure page"),
        ("I encountered an error doing what you asked. Could you try again?", True,
         "its other failure page"),
        ("Something went wrong with the build here: the import on line 3 is unused.", False,
         "a one-sentence answer that opens the same way is an answer"),
        ("The function returns early.", False, "an ordinary reply"),
    ]:
        if is_upstream_failure(text) is not want:
            fails.append(f"{why}: is_upstream_failure gave {not want}")

    try:
        install()
    except AttributeError as exc:
        fails.append(f"install() cannot find a seam in the vendored file: {exc}")
    else:
        prompt, _ = upstream.messages_to_prompt([{"role": "user", "content": "hi"}], tools)
        if "RULES FOR TOOL CALLS" not in prompt:
            fails.append("the strict rules are not reaching the prompt")
        plain, _ = upstream.messages_to_prompt([{"role": "user", "content": "hi"}], None)
        if "RULES FOR TOOL CALLS" in plain:
            fails.append("the strict rules are added to a request with no tools")
        if prompt.index("RULES FOR TOOL CALLS") > 40:
            fails.append("the strict rules are not at the front, where a long prompt keeps them")

        # A conversation that has read five big files. Literal sizes: 5 x 15 KB
        # cannot fit in 46 KB, and the two newest must be the ones that stay.
        convo = [{"role": "user", "content": "review this diff"}]
        for n in range(5):
            convo.append({"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": "file_read", "arguments": '{"file_path": "f%d.py"}' % n}}]})
            convo.append({"role": "tool", "name": "file_read", "content": f"FILE{n} " + "x" * 15000})
        before = dict(STATS)
        long_prompt, _ = upstream.messages_to_prompt(convo, tools)
        if len(long_prompt.encode("utf-8")) > 46000:
            fails.append(f"a long conversation is still {len(long_prompt)} bytes after eliding")
        if "FILE4 " not in long_prompt or "FILE3 " not in long_prompt:
            fails.append("the newest tool results were elided instead of the oldest")
        if "FILE0 " in long_prompt:
            fails.append("the oldest tool result survived while the prompt was over")
        if STATS["oversized"] != before["oversized"]:
            fails.append("a prompt that fits after eliding was counted as oversized")
        if "x" * 15000 not in convo[2]["content"]:
            fails.append("eliding edited the caller's own messages")
        # The tool definitions, compacted: same content, fewer bytes.
        wide = [{"type": "function", "function": {
            "name": "code_comment", "description": "Report a defect. " * 20,
            "parameters": {"type": "object", "properties": {
                "comments": {"type": "array", "items": {"type": "object", "properties": {
                    "path": {"type": "string"}, "body": {"type": "string"}}}}},
                "required": ["comments"]}}}]
        raw, _ = _orig_messages_to_prompt([{"role": "user", "content": "hi"}], wide)
        packed = _compact_tools(raw, wide)
        if len(packed) >= len(raw):
            fails.append("the tool definitions were not compacted")
        if '"required":["comments"]' not in packed or "Report a defect. " * 20 not in packed:
            fails.append("compacting the tool definitions changed what they say")

        # The reviewer's grouping request, as v1.13.1 words it and flattened
        # the way the proxy flattens it, is answered here and never reaches the
        # network. A review turn still does, and so does a request without
        # tools that quotes the sentence, as a re-location of a comment on
        # this very file would.
        grouping, _ = upstream.messages_to_prompt([
            {"role": "system", "content": "You are a file grouping assistant for code review. "
                                          "Group changed files into clusters."},
            {"role": "user", "content": "Group the following changed files:\n\n"
                                        "[0] MODIFIED   a.py (+1/-0)\n"}], None)
        quoting, _ = upstream.messages_to_prompt([
            {"role": "system", "content": "You re-locate a review comment in a diff."},
            {"role": "user", "content": '+GROUPING_REQUEST = re.compile(r"You are a file '
                                        'grouping assistant for code review.")'}], None)
        real_generate = upstream.gemini_stream_generate

        def no_network(*_a, **_k):
            raise AssertionError("reached the network")
        upstream.gemini_stream_generate = no_network
        try:
            answer = _call_gemini(None, grouping, 1, 0, None)
            streamed = "".join(upstream.gemini_stream_generate_iter(grouping, 1, 0))
            if answer != (GROUPING_ANSWER, None) or streamed != GROUPING_ANSWER:
                fails.append(f"the grouping request was not answered with one group per file: {answer!r} {streamed!r}")
            for name, prompt, with_tools in (("a review turn", "review this diff", tools),
                                             ("a request quoting the sentence", quoting, None)):
                try:
                    _call_gemini(None, prompt, 1, 0, with_tools)
                    fails.append(f"{name} was answered without asking Gemini")
                except AssertionError:
                    pass
        except AssertionError:
            fails.append("the grouping request was sent to Gemini")
        finally:
            upstream.gemini_stream_generate = real_generate

        huge = [{"role": "user", "content": "d" * 60000}]
        upstream.messages_to_prompt(huge, tools)
        if STATS["oversized"] != before["oversized"] + 1:
            fails.append("a prompt nothing can shrink was not counted as oversized")

        # The retry logic, with Gemini replaced by a script of replies.
        real_generate, real_extract, real_sleep = (
            upstream.gemini_stream_generate, upstream.extract_response_text, time.sleep)
        time.sleep = lambda s: None
        upstream.extract_response_text = lambda raw: raw
        prose = "The path on line 8 is hardcoded to one machine. " * 12
        page = "Sorry, something went wrong. Please try your request again."

        def run(replies, with_tools=True):
            script = list(replies)

            def fake(prompt, model_id, think_mode, file_refs=None):
                item = script.pop(0)
                if isinstance(item, Exception):
                    raise item
                return item
            upstream.gemini_stream_generate = fake
            try:
                return _call_gemini(None, "p", 1, 4, tools if with_tools else None)
            except Exception as exc:  # noqa: BLE001
                return exc

        for why, replies, with_tools, check in [
            ("prose, then the call on the nudge",
             [prose, block({"name": "code_comment", "arguments": finding("x")})], True,
             lambda r: isinstance(r, tuple) and r[1] and r[1][0]["function"]["name"] == "code_comment"),
            ("a network error on the nudge keeps the first reply",
             [prose, OSError("connection reset")], True,
             lambda r: r == (prose, None)),
            ("the failure page twice, then an answer",
             [page, page, block({"state": "DONE"})], True,
             lambda r: isinstance(r, tuple) and r[1] and r[1][0]["function"]["name"] == "task_done"),
            ("the failure page every time is an error for a tool client",
             [page, page, page], True, lambda r: isinstance(r, RuntimeError)),
            ("and plain text for a caller with no tools",
             [page, page, page], False, lambda r: r == (page, None)),
        ]:
            got = run(replies, with_tools)
            if not check(got):
                fails.append(f"{why}: got {got!r}")
        upstream.gemini_stream_generate, upstream.extract_response_text, time.sleep = (
            real_generate, real_extract, real_sleep)
        fails += _split_checks(tools, block)

    # The reviewer's rules, against the room they are paid for out of.
    rules_path = Path(__file__).resolve().parents[2] / ".opencodereview" / "rule.json"
    try:
        rules = json.loads(rules_path.read_text(encoding="utf-8"))["rules"]
    except (OSError, ValueError, KeyError) as exc:
        fails.append(f"cannot read {rules_path.name}: {exc}")
    else:
        for rule in rules:
            weight = len(rule["rule"].encode("utf-8"))
            if weight > RULE_MAX_BYTES:
                fails.append(
                    f"the rule for {rule['path']} is {weight} bytes, over the {RULE_MAX_BYTES} "
                    f"a rule may weigh. It is sent on every turn about a matching file, out "
                    f"of the 46 KB the endpoint reads. Split it by path (a narrower glob "
                    f"ABOVE this one, carrying only what those files need) or cut it.")

    if fails:
        print(f"self-check: {len(fails)} failure(s)")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("self-check: the tool-call scrape, the retries, the seams and the rule budget behave")
    return 0


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        sys.exit(self_check())
    install()
    upstream.main()
