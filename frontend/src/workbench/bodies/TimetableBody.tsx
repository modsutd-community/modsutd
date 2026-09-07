import {useEffect, useMemo, useState} from "react";
import {useAppDispatch, useAppSelector} from "@/store";
import {setTimetableEvents, clearTimetable} from "@/reducers/timetableReducer";
import {parseTimetableText} from "@/utils/timetableParser";
import {parseWeeklyHtml, looksWeekly, looksWeeklyText} from "@/utils/weeklyParser";
import {expandWeekToTerm, labelFor} from "@/utils/termCalendar";
import type {TermCalendar, ExpandResult} from "@/utils/termCalendar";
import {downloadICS} from "@/utils/icsGenerator";
import {buildTermReminderEvents} from "@/utils/termReminders";
import {
    eventsToSlots,
    isSampleTimetable,
    postSlots,
} from "@/utils/contributeTimetable";
import type {TimetableEvent} from "@/types";
import {ConsentOverlay} from "../consent";
import {useWorkbenchUi} from "../uiContext";
import {useConsent, DEFAULT_TERM_LABEL, detectConflicts} from "../logic";
import {rememberContributed} from "../contributed";
import {PlanTree} from "./PlanTree";
import {TermPillar} from "../TermPillar";
import wb from "../wb.module.scss";
import {Tip} from "@/components/Tip/Tip";
import styles from "./TimetableBody.module.scss";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;

const EVENT_PALETTE = [
    "#ffb000",
    "#5b8def",
    "#3ca87a",
    "#e0683c",
    "#b069d6",
    "#4bb3c4",
] as const;

function modColor(code: string): string {
    let h = 0;
    for (let i = 0; i < code.length; i++)
        h = (h * 31 + code.charCodeAt(i)) >>> 0;
    return EVENT_PALETTE[h % EVENT_PALETTE.length];
}

function timeToFraction(t: string): number {
    const [h, m] = t.split(":").map(Number);
    return h + (m || 0) / 60;
}

// An END time of "00:00" means midnight at the end of the day, not the
// start - without this a midnight-crossing event gets negative height.
function endToFraction(t: string): number {
    const f = timeToFraction(t);
    return f === 0 ? 24 : f;
}

// Greedy per-day row packing - overlapping events render side by side.
function packDay(events: TimetableEvent[]): TimetableEvent[][] {
    const sorted = [...events].sort((a, b) =>
        a.startTime.localeCompare(b.startTime),
    );
    const rows: TimetableEvent[][] = [];
    for (const e of sorted) {
        const target = rows.find((row) =>
            row.every(
                (other) =>
                    other.endTime <= e.startTime ||
                    other.startTime >= e.endTime,
            ),
        );
        if (target) target.push(e);
        else rows.push([e]);
    }
    return rows;
}

const HOUR_PX = 34;

interface Props {
    onPickMod?: (code: string) => void;
}

// The grid shows ONLY parsed MyPortal events. The catalogue plan is a
// credit shortlist and never appears here - placeholder schedules must not
// masquerade as a timetable.
export function TimetableBody({onPickMod}: Props) {
    const dispatch = useAppDispatch();
    const events = useAppSelector((s) => s.timetable.events);
    const [consent, agree] = useConsent();

    const [text, setText] = useState("");
    const [error, setError] = useState<string | null>(null);
    // Which paste failure is on screen. The copy explains it to a reader; this
    // is what a test asserts on, so rewording the message cannot silently turn
    // an absence check into one that passes because the words moved.
    const [errorKind, setErrorKind] = useState<string | null>(null);
    const [shared, setShared] = useState(false);
    // The clipboard carries text/html beside the plain text. For the Weekly
    // Calendar View that HTML is the only copy that keeps which day a class is
    // on, so it is stashed on paste and used when the text parse finds nothing.
    const [pastedHtml, setPastedHtml] = useState("");
    const [weekOnly, setWeekOnly] = useState<ExpandResult | null>(null);
    // Which view the student says they copied. It only picks the instructions -
    // parsing still decides for itself from what actually arrives, so choosing
    // wrong costs nothing.
    const [view, setView] = useState<"weekly" | "list">("list");
    // SUTD's published term calendar, regenerated from SUTD's own page. The
    // weekly path needs the week dates; everything else needs the label, which
    // is why it is read from here rather than typed into a constant that has to
    // be remembered three times a year.
    const [termCal, setTermCal] = useState<TermCalendar | null>(null);
    const termLabel = useMemo(
        () =>
            labelFor(
                new Date().toISOString().slice(0, 10),
                termCal,
                DEFAULT_TERM_LABEL,
            ),
        [termCal],
    );
    useEffect(() => {
        let live = true;
        fetch("/data/term-calendar.json")
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
                if (live) setTermCal(j as TermCalendar | null);
            })
            .catch(() => {
                /* the weekly paste falls back to its one honest week */
            });
        return () => {
            live = false;
        };
    }, []);
    // View lives in the shared UI context so dragging a catalogue row can
    // land the panel on the plan. null = never chosen: the timetable, which is
    // what the panel is for - an empty grid still shows the week.
    const {ttMode, setTtMode, currentTerm} = useWorkbenchUi();
    const mode = ttMode ?? "grid";
    const setMode = setTtMode;

    const conflicts = useMemo(() => detectConflicts(events), [events]);

    // Hour range adapts to the data (min 08:00–18:00) so early/late classes
    // are never clipped.
    const [hourStart, hourEnd] = useMemo(() => {
        let lo = 8,
            hi = 18;
        for (const e of events) {
            lo = Math.min(lo, Math.floor(timeToFraction(e.startTime)));
            hi = Math.max(hi, Math.ceil(endToFraction(e.endTime)));
        }
        return [lo, hi];
    }, [events]);
    const hours = useMemo(
        () =>
            Array.from({length: hourEnd - hourStart}, (_, i) => hourStart + i),
        [hourStart, hourEnd],
    );

    const packed = useMemo(() => {
        const byDay: Record<string, TimetableEvent[]> = {};
        for (const d of DAYS) byDay[d] = [];
        for (const e of events)
            if ((DAYS as readonly string[]).includes(e.day))
                byDay[e.day].push(e);
        const out: Record<string, TimetableEvent[][]> = {};
        for (const d of DAYS) out[d] = packDay(byDay[d]);
        return out;
    }, [events]);

    const onParse = () => {
        setError(null);
        setErrorKind(null);
        try {
            const parsed = parseTimetableText(text);
            if (!parsed.length) {
                if (looksWeekly(pastedHtml)) {
                    const weekly = parseWeeklyHtml(pastedHtml, text);
                    if (weekly.missingWeek) {
                        setErrorKind("weekly-missing-week");
                        setError(
                            "this is the Weekly Calendar View, but the copy is missing the " +
                                '"Week of" line above the grid that carries the year. select the ' +
                                "whole page and paste again.",
                        );
                        return;
                    }
                    if (weekly.events.length) {
                        // One week is true but close to useless for an export, so repeat it
                        // across the published teaching weeks - which is also the only way
                        // recess week and Deepavali stay empty.
                        const spread = expandWeekToTerm(weekly.events, termCal);
                        dispatch(setTimetableEvents(spread.events));
                        setWeekOnly(spread);
                        setShared(false);
                        setMode("grid");
                        return;
                    }
                }
                // The grid is parsed from the text/html flavour of the clipboard,
                // so a plain-text copy fails with the weekly page perfectly visible
                // on screen. Naming the clipboard rather than the view matters here:
                // List View is often the one this reader has no access to, so
                // sending them there is advice they cannot act on.
                if (looksWeeklyText(text)) {
                    setErrorKind("weekly-plain-text");
                    setError(
                        "this is the Weekly Calendar View, but it arrived as plain text. " +
                            "the grid needs the formatting to keep each class in its own day " +
                            "column. click the MyPortal page, Ctrl/Cmd A, Ctrl/Cmd C, then " +
                            "paste with Ctrl/Cmd V (not Ctrl/Cmd Shift V).",
                    );
                    return;
                }
                setErrorKind("not-a-timetable");
                setError(
                    "nothing parsed. this is neither view - select the whole MyPortal " +
                        "schedule page and copy it. List View is the one that carries the " +
                        "dates an export needs; if it says you have no access, your " +
                        "enrolment is not final yet and the Weekly view still works.",
                );
                return;
            }
            setWeekOnly(null);
            dispatch(setTimetableEvents(parsed));
            setMode("grid");
            // Deidentified slots auto-post through the anonymous /api/contribute
            // relay - covered by the consent gate, fire-and-forget. Only CURRENT
            // or FUTURE timetables feed the crowdsourced data: a paste of an old
            // term still parses and renders, but stale rooms must not poison the
            // heatmaps or spawn batch chats. Only this branch reaches here, and
            // only List View can name a span: `source: 'list'` is the type's way
            // of saying the two dates below came off real rows.
            const slots = eventsToSlots(parsed);
            const today = new Date().toISOString().slice(0, 10);
            const dates = parsed
                .flatMap((e) => [e.startDate, e.endDate])
                .filter(Boolean)
                .sort();
            const isCurrent = (dates[dates.length - 1] ?? "") >= today;
            if (isSampleTimetable(text)) {
                setShared(false);
            } else if (slots.length > 0 && isCurrent) {
                // Only claim it landed once the relay says so - fetch resolves on 4xx
                // and 5xx, so a thanks fired before this resolves is a thanks for a
                // contribution the relay may have rejected.
                void postSlots({
                    term: termLabel,
                    span: {
                        source: "list",
                        termStart: dates[0],
                        termEnd: dates[dates.length - 1],
                    },
                    slots,
                }).then((ok) => {
                    setShared(ok);
                    // So the mod pages can tell "contributed, waiting on the
                    // next deploy" from "nobody is taking this".
                    if (ok) {
                        rememberContributed([
                            ...new Set(slots.map((s) => s.mod)),
                        ]);
                    }
                });
            } else if (slots.length > 0) {
                setShared(false);
            }
        } catch (e) {
            setError(`parser choked: ${(e as Error).message}`);
        }
    };

    // Week-1 Monday from the earliest parsed class date - so the exported
    // .ics can carry the week-7/14 review reminders with zero extra input.
    const termStartISO = useMemo(() => {
        const first = events
            .map((e) => e.startDate)
            .filter(Boolean)
            .sort()[0];
        if (!first) return null;
        const [y, m, d] = first.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
        const z = (n: number) => String(n).padStart(2, "0");
        return `${dt.getUTCFullYear()}-${z(dt.getUTCMonth() + 1)}-${z(dt.getUTCDate())}`;
    }, [events]);

    const exportICS = () => {
        const reminders = termStartISO
            ? buildTermReminderEvents({
                  cal: termCal,
                  termLabel,
                  termStartISO,
                  origin: window.location.origin,
              })
            : [];
        // Named for the term the student says they are in, so three exports in a
        // downloads folder are told apart at a glance and the calendar arrives with
        // a name they recognise. Same string for both.
        downloadICS([...events, ...reminders], exportName, {
            calendarName: exportName,
        });
    };

    // e.g. "modSUTD T7 '26" - the year is the current one, not the term label,
    // because that is what a student reads off their own calendar.
    const exportName = `modSUTD T${currentTerm} '${String(new Date().getFullYear()).slice(2)}`;

    const gridHeight = hours.length * HOUR_PX;

    return (
        <div className={`${wb.scroll} ${styles.wrap}`}>
            <div className={styles.toolRow}>
                {(
                    [
                        ["paste", "generate timetable"],
                        ["grid", "timetable"],
                        ["tree", "plan"],
                    ] as const
                ).map(([m, label]) => (
                    <button
                        key={m}
                        type="button"
                        className={wb.btnQuiet}
                        style={
                            mode === m
                                ? {
                                      borderColor: "rgba(255,176,0,0.6)",
                                      color: "#ffce5a",
                                  }
                                : undefined
                        }
                        aria-pressed={mode === m}
                        onClick={() => setMode(m)}
                    >
                        {label}
                    </button>
                ))}
                <TermPillar />
                {mode === "grid" && (
                    <>
                        <button
                            type="button"
                            className={wb.btn}
                            disabled={!events.length}
                            data-tip={
                                "Mobile? Just tap on the downloaded .ics!\nWeb? Import into your Google Calendar!"
                            }
                            onClick={exportICS}
                        >
                            ⇣ .ics ({events.length})
                        </button>
                        <button
                            type="button"
                            className={wb.btnQuiet}
                            disabled={!events.length && !text}
                            onClick={() => {
                                dispatch(clearTimetable());
                                setText("");
                                setError(null);
                                setShared(false);
                                setPastedHtml("");
                                setWeekOnly(null);
                                setMode("paste");
                            }}
                        >
                            clear
                        </button>
                    </>
                )}
            </div>

            {mode === "tree" && (
                <PlanTree onPick={(code) => onPickMod?.(code)} />
            )}

            {mode === "paste" && (
                <div className={styles.pasteBlock}>
                    <div className={styles.howto}>
                        MyPortal → My Record → My Weekly Schedule
                    </div>
                    {/* Both views are offered because SAMS answers "You do not have access
              to the class schedule at this time" on List View until enrolment is
              final, while the weekly grid keeps rendering. The page looks
              healthy and only the better view is missing, so the chooser names
              the fallback rather than leaving a dead end. */}
                    <div
                        className={styles.viewPick}
                        role="radiogroup"
                        aria-label="which view you copied"
                    >
                        {(["weekly", "list"] as const).map((v) => (
                            <label key={v} className={styles.viewOpt}>
                                <input
                                    type="radio"
                                    name="tt-view"
                                    value={v}
                                    checked={view === v}
                                    onChange={() => setView(v)}
                                    data-act={`view-${v}`}
                                />
                                <span>
                                    {v === "weekly"
                                        ? "Weekly view"
                                        : "List view"}
                                </span>
                                {v === "list" && (
                                    <>
                                        <small className={styles.viewNote}>
                                            Recommended!
                                        </small>
                                        {/* Inside the label, so it wraps under
                                            "Recommended!" rather than under the
                                            option to its left. A button is
                                            interactive content, so clicking it
                                            does not tick the radio. */}
                                        <span className={styles.viewTip}>
                                            <Tip
                                                label="List view error on MyPortal?"
                                                data-act="listview-tip"
                                            >
                                                Please wait till your HASS
                                                electives are confirmed, as your
                                                current one is still subject to
                                                changes.
                                            </Tip>
                                        </span>
                                    </>
                                )}
                            </label>
                        ))}
                    </div>

                    {view === "weekly" && (
                        // Not an <ol>: there is one line, and a list padded for
                        // markers it does not have reads as a stray indent.
                        <p className={styles.steps} data-act="steps-weekly">
                            <span aria-hidden="true">❗</span> find a regular
                            week, not a holiday or recess one
                        </p>
                    )}
                    {consent ? (
                        <div
                            className={styles.dropzone}
                            onDrop={(e) => {
                                e.preventDefault();
                                const d = e.dataTransfer.getData("text");
                                if (d) setText(d);
                            }}
                            onDragOver={(e) => e.preventDefault()}
                        >
                            <textarea
                                className={styles.textarea}
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                onPaste={(e) =>
                                    setPastedHtml(
                                        e.clipboardData.getData("text/html"),
                                    )
                                }
                                placeholder={
                                    view === "weekly"
                                        ? "Ctrl/Cmd A, copy and paste MyPortal Weekly view here… (the whole page)"
                                        : "Ctrl/Cmd A, copy and paste MyPortal List view here… (the whole page)"
                                }
                                rows={7}
                            />
                        </div>
                    ) : (
                        <ConsentOverlay onAgree={agree} />
                    )}
                    {isSampleTimetable(text) && (
                        <div className={wb.error}>
                            sample timetable - renders normally, never
                            contributed.
                        </div>
                    )}
                    {consent && (
                        <p
                            className={`${styles.thanks} ${
                                shared ? styles.thanksOn : styles.thanksOff
                            }`}
                            data-act="contrib-thanks"
                        >
                            ✦ This feature may not be useful to you, but it
                            could really help the SUTD family.
                            <br />
                            {shared
                                ? "Thanks for your contributions."
                                : "Contribute now?"}
                        </p>
                    )}
                    {error && (
                        <div className={wb.error} data-act={errorKind ?? "error"}>
                            ! {error}
                        </div>
                    )}
                    <button
                        type="button"
                        className={wb.btn}
                        onClick={onParse}
                        disabled={!text || !consent}
                    >
                        parse timetable
                    </button>
                </div>
            )}

            {mode === "grid" && weekOnly && (
                <div className={styles.tip} data-act="weekly-note">
                    {weekOnly.weeks > 1 ? (
                        <>
                            read from the Weekly Calendar View, which shows one
                            week, then repeated across all {weekOnly.weeks}{" "}
                            teaching weeks of the term. assuming every week is
                            the same. List View is more accurate, please paste
                            once it&apos;s available. Your data was not
                            contributed.
                        </>
                    ) : (
                        <>
                            read from the Weekly Calendar View. this week is not
                            in a term calendar modSUTD knows, so it stayed as
                            the one week you pasted. nothing was contributed.
                        </>
                    )}
                </div>
            )}

            {mode === "grid" && conflicts.length > 0 && (
                <div className={wb.error}>
                    ⚠ {conflicts.length} clash
                    {conflicts.length !== 1 ? "es" : ""} ·{" "}
                    {conflicts.slice(0, 4).map((c, i) => (
                        <span key={i}>
                            {c.a.modCode}×{c.b.modCode} {c.a.day.slice(0, 3)}{" "}
                            {c.a.startTime}
                            {i < Math.min(conflicts.length, 4) - 1 ? " · " : ""}
                        </span>
                    ))}
                </div>
            )}

            {mode === "grid" &&
                (events.length > 0 ? (
                    <div
                        className={`${wb.nobar} ${styles.gridScroller}`}
                        data-act="tt-grid"
                    >
                        <div className={styles.gridHead}>
                            <div />
                            {DAYS.map((d) => (
                                <div key={d} className={styles.dayHead}>
                                    {d.slice(0, 3)}
                                </div>
                            ))}
                        </div>
                        <div
                            className={styles.grid}
                            style={{height: gridHeight}}
                        >
                            <div className={styles.timeCol}>
                                {hours.map((h) => (
                                    <div
                                        key={h}
                                        className={styles.timeLabel}
                                        style={{height: HOUR_PX}}
                                    >
                                        {String(h).padStart(2, "0")}
                                    </div>
                                ))}
                            </div>
                            {DAYS.map((day) => {
                                const rows = packed[day];
                                return (
                                    <div key={day} className={styles.dayCol}>
                                        {hours.map((h) => (
                                            <div
                                                key={h}
                                                className={styles.hourLine}
                                                style={{height: HOUR_PX}}
                                            />
                                        ))}
                                        {rows.map((row, ri) => (
                                            <div
                                                key={ri}
                                                className={styles.dayLane}
                                                style={{
                                                    width: `${100 / rows.length}%`,
                                                    left: `${(100 * ri) / rows.length}%`,
                                                }}
                                            >
                                                {row.map((ev, ei) => {
                                                    const top =
                                                        (timeToFraction(
                                                            ev.startTime,
                                                        ) -
                                                            hourStart) *
                                                        HOUR_PX;
                                                    const height = Math.max(
                                                        0,
                                                        (endToFraction(
                                                            ev.endTime,
                                                        ) -
                                                            timeToFraction(
                                                                ev.startTime,
                                                            )) *
                                                            HOUR_PX,
                                                    );
                                                    const color = modColor(
                                                        ev.modCode,
                                                    );
                                                    return (
                                                        <button
                                                            key={ei}
                                                            type="button"
                                                            className={
                                                                styles.event
                                                            }
                                                            style={{
                                                                top,
                                                                height,
                                                                borderLeftColor:
                                                                    color,
                                                                background: `${color}26`,
                                                            }}
                                                            data-tip={
                                                                ev.modName
                                                            }
                                                            onClick={() =>
                                                                onPickMod?.(
                                                                    ev.modCode,
                                                                )
                                                            }
                                                        >
                                                            <span
                                                                className={
                                                                    styles.evCode
                                                                }
                                                            >
                                                                {ev.modCode}
                                                            </span>
                                                            <span
                                                                className={
                                                                    styles.evMeta
                                                                }
                                                            >
                                                                {ev.type}
                                                            </span>
                                                            <span
                                                                className={
                                                                    styles.evMeta
                                                                }
                                                            >
                                                                ▽ {ev.location}
                                                            </span>
                                                            <span
                                                                className={
                                                                    styles.evMeta
                                                                }
                                                            >
                                                                {ev.startTime}–
                                                                {ev.endTime}
                                                            </span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        ))}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ) : (
                    <div className={wb.empty} style={{padding: "32px 20px"}}>
                        no timetable yet - "generate timetable"
                    </div>
                ))}
        </div>
    );
}
