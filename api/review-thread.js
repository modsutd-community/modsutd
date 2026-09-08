// Ensures a mod's review thread exists, and hands back its URL.
//
// Why this exists: giscus renders a discussion's COMMENTS, so a review has to
// be a comment - but GitHub's own composer can only create a discussion with a
// body. A student without a linked account was therefore asked to start a
// thread and then post again inside it, and predictably typed their review into
// the first box. This creates the empty thread for them so they land straight
// on the comment box.
//
// The alternative was pre-creating a thread for all 386 mods, which would bury
// the Ideas category under empty threads. Threads are made where someone
// actually wants to review.
//
// The only caller content that reaches GitHub is the mod's name, and only
// inside the header this writes. Anyone can POST here, so that string ends up
// in a public body that lives forever - hence the two guards on it below.
const REPO = "modsutd-community/modsutd";
const REPO_ID = "R_kgDOTe0tpA";
const REVIEWS_CATEGORY_ID = "DIC_kwDOTe0tpM4DBo3C";
// Letters allowed: SUTD splits a course into 03.007A/03.007B rather than
// issuing a second number. Kept in step with CANONICAL_MOD in
// frontend/src/utils/contributeTimetable.ts - the relays cannot import
// from the app, so this is a copy on purpose.
const MOD_RE = /^\d{2}\.\d{3}[A-Za-z]?$/;
// ':' and '/' have to stay - 67 mod names use them - so the guard is on what
// GitHub would turn into a link. The body this lands in is public and permanent.
const NAME_RE = /^[\w ,.:'()\-/&]{1,80}$/;
const LINKY_RE = /\/\/|www\./i;

// Same shape as /api/contribute: generous, per minute, because a cohort shares
// one campus IP. Creating a thread is cheap and idempotent, so this only has to
// stop a loop.
const PER_IP_PER_MINUTE = 30;
const hits = new Map();

function overQuota(ip) {
    const minute = new Date().toISOString().slice(0, 16);
    const key = `${ip}:${minute}`;
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    if (hits.size > 5000) {
        for (const k of hits.keys()) if (!k.endsWith(minute)) hits.delete(k);
    }
    return n > PER_IP_PER_MINUTE;
}

function foreignOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
        const host = new URL(origin).hostname;
        return !(
            host === "modsutd.tech" ||
            host.endsWith(".vercel.app") ||
            host === "localhost"
        );
    } catch {
        return true;
    }
}

async function gql(token, query, variables) {
    const r = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({query, variables}),
    });
    const json = await r.json().catch(() => ({}));
    // A rejected token answers with {message} and no errors array, so checking
    // errors alone let `undefined.search` surface as the user-facing message.
    if (!r.ok) throw new Error(json.message || `GitHub returned ${r.status}`);
    if (json.errors?.length) throw new Error(json.errors[0].message);
    if (!json.data) throw new Error("GitHub returned no data");
    return json.data;
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.status(405).json({error: "POST only"});
        return;
    }
    if (foreignOrigin(req)) {
        res.status(403).json({error: "this endpoint only serves modsutd"});
        return;
    }
    const ip =
        String(req.headers["x-forwarded-for"] ?? "")
            .split(",")[0]
            .trim() || "unknown";
    if (overQuota(ip)) {
        res.status(429).json({
            error: "too many requests from this network right now - try again shortly",
        });
        return;
    }
    const token = process.env.MODSUTD_BOT_TOKEN;
    if (!token) {
        res.status(503).json({
            error: "review threads are not configured on the server",
        });
        return;
    }

    const mod = String((req.body && req.body.mod) || "");
    const name = String((req.body && req.body.name) || "");
    if (!MOD_RE.test(mod)) {
        res.status(400).json({error: "mod must look like 10.013"});
        return;
    }
    // Only ever used inside the header we write, and only if it looks sane.
    const safeName = NAME_RE.test(name) && !LINKY_RE.test(name) ? name : "";

    const title = `mod-${mod}`;

    try {
        // The title is the giscus term, so an existing thread must be reused or the
        // mod page would end up with two and render neither reliably.
        const found = await gql(
            token,
            `query($q: String!) {
        search(type: DISCUSSION, query: $q, first: 10) {
          nodes { ... on Discussion { title url } }
        }
      }`,
            {q: `repo:${REPO} in:title ${title}`},
        );
        const hit = (found.search.nodes || []).find((n) => n.title === title);
        if (hit?.url) {
            res.status(200).json({url: hit.url, created: false});
            return;
        }

        const made = await gql(
            token,
            `mutation($repo: ID!, $cat: ID!, $title: String!, $body: String!) {
        createDiscussion(input: { repositoryId: $repo, categoryId: $cat, title: $title, body: $body }) {
          discussion { url }
        }
      }`,
            {
                repo: REPO_ID,
                cat: REVIEWS_CATEGORY_ID,
                title,
                // The one place a note can reach someone who has just left modSUTD for
                // this tab: nothing on our side can draw on github.com, but a
                // discussion's body renders here and giscus never shows it, so this
                // costs the mod page nothing. Phrased for every reader, since people
                // arrive from search too.
                body:
                    `**${mod}${safeName ? ` ${safeName}` : ""}** - Students' Reviews` +
                    "\n\n> Came from modSUTD? Your review is copied already -" +
                    ' just paste it into the comment box below and "Comment".',
            },
        );
        res.status(201).json({
            url: made.createDiscussion.discussion.url,
            created: true,
        });
    } catch (e) {
        res.status(502).json({error: `could not open the review thread: ${explain(e.message)}`});
    }
}

// GitHub reports "no access" as "this id does not exist", which reads like a
// wrong repository id in the code and sends you to check a constant that is
// fine. The browser token carries `public_repo`, which excludes private repos,
// so every review fails this way until the repository is public - and giscus
// cannot render the discussion on a private repo either.
function explain(message) {
    if (/Could not resolve to a node with the global id/i.test(message)) {
        return "the repository is still private. reviews need it public - "
            + "the browser token's public_repo scope cannot reach a private repo, "
            + "and giscus cannot render the thread on one.";
    }
    return message;
}
