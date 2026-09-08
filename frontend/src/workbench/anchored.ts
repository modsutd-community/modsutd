import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// Place a hover card in viewport coordinates, under the thing that opened it.
//
// The card used to be `position: absolute` inside the panel, which cost twice:
// the panel clips it, so a card wider than the panel lost its right-hand edge;
// and an absolutely-positioned child still counts toward the scrollable area,
// so it put a horizontal scrollbar under the whole plan.
//
// `position: fixed` answers both - it escapes `overflow: hidden` on an ancestor
// and contributes nothing to any scroll area - but a fixed element cannot be
// positioned relative to its anchor in CSS, so the anchor is measured here.
//
// It is measured on open and on scroll/resize, not on every render: the card is
// short-lived, and reading a rect forces layout.

export interface AnchorPos {
  top: number;
  left: number;
  /** Card opens upward: its own height is unknown here, so CSS shifts it. */
  flip: boolean;
}

/** Keep a box of `width` fully on screen, given where its anchor sits. */
function clamp(rect: DOMRect, width: number, gap: number): AnchorPos {
  const margin = 8;
  // 160 is a floor, not the card's real height: enough room for a card worth
  // opening, and the flip is what stops it running off the bottom either way.
  const flip = rect.bottom + gap + 160 > window.innerHeight && rect.top > 180;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  return {
    left: Math.min(Math.max(margin, rect.left), maxLeft),
    // Below the anchor, or above it when there is no room below - a card that
    // opens off the bottom of the window is a card nobody can read. Which way
    // is decided here; how far is left to CSS, because the height is not known
    // until the card has rendered and guessing it puts the card in the wrong
    // place for exactly one frame.
    top: flip ? rect.top - gap : rect.bottom + gap,
    flip,
  };
}

/**
 * `open` is anything truthy - pass the id of the open card rather than a
 * boolean when one hook serves several anchors, so moving between them
 * re-measures instead of leaving the card where the last one was.
 */
export function useAnchoredCard(open: unknown, width = 280, gap = 4) {
  const el = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<AnchorPos | null>(null);

  // A callback ref rather than a ref object: the caller attaches it and never
  // writes to it, which is both a smaller surface and what the hooks lint
  // wants - a ref handed out of a hook is not the caller's to assign.
  const anchor = useCallback((node: HTMLElement | null) => {
    el.current = node;
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const measure = () => {
      const node = el.current;
      if (node) setPos(clamp(node.getBoundingClientRect(), width, gap));
    };
    measure();
    // Capture, so a scroll inside the panel is seen too - a scroll event does
    // not bubble, and the panel is what actually moves under the card.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, width, gap]);

  return { anchor, pos };
}

/** The inline style a card needs, or `undefined` before it has been measured. */
export const anchoredStyle = (pos: AnchorPos | null, width = 280) =>
  pos
    ? {
        position: 'fixed' as const,
        top: pos.top,
        left: pos.left,
        width,
        ...(pos.flip ? { transform: 'translateY(-100%)' } : null),
      }
    : undefined;
