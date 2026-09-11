import styles from './ExtLink.module.scss';

/**
 * A box with an arrow leaving it: the one glyph readers already read as "this
 * opens somewhere else".
 *
 * One copy, because it now marks three different things - a mod name, a
 * specialisation track, a minor - and three drifting copies of the same nine
 * path commands is how one of them ends up a different size.
 */
export function ExtIcon({ className }: { className?: string }) {
  return (
    <svg
      className={`${styles.icon} ${className ?? ''}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12.5 9.5v3a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3" />
      <path d="M9.5 2.5h4v4" />
      <path d="M13.5 2.5 7.5 8.5" />
    </svg>
  );
}

/**
 * The icon as a standalone link to the page a record was read from.
 *
 * Standalone because the badges it sits beside are `<label>`s wrapping a
 * checkbox: a link nested inside one toggles the checkbox on the way through.
 */
export function ExtLink({ href, what }: { href: string; what: string }) {
  return (
    <a
      className={styles.link}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-act="source-link"
      data-tip="read on the official site"
      // data-tip is a CSS ::after, which a screen reader does not announce.
      aria-label={`${what} - read on the official site`}
      onClick={(e) => e.stopPropagation()}
    >
      <ExtIcon />
    </a>
  );
}
