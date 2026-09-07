import styles from "./consent.module.scss";

export function ConsentOverlay({onAgree}: {onAgree: () => void}) {
    return (
        // No dialog role - the checkbox is the actionable, keyboard-focusable element.
        <div
            className={styles.overlay}
            data-act="consent-gate"
            aria-label="consent required to use the timetable"
        >
            <div className={styles.inner}>
                <p className={styles.eyebrow}>⟡ before you generate</p>
                <h3>We need your help.</h3>
                <p className={styles.body}>
                    Using this tool means your{" "}
                    <strong>parsed mod + venue + day + time slots</strong> are
                    contributed to Room Finder's availability heatmap -
                    automatically and anonymously.
                </p>
                <label className={styles.checkbox}>
                    <input
                        type="checkbox"
                        onChange={(e) => {
                            if (e.target.checked) onAgree();
                        }}
                    />
                    <span>I understand and agree.</span>
                </label>
            </div>
        </div>
    );
}
