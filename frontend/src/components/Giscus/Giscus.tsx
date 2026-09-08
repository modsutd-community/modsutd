import { useEffect, useRef } from 'react';
import { useLinkVersion } from '@/workbench/sync';
import styles from './Giscus.module.scss';

// Hand-rolled giscus embed. The official client.js supports ONE widget per
// page - every load hijacks the single global .giscus container and its
// resize listener matches any giscus iframe - so two open panels (mod
// reviews + discuss) blanked each other. We build the widget iframe
// ourselves with the same URL contract and scope each message by
// event.source, which makes any number of instances coexist.

const HOST = 'https://giscus.app';
const SESSION_KEY = 'giscus-session';

// giscus keeps its OWN GitHub session, separate from the device-flow token in
// sync.ts: linking an account in the workbench does not sign you in here, and
// the "Sign in" inside this iframe is giscus's, not ours. Nothing on our side
// can change it - the frame is cross-origin.
//
// GitHub sign-in bounces back to the page with ?giscus=<session>; capture
// it exactly like client.js does (module scope: before any router code
// can touch the URL).
function captureSession(): string {
  const url = new URL(window.location.href);
  const fresh = url.searchParams.get('giscus');
  if (fresh) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(fresh));
    url.searchParams.delete('giscus');
    url.hash = '';
    history.replaceState(undefined, document.title, url.toString());
    return fresh;
  }
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? '""') as string;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return '';
  }
}
// Module scope, because the URL must be read before any router code rewrites
// it. The value is deliberately not reused: `session()` re-reads storage when
// a frame is built, so a sign-out in one panel does not leave a sibling
// re-sending a session giscus has already thrown away.
captureSession();
const session = () => {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? '""') as string;
  } catch {
    return '';
  }
};

interface GiscusProps {
  repo: string;
  repoId: string;
  category: string;
  categoryId: string;
  mapping?: 'specific';
  term?: string;
  reactionsEnabled?: '1' | '0';
  emitMetadata?: '1' | '0';
  // Called with the discussion giscus resolved for this term, so a caller
  // can link to the existing thread instead of opening a duplicate.
  onDiscussion?: (url: string | null) => void;
  /** Fired once the frame has rendered something, so a caller can swap a
   *  freshly loaded copy in for a stale one without a blank in between. */
  onReady?: () => void;
  inputPosition?: 'top' | 'bottom';
  lang?: string;
  loading?: 'lazy' | 'eager';
  forcedTheme?: 'dark' | 'light';
  // Bump to rebuild the iframe. giscus has no imperative refresh, and it does
  // not notice a comment posted outside itself - so after we post one through
  // the API the panel would keep showing the old thread until a reload.
  reloadKey?: number;
  // Absolute URL of a giscus custom theme CSS - overrides forcedTheme.
  // Used to hide the top-level comment box where the structured form is
  // the only sanctioned entry point.
  themeUrl?: string;
}

export const Giscus = ({
  repo,
  repoId,
  category,
  categoryId,
  term,
  reactionsEnabled = '1',
  emitMetadata = '0',
  onDiscussion,
  onReady,
  reloadKey = 0,
  inputPosition = 'bottom',
  lang = 'en',
  loading = 'lazy',
  forcedTheme,
  themeUrl,
}: GiscusProps) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Held in a ref and kept OUT of the effect's deps. A caller writing
  // `onDiscussion={(url) => setX(url)}` hands over a new function every render,
  // and with it in the deps that rebuilt the iframe - which emitted the
  // discussion again, which set state again. The frame reloaded on a loop and
  // lost whatever was typed into it each time.
  const onDiscussionRef = useRef(onDiscussion);
  onDiscussionRef.current = onDiscussion;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // Same reasoning, and it also has to be read at effect time rather than
  // captured: whether metadata is wanted cannot change which effect runs.
  const wantsMetadata = onDiscussion ? '1' : emitMetadata;
  const theme = themeUrl ?? forcedTheme ?? 'dark';
  // This frame is cross-origin, so it cannot be told anything - it can only be
  // rebuilt. Linking or unlinking GitHub anywhere on the site (or in another
  // tab) bumps this, and every widget on the page comes back current instead
  // of one panel knowing and the rest still offering to sign you in.
  const linkVersion = useLinkVersion();

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const pageUrl = new URL(window.location.href);
    pageUrl.searchParams.delete('giscus');
    pageUrl.hash = '';
    const origin = pageUrl.toString();

    const params = new URLSearchParams({
      origin,
      session: session(),
      theme,
      reactionsEnabled,
      emitMetadata: wantsMetadata,
      inputPosition,
      repo,
      repoId,
      category,
      categoryId,
      strict: '0',
      description: '',
      backLink: origin,
      term: term ?? 'index',
    });
    frame.src = `${HOST}/${lang}/widget?${params}`;

    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== HOST || ev.source !== frame.contentWindow) return;
      const data = ev.data as {
        giscus?: {
          resizeHeight?: number; signOut?: boolean; error?: string;
          discussion?: { url?: string };
        };
      };
      if (typeof data !== 'object' || !data.giscus) return;
      if (data.giscus.resizeHeight) {
        // The first resize is giscus saying it has laid the thread out. There
        // is no load event that means that: the iframe fires one as soon as
        // the document arrives, before any comment is on screen.
        const first = !frame.style.height;
        frame.style.height = `${data.giscus.resizeHeight}px`;
        if (first) onReadyRef.current?.();
      }
      if (data.giscus.signOut) localStorage.removeItem(SESSION_KEY);
      if (data.giscus.discussion) onDiscussionRef.current?.(data.giscus.discussion.url ?? null);
      if (data.giscus.error && /Bad credentials|Invalid state value|State has expired/.test(data.giscus.error)) {
        localStorage.removeItem(SESSION_KEY);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [repo, repoId, category, categoryId, term, reactionsEnabled, wantsMetadata,
      inputPosition, lang, theme, reloadKey, linkVersion]);

  return (
    <iframe
      ref={frameRef}
      className={styles.frame}
      title="Comments"
      scrolling="no"
      allow="clipboard-write"
      loading={loading}
    />
  );
};

export default Giscus;
