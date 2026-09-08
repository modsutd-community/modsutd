// Each surface gets its OWN category - giscus's "only search in this
// category" scoping is per-embed, so reviews and discussion never collide.
// Reviews threads are created per mod (mod-XX.YYY) on first review.
// The Polls category is NOT giscus-compatible (giscus can't create or
// render GitHub's native poll discussions); for curated voting, pre-create
// a thread and point an embed at it - creation is all a closed category blocks.
export const GISCUS_CONFIG = {
    repo: "modsutd-community/modsutd" as const,
    repoId: "R_kgDOTe0tpA",
    categories: {
        reviews: {name: "Module Reviews", id: "DIC_kwDOTe0tpM4DBo3C"},
        // Features and bugs are separate boards, not two halves of one thread:
        // "the site should do X" and "X is broken" get read by different people on
        // different days, and mixing them buries both.
        features: {name: "Features", id: "DIC_kwDOTe0tpM4DBop8"},
        bugs: {name: "Bugs", id: "DIC_kwDOTe0tpM4DE9Ao"},
    },
};

// Kept as a function so the panels' fallback copy stays honest if this
// file is ever reset to placeholders.
export const giscusWired = () => !GISCUS_CONFIG.repoId.startsWith("YOUR_");

// giscus themes are plain CSS custom properties, so the workbench's palette
// drops straight in. Without this the frame keeps Primer's near-white on
// Primer's navy and reads as a window from another site sitting in the middle
// of this one.
const PALETTE = [
    ":root {",
    "  --color-canvas-default: #14161a;",
    "  --color-canvas-subtle: #0d0e11;",
    "  --color-canvas-inset: #0d0e11;",
    "  --color-fg-default: #e9eaed;",
    "  --color-fg-muted: rgba(233, 234, 237, 0.62);",
    "  --color-fg-subtle: rgba(233, 234, 237, 0.45);",
    "  --color-border-default: rgba(255, 255, 255, 0.12);",
    "  --color-border-muted: rgba(255, 255, 255, 0.08);",
    "  --color-accent-fg: #ffb000;",
    "  --color-accent-emphasis: #ffb000;",
    "  --color-btn-primary-bg: #ffb000;",
    "  --color-btn-primary-text: #0d0e11;",
    "}",
];

// The mod-page wall is read-and-reply only: structured reviews are the only
// way to open a thread. giscus applies whatever CSS the theme URL serves,
// and a data: URI keeps it self-contained - an origin-hosted file is
// unreachable from the https iframe over http://localhost, which silently
// dropped the theme and left that panel unstyled. The direct-child selector
// spares reply boxes, which live under .gsc-replies.
const REVIEWS_CSS = [
    "@import url('https://giscus.app/themes/dark.css');",
    ...PALETTE,
    ".gsc-comments > .gsc-comment-box { display: none !important; }",
].join("\n");

export const REVIEWS_THEME = `data:text/css;base64,${btoa(REVIEWS_CSS)}`;

const DISCUSS_CSS = [
    "@import url('https://giscus.app/themes/dark.css');",
    ...PALETTE,
    // Plain text, no link: `content:` cannot hold an anchor, and a sentence
    // whose useful half would have been a link is better as the rule alone.
    ".gsc-comment-box-write::before {",
    '  content: "Paste the template, then fill it in.";',
    "  display: block;",
    "  margin-bottom: 8px;",
    "  font-size: 12px;",
    "  color: var(--color-fg-muted);",
    "}",
].join("\n");

export const DISCUSS_THEME = `data:text/css;base64,${btoa(DISCUSS_CSS)}`;
