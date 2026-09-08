import { ReactNode } from 'react';
import { fitToViewport, PanelId, PanelLayout, ResizeDir, WorkbenchLayoutApi } from './layout';
import styles from './Panel.module.scss';

interface PanelProps {
  id: PanelId;
  title: string;
  layout: PanelLayout;
  api: WorkbenchLayoutApi;
  meta?: ReactNode;
  // Dynamic panels (pinned inspectors) have no rail toggle, so they get a ✕
  // when onClose is provided. Static tool panels don't - the rail toggles them.
  onClose?: () => void;
  children: ReactNode;
}

const RESIZE_DIRS: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

// Viewport fitting happens at render time, so stored geometry survives
// transient window shrinks and panels can never clip off-screen.
export function Panel({ id, title, layout, api, meta, onClose, children }: PanelProps) {
  if (layout.hidden) return null;
  const fitted = fitToViewport(layout, api.viewport.vw, api.viewport.vh);

  return (
    <section
      className={styles.panel}
      data-panel={id}
      style={{
        left: fitted.x,
        top: fitted.y,
        width: fitted.w,
        height: fitted.collapsed ? 'auto' : fitted.h,
        zIndex: layout.z,
      }}
      onPointerDown={() => api.focus(id)}
      aria-label={`${title} panel`}
    >
      <header
        className={styles.titlebar}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          api.beginDrag(id, e);
        }}
        onDoubleClick={() => api.toggleCollapse(id)}
      >
        <span className={styles.grip} aria-hidden>⠿</span>
        <span className={styles.title}>{title}</span>
        {meta !== undefined && <span className={styles.meta}>{meta}</span>}
        <button
          type="button"
          className={styles.hbtn}
          style={meta === undefined ? { marginLeft: 'auto' } : undefined}
          onClick={() => api.toggleCollapse(id)}
          aria-label={layout.collapsed ? `expand ${title}` : `collapse ${title}`}
        >
          {layout.collapsed ? '▸' : '▾'}
        </button>
        {onClose && (
          <button type="button" className={styles.hbtn} onClick={onClose} aria-label={`close ${title}`}>
            ✕
          </button>
        )}
      </header>
      {!layout.collapsed && <div className={styles.body}>{children}</div>}
      {!layout.collapsed &&
        RESIZE_DIRS.map((dir) => (
          <button
            key={dir}
            type="button"
            className={`${styles.rz} ${styles[`rz_${dir}`]}`}
            onPointerDown={(e) => api.beginResize(id, dir, e)}
            aria-label={`resize ${title} ${dir}`}
            tabIndex={-1}
          />
        ))}
    </section>
  );
}
