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

What the scrape could not save is counted, in the file WEB2API_STATS names.
The client cannot report a call it never received, so that file is the only
place a dropped finding leaves a trace, and the review workflow reads it.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import uuid
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
# A tool result older than the newest few is replaced by this when a prompt
# would not fit. The model can ask for the file again; it cannot ask for the
# end of a prompt it never saw.
KEEP_RECENT_RESULTS = 2
ELIDED = "[elided to fit the prompt: an older tool result. Call the tool again if you need it.]"

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
    "oversized": 0,           # a prompt past the limit even so: its end was not read
}

# How many tool_call blocks the last parse on this thread refused. Per thread
# because the handler is threaded and two reviews' turns interleave; a global
# would charge one turn with another's refusals.
_turn = threading.local()


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


def messages_to_prompt(messages: list, tools: list | None = None) -> tuple:
    """Upstream's flattening, kept under what the endpoint actually reads.

    The rules go at the FRONT. They were appended once, and the end of a long
    prompt is the part that is dropped, so the turns that most needed them
    never saw them.

    A review turn grows with every file the model reads, because the whole
    conversation is re-sent as one prompt. When it would not fit, the oldest
    tool results go first and the newest stay: what the model asked for last is
    what it is about to reason about. A prompt still too long after that is
    counted, because its tail was not read and the review of that group is not
    one to trust.
    """
    def build(msgs):
        prompt, images = _orig_messages_to_prompt(msgs, tools)
        if tools:
            prompt = f"[System instruction]: {STRICT_RULES}\n\n{prompt}"
        return prompt, images

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
    bump("oversized")
    upstream.log(f"prompt is {_size(prompt)} bytes after eliding, past the "
                 f"{SAFE_PROMPT_BYTES} the endpoint reads: its end will be dropped")
    return prompt, images


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
                 "gemini_stream_generate", "log", "main", "PROMPT_MAX_BYTES"):
        getattr(upstream, name)
    getattr(upstream.GeminiHandler, "_call_gemini")
    _orig_messages_to_prompt = upstream.messages_to_prompt
    upstream.messages_to_prompt = messages_to_prompt
    upstream.parse_tool_calls = parse_tool_calls
    upstream.GeminiHandler._call_gemini = _call_gemini


# ---------------------------------------------------------------------------


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

    if fails:
        print(f"self-check: {len(fails)} failure(s)")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("self-check: the tool-call scrape, the retries and the seams behave")
    return 0


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        sys.exit(self_check())
    install()
    upstream.main()
