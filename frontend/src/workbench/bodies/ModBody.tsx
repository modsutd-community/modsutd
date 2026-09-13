import {useEffect, useMemo, useState} from "react";
import {useAppDispatch, useAppSelector} from "@/store";
import {selectMod, deselectMod} from "@/reducers/timetableReducer";
import {PrerequisiteTree} from "@/components/PrerequisiteTree/PrerequisiteTree";
import {Giscus} from "@/components/Giscus/Giscus";
import {
    GISCUS_CONFIG,
    REVIEWS_THEME,
    giscusWired as giscusIsWired,
} from "@/config/giscus";
import type {Mod} from "@/types";
import {pillarColor, modPillars} from "../pillars";
import {notify} from "../notice";
import {getToken} from "../sync";
import {
    useTelegramData,
    isActive,
    fetchJoinLink,
    slotsOnMain,
} from "../telegram";
import {awaitingDeploy, CONTRIBUTED_EVENT} from "../contributed";
import {teleState, chatEligible} from "../teleState";
import {askedAt, markAsked, clearAsked, TELE_ASKED_EVENT} from "../teleAsked";
import {ReviewForm} from "../ReviewForm";
import {defaultLevel, useFreshmore, freshmoreFixedSet} from "../logic";
import {useWorkbenchUi} from "../uiContext";
import {Otto} from "../Otto";
import {ExtIcon} from "../ExtLink";
import wb from "../wb.module.scss";
import styles from "./ModBody.module.scss";

const REPO = "modsutd-community/modsutd";

function TelegramIcon() {
    return (
        <svg
            className={styles.teleIcon}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
        >
            <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
        </svg>
    );
}

// A share glyph rather than a copy one: what a reader wants to do with a chat
// link is send it to their cohort, and "copy" is only the mechanism. Clicking
// still copies - the Web Share API is a phone affordance and would be a dead
// button on the desktop this panel mostly runs on.
function ShareIcon() {
    return (
        <svg
            className={styles.teleIcon}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
        >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
        </svg>
    );
}

// Batch chats exist for mods a student PICKS (term >= 3 or HASS) that
// are CURRENTLY OFFERED - crowdsourced schedules are the offering signal,
// so no group ever spawns for a mod nobody is taking this term.
function TeleChat({mod}: {mod: Mod}) {
    const [tg, refresh] = useTelegramData();
    const [copied, setCopied] = useState(false);

    // The catalogue marks the same mods in its own column, so the rule lives in
    // teleState.ts and neither copy can drift from the other.
    const chatMod = chatEligible(mod);

    // Re-render on either store changing. localStorage fires no event in the
    // tab that wrote it, so without these the panel is a render behind its own
    // paste, and behind its own click.
    const [, bump] = useState(0);
    useEffect(() => {
        const on = () => bump((n) => n + 1);
        window.addEventListener(CONTRIBUTED_EVENT, on);
        window.addEventListener(TELE_ASKED_EVENT, on);
        return () => {
            window.removeEventListener(CONTRIBUTED_EVENT, on);
            window.removeEventListener(TELE_ASKED_EVENT, on);
        };
    }, []);

    const entryRaw = tg?.registry[mod.code];
    const entry = entryRaw && isActive(entryRaw) ? entryRaw : undefined;

    // The slots are on main. Deployed data proves it outright; for this
    // browser's own paste the raw-main probe is the only thing that knows,
    // because the deploy that would show it to anyone else is hours away.
    const pastedHere = mod.localSchedules === true;
    const [probed, setProbed] = useState(false);
    const committed = (mod.schedules.length > 0 && !pastedHere) || probed;

    const today = new Date().toISOString().slice(0, 10);
    const state = teleState({
        chatMod,
        entry: !!entry,
        askedAt: askedAt(mod.code),
        // The paste carries its own term end, which is what covers the first
        // paste of a term - term-window.json is written by the same workflow
        // and is still empty at that moment.
        termOk:
            (!!tg?.term.end && today <= tg.term.end) ||
            awaitingDeploy(mod.code, false),
        committed,
        committing: pastedHere && !committed,
    });

    // Watch main until this browser's own paste lands there, so COMMITTING
    // becomes READY on its own.
    //
    // `round` is what makes it never give up. slotsOnMain resolves false after
    // its own window, and with only [state, mod.code] in the deps a single
    // failed window left COMMITTING on screen for good: the state had not
    // changed, so the effect never ran again and nothing else could move it.
    // A dead end is the one thing this state must not be, because the student
    // is watching it.
    const [round, setRound] = useState(0);
    useEffect(() => {
        if (state !== "committing") return;
        let live = true;
        void slotsOnMain(mod.code).then((ok) => {
            if (!live) return;
            if (ok) setProbed(true);
            else setRound((n) => n + 1);
        });
        return () => {
            live = false;
        };
    }, [state, mod.code, round]);

    // Reset the probe when the panel swaps to another mod. The panel does not
    // remount, so without this the next mod inherits this one's answer.
    useEffect(() => {
        setProbed(false);
        setRound(0);
    }, [mod.code]);

    // The group exists: stop saying it is being created, in this tab and every
    // other one that syncs.
    useEffect(() => {
        if (entry) clearAsked(mod.code);
    }, [entry, mod.code]);

    // While a creation is outstanding, watch the registry closely. Skipped when
    // the tab is hidden: a backgrounded tab should cost nothing.
    useEffect(() => {
        if (state !== "creating") return;
        const t = setInterval(() => {
            if (document.visibilityState === "visible") void refresh();
        }, 10_000);
        return () => clearInterval(t);
    }, [state, refresh]);

    // A mod that can never have a chat says so, rather than showing nothing.
    // Silence read as a bug: a student who saw the button on one mod and not
    // the next had no way to tell whether it was broken or deliberate.
    //
    // Only when chatMod is what ruled it out. state is also "none" while the
    // term window is shut or the slots are not on main yet, and both of those
    // are temporary - claiming a mod will never get a chat would be wrong.
    if (state === "none") {
        if (chatMod) return null;
        return (
            <div className={styles.teleRow}>
                <button
                    type="button"
                    className={`${styles.teleBtn} ${styles.teleNever}`}
                    disabled
                    data-act="tele-never"
                    data-tip-side="block"
                    data-tip="Batch chats are for electives and HASS from T3 onwards. Capstones and thesis mods split students across their own project teams, so a cohort-wide group would be noise."
                >
                    <TelegramIcon /> won&apos;t create tele chat
                </button>
            </div>
        );
    }

    if (state === "committing") {
        // Dotted and unpressable because pressing it could not work yet: the
        // workflow reads main, and this browser's slots are still on their way
        // there. Seconds, not the next deploy - the old copy named a build four
        // hours out for a wait of about eleven seconds.
        return (
            <div className={styles.teleRow}>
                <button
                    type="button"
                    className={`${styles.teleBtn} ${styles.teleWaiting}`}
                    disabled
                    data-act="tele-awaiting"
                    data-tip-side="block"
                    data-tip="Please wait a few seconds"
                >
                    <TelegramIcon /> reading timetable
                </button>
            </div>
        );
    }

    if (state === "creating") {
        return (
            <div className={styles.teleRow}>
                <button
                    type="button"
                    className={`${styles.teleBtn} ${styles.teleWaiting}`}
                    disabled
                    data-act="tele-creating"
                    data-tip-side="block"
                    data-tip="usually under 2 mins. Please wait."
                >
                    <TelegramIcon /> creating the chat...
                </button>
            </div>
        );
    }

    if (entry) {
        // The link is fetched on demand rather than rendered from the registry:
        // the registry is public, so it only carries ciphertext. Failures are told
        // once in the top banner - the reason is never the student's fault to fix
        // in place, so an inline error would just sit there.
        const reveal = async (then: (link: string) => void) => {
            try {
                then(await fetchJoinLink(entry, getToken()));
            } catch (e) {
                notify((e as Error).message);
            }
        };

        return (
            <div>
                <div className={styles.teleRow}>
                    <button
                        type="button"
                        className={styles.teleBtn}
                        // On the button rather than under it: the caveat is only worth
                        // reading once the link has actually refused, and a line of small
                        // print sitting there permanently reads as a warning about the
                        // button you are being asked to press.
                        data-tip-side="block"
                        data-tip="link invalid? May have expired - ask around in the SUTD group chat"
                        onClick={() =>
                            reveal((link) =>
                                window.open(
                                    link,
                                    "_blank",
                                    "noopener,noreferrer",
                                ),
                            )
                        }
                    >
                        <TelegramIcon /> Join the Tele chat!
                    </button>
                    <button
                        type="button"
                        className={styles.teleCopy}
                        aria-label="copy invite link"
                        data-tip-side="left"
                        data-tip={copied ? "copied" : "copy link"}
                        onClick={() =>
                            reveal(async (link) => {
                                await navigator.clipboard
                                    .writeText(link)
                                    .catch(() => {});
                                setCopied(true);
                                setTimeout(() => setCopied(false), 1500);
                            })
                        }
                    >
                        {copied ? "✓" : <ShareIcon />}
                    </button>
                </div>
            </div>
        );
    }

    // READY: the slots are on main, so the workflow will accept the ask.
    return (
        <div className={styles.teleRow}>
            <button
                type="button"
                className={styles.teleBtn}
                data-act="tele-create"
                onClick={async () => {
                    // Recorded BEFORE the request, and in localStorage rather
                    // than component state, so a reload, a switch to another
                    // mod and a second browser all agree about what was asked
                    // for. The relay answers 202 the moment GitHub accepts the
                    // dispatch and says nothing about a group, so this row is
                    // the only record that the ask happened at all.
                    markAsked(mod.code);
                    try {
                        // Creating the chat is deliberately ungated: whoever asks first
                        // gets the group made for everyone, even if they cannot be shown
                        // the link themselves. The gate is on revealing the link, not on
                        // the cohort having a chat at all.
                        const r = await fetch("/api/telegram-group", {
                            method: "POST",
                            headers: {"Content-Type": "application/json"},
                            body: JSON.stringify({mod: mod.code}),
                        });
                        if (!r.ok) {
                            const j = await r
                                .json()
                                .catch(() => ({error: `HTTP ${r.status}`}));
                            throw new Error(j.error ?? `HTTP ${r.status}`);
                        }
                    } catch (e) {
                        // The ask never left, so do not leave the button
                        // claiming a chat is on its way.
                        clearAsked(mod.code);
                        notify((e as Error).message);
                    }
                }}
            >
                <TelegramIcon />
                Join the Tele chat!
            </button>
        </div>
    );
}

interface Props {
    code: string | null;
    onPick: (code: string) => void;
    onFocusRoom: (room: string) => void;
}

export function ModBody({code, onPick, onFocusRoom}: Props) {
    const dispatch = useAppDispatch();
    const allMods = useAppSelector((s) => s.mods.data);
    const loading = useAppSelector((s) => s.mods.loading);
    const {freshmoreMode} = useWorkbenchUi();
    const plan = useAppSelector(
        (s) => s.timetable.plans[freshmoreMode].selectedMods,
    );
    const freshmore = useFreshmore(freshmoreMode);
    const fixed = useMemo(() => freshmoreFixedSet(freshmore), [freshmore]);
    const mod: Mod | undefined = code ? allMods[code] : undefined;

    // giscus resolves the mod's discussion; the unlinked review path uses it to
    // avoid opening a duplicate thread that would never render here.
    const [threadUrl, setThreadUrl] = useState<string | null>(null);
    // Rebuilding the embed is the only way to surface a comment posted through
    // the API - giscus never learns about one it did not create itself.
    const [reloadKey, setReloadKey] = useState(0);
    useEffect(() => setThreadUrl(null), [code]);

    const fulfils = useMemo(() => {
        if (!mod) return [] as Mod[];
        return Object.values(allMods).filter((m) =>
            (m.prerequisites ?? []).includes(mod.code),
        );
    }, [allMods, mod]);

    if (!mod) {
        return (
            <div className={wb.empty}>
                <span className={wb.ottoDim}>
                    <Otto size={64} />
                </span>
                <span>
                    {loading && code
                        ? `dredging the catalogue for ${code}…`
                        : code
                          ? `nothing called ${code} in the catalogue.`
                          : "pick a module from the catalogue."}
                </span>
            </div>
        );
    }

    // The plan stores unique keys, not codes - the 99.999 placeholders share
    // a code and only the key tells them apart.
    const planKey = mod.key ?? mod.code;
    // Terms 1-3 pin the freshmore core, and a pinned mod is in the plan without
    // being in selectedMods. The button read "+ ADD TO PLAN" for a mod already
    // sitting in T1 of the tree, and pressing it would have added a second copy
    // of something nobody chose in the first place.
    const pinnedTerm = fixed.get(planKey) ?? fixed.get(mod.code);
    const inPlan = plan.includes(planKey);
    const color = pillarColor(mod.pillar);
    const w = mod.workload;
    const totalGrade =
        mod.grading?.components.reduce((s, c) => s + c.percentage, 0) ?? 0;
    const giscusWired = giscusIsWired();

    const reportUrl = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(
        `data: ${mod.code} ${mod.name}`,
    )}&body=${encodeURIComponent(
        `<!-- describe the issue Eg. wrong term, missing information -->`,
    )}&labels=data`;
    return (
        <div className={`${wb.scroll} ${styles.wrap}`}>
            <div className={styles.headRow}>
                <div>
                    <div className={styles.code} data-code={mod.code}>
                        {mod.code}
                    </div>
                    {/* The name links to the page this record was read from.
                        Cross-checking should be one click: this app is not the
                        source of truth, and a dead link here is how a
                        maintainer learns a re-scrape is due. */}
                    <div className={styles.name}>
                        {mod.sourceUrl ? (
                            <a
                                className={styles.sourceLink}
                                href={mod.sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-act="mod-source"
                                data-tip="read on the official site"
                                // data-tip is a CSS ::after, which a screen
                                // reader does not announce. The label carries
                                // the same thing for anyone not seeing the
                                // icon.
                                aria-label={`${mod.name} - read on the official site`}
                            >
                                {mod.name}
                                {/* Box with an arrow leaving it: the one glyph
                                    readers already read as "this opens
                                    somewhere else". Without it a dotted
                                    underline is indistinguishable from the
                                    in-app links everywhere else in the panel. */}
                                <ExtIcon className={styles.extIcon} />
                            </a>
                        ) : (
                            mod.name
                        )}
                    </div>
                </div>
                <span className={styles.pillarStack}>
                    {modPillars(mod).map((p) => (
                        <span
                            key={p}
                            className={styles.pillarBadge}
                            style={{
                                color: pillarColor(p),
                                borderColor: pillarColor(p),
                            }}
                        >
                            {p}
                        </span>
                    ))}
                </span>
            </div>

            <button
                type="button"
                className={styles.planBtn}
                data-act="plan-btn"
                data-in-plan={inPlan || pinnedTerm !== undefined || undefined}
                disabled={pinnedTerm !== undefined}
                data-tip={
                    pinnedTerm !== undefined
                        ? "every freshmore takes this one - it cannot be removed"
                        : inPlan
                          ? "remove from your plan"
                          : `plans it at T${defaultLevel(mod)}`
                }
                onClick={() =>
                    dispatch(
                        inPlan
                            ? deselectMod({mode: freshmoreMode, code: planKey})
                            : selectMod({
                                  mode: freshmoreMode,
                                  code: planKey,
                                  level: defaultLevel(mod),
                              }),
                    )
                }
            >
                {pinnedTerm !== undefined
                    ? `✓ FRESHMORE CORE - T${pinnedTerm}`
                    : inPlan
                      ? "✓ IN PLAN - REMOVE"
                      : "+ ADD TO PLAN"}
            </button>

            <TeleChat mod={mod} />

            <div className={wb.statGrid} style={{marginTop: 18}}>
                <div className={wb.statCell}>
                    <div className={wb.statLabel}>TERM</div>
                    <div className={wb.statValue}>{mod.term}</div>
                </div>
                <div className={wb.statCell}>
                    <div className={wb.statLabel}>CREDITS</div>
                    <div className={wb.statValue}>{mod.credits}</div>
                </div>
                <div className={wb.statCell}>
                    <div className={wb.statLabel}>PREREQ</div>
                    <div
                        className={wb.statValue}
                        style={{
                            color: mod.prerequisites?.length
                                ? "#c9a23a"
                                : "#3ca87a",
                        }}
                    >
                        {mod.prerequisites?.length ?? 0}
                    </div>
                </div>
            </div>

            <p className={styles.desc}>{mod.description}</p>

            {w && (
                <>
                    <div className={wb.eyebrow} style={{margin: "18px 0 8px"}}>
                        WORKLOAD · {w.total}h/wk
                    </div>
                    <div className={styles.workload}>
                        {(
                            [
                                "lecture",
                                "tutorial",
                                "project",
                                "preparation",
                            ] as const
                        ).map((k) =>
                            w[k] > 0 ? (
                                <div
                                    key={k}
                                    className={styles.workSeg}
                                    style={{flex: w[k]}}
                                    data-tip={`${k} ${w[k]}h/wk`}
                                >
                                    <span>{w[k]}</span>
                                    <span className={styles.workLabel}>
                                        {k.slice(0, 4)}
                                    </span>
                                </div>
                            ) : null,
                        )}
                    </div>
                </>
            )}

            {mod.schedules.length > 0 && (
                <>
                    <div className={wb.eyebrow} style={{margin: "18px 0 8px"}}>
                        SCHEDULE{" "}
                        <span style={{color: "rgba(255,176,0,0.6)"}}>
                            · crowdsourced
                        </span>
                    </div>
                    {mod.schedules.map((s, i) => (
                        <div key={i} className={styles.slot}>
                            <span className={wb.amber}>
                                {s.day.slice(0, 3)}
                            </span>
                            <span className={wb.dim}>
                                {s.startTime}–{s.endTime} · {s.type}
                                {s.cohort ? ` · cohort ${s.cohort}` : ""}
                                {s.instructors.length > 0
                                    ? ` · ${s.instructors.join(" · ")}`
                                    : ""}
                            </span>
                            <button
                                type="button"
                                className={styles.roomLink}
                                onClick={() => onFocusRoom(s.location)}
                            >
                                ▽ {s.location}
                            </button>
                        </div>
                    ))}
                </>
            )}

            {mod.grading && (
                <>
                    <div className={wb.eyebrow} style={{margin: "18px 0 10px"}}>
                        GRADING · {totalGrade}% accounted
                    </div>
                    {mod.grading.components.map((g) => (
                        <div key={g.name} className={styles.gradeRow}>
                            <div className={styles.gradeMeta}>
                                <span
                                    data-tip={
                                        g.description
                                            ? `${g.description.slice(0, 70)}${g.description.length > 70 ? "…" : ""}`
                                            : undefined
                                    }
                                >
                                    {g.name}
                                </span>
                                <span style={{color: "#ffce5a"}}>
                                    {g.percentage}%
                                </span>
                            </div>
                            <div className={styles.gradeBar}>
                                <div
                                    style={{
                                        width: `${g.percentage}%`,
                                        background: color,
                                        height: "100%",
                                    }}
                                />
                            </div>
                        </div>
                    ))}
                    {mod.grading.passingGrade && (
                        <p className={wb.faint} style={{fontSize: 11}}>
                            passing grade · {mod.grading.passingGrade}
                        </p>
                    )}
                </>
            )}

            <div className={wb.eyebrow} style={{margin: "18px 0 8px"}}>
                PREREQUISITES
            </div>
            <div className={styles.treeWrap}>
                <PrerequisiteTree
                    modCode={mod.code}
                    tree={mod.prereqTree}
                    fallback={mod.prerequisites}
                    knownMods={Object.fromEntries(
                        Object.values(allMods).map((m) => [
                            m.code,
                            {code: m.code, name: m.name},
                        ]),
                    )}
                    onPick={onPick}
                />
            </div>
            {mod.corequisites?.length ? (
                <p className={wb.dim} style={{fontSize: 11.5}}>
                    co-requisites:{" "}
                    {mod.corequisites.map((c, i) => (
                        <span key={c}>
                            <button
                                type="button"
                                className={styles.modLink}
                                onClick={() => onPick(c)}
                            >
                                {c}
                            </button>
                            {i < mod.corequisites!.length - 1 ? " · " : ""}
                        </span>
                    ))}
                </p>
            ) : null}

            {fulfils.length > 0 && (
                <>
                    <div className={wb.eyebrow} style={{margin: "18px 0 8px"}}>
                        UNLOCKS · mods that need {mod.code}
                    </div>
                    <div className={styles.unlocks}>
                        {fulfils.map((m) => (
                            <button
                                key={m.code}
                                type="button"
                                className={styles.unlockChip}
                                onClick={() => onPick(m.code)}
                            >
                                <span style={{fontWeight: 700}}>{m.code}</span>
                                <span className={wb.dim}>{m.name}</span>
                            </button>
                        ))}
                    </div>
                </>
            )}

            <a
                href={reportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.report}
            >
                ⚠ report bad data
            </a>

            <div className={wb.eyebrow} style={{margin: "20px 0 8px"}}>
                SHARE A REVIEW · because every experience counts
            </div>
            <ReviewForm
                mod={mod}
                threadUrl={threadUrl}
                onPosted={() => setReloadKey((n) => n + 1)}
            />

            <div className={wb.eyebrow} style={{margin: "20px 0 8px"}}>
                REVIEWS · from past students
            </div>
            {giscusWired ? (
                <Giscus
                    repo={GISCUS_CONFIG.repo}
                    repoId={GISCUS_CONFIG.repoId}
                    category={GISCUS_CONFIG.categories.reviews.name}
                    categoryId={GISCUS_CONFIG.categories.reviews.id}
                    mapping="specific"
                    term={`mod-${mod.code}`}
                    reactionsEnabled="1"
                    onDiscussion={setThreadUrl}
                    reloadKey={reloadKey}
                    inputPosition="top"
                    lang="en"
                    forcedTheme="dark"
                    themeUrl={REVIEWS_THEME}
                />
            ) : (
                <p className={wb.faint} style={{fontSize: 12}}>
                    {"// reviews go live once the discussion repo is wired."}
                </p>
            )}
        </div>
    );
}
