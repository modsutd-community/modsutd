import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store';
import { deselectMod, selectMod, setPlanLevel } from '@/reducers/timetableReducer';
import {
  setNotes, initComponents, setComponent, addComponent, removeComponent, importRecords,
} from '@/reducers/recordsReducer';
import { importPlans } from '@/reducers/timetableReducer';
import { isBundle } from '../backup';
import type { Mod, RecordsState } from '@/types';
import { pillarColor } from '../pillars';
import { defaultLevel, useSpecializations, useMinors, earliestAchieved, useFreshmore, freshmoreFixedSet } from '../logic';
import { beginModDrag, chipLabel } from '../modDrag';
import { useGithubLink, startDeviceFlow, pollForToken, pushBackup, DeviceStart } from '../sync';
import { useWorkbenchUi } from '../uiContext';
import wb from '../wb.module.scss';
import styles from './PlanTree.module.scss';

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

interface Props {
  onPick: (code: string) => void;
}

const keyOf = (m: Mod) => m.key ?? m.code;

// Terms 1–3 pin the fixed Freshmore core automatically; the AY2026? toggle
// switches to a fully SEPARATE plan - the two curricula never bleed into
// each other.
export function PlanTree({ onPick }: Props) {
  const dispatch = useAppDispatch();
  const mods = useAppSelector((s) => s.mods.data);
  const { currentTerm, currentPillar, freshmoreMode, setFreshmoreMode, dragGhost, setDragGhost, declared, toggleDeclared, replaceDeclared } = useWorkbenchUi();
  const plan = useAppSelector((s) => s.timetable.plans[freshmoreMode].selectedMods);
  const planLevels = useAppSelector((s) => s.timetable.plans[freshmoreMode].planLevels);
  const records = useAppSelector((s) => s.records);
  const plans = useAppSelector((s) => s.timetable.plans);
  const tracks = useSpecializations();
  const minors = useMinors();
  const freshmore = useFreshmore(freshmoreMode);
  const importRef = useRef<HTMLInputElement>(null);
  const linked = useGithubLink();
  const [exportOpen, setExportOpen] = useState(false);
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  const suppressClick = useRef(false);

  // Hover-intent card: closes on a grace timer so the pointer can travel
  // into it, and never auto-closes while the form inside has focus.
  // cardKey is a mod key, or 'hint:<level>' for a choice slot's card.
  const [cardKey, setCardKey] = useState<string | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardHasFocus = useRef(false);

  const armOpen = (key: string, delay: number) => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (cardKey === key) return;
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setCardKey(key), delay);
  };
  const cancelOpen = () => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
  };
  const armClose = () => {
    cancelOpen();
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!cardHasFocus.current) setCardKey(null);
    }, 320);
  };
  const holdOpen = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };

  const fixed = useMemo(() => freshmoreFixedSet(freshmore), [freshmore]);

  const levelOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const [key, term] of fixed) m.set(key, term);
    for (const key of plan) {
      if (!m.has(key)) m.set(key, planLevels[key] ?? defaultLevel(mods[key]));
    }
    return m;
  }, [plan, planLevels, mods, fixed]);

  const placed = useMemo(() => {
    const byLevel = new Map<number, Array<{ mod: Mod; missing: string[]; isFixed: boolean }>>(
      LEVELS.map((l) => [l, []]),
    );
    const put = (key: string, isFixed: boolean) => {
      const mod = mods[key];
      if (!mod) return;
      const level = Math.min(10, Math.max(1, levelOf.get(key)!));
      const missing = (mod.prerequisites ?? []).filter((p) => {
        const pl = levelOf.get(p);
        return pl === undefined || pl >= level;
      });
      byLevel.get(level)!.push({ mod, missing, isFixed });
    };
    for (const [key] of fixed) put(key, true);
    for (const key of plan) if (!fixed.has(key)) put(key, false);
    for (const list of byLevel.values()) list.sort((a, b) => chipLabel(a.mod).localeCompare(chipLabel(b.mod)));
    return byLevel;
  }, [plan, levelOf, mods, fixed]);

  const issueCount = useMemo(
    () => [...placed.values()].flat().filter((p) => p.missing.length > 0).length,
    [placed],
  );

  // Cumulative plan per level: what's completed by the end of T1, T2, …
  const cumulative = useMemo(() => {
    const sets: Array<Set<string>> = [];
    let acc = new Set<string>();
    for (let l = 1; l <= 10; l++) {
      acc = new Set(acc);
      for (const [key, lv] of levelOf) if (lv === l) acc.add(key);
      sets.push(acc);
    }
    return sets;
  }, [levelOf]);

  const badge = useMemo(() =>
    [...tracks, ...minors]
      // Home pillar gates eligibility: specialisations belong to your own
      // pillar; minors bar the offering pillar's own students (notFor).
      .filter((t) => {
        if (!currentPillar) return true;
        if (t.pillar === 'Minor') return !(t.notFor ?? []).includes(currentPillar);
        return t.pillar === currentPillar;
      })
      .map((t) => {
        const earliest = earliestAchieved(t, cumulative);
        const status = earliest === null ? 'no' : earliest <= currentTerm ? 'achieved' : 'planned';
        return { track: t, earliest, status };
      })
      .filter((b) => b.status !== 'no' || declared.includes(b.track.id)),
  [tracks, minors, cumulative, currentTerm, currentPillar, declared]);

  // addOnDrop: prereq / choice-suggestion chips ADD the mod on drop;
  // regular plan chips just MOVE.
  const dragChip = (key: string, label: string, e: React.PointerEvent, addOnDrop = false) => {
    // ✕ buttons never start drags; and a chip must not start dragging when
    // the pointer lands inside its hover card (unless the card explicitly
    // routes a chip drag through addOnDrop).
    if ((e.target as HTMLElement).closest('[data-nodrag]')) return;
    if (!addOnDrop && (e.target as HTMLElement).closest('[data-card]')) return;
    beginModDrag(e, {
      key,
      label,
      setGhost: setDragGhost,
      onEngage: () => {
        suppressClick.current = true;
        setCardKey(null);
      },
      onDrop: (level) => {
        if (level !== null) {
          if (addOnDrop) dispatch(selectMod({ mode: freshmoreMode, code: key, level }));
          else dispatch(setPlanLevel({ mode: freshmoreMode, code: key, level }));
        }
        setTimeout(() => { suppressClick.current = false; }, 0);
      },
    });
  };

  const exportRecords = () => {
    const bundle = { records, plans, declared };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'modsutd-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const empty = plan.filter((c) => !fixed.has(c)).length === 0 && fixed.size === 0;
  if (empty) {
    return (
      <div className={wb.empty} style={{ padding: '32px 20px' }}>
        your plan is empty - open a mod in the catalogue and hit "+ ADD TO PLAN",
        or drag a row straight in. each term is a level; prerequisites check themselves.
      </div>
    );
  }

  return (
    <div className={styles.tree}>
      <div className={styles.header}>
        <div className={styles.headerRow}>
        <div className={styles.recordTools}>
          <span className={styles.exportWrap}>
            <button type="button" className={wb.btnQuiet} aria-expanded={exportOpen} onClick={() => setExportOpen((v) => !v)}>
              ⇣ export ▾
            </button>
            {exportOpen && (
              <span className={styles.exportMenu}>
                <button type="button" onClick={() => { exportRecords(); setExportOpen(false); }}>
                  download .json
                </button>
                {linked ? (
                  <button
                    type="button"
                    onClick={async () => {
                      setExportOpen(false);
                      try {
                        setSyncStatus('saving…');
                        await pushBackup({ records, plans, declared });
                        setSyncStatus('✓ saved to your private gist');
                      } catch (e) {
                        setSyncStatus(`✗ ${(e as Error).message}`);
                      }
                    }}
                  >
                    save to github
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      setExportOpen(false);
                      try {
                        const d = await startDeviceFlow();
                        setDevice(d);
                        pollForToken(d)
                          .then(() => { setDevice(null); setSyncStatus('✓ linked - export again to save'); })
                          .catch((e) => { setDevice(null); setSyncStatus(`✗ ${(e as Error).message}`); });
                      } catch (e) {
                        setSyncStatus(`✗ ${(e as Error).message}`);
                      }
                    }}
                  >
                    link github first…
                  </button>
                )}
              </span>
            )}
          </span>
          <button type="button" className={wb.btnQuiet} onClick={() => importRef.current?.click()}>⇡ import</button>
          <input
            ref={importRef}
            type="file"
            accept="application/json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const parsed = JSON.parse(await f.text()) as unknown;
                if (isBundle(parsed)) {
                  dispatch(importRecords(parsed.records));
                  dispatch(importPlans(parsed.plans));
                  replaceDeclared(parsed.declared ?? []);
                } else {
                  dispatch(importRecords(parsed as RecordsState));
                }
              } catch {
                // unreadable file - ignore
              }
              e.target.value = '';
            }}
          />
        </div>
        <label className={styles.ayToggle}>
          <input
            type="checkbox"
            checked={freshmoreMode === 'ay2026'}
            onChange={(e) => setFreshmoreMode(e.target.checked ? 'ay2026' : 'classic')}
            aria-label="use the AY2026 freshmore curriculum"
          />
          AY2026?
        </label>
        </div>
        {badge.length > 0 && (
          <div className={styles.badges}>
            {badge.map(({ track, status, earliest }) => {
              const isDeclared = declared.includes(track.id);
              const base = earliest !== null
                ? `${track.pillar} · achieved by T${earliest}`
                : `${track.pillar} · plan doesn't reach it`;
              const tip = isDeclared ? base : `declared? ${base}`;
              return (
                <label
                  key={track.id}
                  className={[
                    styles.badge,
                    status === 'achieved' ? styles.badgeOn : '',
                    isDeclared ? styles.badgeDeclared : '',
                    status === 'no' ? styles.badgeGap : '',
                  ].join(' ')}
                  data-tip={tip}
                >
                  <input
                    type="checkbox"
                    checked={isDeclared}
                    onChange={() => toggleDeclared(track.id)}
                    aria-label={`declared: ${track.name}`}
                  />
                  {status === 'achieved' ? '◆' : status === 'planned' ? '◇' : '◌'}{' '}
                  ({track.pillar === 'Minor' ? 'M' : 'S'}) {track.name}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {device && (
        <p className={wb.faint} style={{ fontSize: 10.5, margin: '2px 0' }}>
          enter <strong>{device.user_code}</strong> at{' '}
          <a href={device.verification_uri} target="_blank" rel="noopener noreferrer">{device.verification_uri}</a>
          {' '}- waiting…
        </p>
      )}
      {syncStatus && <p className={wb.faint} style={{ fontSize: 10.5, margin: '2px 0' }}>{syncStatus}</p>}

      {issueCount > 0 && (
        <div className={styles.issues} data-act="plan-issues" data-count={issueCount}>
          {issueCount} mod{issueCount !== 1 ? 's have' : ' has'} unmet prereqs
        </div>
      )}

      {LEVELS.map((level) => {
        const row = placed.get(level)!;
        const credits = row.reduce((s, p) => s + p.mod.credits, 0);
        const future = level > currentTerm;
        const choice = freshmore[String(level)]?.choice;
        // Options fill the slot only when placed AT this level.
        const slotRemaining = choice
          ? (choice.count ?? 1) - choice.anyOf.filter((k) => levelOf.get(k) === level).length
          : 0;
        const slotFilled = slotRemaining <= 0;
        // "2 freshmore electives" counts down to "1 freshmore elective".
        const slotNoun = choice
          ? (() => {
              const noun = choice.label.replace(/^\d+\s*/, '');
              return slotRemaining === 1 && (choice.count ?? 1) > 1 && noun.endsWith('s')
                ? noun.slice(0, -1)
                : noun;
            })()
          : '';
        const hintKey = `hint:${level}`;
        // The dimmed future rows are opacity stacking contexts - later
        // siblings would paint OVER an open hover card, swallowing its
        // clicks, unless the card's row is raised above them.
        const hostsCard = cardKey !== null
          && (cardKey === hintKey || row.some((r) => keyOf(r.mod) === cardKey));
        return (
          <div
            key={level}
            data-level={level}
            className={[
              styles.levelRow,
              future ? styles.levelFuture : '',
              dragGhost?.level === level ? styles.levelDrop : '',
              hostsCard ? styles.levelRaised : '',
            ].join(' ')}
          >
            <div className={styles.levelLabel}>
              <span className={styles.levelNum}>T{level}</span>
              {credits > 0 && <span className={styles.levelCredits}>{credits}cr</span>}
            </div>
            <div className={styles.levelMods}>
              {row.length === 0 && slotFilled && <span className={styles.levelEmpty}>-</span>}
              {row.map(({ mod, missing, isFixed }) => (
                <span
                  key={keyOf(mod)}
                  className={[
                    styles.chip,
                    missing.length ? styles.chipBad : '',
                    isFixed ? styles.chipFixed : '',
                    dragGhost?.key === keyOf(mod) ? styles.chipDragging : '',
                  ].join(' ')}
                  style={{ borderLeftColor: missing.length ? undefined : pillarColor(mod.pillar) }}
                  onPointerDown={isFixed ? undefined : (e) => dragChip(keyOf(mod), chipLabel(mod), e)}
                  onPointerEnter={(e) => { if (e.pointerType === 'mouse') armOpen(keyOf(mod), 300); }}
                  onPointerLeave={(e) => { if (e.pointerType === 'mouse') armClose(); }}
                  onTouchStart={() => armOpen(keyOf(mod), 420)}
                >
                  <button
                    type="button"
                    className={styles.chipCode}
                    onClick={() => { if (!suppressClick.current) onPick(keyOf(mod)); }}
                  >
                    {chipLabel(mod)}
                  </button>
                  {!isFixed && (
                    <button
                      type="button"
                      data-nodrag
                      className={styles.chipRemove}
                      aria-label={`remove ${chipLabel(mod)} from plan`}
                      onClick={() => dispatch(deselectMod({ mode: freshmoreMode, code: keyOf(mod) }))}
                    >
                      ✕
                    </button>
                  )}

                  {cardKey === keyOf(mod) && (
                    <ChipCard
                      mod={mod}
                      missing={missing}
                      levelOf={levelOf}
                      onHold={holdOpen}
                      onRelease={armClose}
                      onFocusChange={(f) => { cardHasFocus.current = f; if (!f) armClose(); }}
                      onClose={() => setCardKey(null)}
                      beginPrereqDrag={(p, e) => dragChip(p, chipLabel(mods[p] ?? { code: p, name: p }), e, true)}
                      addPrereq={(p) => {
                        if (suppressClick.current) return;
                        dispatch(selectMod({ mode: freshmoreMode, code: p, level: defaultLevel(mods[p]) }));
                      }}
                    />
                  )}
                </span>
              ))}
              {choice && !slotFilled && (
                <span
                  data-act="choice-slot"
                  className={styles.choiceHint}
                  onPointerEnter={(e) => { if (e.pointerType === 'mouse') armOpen(hintKey, 300); }}
                  onPointerLeave={(e) => { if (e.pointerType === 'mouse') armClose(); }}
                  onTouchStart={() => armOpen(hintKey, 420)}
                >
                  + {slotRemaining} {slotNoun}
                  {cardKey === hintKey && (
                    <span
                      data-card
                      className={styles.card}
                      onPointerEnter={holdOpen}
                      onPointerLeave={(e) => { if (e.pointerType === 'mouse') armClose(); }}
                    >
                      <span className={styles.cardHead}>
                        <span className={styles.cardTitle}>pick from</span>
                        <button type="button" className={styles.cardClose} data-nodrag onClick={() => setCardKey(null)} aria-label="close options">✕</button>
                      </span>
                      <span className={styles.cardPrereqs} style={{ borderTop: 'none', paddingTop: 0 }}>
                        {choice.anyOf.filter((k) => !levelOf.has(k) && mods[k]).map((k) => (
                          <span
                            key={k}
                            className={`${styles.popChip} ${styles.popOption}`}
                            onPointerDown={(e) => dragChip(k, chipLabel(mods[k]), e, true)}
                            onClick={() => {
                              if (suppressClick.current) return;
                              dispatch(selectMod({ mode: freshmoreMode, code: k, level }));
                            }}
                          >
                            {mods[k].code === '99.999' ? mods[k].name : `${mods[k].code} ${mods[k].name}`} +
                          </span>
                        ))}
                      </span>
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const fmtPts = (n: number) => String(Math.round(n * 10) / 10);

// Score entry is in POINTS out of the component's max; a "14/35" fraction
// converts in place once the user pauses. The store keeps a PERCENT so
// re-weighting a component keeps the score.
function ScoreInput({ value, max, ariaLabel, onCommit }: {
  value: number | null; // percent, 0–100
  max: number;
  ariaLabel: string;
  onCommit: (v: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? '' : fmtPts((value * max) / 100));
  const [bad, setBad] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const parse = (raw: string): { pct: number | null; asFraction: boolean } | 'bad' => {
    const t = raw.trim();
    if (t === '') return { pct: null, asFraction: false };
    const frac = t.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (frac) {
      const den = Number(frac[2]);
      const ratio = den > 0 ? Number(frac[1]) / den : Number.NaN;
      if (!Number.isFinite(ratio) || ratio > 1) return 'bad';
      return { pct: ratio * 100, asFraction: true };
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > max || max <= 0) return 'bad';
    return { pct: (n / max) * 100, asFraction: false };
  };

  const settle = (raw: string) => {
    const p = parse(raw);
    if (p === 'bad') {
      setBad(true);
      return;
    }
    setBad(false);
    onCommit(p.pct);
    if (p.asFraction) setText(p.pct === null ? '' : fmtPts((p.pct * max) / 100));
  };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <input
      className={`${wb.input} ${styles.compNum} ${bad ? wb.inputBad : ''}`}
      type="text"
      inputMode="decimal"
      value={text}
      placeholder="-"
      aria-label={ariaLabel}
      aria-invalid={bad}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => settle(raw), 600);
      }}
      onBlur={() => {
        if (timer.current) clearTimeout(timer.current);
        settle(text);
      }}
    />
  );
}

// While the mod still has unmet prerequisites the card shows ONLY those -
// the record form unlocks once they're settled.
function ChipCard({
  mod, missing, levelOf, onHold, onRelease, onFocusChange, onClose, beginPrereqDrag, addPrereq,
}: {
  mod: Mod;
  missing: string[];
  levelOf: Map<string, number>;
  onHold: () => void;
  onRelease: () => void;
  onFocusChange: (focused: boolean) => void;
  onClose: () => void;
  beginPrereqDrag: (code: string, e: React.PointerEvent) => void;
  addPrereq: (code: string) => void;
}) {
  const dispatch = useAppDispatch();
  const rkey = mod.key ?? mod.code;
  const record = useAppSelector((s) => s.records[rkey]);
  const unlocked = missing.length === 0;

  useEffect(() => {
    if (unlocked && !record?.components?.length) {
      const defaults = (mod.grading?.components ?? []).map((c) => ({ name: c.name, weight: c.percentage }));
      dispatch(initComponents({ code: rkey, defaults }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rkey, unlocked]);

  const comps = record?.components ?? [];
  const entered = comps.filter((c) => typeof c.score === 'number');
  const weighted = entered.reduce((s, c) => s + (c.score! * c.weight) / 100, 0);
  const wtTotal = comps.reduce((s, c) => s + c.weight, 0);

  return (
    <span
      data-card
      className={styles.card}
      onPointerEnter={onHold}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') onRelease(); }}
      onFocus={() => onFocusChange(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) onFocusChange(false); }}
    >
      <span className={styles.cardHead}>
        <span className={styles.cardTitle}>{mod.name}</span>
        <button type="button" className={styles.cardClose} onClick={onClose} aria-label={`close ${chipLabel(mod)} card`}>✕</button>
      </span>

      {unlocked && comps.map((c, i) => (
        <span key={i} className={styles.compRow}>
          <input
            className={`${wb.input} ${styles.compName}`}
            value={c.name}
            placeholder="component"
            aria-label={`component ${i + 1} name for ${chipLabel(mod)}`}
            onChange={(e) => dispatch(setComponent({ code: rkey, index: i, patch: { name: e.target.value } }))}
          />
          <input
            className={`${wb.input} ${styles.compNum}`}
            type="number" min={0} max={100}
            value={c.weight === 0 ? '' : c.weight}
            placeholder="max"
            aria-label={`component ${i + 1} max for ${chipLabel(mod)}`}
            onChange={(e) =>
              dispatch(setComponent({ code: rkey, index: i, patch: { weight: Math.min(100, Math.max(0, Number(e.target.value) || 0)) } }))}
          />
          <ScoreInput
            value={c.score ?? null}
            max={c.weight}
            ariaLabel={`${c.name || `component ${i + 1}`} score for ${chipLabel(mod)}`}
            onCommit={(v) => dispatch(setComponent({ code: rkey, index: i, patch: { score: v } }))}
          />
          <button
            type="button"
            className={styles.compDel}
            aria-label={`remove component ${c.name || i + 1}`}
            onClick={() => dispatch(removeComponent({ code: rkey, index: i }))}
          >
            ✕
          </button>
        </span>
      ))}
      {unlocked && (
        <span className={styles.compFoot}>
          <button type="button" className={styles.compAdd} onClick={() => dispatch(addComponent({ code: rkey }))}>
            + component
          </button>
          <span className={`${styles.footCell} ${wtTotal === 100 ? '' : styles.wtOff}`}>{wtTotal}%</span>
          <span className={`${styles.footCell} ${styles.computed}`}>
            {entered.length > 0 ? `${fmtPts(weighted)}%` : '-'}
          </span>
          <span aria-hidden />
        </span>
      )}

      {unlocked && (
        <textarea
          className={styles.cardNotes}
          rows={2}
          placeholder="notes…"
          value={record?.notes ?? ''}
          aria-label={`notes for ${chipLabel(mod)}`}
          onChange={(e) => dispatch(setNotes({ code: rkey, notes: e.target.value }))}
        />
      )}
      {(mod.prerequisites?.length ?? 0) > 0 && (
        <span className={styles.cardPrereqs} data-act="prereq-list">
          <span className={styles.popTitle}>needs</span>
          {mod.prerequisites!.map((p) => {
            const planned = levelOf.has(p);
            return planned ? (
              <span key={p} className={`${styles.popChip} ${styles.popPlanned}`}>
                {p} ✓ <span className={styles.popTerm}>T{levelOf.get(p)}</span>
              </span>
            ) : (
              <span
                key={p}
                data-act="add-prereq"
                data-code={p}
                className={`${styles.popChip} ${styles.popMissing}`}
                onPointerDown={(e) => beginPrereqDrag(p, e)}
                onClick={() => addPrereq(p)}
              >
                {p} +
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}
