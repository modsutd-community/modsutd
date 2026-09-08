import { Link } from 'react-router-dom';
import type { PrereqNamed, PrereqTree } from '@/types';
import { COHORTS } from '@/workbench/uiContext';
import styles from './PrerequisiteTree.module.scss';

interface Props {
  modCode: string;
  tree?: PrereqTree;
  fallback?: string[];
  knownMods?: Record<string, { code: string; name: string }>;
  // When provided, leaves invoke this instead of rendering a router <Link> -
  // hosts that manage selection as state (the Workbench inspector) need the
  // callback; the URL alone doesn't update their view.
  onPick?: (code: string) => void;
}

// SUTD's prereq strings are usually flat ("10.013 AND 10.014") but the
// recursive shape lets us render any combination of AND/OR/N-of cleanly.
//
// Shapes:
//   string                 leaf - a mod code (supports "10.014:B" min-grade)
//   { and: PrereqTree[] }  all of
//   { or: PrereqTree[] }   one of
//   { nOf: [n, choices] }  n of m
//
// Renderer is depth-aware so colours alternate on each level - gives the
// branching some visual rhythm without being noisy.

function isAnd(t: PrereqTree): t is { and: PrereqTree[] } { return typeof t === 'object' && 'and' in t; }
function isOr(t: PrereqTree):  t is { or:  PrereqTree[] } { return typeof t === 'object' && 'or'  in t; }
function isNof(t: PrereqTree): t is { nOf: [number, PrereqTree[]] } { return typeof t === 'object' && 'nOf' in t; }

function parseLeaf(leaf: string): { code: string; minGrade?: string; wildcard: boolean } {
  if (leaf.endsWith('%')) return { code: leaf, wildcard: true };
  const [code, grade] = leaf.split(':');
  return { code, minGrade: grade, wildcard: false };
}

function asTree(fallback: string[]): PrereqTree | undefined {
  if (!fallback.length) return undefined;
  if (fallback.length === 1) return fallback[0];
  return { and: fallback };
}

const isNamed = (t: PrereqTree): t is PrereqNamed =>
  typeof t === 'object' && t !== null && 'name' in t;

/** How the cohort dropdown spells each one, so the two never disagree. */
const cohortLabel = (c: string): string =>
  COHORTS.find((x) => x.value === c)?.label ?? c;

function Node({ tree, depth, knownMods, onPick }: { tree: PrereqTree; depth: number; knownMods: Props['knownMods']; onPick?: Props['onPick'] }) {
  // A requirement SUTD has named but not numbered, or one that only applies to
  // some matriculation years. Handled BEFORE the string case and before the
  // and/or cases, because the fall-through at the bottom of this function is
  // `return null` - an unhandled leaf shape draws an empty bullet rather than
  // failing, and 50.057's three alternatives vanished exactly that way.
  if (isNamed(tree)) {
    const label = tree.code ? `${tree.code} ${tree.name}` : tree.name;
    const inner = (
      <span className={`${styles.leaf} ${styles[`d${depth % 4}`]}`}>
        {/* An uncoded requirement is a NAME, so it takes the name's voice.
            Set in the code style it read as a very long course number. */}
        {tree.code && <span className={styles.leafCode}>{tree.code}</span>}
        <span className={styles.leafName}>{tree.name}</span>
        {tree.cohort?.length && (
          <span className={styles.leafGrade}>{tree.cohort.map(cohortLabel).join(', ')}</span>
        )}
      </span>
    );
    // Uncoded means there is no mod page to open, so it is text, not a link.
    if (!tree.code) return <span aria-label={label}>{inner}</span>;
    if (onPick) {
      return (
        <button type="button" className={styles.leafLink} onClick={() => onPick(tree.code!)}>
          {inner}
        </button>
      );
    }
    return <Link className={styles.leafLink} to={`/mods/${tree.code}`}>{inner}</Link>;
  }

  if (typeof tree === 'string') {
    const { code, minGrade, wildcard } = parseLeaf(tree);
    const known = !wildcard && knownMods && knownMods[code];
    const inner = (
      <span className={`${styles.leaf} ${styles[`d${depth % 4}`]}`}>
        <span className={styles.leafCode}>{wildcard ? code : code}</span>
        {known && <span className={styles.leafName}>{known.name}</span>}
        {minGrade && <span className={styles.leafGrade}>min {minGrade}</span>}
      </span>
    );
    if (wildcard) return inner;
    if (onPick) {
      return (
        <button type="button" className={styles.leafLink} onClick={() => onPick(code)}>
          {inner}
        </button>
      );
    }
    return (
      <Link className={styles.leafLink} to={`/mods/${code}`}>{inner}</Link>
    );
  }

  if (isAnd(tree)) {
    return (
      <div className={`${styles.branch} ${styles.and}`}>
        <span className={styles.label}>all of</span>
        <ul className={styles.list}>
          {tree.and.map((c, i) => (
            <li key={i}><Node tree={c} depth={depth + 1} knownMods={knownMods} onPick={onPick} /></li>
          ))}
        </ul>
      </div>
    );
  }

  if (isOr(tree)) {
    return (
      <div className={`${styles.branch} ${styles.or}`}>
        <span className={styles.label}>one of</span>
        <ul className={styles.list}>
          {tree.or.map((c, i) => (
            <li key={i}><Node tree={c} depth={depth + 1} knownMods={knownMods} onPick={onPick} /></li>
          ))}
        </ul>
      </div>
    );
  }

  if (isNof(tree)) {
    const [n, choices] = tree.nOf;
    return (
      <div className={`${styles.branch} ${styles.nof}`}>
        <span className={styles.label}>at least {n} of</span>
        <ul className={styles.list}>
          {choices.map((c, i) => (
            <li key={i}><Node tree={c} depth={depth + 1} knownMods={knownMods} onPick={onPick} /></li>
          ))}
        </ul>
      </div>
    );
  }

  return null;
}

export function PrerequisiteTree({ modCode, tree, fallback = [], knownMods, onPick }: Props) {
  const t = tree ?? asTree(fallback);
  if (!t) {
    return <div className={styles.empty}>None</div>;
  }
  return (
    <div className={styles.wrap}>
      <div className={styles.self}>{modCode}<span className={styles.selfTag}>this mod</span></div>
      <div className={styles.line} aria-hidden />
      <div className={styles.requires}>requires</div>
      <Node tree={t} depth={0} knownMods={knownMods} onPick={onPick} />
    </div>
  );
}

export default PrerequisiteTree;
