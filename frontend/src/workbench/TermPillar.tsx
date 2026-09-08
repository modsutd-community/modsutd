import { useWorkbenchUi } from './uiContext';
import wb from './wb.module.scss';
import styles from './TermPillar.module.scss';

const LEVELS = Array.from({ length: 10 }, (_, i) => i + 1);
const PILLARS = ['EPD', 'ESD', 'CSD', 'ASD', 'DAI'] as const;

// Which term you are in and which pillar you are from. Both already live in the
// workbench context, so this renders the same two values wherever it appears -
// the plan, the timetable and the paste screen all read and write one answer.
export function TermPillar() {
  const { currentTerm, setCurrentTerm, currentPillar, setCurrentPillar } = useWorkbenchUi();

  return (
    <>
      <label className={styles.field}>
        <span className={wb.faint}>current term</span>
        <select
          className={wb.input}
          value={currentTerm}
          onChange={(e) => setCurrentTerm(Number(e.target.value))}
          aria-label="your current term"
        >
          {LEVELS.map((l) => <option key={l} value={l}>T{l}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        <span className={wb.faint}>pillar</span>
        <select
          className={wb.input}
          value={currentPillar ?? ''}
          onChange={(e) => setCurrentPillar((e.target.value || null) as typeof PILLARS[number] | null)}
          aria-label="your pillar"
        >
          <option value="">?</option>
          {PILLARS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
    </>
  );
}
