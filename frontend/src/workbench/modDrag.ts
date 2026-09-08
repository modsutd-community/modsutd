import type { DragGhost } from './uiContext';

// How close (px) a release has to be to a term row to snap into it.
// Farther than this, the drag just dissolves - no accidental placements.
const SNAP_PX = 48;

// Nearest visible [data-level] row within SNAP_PX of the point. Rows are
// measured clipped to their panel so a row scrolled out of the plan can't
// catch a drop through whatever is drawn on top of it.
function levelNear(x: number, y: number): number | null {
  let best: number | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  document.querySelectorAll<HTMLElement>('[data-level]').forEach((el) => {
    let { top, bottom, left, right } = el.getBoundingClientRect();
    if (right <= left || bottom <= top) return;
    const host = el.closest('[data-panel]');
    if (host) {
      const h = host.getBoundingClientRect();
      top = Math.max(top, h.top);
      bottom = Math.min(bottom, h.bottom);
      left = Math.max(left, h.left);
      right = Math.min(right, h.right);
      if (right <= left || bottom <= top) return;
    }
    const dx = Math.max(left - x, 0, x - right);
    const dy = Math.max(top - y, 0, y - bottom);
    const d = Math.hypot(dx, dy);
    if (d < bestD) {
      bestD = d;
      best = Number(el.dataset.level);
    }
  });
  return bestD <= SNAP_PX ? best : null;
}

// Shared drag for everything that can land in the plan. Engages after a
// 6px threshold (or a holdMs long-press on touch); releasing within
// SNAP_PX of a term row drops, anywhere else cancels.
export function beginModDrag(
  e: React.PointerEvent,
  opts: {
    key: string;
    label: string;
    setGhost: (g: DragGhost | null) => void;
    // Fires once when the drag engages (suppress clicks, open the plan,
    // close hover cards…).
    onEngage?: () => void;
    // Fires on release only if the drag engaged. level is null when the
    // pointer wasn't near a plan row.
    onDrop: (level: number | null) => void;
    // Touch pointers only: engage after holding this long without moving
    // (so the list still scrolls normally). Without it, touch engages on
    // the same movement threshold as the mouse.
    holdMs?: number;
  },
) {
  const startX = e.clientX;
  const startY = e.clientY;
  const pointerId = e.pointerId;
  const isHold = opts.holdMs !== undefined && e.pointerType === 'touch';
  let lastX = startX;
  let lastY = startY;
  let engaged = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  // Once a touch drag engages, the first significant touchmove must not
  // start a native scroll - that would pointercancel the drag.
  const blockScroll = (ev: TouchEvent) => {
    if (engaged) ev.preventDefault();
  };

  const engage = () => {
    engaged = true;
    // A touch pointer is implicitly captured by the element it went down
    // on - which onEngage may unmount (the mobile shell hops to the plan
    // tab). Re-capture on <body> so the pointer stream survives.
    try {
      document.body.setPointerCapture(pointerId);
    } catch {
      // no active pointer with that id (e.g. synthetic events) - harmless
    }
    opts.onEngage?.();
    opts.setGhost({ key: opts.key, label: opts.label, x: lastX, y: lastY, level: levelNear(lastX, lastY) });
  };

  const move = (ev: PointerEvent) => {
    lastX = ev.clientX;
    lastY = ev.clientY;
    if (!engaged) {
      const moved = Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6;
      if (isHold) {
        // Moving before the hold fires means the user is scrolling.
        if (moved) teardown();
        return;
      }
      if (!moved) return;
      engage();
    }
    ev.preventDefault();
    opts.setGhost({
      key: opts.key,
      label: opts.label,
      x: ev.clientX,
      y: ev.clientY,
      level: levelNear(ev.clientX, ev.clientY),
    });
  };

  const teardown = () => {
    if (holdTimer) clearTimeout(holdTimer);
    try {
      document.body.releasePointerCapture(pointerId);
    } catch {
      // capture was never taken
    }
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', cancel);
    document.removeEventListener('touchmove', blockScroll);
    opts.setGhost(null);
  };
  const up = (ev: PointerEvent) => {
    const wasEngaged = engaged;
    // Some touch stacks report (0,0) on the final pointerup - trust the
    // last tracked position instead.
    const x = ev.clientX || lastX;
    const y = ev.clientY || lastY;
    teardown();
    if (wasEngaged) opts.onDrop(levelNear(x, y));
  };
  const cancel = () => {
    const wasEngaged = engaged;
    teardown();
    if (wasEngaged) opts.onDrop(null);
  };

  if (isHold) holdTimer = setTimeout(engage, opts.holdMs);
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', cancel);
  document.addEventListener('touchmove', blockScroll, { passive: false });
}

// AY2026 placeholders all share code 99.999 - the name is the identity, so
// it's also the chip label.
export function chipLabel(mod: { code: string; name: string }): string {
  return mod.code === '99.999' ? mod.name : mod.code;
}
