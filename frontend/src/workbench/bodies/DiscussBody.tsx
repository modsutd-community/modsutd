import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {Giscus} from "@/components/Giscus/Giscus";
import {GISCUS_CONFIG, DISCUSS_THEME, giscusWired} from "@/config/giscus";
import wb from "../wb.module.scss";
import styles from "./DiscussBody.module.scss";
import featureTemplate from "../../../../.github/ISSUE_TEMPLATE/Feature_Request.md?raw";
import bugTemplate from "../../../../.github/ISSUE_TEMPLATE/Bug_Report.md?raw";

const REPO = "modsutd-community/modsutd";

type Kind = "feature" | "bug";

// The same two files GitHub serves at /issues/new?template=Feature_Request.md,
// imported rather than fetched or copied. One source of truth, no network, and
// it works on localhost - which reading them through the contents API did not,
// because a template only reaches that API once it is on the default branch.
//
// Deliberately not a link to the issue form either. A reader who clicks one
// files an issue, and this panel exists so they do not have to.
const TEMPLATES: Record<Kind, string> = {
    feature: featureTemplate,
    bug: bugTemplate,
};

// Each tab is its own board. giscus scopes to one category per embed, so
// switching tabs switches the category AND the thread - "the site should do X"
// and "X is broken" are read by different people on different days.
const BOARD: Record<
    Kind,
    {category: keyof typeof GISCUS_CONFIG.categories; term: string}
> = {
    feature: {category: "features", term: "features"},
    bug: {category: "bugs", term: "bugs"},
};

// How old a board's contents may be before it is worth rebuilding.
const STALE_MS = 60_000;
// How often to look, while a board is on screen. Every refresh is a fresh load
// of giscus.app and a GitHub query behind it, so this is as often as is polite
// rather than as often as is possible.
const POLL_MS = 120_000;
// A rebuild throws away whatever is in giscus's box, which may be a
// half-written report. The box is cross-origin so its contents cannot be read,
// but focus can: to type in it you have to be in it. Anyone who has been in the
// box this recently is left alone.
const DRAFT_GRACE_MS = 10 * 60_000;

// Everything above the second `---` is GitHub's frontmatter: name, about,
// labels. It configures the issue form and is not part of what you write.
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

function body(markdown: string): string {
    const m = FRONTMATTER.exec(markdown);
    return (m ? markdown.slice(m[0].length) : markdown).trim();
}

// One board's embed. `gen` is only there to be a React key: bumping it builds
// a second frame rather than re-pointing the one on screen, which is what makes
// a refresh invisible.
function Board({
    kind,
    gen,
    onReady,
    eager,
}: {
    kind: Kind;
    gen: number;
    onReady: () => void;
    // The copy loading behind the one on screen has to be eager. A lazy iframe
    // that is display:none is never near the viewport, so the browser never
    // fetches it and the swap never comes.
    eager?: boolean;
}) {
    const board = BOARD[kind];
    return (
        <Giscus
            key={gen}
            repo={GISCUS_CONFIG.repo}
            repoId={GISCUS_CONFIG.repoId}
            category={GISCUS_CONFIG.categories[board.category].name}
            categoryId={GISCUS_CONFIG.categories[board.category].id}
            mapping="specific"
            term={board.term}
            reactionsEnabled="1"
            emitMetadata="0"
            inputPosition="top"
            lang="en"
            loading={eager ? "eager" : "lazy"}
            themeUrl={DISCUSS_THEME}
            onReady={onReady}
        />
    );
}

export function DiscussBody() {
    const wired = giscusWired();
    const [kind, setKind] = useState<Kind>("feature");
    const text = useMemo(() => body(TEMPLATES[kind]), [kind]);
    const [copied, setCopied] = useState(false);
    // Which boards have ever been opened. Each one's frame is built the first
    // time you ask for it and then stays mounted, hidden - giscus is a
    // cross-origin iframe, so unmounting it means a full reload on the way
    // back, and switching tabs used to pay for one every time.
    const [seen, setSeen] = useState<Kind[]>(["feature"]);

    // giscus fetches a thread once and never polls, so a board left open shows
    // what it fetched - somebody else's new comment is simply not there. The
    // only way to see it is to build the frame again.
    //
    // Which is why it is not on a timer. A rebuild throws away whatever is in
    // giscus's box, and that is somebody's half-written report. It happens on
    // the way IN to a board instead - switching tabs, or coming back to the
    // browser tab - where nobody is mid-sentence.
    // The generation on screen, and the one loading behind it. Two frames for a
    // moment, so the refresh has nothing visible to it: the old thread stays up
    // until the new one says it has laid itself out.
    const [live, setLive] = useState<Record<Kind, number>>({feature: 0, bug: 0});
    const [pending, setPending] = useState<Partial<Record<Kind, number>>>({});
    const loadedAt = useRef<Partial<Record<Kind, number>>>({});

    // When focus was last inside each board's frame.
    const touchedAt = useRef<Partial<Record<Kind, number>>>({});
    const drafting = useRef(false);

    const refreshIfStale = useCallback((k: Kind) => {
        const at = loadedAt.current[k];
        if (at === undefined || Date.now() - at < STALE_MS) return;
        // Somebody is writing, or just was. Their words beat a fresher thread.
        if (drafting.current) return;
        const touched = touchedAt.current[k];
        if (touched !== undefined && Date.now() - touched < DRAFT_GRACE_MS) return;
        setPending((cur) => (cur[k] !== undefined ? cur : {...cur, [k]: Date.now()}));
    }, []);

    useEffect(() => setCopied(false), [kind]);

    // Focus moving INTO a cross-origin iframe shows up here as the window
    // losing focus while the iframe is the active element. It is the only
    // signal this side gets that someone is typing in there.
    useEffect(() => {
        const enter = () => {
            const el = document.activeElement;
            if (!(el instanceof HTMLIFrameElement) || el.title !== "Comments") {
                drafting.current = false;
                return;
            }
            const board = el.closest<HTMLElement>('[data-act^="board-"]');
            const k = board?.dataset.act?.split("-")[1] as Kind | undefined;
            if (!k) return;
            drafting.current = true;
            touchedAt.current[k] = Date.now();
        };
        const leave = () => {
            if (drafting.current) {
                // Stamp again on the way out, so the grace period runs from
                // when they stopped rather than from when they started.
                const el = document.activeElement;
                const board = el?.closest?.<HTMLElement>('[data-act^="board-"]');
                const k = board?.dataset.act?.split("-")[1] as Kind | undefined;
                if (k) touchedAt.current[k] = Date.now();
            }
            drafting.current = false;
        };
        window.addEventListener("blur", enter);
        window.addEventListener("focus", leave);
        return () => {
            window.removeEventListener("blur", enter);
            window.removeEventListener("focus", leave);
        };
    }, []);

    // While a board is up, look for new comments on a slow loop. giscus never
    // polls, so without this a board left open shows what it fetched and
    // nothing anyone has said since.
    useEffect(() => {
        const tick = () => {
            if (document.visibilityState !== "visible") return;
            refreshIfStale(kind);
        };
        const id = setInterval(tick, POLL_MS);
        document.addEventListener("visibilitychange", tick);
        return () => {
            clearInterval(id);
            document.removeEventListener("visibilitychange", tick);
        };
    }, [kind, refreshIfStale]);

    const show = (k: Kind) => {
        setKind(k);
        setSeen((cur) => (cur.includes(k) ? cur : [...cur, k]));
        refreshIfStale(k);
    };

    // A frame has laid itself out. The one on screen is only reporting when it
    // last loaded; the one loading behind it takes over.
    const ready = useCallback((k: Kind, gen: number, isPending: boolean) => {
        loadedAt.current[k] = Date.now();
        if (!isPending) return;
        setLive((cur) => ({...cur, [k]: gen}));
        setPending((cur) => {
            const {[k]: _gone, ...rest} = cur;
            return rest;
        });
    }, []);

    const copy = () => {
        void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    return (
        <div className={`${wb.scroll} ${styles.wrap}`}>
            <div className={styles.steps}>
                <div>
                    <span className={wb.amber}>1.</span> 1 idea per post
                </div>
                <div>
                    <span className={wb.amber}>2.</span> react - 👍 support · 👀
                    track · 🎉 shipped. · 😕 declined.
                </div>
            </div>

            <hr className={wb.hr} />
            <div className={styles.rules}>
                <div className={wb.eyebrow}>SOME RULES</div>
                <ul>
                    <li>be as specific as possible.</li>
                    <li>look first - your idea probably has a thread.</li>
                    <li>be patient - the maintainers are also studying.</li>
                </ul>
            </div>

            <div
                className={styles.kinds}
                role="tablist"
                aria-label="what you are posting"
            >
                {(Object.keys(TEMPLATES) as Kind[]).map((k) => (
                    <button
                        key={k}
                        type="button"
                        role="tab"
                        aria-selected={kind === k}
                        className={`${styles.kind} ${kind === k ? styles.kindOn : ""}`}
                        onClick={() => show(k)}
                        data-act={`discuss-${k}`}
                    >
                        {k === "feature" ? "Feature" : "Bug"}
                    </button>
                ))}
            </div>

            {/* The comment box below is giscus's own frame, on giscus.app, so
                nothing here can type into it. Copy is the honest affordance. */}
            {/* The template is not shown. It is a page of headings, and a
                page of headings above the box you are meant to type in reads
                as the form itself rather than as something to take with you. */}
            <button
                type="button"
                className={styles.copy}
                onClick={copy}
                data-act="discuss-copy"
            >
                <svg
                    className={styles.copyIcon}
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                    focusable="false"
                >
                    <rect x="5.5" y="1.5" width="9" height="11" rx="1.5" />
                    <path d="M10.5 14.5h-8a1 1 0 0 1-1-1v-9" />
                </svg>
                {copied ? "Copied ✓" : "Click to copy the template❗"}
            </button>

            {wired ? (
                seen.map((k) => (
                    // Hidden, not unmounted. Unmounting a cross-origin iframe
                    // throws away everything it loaded, so coming back to a tab
                    // paid for the whole board again.
                    <div
                        key={k}
                        className={styles.board}
                        hidden={k !== kind}
                        data-act={`board-${k}`}
                    >
                        <Board
                            kind={k}
                            gen={live[k]}
                            onReady={() => ready(k, live[k], false)}
                        />
                        {pending[k] !== undefined && (
                            // The fresh copy, loading out of sight. Off-stage
                            // rather than display:none, or the browser would
                            // never fetch it. It takes over the moment it has
                            // something to show, so a refresh never leaves an
                            // empty panel behind.
                            <div
                                className={styles.offstage}
                                aria-hidden="true"
                                data-act={`board-${k}-next`}
                            >
                                <Board
                                    kind={k}
                                    gen={pending[k]!}
                                    eager
                                    onReady={() => ready(k, pending[k]!, true)}
                                />
                            </div>
                        )}
                    </div>
                ))
            ) : (
                <p className={wb.faint} style={{fontSize: 12, lineHeight: 1.6}}>
                    {
                        "// the board goes live once the discussion repo is wired. meanwhile: "
                    }
                    <a
                        className={wb.amber}
                        href={`https://github.com/${REPO}/discussions`}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        github discussions
                    </a>
                </p>
            )}
        </div>
    );
}
