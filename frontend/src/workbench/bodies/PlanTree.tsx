import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store';
import { deselectMod, selectMod, setPlanLevel } from '@/reducers/timetableReducer';
import {
  setNotes, initComponents, setComponent, addComponent, removeComponent, importRecords,
} from '@/reducers/recordsReducer';
import { importPlans } from '@/reducers/timetableReducer';
import { buildPlanFile, readPlanFile, importableRecords } from '../planFile';
import type { Curriculum, Mod, RecordsState } from '@/types';
import { pillarColor } from '../pillars';
import { unmet, requirementsOf, treeOf } from '@/utils/prereq';
import { defaultLevel, useSpecializations, useMinors, earliestAchieved, useFreshmore, freshmoreFixedSet, freshmoreCoreFor } from '../logic';
import { beginModDrag, chipLabel } from '../modDrag';
import { useGithubLink, startDeviceFlow, pollForToken, pushBackup, DeviceStart } from '../sync';
import { useAutoState, useAutoSaveSetting, setAutoSave } from '../autoBackup';
import { ExtLink } from '../ExtLink';
import { exportContributed } from '../contributed';
import { useWorkbenchUi, COHORTS } from '../uiContext';
import { useAnchoredCard, anchoredStyle } from '../anchored';
import type { FreshmoreMode } from '../uiContext';
import wb from '../wb.module.scss';
import styles from './PlanTree.module.scss';

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// A degree is eight terms. Only ASD runs to ten, so everyone else was reading
// two empty rows on every plan.
const ASD_LEVELS = 10;
const DEFAULT_LEVELS = 8;

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
  // A menu that only closes by pressing its own button is a menu that follows
  // you around the panel. pointerdown rather than click, so it closes on the
  // press that starts an interaction somewhere else rather than after it.
  const exportWrapRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!exportOpen) return;
    const away = (e: PointerEvent) => {
      if (!exportWrapRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setExportOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [exportOpen]);
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const autoOn = useAutoSaveSetting();
  // Deliberately not memoised on the three parts: the hook compares the
  // serialised bundle, so a new object per render costs nothing.
  // Everything this browser knows, so a second device does not need the paste
  // again. The stamps are what make the merge safe - see sectionSync.
  const events = useAppSelector((st) => st.timetable.events);
  // Read, not run. The autosave itself is mounted in WorkbenchInner: this
  // panel renders only when the Timetable window is open AND switched to the
  // tree view, so a student who linked from the banner and never came here had
  // no autosave at all - their laptop never wrote the gist, and their phone
  // pulled an account that had none.
  const auto = useAutoState();

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
      // Through the tree, so an "or" is satisfied by either branch. The flat
      // list cannot express that and read 40.321 as needing both 40.002 and
      // 60.008 when the listing says either.
      // The cohort is not optional here. Without it every branch of an "or"
      // survives pruning, and a branch naming an uncoded course cannot block -
      // so 50.057 read as reachable with neither 10.014 nor 10.025 anywhere in
      // the plan, for every cohort at once.
      const missing = unmet(
        treeOf(mod.prereqTree, mod.prerequisites),
        (p) => {
          const pl = levelOf.get(p);
          return pl !== undefined && pl < level;
        },
        freshmoreMode,
        mod.pillar,
      );
      byLevel.get(level)!.push({ mod, missing, isFixed });
    };
    for (const [key] of fixed) put(key, true);
    for (const key of plan) if (!fixed.has(key)) put(key, false);
    for (const list of byLevel.values()) list.sort((a, b) => chipLabel(a.mod).localeCompare(chipLabel(b.mod)));
    return byLevel;
  }, [plan, levelOf, mods, fixed, freshmoreMode]);

  // One hook for every choice slot: only one card is open at a time, and the
  // id of that card is what tells it to re-measure when the reader moves from
  // one slot to another.
  const { anchor: setHintAnchor, pos: hintPos } = useAnchoredCard(cardKey);
  const hintAnchor = (el: HTMLSpanElement | null) => {
    if (el?.dataset.slotKey === cardKey) setHintAnchor(el);
  };

  // Terms 9 and 10 belong to ASD. They still appear for anyone who has put
  // something there - hiding a row would hide the mod in it.
  const lastLevel = useMemo(() => {
    if (currentPillar === 'ASD') return ASD_LEVELS;
    const deepest = Math.max(
      DEFAULT_LEVELS,
      ...[...placed.entries()].filter(([, row]) => row.length > 0).map(([l]) => l),
    );
    return Math.min(ASD_LEVELS, deepest);
  }, [currentPillar, placed]);

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
      // pillar; minors bar the offering pillar's own students (notForPillar).
      .filter((t) => {
        if (!currentPillar) return true;
        if (t.pillar === 'Minor') return !(t.notForPillar ?? []).includes(currentPillar);
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
      // A touch has to rest on the chip before it becomes a drag. Without it a
      // chip engaged on the same tiny movement a mouse does, so a finger
      // scrolling the plan dragged whatever it started on, and the column of
      // chips could not be scrolled at all - only the term labels down the
      // left were safe to touch.
      //
      // Longer than the catalogue's 450ms on purpose. Dragging OUT of a list is
      // a deliberate act with nowhere else for the gesture to go; dragging a
      // chip happens inside the thing a reader is trying to scroll.
      holdMs: 1000,
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

  // This button sits on one matriculation year's tab, so that is what it
  // writes. It used to hand over the whole browser - every curriculum, the
  // parsed timetable, the contributed slots - which is not what "export" on
  // this tab means, and made the file useless for moving one plan anywhere.
  const exportRecords = () => {
    // [...fixed.keys()] is the freshmore core pinned into terms 1 to 3. Its
    // chips carry records like any other and it is never in selectedMods.
    const file = buildPlanFile(
      freshmoreMode, plans[freshmoreMode], declared, records, [...fixed.keys()],
    );
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `modsutd-plan-${freshmoreMode}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Three cohorts, not a yes/no: the freshmore core changed twice, and some
  // prerequisites differ between all three. Each keeps its own plan, so
  // switching to look never disturbs the other two - which is also why this
  // renders on an EMPTY plan. Switching to a cohort you have not planned yet
  // used to take the control away with the tree, leaving no way back.
  const cohortPicker = (
    <label className={styles.ayToggle}>
      <span className={wb.faint}>matric</span>
      <select
        value={freshmoreMode}
        onChange={(e) => setFreshmoreMode(e.target.value as FreshmoreMode)}
        aria-label="matriculation year - picks the freshmore core and prerequisites"
        data-act="cohort"
      >
        {COHORTS.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>
    </label>
  );

  const empty = plan.filter((c) => !fixed.has(c)).length === 0 && fixed.size === 0;
  if (empty) {
    return (
      <div>
        <div className={styles.header}>
          <div className={styles.headerRow}>{cohortPicker}</div>
        </div>
        <div className={wb.empty} style={{ padding: '32px 20px' }}>
          your plan is empty - open a mod in the catalogue and hit "+ ADD TO PLAN",
          or drag a row straight in. each term is a level; prerequisites check themselves.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.tree}>
      <div className={styles.header}>
        <div className={styles.headerRow}>
        <div className={styles.recordTools}>
          <span className={styles.exportWrap} ref={exportWrapRef}>
            <button type="button" data-act="export-menu" className={wb.btnQuiet} aria-expanded={exportOpen} onClick={() => setExportOpen((v) => !v)}>
              ⇣ export ▾
            </button>
            {exportOpen && (
              <span className={styles.exportMenu}>
                <button type="button" data-act="export-json" onClick={() => { exportRecords(); setExportOpen(false); }}>
                  download .json
                </button>
                {/* Only when autosave is OFF. With it on, the gist is written a
                    few seconds after any change, so this button is a second way
                    to do what already happened - and one that reads as though
                    nothing had been saved until it was pressed. Turning autosave
                    off is what leaves a reader with no way to write the gist at
                    all, which is the case this is here for. */}
                {linked && !autoOn ? (
                  <button
                    type="button"
                    onClick={async () => {
                      setExportOpen(false);
                      try {
                        setSyncStatus('saving…');
                        await pushBackup({
                          records, plans, declared,
                          timetable: events,
                          contributed: exportContributed(),
                        });
                        setSyncStatus('✓ saved to your private gist');
                      } catch (e) {
                        setSyncStatus(`✗ ${(e as Error).message}`);
                      }
                    }}
                  >
                    save to github now
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
                {linked && (
                  <label className={styles.autoToggle}>
                    <input
                      type="checkbox"
                      checked={autoOn}
                      onChange={(e) => setAutoSave(e.target.checked)}
                    />
                    keep it saved automatically
                  </label>
                )}
              </span>
            )}
          </span>
          <button type="button" className={wb.btnQuiet} onClick={() => importRef.current?.click()}>⇡ import</button>
          <input
            ref={importRef}
            type="file"
            data-act="import-json"
            accept="application/json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const parsed = JSON.parse(await f.text()) as unknown;
                const read = readPlanFile(parsed, freshmoreMode);
                if (read) {
                  // THE FILE DECIDES THE TAB. A plan file records the
                  // matriculation year it was exported from, so an AY2025 file
                  // is an AY2025 plan wherever you happen to be standing, and
                  // it goes back to the AY2025 tab. Nothing is asked and no
                  // other year is touched.
                  //
                  // Two earlier shapes were both worse. Writing it into the
                  // tab you are on replaced a plan that had nothing to do with
                  // the file. Asking first made the reader answer a question
                  // whose right answer is always the same one.
                  //
                  // A whole-browser backup names no single cohort, so
                  // readPlanFile hands back the tab you are on and this lands
                  // exactly where it used to.
                  const into = read.curriculum;
                  dispatch(importPlans({ ...plans, [into]: read.plan }));
                  // The plan comes from the file; the freshmore core does not.
                  // It is read out of data/freshmore.json for the cohort, so a
                  // file cannot add to it, reorder it or swap a course out of
                  // it - the only thing an import may do to a core mod is
                  // replace its record. Records for anything else were being
                  // merged into the store wholesale, so a hand-edited file
                  // could leave notes on a course nobody is taking.
                  dispatch(importRecords({
                    ...records,
                    ...importableRecords(
                      read.records,
                      read.plan?.selectedMods ?? [],
                      [...freshmoreFixedSet(freshmoreCoreFor(into)).keys()],
                    ),
                  }));
                  // Unconditional. `if (read.declared.length)` meant a file
                  // that honestly declares no tracks could not clear the ones
                  // this browser has, so importing a plan left the old badges
                  // claiming tracks the imported plan never declared.
                  replaceDeclared(read.declared);
                  // Follow it, or the import is invisible: the panel would go
                  // on showing the year you were already on while the plan
                  // landed in another.
                  if (into !== freshmoreMode) setFreshmoreMode(into);
                } else {
                  // Older still: a bare RecordsState, no plans at all.
                  dispatch(importRecords(parsed as RecordsState));
                }
              } catch {
                // unreadable file - ignore
              }
              e.target.value = '';
            }}
          />
        </div>
        {cohortPicker}
        </div>
        {badge.length > 0 && (
          <div className={styles.badges}>
            {badge.map(({ track, status, earliest }) => {
              const isDeclared = declared.includes(track.id);
              const base = earliest !== null
                ? `${track.pillar} · achieved by T${earliest}`
                : `${track.pillar} · plan doesn't reach it`;
              const tip = isDeclared ? base : `declared? ${base}`;
              // Tracks carry `url`, minors carry `source`: two scrapes, two
              // spellings, and no reason to make a reader care which.
              const src = track.url ?? track.source;
              return (
                <span key={track.id} className={styles.badgeWrap}>
                <label
                  className={[
                    styles.badge,
                    status === 'achieved' ? styles.badgeOn : '',
                    isDeclared ? styles.badgeDeclared : '',
                    status === 'no' ? styles.badgeGap : '',
                  ].join(' ')}
                  data-tip={tip}
                  // Left-anchored: these sit at the panel's left edge and the
                  // tip is a sentence, so centring it clipped the opening words.
                  data-tip-side="start"
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
                {/* Outside the label on purpose: a link nested in one toggles
                    the checkbox on the way through. */}
                {src ? <ExtLink href={src} what={track.name} /> : null}
                </span>
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
      {!syncStatus && linked && autoOn && (auto.busy || auto.at || auto.error) && (
        <p className={wb.faint} style={{ fontSize: 10.5, margin: '2px 0' }} data-act="autosave-status">
          {auto.error ? `✗ autosave: ${auto.error}` : auto.busy ? 'saving…' : '✓ saved to your private gist'}
        </p>
      )}

      {issueCount > 0 && (
        <div className={styles.issues} data-act="plan-issues" data-count={issueCount}>
          {issueCount} mod{issueCount !== 1 ? 's have' : ' has'} unmet prereqs
        </div>
      )}

      {LEVELS.filter((l) => l <= lastLevel).map((level) => {
        const row = placed.get(level)!;
        const credits = row.reduce((s, p) => s + p.mod.credits, 0);
        const future = level > currentTerm;
        const term = freshmore[String(level)];
        // A term may carry more than one pick: AY2025 and earlier put HASS in
        // term 3 next to the freshmore electives.
        const picks = term?.choices ?? (term?.choice ? [term.choice] : []);
        // Options fill a slot only when placed AT this level.
        const slots = picks.map((c, ci) => {
          const remaining = (c.count ?? 1) - c.anyOf.filter((k) => levelOf.get(k) === level).length;
          // "2 freshmore electives" counts down to "1 freshmore elective".
          const noun = c.label.replace(/^\d+\s*/, '');
          return {
            choice: c,
            key: `hint:${level}:${ci}`,
            remaining,
            noun: remaining === 1 && (c.count ?? 1) > 1 && noun.endsWith('s') ? noun.slice(0, -1) : noun,
          };
        }).filter((s2) => s2.remaining > 0);
        const anyOpen = slots.some((s2) => s2.key === cardKey);
        // The dimmed future rows are opacity stacking contexts - later
        // siblings would paint OVER an open hover card, swallowing its
        // clicks, unless the card's row is raised above them.
        const hostsCard = cardKey !== null
          && (anyOpen || row.some((r) => keyOf(r.mod) === cardKey));
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
              {row.length === 0 && slots.length === 0 && <span className={styles.levelEmpty}>-</span>}
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
                      cohort={freshmoreMode}
                      onHold={holdOpen}
                      onRelease={armClose}
                      onFocusChange={(f) => { cardHasFocus.current = f; if (!f) armClose(); }}
                      onClose={() => setCardKey(null)}
                      beginPrereqDrag={(p, e) => dragChip(p, chipLabel(mods[p] ?? { code: p, name: p }), e, true)}
                      addPrereq={(p) => {
                        if (suppressClick.current) return;
                        // Never at or after the mod that needs it: a prereq in
                        // the same term is not a prereq met, so placing it at
                        // its catalogue term would answer the pick with a chip
                        // that is still red.
                        const wanted = defaultLevel(mods[p]);
                        const at = levelOf.get(keyOf(mod)) ?? level;
                        const placeAt = Math.max(1, Math.min(wanted, at - 1));
                        dispatch(selectMod({ mode: freshmoreMode, code: p, level: placeAt }));
                      }}
                    />
                  )}
                </span>
              ))}
              {slots.map(({ choice, key: hintKey, remaining: slotRemaining, noun: slotNoun }) => (
                <Fragment key={hintKey}>
                <span
                  ref={hintAnchor}
                  data-slot-key={hintKey}
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
                      style={anchoredStyle(hintPos)}
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
                </Fragment>
              ))}
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
  mod, missing, levelOf, cohort, onHold, onRelease, onFocusChange, onClose, beginPrereqDrag, addPrereq,
}: {
  mod: Mod;
  missing: string[];
  levelOf: Map<string, number>;
  cohort: Curriculum;
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

  // Fixed, so the panel cannot clip it and it adds nothing to the scroll area.
  // The anchor is the chip this card belongs to, one level up in the DOM.
  const { anchor, pos } = useAnchoredCard(true);
  // The card's own parent is the chip it belongs to, which is what it hangs off.
  const setAnchor = (el: HTMLSpanElement | null) => anchor(el?.parentElement ?? null);

  // Grouped by the tree, not the flat list: the flat one cannot say "either",
  // so 50.057 asked for 10.014 AND 10.025 and stayed red once one was placed.
  // The SAME predicate the verdict uses: strictly earlier, not merely present.
  // "Is it in the plan" would let the chip say met while the red border, which
  // asks "is it earlier", still says missing.
  const here = levelOf.get(keyOf(mod)) ?? 1;
  const reqs = requirementsOf(
    treeOf(mod.prereqTree, mod.prerequisites),
    (p) => { const at = levelOf.get(p); return at !== undefined && at < here; },
    cohort,
    mod.pillar,
  );

  const comps = record?.components ?? [];
  const entered = comps.filter((c) => typeof c.score === 'number');
  const weighted = entered.reduce((s, c) => s + (c.score! * c.weight) / 100, 0);
  const wtTotal = comps.reduce((s, c) => s + c.weight, 0);

  return (
    <span
      ref={setAnchor}
      data-card
      className={styles.card}
      style={anchoredStyle(pos)}
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
      {reqs.length > 0 && (
        <span className={styles.cardPrereqs} data-act="prereq-list">
          <span className={styles.popTitle}>needs</span>
          {reqs.map((r, i) => {
            if (r.kind === 'need') {
              const label = r.code ?? r.name!;
              if (r.met) {
                const at = r.code ? levelOf.get(r.code) : undefined;
                return (
                  <span key={i} className={`${styles.popChip} ${styles.popPlanned}`}>
                    {label} ✓{at !== undefined && <> <span className={styles.popTerm}>T{at}</span></>}
                  </span>
                );
              }
              return (
                <span
                  key={i}
                  data-act="add-prereq"
                  data-code={r.code}
                  className={`${styles.popChip} ${styles.popMissing}`}
                  onPointerDown={(e) => r.code && beginPrereqDrag(r.code, e)}
                  onClick={() => r.code && addPrereq(r.code)}
                >
                  {label} +
                </span>
              );
            }
            // An "or" the student has already answered says so, and says with
            // which - listing the alternatives again would read as more work.
            if (r.met) {
              const at = r.metBy ? levelOf.get(r.metBy) : undefined;
              return (
                <span key={i} className={`${styles.popChip} ${styles.popPlanned}`}>
                  {r.metBy} ✓{at !== undefined && <> <span className={styles.popTerm}>T{at}</span></>}
                </span>
              );
            }
            // Unanswered: one dotted slot holding the choices, not several
            // demands the student can only ever half-satisfy.
            return (
              <span key={i} className={styles.pickSlot} data-act="prereq-pick">
                <span className={styles.pickLabel}>pick from</span>
                {r.options.map((o) => (
                  <span
                    key={o.code ?? o.name}
                    data-act={o.code ? 'add-prereq' : undefined}
                    data-code={o.code}
                    className={`${styles.popChip} ${o.code ? styles.popOption : styles.popStated}`}
                    onPointerDown={(e) => o.code && beginPrereqDrag(o.code, e)}
                    onClick={() => o.code && addPrereq(o.code)}
                  >
                    {o.code ?? o.name}{o.code ? ' +' : ''}
                  </span>
                ))}
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}
