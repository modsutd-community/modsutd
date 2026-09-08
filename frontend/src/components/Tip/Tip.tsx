import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './Tip.module.scss';

// A tooltip that is not clipped by whatever it sits inside.
//
// The panels scroll and each is its own stacking context, so a bubble
// positioned inside one is cut off at the panel edge however high its z-index
// goes: `overflow` clips before `z-index` is consulted. This renders into
// document.body instead and positions from the trigger's rect, so nothing
// between it and the page can crop it.
//
// Hover alone would make it unreachable by keyboard and invisible on a phone,
// so it opens on focus and on tap as well, and Escape closes it.

interface Props {
  /** The trigger. Rendered as a button, so it is tabbable and tappable. */
  label: string;
  children: React.ReactNode;
  'data-act'?: string;
}

const GAP = 8;

export function Tip({ label, children, 'data-act': act }: Props) {
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const id = useId();

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    // Clamped to the viewport: near the right edge an unclamped bubble runs
    // off screen, and on a phone the trigger is often close to it.
    const width = Math.min(260, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setAt({ top: r.bottom + GAP, left });
  }, []);

  const open = useCallback(() => place(), [place]);
  const close = useCallback(() => setAt(null), []);

  useEffect(() => {
    if (!at) return;
    // Anything that moves the trigger invalidates a fixed position, and the
    // panels scroll under it. Capture phase, so a scroll inside a panel counts.
    const onScroll = () => place();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('keydown', onKey);
    };
  }, [at, place, close]);

  return (
    <span className={styles.wrap} data-act={act}>
      <button
        ref={btn}
        type="button"
        className={styles.trigger}
        aria-describedby={at ? id : undefined}
        aria-expanded={!!at}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        // Never a toggle. A click arrives after the mouseenter that already
        // opened it, so toggling closed it again the instant it appeared - and
        // a tap is a click too. Opening is idempotent; blur, mouseleave and
        // Escape are what close it.
        onPointerDown={open}
      >
        {label}
      </button>
      {at && createPortal(
        <span
          id={id}
          role="tooltip"
          className={styles.bubble}
          style={{ top: at.top, left: at.left }}
        >
          {children}
        </span>,
        document.body,
      )}
    </span>
  );
}

export default Tip;
