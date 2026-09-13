import {ReactNode, useEffect, useMemo, useRef, useState} from "react";
import {useLocation, useNavigate} from "react-router-dom";
import {useAppDispatch, useAppSelector} from "@/store";
import {selectMod} from "@/reducers/timetableReducer";
import {beginModDrag, chipLabel} from "./modDrag";
import {GithubLinkBanner} from "./GithubLinkBanner";
import {HotBanner} from "./HotBanner";
import {
    useWorkbenchLayout,
    StaticPanelId,
    RAIL_W,
    TOPBAR_H,
    OPEN_PANEL_EVENT,
} from "./layout";
import {WorkbenchUiProvider} from "./context";
import {useSync} from "./useSync";
import {useLiveBackup} from "./useLiveBackup";
import {useWorkbenchUi, MobileTab} from "./uiContext";
import {useFilteredMods, detectConflicts, useNowInfo} from "./logic";
import {Panel} from "./Panel";
import {Otto} from "./Otto";
import {CatalogueBody} from "./bodies/CatalogueBody";
import {chatEligible} from "./teleState";
import {ModBody} from "./bodies/ModBody";
import {TimetableBody} from "./bodies/TimetableBody";
import {RoomsBody} from "./bodies/RoomsBody";
import {ShareBody} from "./bodies/ShareBody";
import {DiscussBody} from "./bodies/DiscussBody";
import {ContributeBody} from "./bodies/ContributeBody";
import {pillarColor} from "./pillars";
import wb from "./wb.module.scss";
import styles from "./Workbench.module.scss";

// Phones in landscape (short + coarse-pointer) get the mobile shell too -
// tall panels and small chrome buttons are unusable in a 412px-tall
// touch viewport.
const MOBILE_MQ =
    "(max-width: 767px), ((pointer: coarse) and (max-height: 500px))";

function useIsMobile(): boolean {
    const [mobile, setMobile] = useState(
        () => window.matchMedia(MOBILE_MQ).matches,
    );
    useEffect(() => {
        const mq = window.matchMedia(MOBILE_MQ);
        const on = (e: MediaQueryListEvent) => setMobile(e.matches);
        mq.addEventListener("change", on);
        return () => mq.removeEventListener("change", on);
    }, []);
    return mobile;
}

function safeDecode(segment: string): string {
    // A malformed percent-sequence in the path (e.g. /mods/50%) must not
    // take down the whole tree with a URIError.
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

const TOOLS: Array<{
    id: StaticPanelId;
    icon: string;
    label: string;
    title: string;
}> = [
    {id: "cat", icon: "▤", label: "MODS", title: "Mods"},
    {id: "tt", icon: "▦", label: "TT", title: "Timetable"},
    {id: "rooms", icon: "⌗", label: "ROOM", title: "Room Finder"},
    {id: "share", icon: "✎", label: "REVIEW", title: "Review"},
    {id: "discuss", icon: "💡", label: "DISCUSS", title: "Discuss"},
    {id: "contribute", icon: "✱", label: "CONTRIBUTE", title: "Contribute"},
];

export function Workbench() {
    return (
        <WorkbenchUiProvider>
            <WorkbenchInner />
        </WorkbenchUiProvider>
    );
}

function WorkbenchInner() {
    // A linked account brings the other device's work with it. Inside the
    // provider on purpose: it restores declared tracks, which live in the UI
    // context rather than in redux.
    useSync();
    // And carries this device's work back. Here rather than in the plan panel
    // because this component is always mounted: the panel is hidden by default
    // and has a second view in front of it, so an account linked from the
    // banner used to be backed up only if the student happened to open it.
    useLiveBackup();

    const isMobile = useIsMobile();
    const location = useLocation();
    const navigate = useNavigate();
    const ui = useWorkbenchUi();
    const api = useWorkbenchLayout();

    // A panel body asking for another panel. On desktop that is open-or-raise,
    // exactly what the clock does for the timetable; on a phone there are no
    // windows to raise, so it is the sheet instead.
    useEffect(() => {
        const on = (e: Event) => {
            const id = (e as CustomEvent<string>).detail;
            if (window.matchMedia("(max-width: 900px)").matches) {
                ui.setSheet(id as typeof ui.sheet);
            } else {
                api.open(id);
            }
        };
        window.addEventListener(OPEN_PANEL_EVENT, on);
        return () => window.removeEventListener(OPEN_PANEL_EVENT, on);
    }, [api, ui]);

    const mods = useAppSelector((s) => s.mods.data);
    const events = useAppSelector((s) => s.timetable.events);

    const filtered = useFilteredMods();
    const conflicts = useMemo(() => detectConflicts(events), [events]);
    const nowInfo = useNowInfo(events);

    // Dynamic inspector windows pinned via right-click, keyed by mod code.
    const [pinned, setPinned] = useState<string[]>([]);

    // Prefill carried from /share?text=&mod= deep links (bookmarklet,
    // extension). Parsed synchronously once - inbound-only, like all URLs here.
    const [sharePrefill] = useState<{text?: string; mod?: string}>(() => {
        if (window.location.pathname !== "/share") return {};
        // Fragment first - that is where the bookmarklet puts it now, so the text
        // never reaches a server log. Query string still read for older ones.
        const hash = new URLSearchParams(
            window.location.hash.replace(/^#/, ""),
        );
        const query = new URLSearchParams(window.location.search);
        const pick = (k: string) => hash.get(k) ?? query.get(k) ?? undefined;
        return {text: pick("text"), mod: pick("mod")};
    });

    // ---- Inbound deep links only, once on mount. The workbench is ONE page:
    // switching tools/tabs never touches the URL.
    const booted = useRef(false);
    useEffect(() => {
        if (booted.current) return;
        booted.current = true;
        const path = location.pathname;
        const params = new URLSearchParams(location.search);
        const modMatch = /^\/mods\/([^/]+)$/.exec(path);
        if (modMatch) {
            ui.setSelected(safeDecode(modMatch[1]));
            if (isMobile) {
                ui.setMobileTab("mods");
                ui.setSheet("mod");
            } else api.open("mod");
        } else if (path === "/mods") {
            const q = params.get("q");
            const pillar = params.get("pillar");
            const term = params.get("term");
            if (q !== null) ui.setFilter(q);
            if (
                pillar &&
                ["SMT", "EPD", "ESD", "CSD", "DAI", "ASD", "HASS"].includes(
                    pillar,
                )
            ) {
                ui.setPillar(pillar as Exclude<typeof ui.pillar, "ALL">);
            }
            if (term && /^([1-9]|10)$/.test(term))
                ui.setTerm(term as Exclude<typeof ui.term, "ALL">);
            if (isMobile) ui.setMobileTab("mods");
            else api.open("cat");
        } else if (path === "/venues") {
            const focus = params.get("focus");
            const q = params.get("q");
            if (focus) ui.setSelectedRoom(focus);
            // /venues?q= now feeds the one shared search, same as the mods tab.
            if (q !== null) ui.setFilter(q);
            if (isMobile) ui.setMobileTab("rooms");
            else api.open("rooms");
        } else if (path === "/share") {
            if (isMobile) {
                ui.setMobileTab("more");
                ui.setSheet("share");
            } else api.open("share");
        } else if (path === "/discuss") {
            if (isMobile) {
                ui.setMobileTab("more");
                ui.setSheet("discuss");
            } else api.open("discuss");
        } else if (path === "/contribute") {
            if (isMobile) {
                ui.setMobileTab("more");
                ui.setSheet("contribute");
            } else api.open("contribute");
        } else if (path === "/timetable") {
            if (isMobile) ui.setMobileTab("tt");
            else api.open("tt");
        } else if (path !== "/") {
            navigate("/", {replace: true});
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // A sheet opened on mobile must not lurk behind the desktop shell and
    // re-appear when the viewport narrows again.
    useEffect(() => {
        if (!isMobile) ui.setSheet(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isMobile]);

    // One mod, one window - click and right-click always resolve to the SAME
    // inspector if one already shows that mod, surfacing it instead of
    // spawning a duplicate.
    const pinnedFor = (code: string) =>
        pinned.includes(code) && !api.layout[`mod:${code}`]?.hidden
            ? `mod:${code}`
            : null;
    const mainShows = (code: string) =>
        ui.selected === code && !api.layout.mod?.hidden;

    // Click = select (re-click the selected mod toggles the inspector).
    const pickMod = (code: string) => {
        if (isMobile) {
            ui.setSelected(code);
            ui.setSheet("mod");
            return;
        }
        const pinnedId = pinnedFor(code);
        if (pinnedId) {
            api.open(pinnedId);
            return;
        }
        if (mainShows(code)) {
            api.close("mod");
            return;
        }
        ui.setSelected(code);
        api.open("mod");
    };

    // Right-click = pin an extra inspector window for side-by-side comparison
    // - unless a window for this mod already exists, which is surfaced instead.
    const pinMod = (code: string) => {
        if (isMobile) return;
        const pinnedId = pinnedFor(code);
        if (pinnedId) {
            api.open(pinnedId);
            return;
        }
        if (mainShows(code)) {
            api.open("mod");
            return;
        }
        const id = `mod:${code}`;
        setPinned((prev) => (prev.includes(code) ? prev : [...prev, code]));
        // Cascade over the right column so pinned windows never bury the
        // catalogue the user is browsing.
        const offset = (pinned.length % 5) * 36;
        api.open(id, {
            x: Math.max(RAIL_W + 400, api.viewport.vw - 440) - offset,
            y: TOPBAR_H + 20 + offset,
            w: 400,
            h: api.viewport.vh - TOPBAR_H - 34,
            hidden: false,
            collapsed: false,
            z: 1,
        });
    };

    const unpinMod = (code: string) => {
        setPinned((prev) => prev.filter((c) => c !== code));
        api.remove(`mod:${code}`);
    };

    const focusRoom = (room: string) => {
        ui.setSelectedRoom(room);
        if (isMobile) {
            ui.setMobileTab("rooms");
            ui.setSheet(null);
        } else api.open("rooms");
    };

    // Typing in the global search surfaces MODS + ROOM FINDER: stacked
    // defaults when either is hidden, otherwise just brought to the front.
    const searchWasEmpty = useRef(ui.filter === "");
    const onGlobalFilter = (value: string) => {
        ui.setFilter(value);
        const nowEmpty = value.trim() === "";
        if (!nowEmpty && searchWasEmpty.current && !isMobile) {
            const catHidden = api.layout.cat?.hidden;
            const roomsHidden = api.layout.rooms?.hidden;
            if (catHidden || roomsHidden) {
                const {vw, vh} = api.viewport;
                const left = RAIL_W + 20;
                const top = TOPBAR_H + 20;
                const w = Math.min(560, vw - left - 14);
                const h = Math.floor((vh - top - 14 - 16) / 2);
                api.arrange("cat", {x: left, y: top, w, h});
                api.arrange("rooms", {x: left, y: top + h + 16, w, h});
            } else {
                api.focus("cat");
                api.focus("rooms");
            }
        }
        searchWasEmpty.current = nowEmpty;
    };

    // '/' (and ⌘K/Ctrl+K, as an alias for muscle memory) focuses the search -
    // but never while the user is typing somewhere else.
    const filterRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (isMobile) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.isComposing) return;
            const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(
                (document.activeElement as HTMLElement)?.tagName ?? "",
            );
            if (typing) return;
            if (
                e.key === "/" ||
                ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")
            ) {
                e.preventDefault();
                filterRef.current?.focus();
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [isMobile]);

    const modTitle = (code: string | null): string => {
        if (!code) return "INSPECTOR";
        const m = mods[code];
        return m ? `${m.code} · ${m.name}` : code;
    };

    if (isMobile) {
        return (
            <MobileShell
                nowInfo={nowInfo}
                clashCount={conflicts.length}
                pickMod={pickMod}
                focusRoom={focusRoom}
                sharePrefill={sharePrefill}
            />
        );
    }

    return (
        <div className={styles.root}>
            <div className={styles.frame} aria-hidden />
            <div
                className={`${styles.corner} ${styles.cornerTL}`}
                aria-hidden
            />
            <div
                className={`${styles.corner} ${styles.cornerTR}`}
                aria-hidden
            />
            <div
                className={`${styles.corner} ${styles.cornerBL}`}
                aria-hidden
            />
            <div
                className={`${styles.corner} ${styles.cornerBR}`}
                aria-hidden
            />

            <header className={styles.topbar}>
                <div className={styles.brand}>
                    {/* Otto IS the m, the one modSUTD already starts with -
                        so he stands where that letter does, at lowercase size,
                        rather than as a mascot parked beside the word. */}
                    <span className={styles.wordmark}>
                        <span className={styles.octo}>
                            <Otto />
                        </span>
                        odSUTD
                    </span>
                    <span className={styles.badge}>WORKBENCH</span>
                </div>
                <div className={styles.filterZone}>
                    <span className={styles.slash} aria-hidden>
                        /
                    </span>
                    <input
                        ref={filterRef}
                        className={styles.filter}
                        value={ui.filter}
                        onChange={(e) => onGlobalFilter(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape")
                                (e.target as HTMLInputElement).blur();
                        }}
                        placeholder="Global search (mods, rooms)   (press / anywhere)"
                        spellCheck={false}
                        aria-label="Global search (mods, rooms)"
                    />
                </div>
                <NowChip info={nowInfo} onOpen={() => api.open("tt")} />
                {conflicts.length > 0 && (
                    <button
                        type="button"
                        className={styles.clash}
                        onClick={() => api.open("tt")}
                    >
                        <i aria-hidden /> {conflicts.length} CLASH
                    </button>
                )}
            </header>

            <GithubLinkBanner />
            <HotBanner />

            <nav className={styles.rail} aria-label="tools">
                {TOOLS.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        className={`${styles.tool} ${!api.layout[t.id]?.hidden ? styles.toolOn : ""}`}
                        aria-label={t.title}
                        data-tip={t.title.toLowerCase()}
                        data-tip-side="right"
                        aria-pressed={!api.layout[t.id]?.hidden}
                        onClick={() => api.toggle(t.id)}
                    >
                        <span className={styles.toolIcon} aria-hidden>
                            {t.icon}
                        </span>
                        <span className={styles.toolLabel}>{t.label}</span>
                    </button>
                ))}
                <button
                    type="button"
                    className={styles.toolReset}
                    aria-label="Reset layout"
                    data-tip="reset layout"
                    data-tip-side="right"
                    onClick={api.reset}
                >
                    ⟲
                </button>
                <span className={styles.rev}>modSUTD · 2026</span>
            </nav>

            <div className={styles.desk}>
                <Panel
                    id="cat"
                    title="MODS"
                    layout={api.layout.cat}
                    api={api}
                    meta={`${filtered.length} ROWS`}
                >
                    <CatalogueBody
                        onPick={pickMod}
                        onPin={pinMod}
                        selectedOpen={!api.layout.mod?.hidden}
                        onPlanDragStart={() => {
                            ui.setTtMode("tree");
                            api.open("tt");
                        }}
                    />
                </Panel>
                <Panel
                    id="mod"
                    title={modTitle(ui.selected)}
                    layout={api.layout.mod}
                    api={api}
                >
                    <ModBody
                        code={ui.selected}
                        onPick={pickMod}
                        onFocusRoom={focusRoom}
                    />
                </Panel>
                <Panel
                    id="tt"
                    title="TIMETABLE"
                    layout={api.layout.tt}
                    api={api}
                    meta={events.length ? `${events.length} EVENTS` : undefined}
                >
                    <TimetableBody
                        onPickMod={(code) => {
                            if (mods[code]) pickMod(code);
                        }}
                    />
                </Panel>
                <Panel
                    id="rooms"
                    title="ROOM FINDER"
                    layout={api.layout.rooms}
                    api={api}
                >
                    <RoomsBody />
                </Panel>
                <Panel
                    id="share"
                    title="REVIEW"
                    layout={api.layout.share}
                    api={api}
                >
                    <ShareBody
                        prefillText={sharePrefill.text}
                        prefillMod={sharePrefill.mod}
                    />
                </Panel>
                <Panel
                    id="discuss"
                    title="DISCUSS"
                    layout={api.layout.discuss}
                    api={api}
                >
                    <DiscussBody />
                </Panel>
                <Panel
                    id="contribute"
                    title="CONTRIBUTE"
                    layout={api.layout.contribute}
                    api={api}
                >
                    <ContributeBody />
                </Panel>

                {pinned.map((code) =>
                    api.layout[`mod:${code}`] ? (
                        <Panel
                            key={code}
                            id={`mod:${code}`}
                            title={modTitle(code)}
                            layout={api.layout[`mod:${code}`]}
                            api={api}
                            onClose={() => unpinMod(code)}
                        >
                            <ModBody
                                code={code}
                                onPick={pickMod}
                                onFocusRoom={focusRoom}
                            />
                        </Panel>
                    ) : null,
                )}
            </div>

            <DragGhostChip />
        </div>
    );
}

// The freeform chip that follows the cursor during any mod drag - visual
// feedback only (drops resolve via elementFromPoint, not this element,
// which is pointer-events: none).
function DragGhostChip() {
    const {dragGhost} = useWorkbenchUi();
    if (!dragGhost) return null;
    return (
        <div
            className={styles.dragGhost}
            style={{left: dragGhost.x + 12, top: dragGhost.y + 12}}
            aria-hidden
        >
            {dragGhost.label}
        </div>
    );
}

// ---------------- now chip ----------------

function NowChip({
    info,
    onOpen,
}: {
    info: ReturnType<typeof useNowInfo>;
    onOpen: () => void;
}) {
    const [peekNext, setPeekNext] = useState(false);
    const currentCode = info.current?.modCode;
    useEffect(() => setPeekNext(false), [currentCode]);

    if (!info.current && !info.next) {
        return (
            <button
                type="button"
                className={styles.stat}
                onClick={onOpen}
                data-tip="timetable"
            >
                <strong>{info.clock}</strong>
            </button>
        );
    }

    const showing =
        peekNext && info.next ? info.next : (info.current ?? info.next!);
    const isCurrentView = !peekNext && !!info.current;
    const fillPct = peekNext ? 0 : Math.round(info.fill * 100);

    return (
        <div className={styles.nowWrap}>
            <button
                type="button"
                className={styles.stat}
                onClick={onOpen}
                data-tip="timetable"
            >
                <strong>{info.clock}</strong>
            </button>
            <button
                type="button"
                className={`${styles.nowCard} ${isCurrentView ? styles.nowCurrent : styles.nowUpcoming}`}
                onClick={onOpen}
                data-tip="timetable"
            >
                <span
                    className={styles.nowFill}
                    style={{width: `${fillPct}%`}}
                    aria-hidden
                />
                <span className={styles.nowLines}>
                    <span>
                        {showing.modCode} @ {showing.location}
                    </span>
                    <span>
                        {showing.startTime}–{showing.endTime}
                    </span>
                </span>
            </button>
            {info.current && info.next && (
                <button
                    type="button"
                    className={styles.nowNextBtn}
                    aria-label={
                        peekNext ? "show current class" : "show next class"
                    }
                    onClick={() => setPeekNext((v) => !v)}
                >
                    {peekNext ? "‹" : "›"}
                </button>
            )}
        </div>
    );
}

// ---------------- mobile ----------------

function Sheet({
    label,
    onClose,
    children,
}: {
    label: string;
    onClose: () => void;
    children: ReactNode;
}) {
    const closeRef = useRef<HTMLButtonElement>(null);

    // Focus lands on the close button when the sheet opens and returns to the
    // opener when it closes; Escape closes. Together with role="dialog" this
    // makes the sheet operable without a pointer.
    useEffect(() => {
        const opener = document.activeElement as HTMLElement | null;
        closeRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
            opener?.focus?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className={styles.sheetBackdrop} onClick={onClose}>
            <div
                className={styles.sheet}
                role="dialog"
                aria-modal="true"
                aria-label={label}
                onClick={(e) => e.stopPropagation()}
            >
                <div className={styles.sheetHandle}>
                    <div />
                    <button
                        ref={closeRef}
                        type="button"
                        className={styles.sheetClose}
                        onClick={onClose}
                        aria-label={`close ${label}`}
                    >
                        ✕
                    </button>
                </div>
                <div className={styles.sheetBody}>{children}</div>
            </div>
        </div>
    );
}

interface MobileProps {
    nowInfo: ReturnType<typeof useNowInfo>;
    clashCount: number;
    pickMod: (code: string) => void;
    focusRoom: (room: string) => void;
    sharePrefill: {text?: string; mod?: string};
}

function MobileShell({
    nowInfo,
    clashCount,
    pickMod,
    focusRoom,
    sharePrefill,
}: MobileProps) {
    const ui = useWorkbenchUi();
    const rows = useFilteredMods();
    const dispatch = useAppDispatch();
    const suppressClick = useRef(false);

    const TABS: Array<{key: MobileTab; label: string; icon: string}> = [
        {key: "mods", label: "Mods", icon: "▤"},
        {key: "tt", label: "Timetable", icon: "▦"},
        {key: "rooms", label: "Rooms", icon: "⌗"},
        {key: "more", label: "More", icon: "⋯"},
    ];

    return (
        <div className={styles.root}>
            <div className={styles.mroot}>
                <div className={styles.mbar}>
                    <span className={styles.wordmark}>
                        <span className={styles.octo}>
                            <Otto />
                        </span>
                        odSUTD
                    </span>
                    <span className={styles.mstat}>
                        <NowChip
                            info={nowInfo}
                            onOpen={() => ui.setMobileTab("tt")}
                        />
                        {clashCount > 0 && (
                            <span
                                role="status"
                                aria-label={`${clashCount} timetable clashes`}
                            >
                                <span
                                    className={styles.mclashDot}
                                    aria-hidden
                                />
                            </span>
                        )}
                    </span>
                </div>

                <GithubLinkBanner />
                <HotBanner />

                <div className={styles.mmain}>
                    {ui.mobileTab === "mods" && (
                        <>
                            <div className={styles.msearchRow}>
                                <div className={styles.msearchBox}>
                                    <span className={styles.slash} aria-hidden>
                                        /
                                    </span>
                                    <input
                                        value={ui.filter}
                                        onChange={(e) =>
                                            ui.setFilter(e.target.value)
                                        }
                                        placeholder="search modules…"
                                        spellCheck={false}
                                        aria-label="search modules"
                                    />
                                    <span
                                        className={wb.faint}
                                        style={{fontSize: 10}}
                                    >
                                        {rows.length}
                                    </span>
                                </div>
                                <div className={styles.mchips}>
                                    {(
                                        [
                                            "ALL",
                                            "SMT",
                                            "EPD",
                                            "ESD",
                                            "CSD",
                                            "DAI",
                                            "ASD",
                                            "HASS",
                                        ] as const
                                    ).map((p) => (
                                        <button
                                            key={p}
                                            type="button"
                                            className={`${wb.chip} ${ui.pillar === p ? wb.chipOn : ""}`}
                                            style={{
                                                fontSize: 11,
                                                padding: "6px 12px",
                                                borderRadius: 7,
                                            }}
                                            onClick={() => ui.setPillar(p)}
                                        >
                                            {p === "ALL"
                                                ? "ALL"
                                                : p.toUpperCase()}
                                        </button>
                                    ))}
                                </div>
                                <div className={styles.mchips}>
                                    {(
                                        [
                                            "ALL",
                                            "1",
                                            "2",
                                            "3",
                                            "4",
                                            "5",
                                            "6",
                                            "7",
                                            "8",
                                            "9",
                                            "10",
                                        ] as const
                                    ).map((t) => (
                                        <button
                                            key={t}
                                            type="button"
                                            className={`${wb.chip} ${ui.term === t ? wb.chipOn : ""}`}
                                            style={{
                                                fontSize: 11,
                                                padding: "6px 12px",
                                                borderRadius: 7,
                                            }}
                                            onClick={() => ui.setTerm(t)}
                                        >
                                            {t === "ALL" ? "ALL" : `T${t}`}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className={wb.scroll} style={{flex: 1}}>
                                {rows.map((m) => {
                                    const k = m.key ?? m.code;
                                    return (
                                        <button
                                            key={k}
                                            type="button"
                                            className={styles.mrow}
                                            style={{
                                                borderLeftColor: pillarColor(
                                                    m.pillar,
                                                ),
                                            }}
                                            onClick={() => {
                                                if (!suppressClick.current)
                                                    pickMod(k);
                                            }}
                                            onPointerDown={(e) => {
                                                if (
                                                    e.pointerType === "mouse" &&
                                                    e.button !== 0
                                                )
                                                    return;
                                                // On engage the plan floats in as an overlay INSTEAD
                                                // of a tab switch - unmounting this row mid-touch
                                                // would orphan the touch stream and cancel the drag.
                                                beginModDrag(e, {
                                                    key: k,
                                                    label: chipLabel(m),
                                                    setGhost: ui.setDragGhost,
                                                    holdMs: 450,
                                                    onEngage: () => {
                                                        suppressClick.current = true;
                                                        ui.setTtMode("tree");
                                                    },
                                                    onDrop: (level) => {
                                                        if (level !== null) {
                                                            dispatch(
                                                                selectMod({
                                                                    mode: ui.freshmoreMode,
                                                                    code: k,
                                                                    level,
                                                                }),
                                                            );
                                                            ui.setMobileTab(
                                                                "tt",
                                                            );
                                                        }
                                                        setTimeout(() => {
                                                            suppressClick.current = false;
                                                        }, 0);
                                                    },
                                                });
                                            }}
                                        >
                                            <span className={styles.mrowCode}>
                                                <span
                                                    style={{
                                                        fontWeight: 700,
                                                        fontSize: 15,
                                                    }}
                                                >
                                                    {m.code}
                                                </span>
                                                <span
                                                    style={{
                                                        display: "block",
                                                        fontSize: 9,
                                                        color: pillarColor(
                                                            m.pillar,
                                                        ),
                                                        marginTop: 2,
                                                    }}
                                                >
                                                    {m.pillar}
                                                    {/* The same mark the
                                                        desktop list carries
                                                        beside PILR. The two
                                                        lists are different
                                                        markup and one rule,
                                                        chatEligible(). */}
                                                    {chatEligible(m) ? (
                                                        <span
                                                            data-act="tele-eligible"
                                                            aria-label="can have a batch chat"
                                                            style={{
                                                                marginLeft: 4,
                                                                color: "rgba(122,162,247,0.65)",
                                                            }}
                                                        >
                                                            ✈
                                                        </span>
                                                    ) : null}
                                                </span>
                                            </span>
                                            <span className={styles.mrowName}>
                                                {m.name}
                                                <span
                                                    style={{
                                                        display: "block",
                                                        fontSize: 11,
                                                        color: "rgba(233,234,237,0.62)",
                                                        marginTop: 3,
                                                    }}
                                                >
                                                    Term {m.term} · {m.credits}{" "}
                                                    cr
                                                </span>
                                            </span>
                                            <span
                                                style={{
                                                    color: "rgba(233,234,237,0.3)",
                                                    fontSize: 15,
                                                }}
                                            >
                                                ›
                                            </span>
                                        </button>
                                    );
                                })}
                                {rows.length === 0 && (
                                    <div className={wb.empty}>
                                        <span className={wb.ottoDim}>
                                            <Otto size={76} />
                                        </span>
                                        <span>
                                            Otto found nothing for that.
                                            <br />
                                            Try a different code, pillar or
                                            term.
                                        </span>
                                    </div>
                                )}
                            </div>
                        </>
                    )}

                    {ui.mobileTab === "tt" && (
                        <div
                            style={{
                                flex: 1,
                                display: "flex",
                                flexDirection: "column",
                                minHeight: 0,
                            }}
                        >
                            <TimetableBody onPickMod={pickMod} />
                        </div>
                    )}

                    {/* While a mod is mid-drag from the list, the plan floats OVER
              the (still-mounted) mods tab so the term rows can catch the
              drop. */}
                    {ui.dragGhost && ui.mobileTab === "mods" && (
                        <div className={styles.mdragOverlay}>
                            <TimetableBody onPickMod={pickMod} />
                        </div>
                    )}

                    {ui.mobileTab === "rooms" && (
                        <div
                            style={{
                                flex: 1,
                                display: "flex",
                                flexDirection: "column",
                                minHeight: 0,
                            }}
                        >
                            {/* Same box as the mods tab, bound to the same value - one search
                  that follows you between tabs, instead of two that forget
                  each other. RoomsBody's own input stays off. */}
                            <div className={styles.msearchRow}>
                                <div className={styles.msearchBox}>
                                    <span className={styles.slash} aria-hidden>
                                        /
                                    </span>
                                    <input
                                        value={ui.filter}
                                        onChange={(e) =>
                                            ui.setFilter(e.target.value)
                                        }
                                        placeholder="search rooms…"
                                        spellCheck={false}
                                        aria-label="search rooms by code, name or type"
                                    />
                                </div>
                            </div>
                            <RoomsBody />
                        </div>
                    )}

                    {ui.mobileTab === "more" && (
                        <div className={styles.moreList}>
                            <button
                                type="button"
                                className={styles.moreBtn}
                                data-act="more-review"
                                onClick={() => ui.setSheet("share")}
                            >
                                <span>✎</span> review - share yours{" "}
                                <span>›</span>
                            </button>
                            <button
                                type="button"
                                className={styles.moreBtn}
                                onClick={() => ui.setSheet("discuss")}
                            >
                                <span>💡</span> features &amp; bugs{" "}
                                <span>›</span>
                            </button>
                            <button
                                type="button"
                                className={styles.moreBtn}
                                onClick={() => ui.setSheet("contribute")}
                            >
                                <span>✱</span> contribute <span>›</span>
                            </button>
                        </div>
                    )}
                </div>

                <nav className={styles.mnav} aria-label="primary">
                    {TABS.map((t) => (
                        <button
                            key={t.key}
                            type="button"
                            className={`${styles.mtab} ${ui.mobileTab === t.key ? styles.mtabOn : ""}`}
                            aria-current={
                                ui.mobileTab === t.key ? "page" : undefined
                            }
                            onClick={() => ui.setMobileTab(t.key)}
                        >
                            <span className={styles.mtabIcon} aria-hidden>
                                {t.icon}
                            </span>
                            <span className={styles.mtabLabel}>{t.label}</span>
                        </button>
                    ))}
                </nav>

                {ui.sheet === "mod" && (
                    <Sheet label="mod" onClose={() => ui.setSheet(null)}>
                        <ModBody
                            code={ui.selected}
                            onPick={pickMod}
                            onFocusRoom={focusRoom}
                        />
                    </Sheet>
                )}
                {ui.sheet === "share" && (
                    <Sheet label="share" onClose={() => ui.setSheet(null)}>
                        <ShareBody
                            prefillText={sharePrefill.text}
                            prefillMod={sharePrefill.mod}
                        />
                    </Sheet>
                )}
                {ui.sheet === "discuss" && (
                    <Sheet label="discuss" onClose={() => ui.setSheet(null)}>
                        <DiscussBody />
                    </Sheet>
                )}
                {ui.sheet === "contribute" && (
                    <Sheet label="contribute" onClose={() => ui.setSheet(null)}>
                        <ContributeBody />
                    </Sheet>
                )}
            </div>

            <DragGhostChip />
        </div>
    );
}
