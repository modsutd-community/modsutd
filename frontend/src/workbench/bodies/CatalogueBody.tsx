import { useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store';
import { selectMod } from '@/reducers/timetableReducer';
import type { Term } from '@/types';
import { PILLAR_COLORS, PILLAR_ORDER, pillarColor, modPillars } from '../pillars';
import { useWorkbenchUi, SortKey } from '../uiContext';
import { useFilteredMods } from '../logic';
import { beginModDrag, chipLabel } from '../modDrag';
import { useTelegramData, isActive } from '../telegram';
import { Otto } from '../Otto';
import wb from '../wb.module.scss';
import styles from './CatalogueBody.module.scss';

// The same glyph the mod panel's button uses. Inlined rather than shared,
// because it is drawn at 11px here against 15px there and the two want
// different stroke weights; the path is Telegram's own mark.
function TeleMark() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" aria-label="has a batch chat" role="img">
      <path
        fill="currentColor"
        d="M21.9 4.3 18.9 19c-.2 1-.8 1.2-1.6.8l-4.5-3.3-2.2 2.1c-.2.2-.4.4-.9.4l.3-4.6 8.3-7.5c.4-.3-.1-.5-.6-.2L7.4 13.1 2.9 11.7c-1-.3-1-1 .2-1.5l17.5-6.8c.8-.3 1.5.2 1.3 1z"
      />
    </svg>
  );
}

const TERMS: Term[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

const HEADS: Array<{ key: SortKey; label: string; align: 'left' | 'center' | 'right' }> = [
  { key: 'code', label: 'CODE', align: 'left' },
  { key: 'name', label: 'MODULE', align: 'left' },
  { key: 'pillar', label: 'PILR', align: 'left' },
  { key: 'term', label: 'T', align: 'center' },
  { key: 'credits', label: 'CR', align: 'right' },
];

interface Props {
  onPick: (code: string) => void;
  // Right-click: pin the mod in its own extra inspector window (desktop).
  onPin?: (code: string) => void;
  // Whether the main inspector is open - the selected row shows its
  // highlight only while its inspector is actually showing.
  selectedOpen?: boolean;
  // Desktop only: called when a row drag engages, so the shell can surface
  // the plan as a drop target. Rows stay drag-inert when absent (mobile -
  // ADD TO PLAN in the inspector covers it there).
  onPlanDragStart?: () => void;
}

export function CatalogueBody({ onPick, onPin, selectedOpen = true, onPlanDragStart }: Props) {
  const dispatch = useAppDispatch();
  const { pillar, setPillar, term, setTerm, sortKey, sortDir, sortBy, selected, setDragGhost, freshmoreMode, showRetired, setShowRetired } = useWorkbenchUi();
  const loading = useAppSelector((s) => s.mods.loading);
  const error = useAppSelector((s) => s.mods.error);
  const rows = useFilteredMods();
  // Module-cached and already fetched by the mod panel, so this is a read
  // rather than a request. Null until it lands, which draws no mark: a row
  // that gains one a moment later is better than one that promises a chat
  // and takes it away.
  const [tg] = useTelegramData();
  const hasChat = (code: string) => {
    const entry = tg?.registry[code];
    return !!entry && isActive(entry);
  };
  const suppressClick = useRef(false);

  return (
    <>
      <div className={`${wb.chipRow} ${wb.nobar} ${styles.pillarRow}`}>
        {(['ALL', ...PILLAR_ORDER] as const).map((p) => {
          const on = pillar === p;
          const color = p === 'ALL' ? '#ffb000' : PILLAR_COLORS[p];
          return (
            <button
              key={p}
              type="button"
              className={`${wb.chip} ${on ? wb.chipOn : ''}`}
              style={on && p !== 'ALL' ? { borderColor: color, background: `${color}22`, color: '#fff' } : undefined}
              onClick={() => setPillar(p)}
            >
              {p === 'ALL' ? 'ALL' : p.toUpperCase()}
            </button>
          );
        })}
        {/* Flushed right on the pillar row: a retired mod is still in the data
            for the plans and reviews that name it, and out of the way until
            somebody on an older cohort goes looking for one. */}
        <label className={styles.retiredToggle}>
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(e) => setShowRetired(e.target.checked)}
            data-act="show-retired"
          />
          retired
        </label>
      </div>
      <div className={`${wb.chipRow} ${wb.nobar}`}>
        <button
          type="button"
          className={`${wb.chip} ${term === 'ALL' ? wb.chipOn : ''}`}
          onClick={() => setTerm('ALL')}
        >
          ALL
        </button>
        {TERMS.map((t) => (
          <button
            key={t}
            type="button"
            className={`${wb.chip} ${term === t ? wb.chipOn : ''}`}
            onClick={() => setTerm(t)}
          >
            T{t}
          </button>
        ))}
      </div>

      <div className={styles.headRow}>
        {HEADS.map((h) => {
          const on = sortKey === h.key;
          return (
            <button
              key={h.key}
              type="button"
              className={styles.head}
              style={{ textAlign: h.align, color: on ? '#ffb000' : undefined }}
              onClick={() => sortBy(h.key)}
            >
              {h.label}
              {on ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}
            </button>
          );
        })}
      </div>

      <div className={wb.scroll} style={{ flex: 1 }}>
        {rows.map((m) => {
          const k = m.key ?? m.code;
          return (
          <button
            key={k}
            type="button"
            className={styles.row}
            style={{
              borderLeftColor: pillarColor(m.pillar),
              background: selected === k && selectedOpen ? 'rgba(255,176,0,0.1)' : undefined,
            }}
            onClick={() => { if (!suppressClick.current) onPick(k); }}
            onContextMenu={onPin ? (e) => { e.preventDefault(); onPin(k); } : undefined}
            onPointerDown={onPlanDragStart ? (e) => {
              if (e.pointerType === 'mouse' && e.button !== 0) return;
              beginModDrag(e, {
                key: k,
                label: chipLabel(m),
                setGhost: setDragGhost,
                // Touch long-presses into a drag so the list still scrolls.
                holdMs: 450,
                onEngage: () => { suppressClick.current = true; onPlanDragStart(); },
                onDrop: (level) => {
                  if (level !== null) dispatch(selectMod({ mode: freshmoreMode, code: k, level }));
                  setTimeout(() => { suppressClick.current = false; }, 0);
                },
              });
            } : undefined}
            data-tip={onPin ? 'open · pin (r-click) · drag to plan' : undefined}
          >
            <span className={styles.code} style={{ color: selected === k && selectedOpen ? '#fff' : undefined }}>{m.code}</span>
            <span className={styles.name}>{m.name}</span>
            {/* A chat that EXISTS, not one that could. Eligibility is a
                property of the record and marks every HASS course in the
                catalogue whether or not it runs this term; the registry is
                the only thing that knows a group was actually made, and
                "there is a chat to join" is what a reader scanning this is
                asking. Costs no extra request: useTelegramData is
                module-cached and the mod panel already pays for it. */}
            <span
              className={styles.tele}
              data-act={hasChat(m.code) ? 'tele-eligible' : undefined}
              aria-hidden={!hasChat(m.code)}
            >
              {hasChat(m.code) ? <TeleMark /> : null}
            </span>
            <span className={styles.pillar} style={{ color: pillarColor(m.pillar) }}>
              {m.pillar}
              {modPillars(m).length > 1 ? <span className={styles.pillarMore}>+{modPillars(m).length - 1}</span> : null}
            </span>
            <span className={styles.term}>T{m.term}</span>
            <span className={styles.cr}>{m.credits}</span>
          </button>
          );
        })}
        {rows.length === 0 && (
          <div className={wb.empty}>
            <span className={wb.ottoDim}><Otto size={64} /></span>
            <span>
              {loading ? 'dredging the catalogue…' :
                error ? `catalogue failed to load: ${error}` :
                <>Otto found nothing for that.<br />Try a different code, pillar or term.</>}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
