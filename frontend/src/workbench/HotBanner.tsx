import { useNotice, dismissNotice } from './notice';
import styles from './Workbench.module.scss';

export function HotBanner() {
  const notice = useNotice();
  if (!notice) return null;

  return (
    <div
      className={`${styles.linkBanner} ${notice.tone === 'ok' ? styles.hotOk : styles.hotWarn}`}
      role="status"
    >
      <span>{notice.text}</span>
      <button type="button" className={styles.linkDismiss} aria-label="dismiss" onClick={dismissNotice}>
        ✕
      </button>
    </div>
  );
}
