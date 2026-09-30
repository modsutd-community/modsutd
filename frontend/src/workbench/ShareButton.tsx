import { useEffect, useState } from 'react';
import styles from './ShareButton.module.scss';

export function ShareIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </svg>
  );
}

export interface ShareButtonProps {
  url: string;
  label?: string;
  className?: string;
  'data-act'?: string;
  'data-tip-side'?: 'start' | 'end' | 'right' | 'left' | 'block';
}

export function ShareButton({
  url,
  label = 'Share this venue',
  className,
  'data-act': act = 'share-btn',
  'data-tip-side': tipSide,
}: ShareButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    let success = false;

    // Clipboard API requires document focus and permissions; try first.
    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        success = true;
      } catch {
        // Sandboxed iframe, unfocused tab, or denied permission: fall back below.
      }
    }

    // Fallback for insecure contexts, denied clipboard-write, or embedded webviews.
    // Readonly and off-screen prevent iOS Safari from zooming or popping the keyboard.
    if (!success) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = url;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = `${window.pageYOffset || document.documentElement.scrollTop}px`;
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        success = document.execCommand('copy');
        document.body.removeChild(textarea);
      } catch {
        success = false;
      }
    }

    if (success) {
      setCopied(true);
    }
  };

  const tooltipText = copied ? 'copied!' : label;

  return (
    <button
      type="button"
      className={`${styles.shareBtn} ${className ?? ''}`}
      data-act={act}
      data-tip={tooltipText}
      data-tip-side={tipSide}
      data-copied={copied ? 'true' : undefined}
      aria-label={tooltipText}
      onClick={handleCopy}
    >
      {copied ? <span className={styles.check}>✓</span> : <ShareIcon className={styles.icon} />}
      {/* Screen readers ignore in-place aria-label mutations on focused buttons; announce via live region. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {copied ? 'Link copied to clipboard' : ''}
      </span>
    </button>
  );
}
