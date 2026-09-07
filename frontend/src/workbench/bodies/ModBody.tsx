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
    nextDeploy,
} from "../telegram";
import {awaitingDeploy, CONTRIBUTED_EVENT} from "../contributed";
import {ReviewForm} from "../ReviewForm";
import {defaultLevel, useFreshmore, freshmoreFixedSet} from "../logic";
import {useWorkbenchUi} from "../uiContext";
import {Otto} from "../Otto";
import wb from "../wb.module.scss";
import styles from "./ModBody.module.scss";

const REPO = "modsutd-community/modsutd";

// Capstone and thesis mods get no batch chat: students are split across
// their own project teams, so a cohort-wide group is just noise.
const SOLO_PROJECT = /capstone|thesis/i;

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
    const [pending, setPending] = useState(false);
    const [copied, setCopied] = useState(false);

    // Offered = crowdsourced schedules exist AND the term they came from is
    // still running - buttons retire with the term, before the next term's
    // first paste arrives.
    const today = new Date().toISOString().slice(0, 10);
    const termLive = !!tg?.term.end && today <= tg.term.end;
    // Everything except the schedules. Those arrive only in the deployed bundle,
    // so they are what separates "offered" from "waiting on the next build".
    // Whether a chat is the kind of thing this mod gets at all. Nothing here is
    // fetched, so it is knowable on the first render.
    const chatMod =
        (Number(mod.term) >= 3 || modPillars(mod).includes("HASS")) &&
        !SOLO_PROJECT.test(mod.name);
    const couldBeOffered = chatMod && termLive;
    const eligible = couldBeOffered && mod.schedules.length > 0;
    // This browser pasted a timetable covering this mod and the deployed data
    // has not caught up. Nobody else can see this state, and nobody else needs
    // to: the person owed an explanation is the one who pasted.
    //
    // Deliberately NOT gated on termLive. That comes from term-window.json,
    // which the contribution workflow writes and this reads back through
    // GitHub's raw CDN, so on the first paste of a term it is still empty and
    // the waiting state would be invisible for exactly the window it covers.
    // The paste knew its own term end and awaitingDeploy holds it.
    const awaiting = chatMod && awaitingDeploy(mod.code, mod.schedules.length > 0);
    const entryRaw = tg?.registry[mod.code];
    const entry = entryRaw && isActive(entryRaw) ? entryRaw : undefined;

    // localStorage fires no event in the tab that wrote it, so a paste made
    // while this panel is open would leave the button a render behind.
    const [, bumpContributed] = useState(0);
    useEffect(() => {
        const onChange = () => bumpContributed((n) => n + 1);
        window.addEventListener(CONTRIBUTED_EVENT, onChange);
        return () => window.removeEventListener(CONTRIBUTED_EVENT, onChange);
    }, []);

    useEffect(() => {
        if (!pending || entry) return;
        const t = setInterval(() => void refresh(), 10_000);
        return () => clearInterval(t);
    }, [pending, entry, refresh]);

    if (!eligible) {
        if (!awaiting) return null;
        // Dotted and unpressable, because pressing it could not do anything yet.
        // The tip names the build, not the two minutes: the chat cannot even be
        // asked for until the slots ship.
        return (
            <div className={styles.teleRow}>
                <button
                    type="button"
                    className={`${styles.teleBtn} ${styles.teleWaiting}`}
                    disabled
                    data-act="tele-awaiting"
                    data-tip-side="block"
                    data-tip={`Please check back at ${nextDeploy()}`}
                >
                    <TelegramIcon /> chat opens after the next update
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
                        data-tip="link invalid? the chat may have been upgraded to a supergroup - ask around in the SUTD group chat"
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

    return (
        <div className={styles.teleRow}>
            <button
                type="button"
                className={`${styles.teleBtn} ${pending ? styles.teleWaiting : ""}`}
                disabled={pending}
                // Waiting is a state, not a failure. Dotted so it reads as pending
                // rather than pressable, and the tip names the outside edge: the chat
                // itself is usually a couple of minutes, but the slots that make the
                // button appear ride the deploy schedule.
                data-tip={
                    pending
                        ? `usually under 2 minutes. if it is still not here, check back at ${nextDeploy()}`
                        : undefined
                }
                onClick={async () => {
                    setPending(true);
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
                        // No banner on success: the button already says it is
                        // setting up, and it is the thing being watched.
                    } catch (e) {
                        setPending(false);
                        notify((e as Error).message);
                    }
                }}
            >
                <TelegramIcon />
                {pending
                    ? "setting up the chat - usually under 2 min…"
                    : "Join the Tele chat!"}
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
                    <div className={styles.name}>{mod.name}</div>
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
