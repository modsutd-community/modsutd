import type { Curriculum, PrereqNamed, PrereqTree } from '@/types';

// Which prerequisites are still unmet, given where everything sits in the plan.
//
// The flat `prerequisites` array cannot say "or": SUTD's listing writes
// "40.002 Optimisation or 60.008 Systems Design Studio" and the gatherer keeps
// only the codes, so 40.321 read as needing both. `prereqTree` is the shape
// that can, and this is the one place that decides whether a tree is satisfied.
//
// A leaf can also be an object. Two things the plain string cannot express:
//
//   - a requirement SUTD has named but not numbered. 50.057 wants "Algorithmic
//     Thinking and Object-Based Abstraction (For AY2026 onwards)", and keeping
//     only codes dropped it, so the mod looked easier to reach than it is.
//   - a requirement that applies to some matriculation years and not others.
//     The same 50.057 branch is 10.014 for AY2024 and earlier, 10.025 for
//     AY2025, and the unnumbered course for AY2026.
//
// `met` answers "is this code placed at a strictly earlier level" - a prereq in
// the same term is not a prereq met.

const isNamed = (t: PrereqTree): t is PrereqNamed =>
  typeof t === 'object' && t !== null && 'name' in t;

/** True when this leaf is one the student's own cohort has to take. */
function appliesTo(
  leaf: PrereqNamed,
  cohort: Curriculum | undefined,
  pillar?: string,
): boolean {
  // The exemption, and its own year scope. Without notForCohort this read
  // "no DAI student ever needs 50.001", which is one year too broad: the
  // exemption is DAI AND AY2024-or-earlier, and a DAI student on AY2025 does
  // need it. An absent notForCohort keeps the old meaning, every cohort.
  if (pillar && leaf.notFor?.includes(pillar)) {
    const years = leaf.notForCohort;
    if (!years?.length || (cohort !== undefined && years.includes(cohort))) return false;
  }
  if (!leaf.cohort?.length || cohort === undefined) return true;
  return leaf.cohort.includes(cohort);
}

/**
 * Drop the branches another cohort's students take.
 *
 * Done before evaluating rather than inside it, so an `or` whose only
 * applicable branch is unmet reports that branch instead of picking the
 * shortest across all three cohorts - which would tell an AY2024 student to
 * take a course that does not exist for them.
 */
function prune(tree: PrereqTree, cohort: Curriculum | undefined, pillar?: string): PrereqTree | undefined {
  if (typeof tree === 'string') return tree;
  if (isNamed(tree)) return appliesTo(tree, cohort, pillar) ? tree : undefined;
  if ('and' in tree) {
    const kept = tree.and.map((t) => prune(t, cohort, pillar)).filter((t): t is PrereqTree => !!t);
    return kept.length ? { and: kept } : undefined;
  }
  if ('or' in tree) {
    const kept = tree.or.map((t) => prune(t, cohort, pillar)).filter((t): t is PrereqTree => !!t);
    return kept.length ? { or: kept } : undefined;
  }
  const [n, choices] = tree.nOf;
  const kept = choices.map((t) => prune(t, cohort, pillar)).filter((t): t is PrereqTree => !!t);
  return kept.length ? { nOf: [Math.min(n, kept.length), kept] } : undefined;
}

/**
 * Unmet leaves, or an empty array when the tree is satisfied.
 *
 * A named leaf with no code cannot block: there is nothing to place in a plan,
 * so treating it as forever unmet would leave the mod permanently locked. It is
 * still a real requirement, which is why `requirements()` reports it for
 * display.
 */
export function unmet(
  tree: PrereqTree | undefined,
  met: (code: string) => boolean,
  cohort?: Curriculum,
  pillar?: string,
): string[] {
  if (tree === undefined) return [];
  const t = prune(tree, cohort, pillar);
  if (t === undefined) return [];
  return walk(t, met);
}

function walk(tree: PrereqTree, met: (code: string) => boolean): string[] {
  if (typeof tree === 'string') return met(tree) ? [] : [tree];
  if (isNamed(tree)) {
    if (!tree.code) return []; // nothing to place, so nothing to block on
    return met(tree.code) ? [] : [tree.code];
  }

  if ('and' in tree) return tree.and.flatMap((t) => walk(t, met));

  if ('or' in tree) {
    // Satisfied by any one branch. When none is, the shortest unmet branch is
    // the honest thing to show: it is the least work left, not all the work.
    const branches = tree.or.map((t) => walk(t, met));
    if (branches.some((b) => b.length === 0)) return [];
    return branches.reduce((a, b) => (b.length < a.length ? b : a), branches[0] ?? []);
  }

  const [n, choices] = tree.nOf;
  const results = choices.map((t) => walk(t, met));
  const satisfied = results.filter((r) => r.length === 0).length;
  if (satisfied >= n) return [];
  return results
    .filter((r) => r.length > 0)
    .sort((a, b) => a.length - b.length)
    .slice(0, n - satisfied)
    .flat();
}

/**
 * Every requirement this cohort actually has, as labels, for display.
 *
 * Includes the named-but-unnumbered ones, which is the whole point: they never
 * appear in `unmet`, so without this a reader would never learn about them.
 */
export function requirements(
  tree: PrereqTree | undefined,
  cohort?: Curriculum,
  pillar?: string,
): string[] {
  if (tree === undefined) return [];
  const t = prune(tree, cohort, pillar);
  if (t === undefined) return [];
  const out: string[] = [];
  const visit = (n: PrereqTree): void => {
    if (typeof n === 'string') { out.push(n); return; }
    if (isNamed(n)) { out.push(n.code ? `${n.code} ${n.name}` : n.name); return; }
    if ('and' in n) { n.and.forEach(visit); return; }
    if ('or' in n) { n.or.forEach(visit); return; }
    n.nOf[1].forEach(visit);
  };
  visit(t);
  return [...new Set(out)];
}

/** The tree to evaluate: the explicit one, or the flat list read as "all of". */
export function treeOf(
  prereqTree: PrereqTree | undefined,
  prerequisites: string[] | undefined,
): PrereqTree | undefined {
  if (prereqTree) return prereqTree;
  if (!prerequisites?.length) return undefined;
  return prerequisites.length === 1 ? prerequisites[0] : { and: prerequisites };
}

/**
 * The requirements a chip should SHOW, grouped the way the tree states them.
 *
 * `unmet` answers "what is missing" and collapses an `or` to one branch, which
 * is right for a red/green verdict and wrong for a picker: the reader needs to
 * see the alternatives to choose between them. This keeps the group whole, so
 * "one of 10.014 / 10.025" renders as one slot rather than two demands the
 * student can only ever half-satisfy.
 */
export type Requirement =
  | { kind: 'need'; code?: string; name?: string; met: boolean }
  | {
      kind: 'oneOf';
      options: { code?: string; name?: string; cohort?: Curriculum[] }[];
      met: boolean;
      /** The option that satisfied it, so the chip can say which. */
      metBy?: string;
    };

export function requirementsOf(
  tree: PrereqTree | undefined,
  met: (code: string) => boolean,
  cohort?: Curriculum,
  pillar?: string,
): Requirement[] {
  if (tree === undefined) return [];
  const t = prune(tree, cohort, pillar);
  if (t === undefined) return [];

  const leaf = (n: PrereqTree): { code?: string; name?: string } =>
    typeof n === 'string' ? { code: n } : isNamed(n) ? { code: n.code, name: n.name } : {};

  const out: Requirement[] = [];
  const visit = (n: PrereqTree): void => {
    if (typeof n === 'string') {
      out.push({ kind: 'need', code: n, met: met(n) });
      return;
    }
    if (isNamed(n)) {
      // No code means nothing to place, so it is stated and never demanded.
      out.push({ kind: 'need', code: n.code, name: n.name, met: !n.code || met(n.code) });
      return;
    }
    if ('and' in n) { n.and.forEach(visit); return; }
    if ('or' in n) {
      const options = n.or.map(leaf);
      const hit = n.or.find((o) => walk(o, met).length === 0);
      out.push({
        kind: 'oneOf',
        options,
        met: hit !== undefined,
        metBy: hit ? (leaf(hit).code ?? leaf(hit).name) : undefined,
      });
      return;
    }
    // nOf reads as a pick group too; the count is carried by how many are met.
    const [, choices] = n.nOf;
    const options = choices.map(leaf);
    const hit = choices.find((o) => walk(o, met).length === 0);
    out.push({ kind: 'oneOf', options, met: hit !== undefined, metBy: hit ? leaf(hit).code : undefined });
  };
  visit(t);
  return out;
}
