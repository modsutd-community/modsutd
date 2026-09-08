import {useCallback, useEffect, useRef, useState} from "react";

// Window-manager state for the Workbench desktop. Geometry lives only in
// React state - mutating el.style gets reset by re-renders (drag → click →
// snap-back). Panel ids: static tools ('cat', 'tt', …) plus dynamic pinned
// pinned mod windows ('mod:50.001'). Stored geometry is the user's intent; fitting
// to the viewport happens at render time, never by rewriting it.

// load() keeps ids it does not know and the new panel takes its default.
// Asking for a panel from inside a panel body. The bodies render under the ui
// context, which knows nothing about the window manager - Workbench does, and
// it listens for this. Same shape as the gh-link signal in sync.ts, for the
// same reason: one listener, no state threaded through five components.
export const OPEN_PANEL_EVENT = 'modsutd:open-panel';

export function openPanel(id: PanelId): void {
  window.dispatchEvent(new CustomEvent(OPEN_PANEL_EVENT, { detail: id }));
}

export const STATIC_PANEL_IDS = [
    "cat",
    "mod",
    "tt",
    "rooms",
    "share",
    "discuss",
    "contribute",
] as const;
export type StaticPanelId = (typeof STATIC_PANEL_IDS)[number];
export type PanelId = string;

export interface PanelLayout {
    x: number;
    y: number;
    w: number;
    h: number;
    collapsed: boolean;
    hidden: boolean;
    z: number;
}

export type LayoutMap = Record<PanelId, PanelLayout>;

export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

// Must match --wb-rail in Workbench.module.scss. Panels clamp against it, so a
// rail wider than this number sits on top of the leftmost panel.
export const RAIL_W = 76;
export const TOPBAR_H = 50;
const MIN_W = 280;
const MIN_H = 160;
const PAD = 14;
const STORAGE_KEY = "modsutd.workbench.layout.v3";

// Defaults are computed from the viewport so any screen works.
export function makeDefaults(vw: number, vh: number): LayoutMap {
    const left = RAIL_W + 20;
    const top = TOPBAR_H + 20;
    const usableW = Math.max(640, vw - left - PAD);
    const usableH = Math.max(480, vh - top - PAD);
    const colW = Math.floor(usableW * 0.48);
    const rightW = usableW - colW - 16;
    const catH = Math.floor(usableH * 0.56);
    const fullH = usableH;

    // Hidden-by-default tools open over the right column, cascading - the
    // left column (MODS above ROOM FINDER) stays unobstructed.
    const rightX = left + colW + 16;
    return {
        cat: {
            x: left,
            y: top,
            w: colW,
            h: catH,
            collapsed: false,
            hidden: false,
            z: 4,
        },
        rooms: {
            x: left,
            y: top + catH + 16,
            w: colW,
            h: usableH - catH - 16,
            collapsed: false,
            hidden: false,
            z: 3,
        },
        share: {
            x: rightX,
            y: top,
            w: rightW,
            h: fullH,
            collapsed: false,
            hidden: false,
            z: 2,
        },
        mod: {
            x: rightX,
            y: top,
            w: Math.min(420, rightW),
            h: fullH,
            collapsed: false,
            hidden: true,
            z: 5,
        },
        tt: {
            x: rightX - 40,
            y: top + 30,
            w: Math.min(560, usableW - colW),
            h: Math.floor(usableH * 0.75),
            collapsed: false,
            hidden: true,
            z: 1,
        },
        discuss: {
            x: rightX - 20,
            y: top + 50,
            w: Math.min(480, rightW),
            h: Math.floor(usableH * 0.7),
            collapsed: false,
            hidden: true,
            z: 1,
        },
        contribute: {
            x: rightX - 60,
            y: top + 20,
            w: Math.min(540, usableW - colW),
            h: Math.floor(usableH * 0.8),
            collapsed: false,
            hidden: true,
            z: 1,
        },
    };
}

// Shrink before clamping position - the panel must sit fully inside the viewport.
export function fitToViewport(
    l: PanelLayout,
    vw: number,
    vh: number,
): PanelLayout {
    const maxW = Math.max(MIN_W, vw - RAIL_W - 2 - PAD);
    const maxH = Math.max(MIN_H, vh - TOPBAR_H - 2 - PAD);
    const w = Math.min(Math.max(l.w, MIN_W), maxW);
    const h = Math.min(Math.max(l.h, MIN_H), maxH);
    const x = Math.max(RAIL_W + 2, Math.min(l.x, vw - PAD - w));
    const y = Math.max(TOPBAR_H + 2, Math.min(l.y, vh - PAD - h));
    return {...l, x, y, w, h};
}

function finite(n: unknown, fallback: number): number {
    return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function load(): LayoutMap {
    const out = makeDefaults(window.innerWidth, window.innerHeight);
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return out;
        const saved = JSON.parse(raw) as Record<string, Partial<PanelLayout>>;
        for (const id of Object.keys(saved)) {
            const s = saved[id];
            if (!s) continue;
            const base = out[id] ?? {...out.ins, hidden: true};
            // Coerce defensively - corrupted values must not poison the math.
            out[id] = {
                x: finite(s.x, base.x),
                y: finite(s.y, base.y),
                w: finite(s.w, base.w),
                h: finite(s.h, base.h),
                collapsed: s.collapsed === true,
                hidden:
                    s.hidden === true ||
                    (s.hidden === undefined && base.hidden),
                z: finite(s.z, base.z),
            };
        }
        // Normalise z to 1..N so the counter can't creep toward the chrome
        // z-indexes (rail 1500 / topbar 2000) across sessions.
        const ids = Object.keys(out).sort((a, b) => out[a].z - out[b].z);
        ids.forEach((id, i) => {
            out[id].z = i + 1;
        });
        return out;
    } catch {
        return out;
    }
}

export interface WorkbenchLayoutApi {
    layout: LayoutMap;
    viewport: {vw: number; vh: number};
    focus: (id: PanelId) => void;
    open: (id: PanelId, defaults?: Partial<PanelLayout>) => void;
    close: (id: PanelId) => void;
    toggle: (id: PanelId) => void;
    arrange: (id: PanelId, geo: Partial<PanelLayout>) => void;
    remove: (id: PanelId) => void;
    toggleCollapse: (id: PanelId) => void;
    reset: () => void;
    beginDrag: (id: PanelId, e: React.PointerEvent) => void;
    beginResize: (id: PanelId, dir: ResizeDir, e: React.PointerEvent) => void;
}

export function useWorkbenchLayout(): WorkbenchLayoutApi {
    const [layout, setLayout] = useState<LayoutMap>(load);
    const [viewport, setViewport] = useState(() => ({
        vw: window.innerWidth,
        vh: window.innerHeight,
    }));
    const zTop = useRef(Math.max(1, ...Object.values(layout).map((l) => l.z)));

    useEffect(() => {
        const t = setTimeout(() => {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
            } catch {
                // quota errors are non-fatal
            }
        }, 250);
        return () => clearTimeout(t);
    }, [layout]);

    // Viewport changes only re-render (render-time fitting does the rest) -
    // they never rewrite the stored geometry.
    useEffect(() => {
        const onResize = () =>
            setViewport({vw: window.innerWidth, vh: window.innerHeight});
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    const focus = useCallback((id: PanelId) => {
        setLayout((prev) => {
            if (!prev[id] || prev[id].z === zTop.current) return prev;
            zTop.current += 1;
            return {...prev, [id]: {...prev[id], z: zTop.current}};
        });
    }, []);

    const open = useCallback((id: PanelId, defaults?: Partial<PanelLayout>) => {
        zTop.current += 1;
        setLayout((prev) => {
            const base =
                prev[id] ??
                ({
                    ...makeDefaults(window.innerWidth, window.innerHeight).ins,
                    ...defaults,
                } as PanelLayout);
            return {
                ...prev,
                [id]: {
                    ...base,
                    ...(!prev[id] ? {} : {}),
                    hidden: false,
                    collapsed: false,
                    z: zTop.current,
                },
            };
        });
    }, []);

    const close = useCallback((id: PanelId) => {
        setLayout((prev) =>
            prev[id] ? {...prev, [id]: {...prev[id], hidden: true}} : prev,
        );
    }, []);

    const toggle = useCallback((id: PanelId) => {
        zTop.current += 1;
        setLayout((prev) => {
            const cur = prev[id];
            if (!cur) return prev;
            return {
                ...prev,
                [id]: {
                    ...cur,
                    hidden: !cur.hidden,
                    collapsed: false,
                    z: zTop.current,
                },
            };
        });
    }, []);

    // Explicit geometry + surface - the global search uses it to stack MODS
    // above ROOM FINDER.
    const arrange = useCallback((id: PanelId, geo: Partial<PanelLayout>) => {
        zTop.current += 1;
        setLayout((prev) => {
            const base =
                prev[id] ??
                makeDefaults(window.innerWidth, window.innerHeight).ins;
            return {
                ...prev,
                [id]: {
                    ...base,
                    ...geo,
                    hidden: false,
                    collapsed: false,
                    z: zTop.current,
                },
            };
        });
    }, []);

    // Unlike close, drops the entry entirely (dynamic pinned inspectors).
    const remove = useCallback((id: PanelId) => {
        setLayout((prev) => {
            if (!(id in prev)) return prev;
            const next = {...prev};
            delete next[id];
            return next;
        });
    }, []);

    const toggleCollapse = useCallback((id: PanelId) => {
        setLayout((prev) => ({
            ...prev,
            [id]: {...prev[id], collapsed: !prev[id].collapsed},
        }));
    }, []);

    const reset = useCallback(() => {
        const d = makeDefaults(window.innerWidth, window.innerHeight);
        zTop.current = Math.max(...Object.values(d).map((l) => l.z));
        setLayout(d);
    }, []);

    // Active-gesture teardown, shared by drag and resize and the unmount path.
    const gestureCleanup = useRef<(() => void) | null>(null);
    useEffect(() => () => gestureCleanup.current?.(), []);

    const track = useCallback(
        (
            id: PanelId,
            e: React.PointerEvent,
            apply: (l: PanelLayout, dx: number, dy: number) => PanelLayout,
        ) => {
            e.preventDefault();
            focus(id);
            const pointerId = e.pointerId;
            const startX = e.clientX;
            const startY = e.clientY;
            let start: PanelLayout | null = null;
            setLayout((prev) => {
                start = prev[id];
                return prev;
            });
            let raf = 0;
            const move = (ev: PointerEvent) => {
                if (!start) return;
                // Only the initiating pointer drives the gesture; a released button
                // (mouseup outside the window) ends it instead of gluing the panel
                // to the cursor.
                if (ev.pointerId !== pointerId) return;
                if (ev.pointerType === "mouse" && !(ev.buttons & 1)) {
                    cleanup();
                    return;
                }
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                cancelAnimationFrame(raf);
                raf = requestAnimationFrame(() => {
                    setLayout((prev) => ({
                        ...prev,
                        [id]: fitToViewport(
                            apply(start as PanelLayout, dx, dy),
                            window.innerWidth,
                            window.innerHeight,
                        ),
                    }));
                });
            };
            const end = (ev: PointerEvent) => {
                if (ev.pointerId !== pointerId) return;
                cleanup();
            };
            const cleanup = () => {
                cancelAnimationFrame(raf);
                document.removeEventListener("pointermove", move);
                document.removeEventListener("pointerup", end);
                document.removeEventListener("pointercancel", end);
                document.body.style.userSelect = "";
                gestureCleanup.current = null;
            };
            gestureCleanup.current = cleanup;
            document.body.style.userSelect = "none";
            document.addEventListener("pointermove", move);
            document.addEventListener("pointerup", end);
            document.addEventListener("pointercancel", end);
        },
        [focus],
    );

    const beginDrag = useCallback(
        (id: PanelId, e: React.PointerEvent) =>
            track(id, e, (l, dx, dy) => ({...l, x: l.x + dx, y: l.y + dy})),
        [track],
    );

    // Edge/corner resize: west/north edges move the origin while resizing so
    // the opposite edge stays pinned. Minimum size is enforced against the
    // correct anchor.
    const beginResize = useCallback(
        (id: PanelId, dir: ResizeDir, e: React.PointerEvent) =>
            track(id, e, (l, dx, dy) => {
                let {x, y, w, h} = l;
                if (dir.includes("e")) w = l.w + dx;
                if (dir.includes("s")) h = l.h + dy;
                if (dir.includes("w")) {
                    w = Math.max(MIN_W, l.w - dx);
                    x = l.x + (l.w - w);
                }
                if (dir.includes("n")) {
                    h = Math.max(MIN_H, l.h - dy);
                    y = l.y + (l.h - h);
                }
                return {
                    ...l,
                    x,
                    y,
                    w: Math.max(MIN_W, w),
                    h: Math.max(MIN_H, h),
                    collapsed: false,
                };
            }),
        [track],
    );

    return {
        layout,
        viewport,
        focus,
        open,
        close,
        toggle,
        arrange,
        remove,
        toggleCollapse,
        reset,
        beginDrag,
        beginResize,
    };
}
