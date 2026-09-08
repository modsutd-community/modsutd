import {useEffect, useMemo, useState} from "react";
import {useAppSelector} from "@/store";
import {searchMods} from "@/utils/search";
import {ReviewForm} from "../ReviewForm";
import {pillarColor} from "../pillars";
import wb from "../wb.module.scss";
import styles from "./ShareBody.module.scss";

// The bookmarklet targets whichever origin served this page, so it works
// on localhost during dev and on the real domain in prod.
// Also sniffs the first mod code off the eval page so step 1 arrives
// pre-picked.
//
// The payload rides in the URL FRAGMENT, not the query string. A fragment is
// never sent to the server, so a whole eval - up to 4,000 characters of it -
// stays out of request logs and out of any proxy in between, and cannot be
// truncated or rejected by one. The query form is still read on arrival so
// older bookmarklets keep working.
const bookmarklet = (origin: string) =>
    `javascript:(()=>{const t=getSelection().toString()||document.body.innerText.slice(0,4000);const m=t.match(/\\b\\d{2}[.]\\d{3}[A-Za-z]?\\b/)||document.body.innerText.match(/\\b\\d{2}[.]\\d{3}[A-Za-z]?\\b/);const p=new URLSearchParams();p.set('text',t);if(m)p.set('mod',m[0]);open('${origin}/share#'+p.toString());})()`;

interface Props {
    prefillText?: string;
    prefillMod?: string;
}

export function ShareBody({prefillText, prefillMod}: Props) {
    const mods = useAppSelector((s) => s.mods.data);
    const [modSearch, setModSearch] = useState(prefillMod ?? "");
    const [picked, setPicked] = useState<string | null>(prefillMod ?? null);

    useEffect(() => {
        if (prefillMod && mods[prefillMod]) setPicked(prefillMod);
    }, [prefillMod, mods]);

    const matches = useMemo(() => {
        if (!modSearch || picked) return [];
        return searchMods(modSearch, Object.values(mods)).slice(0, 5);
    }, [mods, modSearch, picked]);

    const mod = picked ? mods[picked] : null;

    return (
        <div className={`${wb.scroll} ${styles.wrap}`}>
            <div className={wb.eyebrow}>1-CLICK BOOKMARKLET</div>
            <p className={styles.note}>
                Drag the button into your <b>bookmarks bar</b>.
                <br />
                At the end of the SUTD eval, click it - it auto-fills your
                review.
            </p>
            <a
                href={bookmarklet(window.location.origin)}
                className={styles.bookmarklet}
                onClick={(e) => e.preventDefault()}
            >
                ⚓ share on modSUTD
            </a>
            <hr className={wb.hr} />

            <div className={wb.eyebrow}>
                The bonus 2%. Why not pay it forward?
            </div>

            <div className={styles.step}>
                <span className={styles.n}>1</span>
                <div className={styles.stepBody}>
                    <strong>Pick the mod</strong>
                    {prefillText && !picked && (
                        <p className={styles.loadedNote} role="status">
                            ✓ your eval text is loaded into step 2 - pick the
                            mod to attach it
                        </p>
                    )}
                    <input
                        className={wb.input}
                        value={modSearch}
                        placeholder="search by code or name…"
                        onChange={(e) => {
                            setModSearch(e.target.value);
                            setPicked(null);
                        }}
                    />
                    {matches.length > 0 && (
                        <div className={styles.matches}>
                            {matches.map((m) => (
                                <button
                                    key={m.key ?? m.code}
                                    type="button"
                                    className={styles.match}
                                    onClick={() => {
                                        setPicked(m.key ?? m.code);
                                        setModSearch(m.code + " - " + m.name);
                                    }}
                                >
                                    <span style={{fontWeight: 700}}>
                                        {m.code}
                                    </span>
                                    <span className={styles.matchName}>
                                        {m.name}
                                    </span>
                                    <span
                                        style={{
                                            color: pillarColor(m.pillar),
                                            fontSize: 10,
                                        }}
                                    >
                                        {m.pillar}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <div className={styles.step}>
                <span className={styles.n}>2</span>
                <div className={styles.stepBody}>
                    <strong>Fill in & send it</strong>
                    {mod ? (
                        <ReviewForm mod={mod} prefillText={prefillText} />
                    ) : (
                        <span className={wb.faint} style={{fontSize: 11}}>
                            pick a mod first ↑
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
