import {useEffect, useState} from "react";
import {openPanel, type PanelId} from "../layout";
import wb from "../wb.module.scss";
import styles from "./ContributeBody.module.scss";

const REPO = "modsutd-community/modsutd";
const WAYS: Array<{
    title: string;
    body: string;
    links: Array<{href: string; label: string}>;
    // A card can point at a panel instead of a URL. The two issue-template
    // links that used to be here sent people to file an issue, which is the
    // one thing the Discuss panel exists to save them from.
    panel?: {id: PanelId; label: string};
}> = [
    {
        title: "features & bugs",
        body: "anything the site should do and does not, and anything that is wrong - including a single wrong prereq.",
        links: [],
        panel: {id: "discuss", label: "discuss →"},
    },
    {
        title: "code",
        body: "react + typescript + vite. clean diffs, working tests.",
        links: [
            {
                href: `https://github.com/${REPO}/blob/main/CONTRIBUTING.md`,
                label: "read the guide →",
            },
        ],
    },
    {
        title: "data",
        body: "wrong description, missing prereq, drifted schedule - PR /data/courses/<code>.json. small diffs ship fast.",
        links: [
            {
                href: `https://github.com/${REPO}/tree/main/data`,
                label: "browse data →",
            },
        ],
    },
    {
        title: "donate",
        body: "the domain, hosting and CI are covered by the GitHub Student Developer Pack, which ends when we graduate. donations go to running costs. Not implemented yet.",
        // No link yet, and the card says so rather than offering a dead one.
        links: [],
    },
];

interface Contributor {
    login: string;
    html_url: string;
    avatar_url: string;
    contributions: number;
}

// Ranked by commits, because that is the number GitHub actually publishes.
// It undercounts review, data corrections filed as issues, and the person who
// walked the campus with a clipboard - so the list says what it is measuring
// rather than calling itself a ranking of who did the most.
function Contributors() {
    const [people, setPeople] = useState<Contributor[] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let live = true;
        fetch(`https://api.github.com/repos/${REPO}/contributors?per_page=40`)
            .then((r) =>
                r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
            )
            .then((j: Contributor[]) => {
                if (live)
                    setPeople(j.filter((p) => !p.login.endsWith("[bot]")));
            })
            .catch(() => {
                if (live) setFailed(true);
            });
        return () => {
            live = false;
        };
    }, []);

    if (failed) {
        return (
            <p className={wb.faint} style={{fontSize: 11}}>
                github is not answering right now.{" "}
                <a
                    href={`https://github.com/${REPO}/graphs/contributors`}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    the list lives here →
                </a>
            </p>
        );
    }
    if (!people)
        return (
            <p className={wb.faint} style={{fontSize: 11}}>
                loading…
            </p>
        );

    return (
        <ol className={styles.people} data-act="contributors">
            {people.map((p, i) => (
                <li key={p.login}>
                    <span className={styles.rank}>{i + 1}</span>
                    <img
                        src={p.avatar_url}
                        alt=""
                        width={22}
                        height={22}
                        loading="lazy"
                    />
                    <a
                        href={p.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {p.login}
                    </a>
                    <span className={wb.faint}>{p.contributions}</span>
                </li>
            ))}
        </ol>
    );
}

export function ContributeBody() {
    return (
        <div className={`${wb.scroll} ${styles.wrap}`}>
            <div className={wb.eyebrow}>by students, for students</div>
            <p className={styles.lede}>Every bit goes a long way!</p>
            <p className={styles.lede}>
                modSUTD is a 100% student-run, open-source project. It would not
                be possible without the continuous support of our contributors
                and the SUTDent community. Join us to make SUTD better for us!
            </p>

            <div className={styles.ways}>
                {WAYS.map((w) => (
                    <article key={w.title} className={styles.way}>
                        <h3>{w.title}</h3>
                        <p>{w.body}</p>
                        {/* A card with no link renders no anchor: an empty
                            href resolves to the current page and reads as a
                            broken link. */}
                        {w.links.map((l) => (
                            <a
                                key={l.href}
                                href={l.href}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {l.label}
                            </a>
                        ))}
                        {w.panel && (
                            <button
                                type="button"
                                className={styles.panelLink}
                                onClick={() => openPanel(w.panel!.id)}
                                data-act={`open-${w.panel.id}`}
                            >
                                {w.panel.label}
                            </button>
                        )}
                    </article>
                ))}
            </div>

            <div className={wb.eyebrow} style={{marginTop: 18}}>
                MONEY · what it costs
            </div>
            <details className={styles.details} data-act="costs">
                <summary>see the breakdown</summary>

                <table className={styles.ledger}>
                    <thead>
                        <tr>
                            <th>what</th>
                            <th>cost</th>
                            <th>paid by</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>domain</td>
                            <td>covered</td>
                            <td>GitHub Student Developer Pack</td>
                        </tr>
                        <tr>
                            <td>
                                hosting<br></br>(Vercel)
                            </td>
                            <td>covered</td>
                            <td>GitHub Student Developer Pack</td>
                        </tr>
                        <tr>
                            <td>
                                CI<br></br>(Github)
                            </td>
                            <td>covered</td>
                            <td>GitHub Student Developer Pack</td>
                        </tr>
                        <tr>
                            <td>
                                AI<br></br>(auto-PR review, maintenance)
                            </td>
                            <td>variable</td>
                            <td>us, out of pocket</td>
                        </tr>
                    </tbody>
                </table>
            </details>

            <div className={wb.eyebrow} style={{marginTop: 18}}>
                CONTRIBUTORS · by commits
            </div>
            <Contributors />

            <p className={wb.faint} style={{fontSize: 10, marginTop: 18}}>
                modSUTD is an independent, student-run project. It is not
                affiliated with, endorsed by, or operated by the Singapore
                University of Technology and Design.
            </p>
        </div>
    );
}
