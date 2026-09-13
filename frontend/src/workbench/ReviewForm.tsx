import {useEffect, useRef, useState} from "react";
import type {Mod} from "@/types";
import {
    useGithubLink,
    startDeviceFlow,
    pollForToken,
    postReview,
    DeviceStart,
} from "./sync";
import {buildBody} from "@/utils/reviewBody";
import wb from "./wb.module.scss";
import styles from "./ReviewForm.module.scss";

const TERMS = Array.from({length: 10}, (_, i) => `T${i + 1}`);
const YEARS = (() => {
    const y = new Date().getFullYear();
    return Array.from({length: 10}, (_, i) => `${y - i}`);
})();
const CHIP_FIELDS = [
    {label: "Difficulty (1-5)", options: ["1", "2", "3", "4", "5"]},
    {
        label: "Workload (lighter / as-stated / heavier)",
        options: ["lighter", "as-stated", "heavier"],
    },
] as const;
/**
 * Enter starts a bullet.
 *
 * A student writing three things about a course writes three lines, and three
 * lines of plain text are one paragraph on GitHub. Rather than teach markdown
 * in a placeholder, the newline brings its own "- ".
 *
 * Already starting with "-" is left alone, so holding Enter does not build
 * "- - - ". The dash is inserted at the caret rather than appended, because a
 * student who goes back to split an earlier line should get a bullet there too.
 */
function bulletOnEnter(
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    set: (v: string) => void,
) {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.currentTarget;
    const {selectionStart: start, selectionEnd: end, value} = el;
    // What will LAND on the new line: the text after the caret, up to the end
    // of the current line. Pressing Enter at the end of a line lands nothing
    // there, so it gets a dash; pressing it just before an existing "- "
    // carries that dash down and must not get a second.
    //
    // The old guard also required the caret to sit at a line end, so Enter
    // between two bullets inserted a bare blank line instead of a third.
    const tail = value.slice(end);
    const lands = tail.split("\n")[0] ?? "";
    if (/^\s*-\s/.test(lands)) return;

    e.preventDefault();
    const insert = "\n- ";
    const next = value.slice(0, start) + insert + tail;
    set(next);
    // React owns the value, so the caret has to be put back after the paint or
    // it jumps to the end of the field on every newline.
    requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + insert.length;
    });
}

const LONG_FIELDS = [
    "Best part",
    "Worst part",
    "Tips for future students",
] as const;

// Shown on hover and to screen readers, so the answer arrives where the
// question gets asked rather than in a docs page nobody opens.
const ANON_WHY =
    "Anonymous posts would require moderation " +
    "to prevent bad content and spam. This site is run by " +
    "students, please consider writing legitimate reviews, (or use a throwaway GitHub account: your cohort won't know, GitHub will.)";

// Half-written reviews survive a switch to another mod and back - losing one
// to a stray click is the fastest way to stop someone writing a second. Kept
// per mod, cleared when that mod's review is actually posted, and left on the
// device: it is the student's own unpublished text and never leaves.
const DRAFT_KEY = "modsutd.review.drafts.v1";

type Draft = {vals: Record<string, string>; text: string};

function readDrafts(): Record<string, Draft> {
    try {
        return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as Record<
            string,
            Draft
        >;
    } catch {
        return {};
    }
}

function writeDraft(code: string, draft: Draft | null): void {
    try {
        const all = readDrafts();
        // An empty draft is an absent draft, so switching away from an untouched
        // form never leaves a husk behind.
        if (
            draft &&
            (draft.text.trim() ||
                Object.values(draft.vals).some((v) => v.trim()))
        ) {
            all[code] = draft;
        } else {
            delete all[code];
        }
        localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
    } catch {
        // storage full or blocked - drafts are a convenience, never a requirement
    }
}

// Without a linked account a student still needs a real thread to comment in,
// and GitHub's composer can only create a discussion whose BODY is their text -
// which giscus never renders. So the server opens an empty thread and we land
// them on it with their answers already copied.
async function openThread(mod: Mod): Promise<string> {
    const r = await fetch("/api/review-thread", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({mod: mod.code, name: mod.name}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url)
        throw new Error(
            j.error || `could not open the thread (HTTP ${r.status})`,
        );
    return j.url as string;
}

// The one structured review form: fixed markdown labels, easy pickers,
// posts as the student via the GitHub link (composer fallback unlinked).
// Used by the review panel and every mod page.
export function ReviewForm({
    mod,
    prefillText,
    threadUrl,
    onPosted,
}: {
    mod: Mod;
    prefillText?: string;
    // Fired after a review is posted through the API, so the giscus embed can
    // be rebuilt - it has no way of noticing a comment it did not create.
    onPosted?: () => void;
    // The discussion giscus already resolved for this mod, when there is one.
    threadUrl?: string | null;
}) {
    const linked = useGithubLink();
    const [vals, setVals] = useState<Record<string, string>>(
        () => readDrafts()[mod.code]?.vals ?? {},
    );
    // An arriving prefill outranks a stored draft. The bookmarklet is an explicit
    // "review this, with this text" - a draft is only there to survive a stray
    // click, and letting it win made the bookmarklet look like it did nothing.
    const [text, setText] = useState(
        () => prefillText ?? readDrafts()[mod.code]?.text ?? "",
    );
    const [device, setDevice] = useState<DeviceStart | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [postedUrl, setPostedUrl] = useState<string | null>(null);
    const [threadFallback, setThreadFallback] = useState<string | null>(null);

    useEffect(() => {
        if (prefillText) setText((cur) => cur || prefillText);
    }, [prefillText]);

    // Switching mods must not carry answers across - that is how a review about
    // one class ends up filed against another - but it must not throw them away
    // either. The outgoing mod's draft is stored and the incoming one restored.
    const codeRef = useRef(mod.code);
    useEffect(() => {
        const leaving = codeRef.current;
        if (leaving !== mod.code) {
            writeDraft(leaving, {vals, text});
            codeRef.current = mod.code;
            const draft = readDrafts()[mod.code];
            setVals(draft?.vals ?? {});
            setText(draft?.text ?? "");
        }
        setPostedUrl(null);
        setThreadFallback(null);
        setStatus(null);
        // vals/text are read here but must not retrigger this - it fires on a mod
        // change only, and depending on them would save on every keystroke.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mod.code]);

    // Keep the draft current so a reload or an unmount does not lose it.
    useEffect(() => {
        writeDraft(mod.code, {vals, text});
    }, [mod.code, vals, text]);

    const set = (label: string, v: string) =>
        setVals((cur) => ({...cur, [label]: v}));
    const setTerm = (part: "term" | "ay", v: string) => {
        setVals((cur) => {
            const [t = "", a = ""] = (cur["Term taken"] ?? ", ").split(", ");
            const term = part === "term" ? v : t;
            const ay = part === "ay" ? v : a;
            return {...cur, "Term taken": term || ay ? `${term}, ${ay}` : ""};
        });
    };
    const [termSel = "", aySel = ""] = (vals["Term taken"] ?? ", ").split(", ");

    // Blank fields are dropped, so a form nobody filled in now builds to nothing
    // at all - and neither path should send an empty comment.
    const body = buildBody(vals, text);

    return (
        <div className={styles.form} data-act="review-form">
            <div className={styles.field}>
                <span className={styles.label}>Term taken</span>
                <div className={styles.selRow}>
                    <select
                        className={styles.input}
                        value={termSel}
                        aria-label="term taken"
                        onChange={(e) => setTerm("term", e.target.value)}
                    >
                        <option value="">term…</option>
                        {TERMS.map((t) => (
                            <option key={t} value={t}>
                                {t}
                            </option>
                        ))}
                    </select>
                    <select
                        className={styles.input}
                        value={aySel}
                        aria-label="academic year"
                        onChange={(e) => setTerm("ay", e.target.value)}
                    >
                        <option value="">year…</option>
                        {YEARS.map((y) => (
                            <option key={y} value={y}>
                                {y}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            <label className={styles.field}>
                <span className={styles.label}>Results (optional)</span>
                <input
                    className={styles.input}
                    value={vals["Results (optional)"] ?? ""}
                    placeholder="only if you want to share"
                    onChange={(e) => set("Results (optional)", e.target.value)}
                />
            </label>

            {CHIP_FIELDS.map(({label, options}) => (
                <div
                    key={label}
                    className={styles.field}
                    role="radiogroup"
                    aria-label={label}
                >
                    <span className={styles.label}>{label}</span>
                    <div className={styles.chips}>
                        {options.map((o) => (
                            <button
                                key={o}
                                type="button"
                                className={`${wb.chip} ${vals[label] === o ? wb.chipOn : ""}`}
                                aria-pressed={vals[label] === o}
                                onClick={() =>
                                    set(label, vals[label] === o ? "" : o)
                                }
                            >
                                {o}
                            </button>
                        ))}
                    </div>
                </div>
            ))}

            {LONG_FIELDS.map((label) => (
                <label key={label} className={styles.field}>
                    <span className={styles.label}>{label}</span>
                    <textarea
                        className={styles.area}
                        rows={2}
                        value={vals[label] ?? ""}
                        onChange={(e) => set(label, e.target.value)}
                        onKeyDown={(e) => bulletOnEnter(e, (v) => set(label, v))}
                    />
                </label>
            ))}

            <label className={styles.field}>
                <span className={styles.label}>In your own words</span>
                <textarea
                    className={styles.area}
                    rows={4}
                    value={text}
                    placeholder="or paste your term eval (the bookmarklet auto fills this)"
                    aria-label="review body"
                    onChange={(e) => setText(e.target.value)}
                />
            </label>

            {/* Deliberately disabled, not missing. Anonymous prose would have to be
          read by a human before it went up - and pre-publication review is
          what makes the site the publisher rather than the host. That is a
          promise one graduating student cannot keep, so it is not offered. */}
            <label className={styles.anonRow} data-tip={ANON_WHY}>
                <input type="checkbox" disabled aria-describedby="anon-why" />
                <span>contribute anonymously</span>
            </label>
            {/* The reason lives in a tooltip, which ::after content does not reliably
          expose to a screen reader - so it is carried here too, for the
          aria-describedby above to resolve against. */}
            <p id="anon-why" className={styles.anonWhy}>
                {ANON_WHY}
            </p>

            {linked ? (
                <button
                    type="button"
                    className={wb.btn}
                    disabled={!!postedUrl || !body}
                    onClick={async () => {
                        try {
                            setStatus("posting…");
                            const link = await postReview(
                                mod.code,
                                mod.name,
                                body,
                            );
                            setPostedUrl(link);
                            setStatus(null);
                            // Leaving the answers behind invites an accidental second post of
                            // the same review, and reads as if it had not sent.
                            setVals({});
                            setText("");
                            writeDraft(mod.code, null);
                            onPosted?.();
                        } catch (e) {
                            setStatus(`✗ ${(e as Error).message}`);
                        }
                    }}
                >
                    {postedUrl ? "✓ posted" : "post review"}
                </button>
            ) : !device ? (
                <>
                    {/* Linking deliberately does not post. The token arrives by polling,
              so it can land while the student is still on GitHub - and someone
              who clicked here to find out what linking involves would come back
              to an unfinished review already public under their real name. The
              "1-click" is every review after this one. */}
                    <button
                        type="button"
                        className={wb.btn}
                        onClick={async () => {
                            try {
                                const d = await startDeviceFlow();
                                setDevice(d);
                                setStatus(null);
                                pollForToken(d)
                                    .then(() => setDevice(null))
                                    .catch((e) => {
                                        setDevice(null);
                                        setStatus(`✗ ${(e as Error).message}`);
                                    });
                            } catch (e) {
                                setStatus(`✗ ${(e as Error).message}`);
                            }
                        }}
                    >
                        Link GitHub once to post in 1-click
                    </button>
                    <p className={styles.note}>
                        <>
                            or without linking:{" "}
                            <button
                                type="button"
                                className={styles.linkish}
                                data-act="open-review-thread"
                                disabled={!body}
                                onClick={async () => {
                                    try {
                                        setStatus("opening the thread…");
                                        // The clipboard write has to happen inside the click, or
                                        // Safari drops the permission by the time the fetch lands.
                                        // Absent entirely on an insecure origin, where reading the
                                        // property is fine but calling it throws - which used to
                                        // take the whole flow down, thread and all.
                                        let copied = false;
                                        const copy = navigator.clipboard
                                            ? navigator.clipboard
                                                  .writeText(body)
                                                  .then(() => {
                                                      copied = true;
                                                  })
                                                  .catch(() => {})
                                            : Promise.resolve();
                                        const url =
                                            threadUrl ??
                                            (await openThread(mod));
                                        await copy;
                                        // GitHub's query parameters create issues and discussions;
                                        // there is none that fills the comment box on an existing
                                        // one. So the clipboard is as close as this path gets -
                                        // posting it for them needs a token, which is the link
                                        // button right above.
                                        //
                                        // The answers stay in the form on purpose. They exist only
                                        // on the clipboard now, one copy away from being lost, and
                                        // a student who did not notice the copy would be left with
                                        // an empty form and no idea where their review went.
                                        if (!copied) {
                                            // The thread tells them to paste something that is not on
                                            // their clipboard, so sending them there is worse than
                                            // keeping them here with the link and their answers.
                                            setThreadFallback(url);
                                            setStatus(
                                                "✗ could not reach the clipboard - copy your answers above, then open the thread",
                                            );
                                            return;
                                        }
                                        setStatus(
                                            "copied - paste it into the comment box on GitHub, then press Comment",
                                        );
                                        window.open(
                                            url,
                                            "_blank",
                                            "noopener,noreferrer",
                                        );
                                    } catch (e) {
                                        setStatus(`✗ ${(e as Error).message}`);
                                    }
                                }}
                            >
                                Post it yourself in the thread →
                            </button>
                            <br />
                        </>
                    </p>
                </>
            ) : null}
            {device && (
                <p className={styles.note}>
                    enter <strong>{device.user_code}</strong> at{" "}
                    <a
                        href={device.verification_uri}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {device.verification_uri}
                    </a>{" "}
                    - waiting…
                </p>
            )}
            {threadFallback && (
                <p className={styles.note}>
                    <a
                        href={threadFallback}
                        data-act="thread-fallback"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        open the thread →
                    </a>
                </p>
            )}
            {postedUrl && (
                <p className={styles.note}>
                    live on the mod page and{" "}
                    <a
                        href={postedUrl}
                        data-act="view-posted-review"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        on github →
                    </a>
                </p>
            )}
            {status && <p className={styles.note}>{status}</p>}
        </div>
    );
}
