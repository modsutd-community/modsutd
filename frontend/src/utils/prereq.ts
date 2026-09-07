import type { PrereqTree } from '@/types';

// Which prerequisites are still unmet, given where everything sits in the plan.
//
// The flat `prerequisites` array cannot say "or": SUTD's listing writes
// "40.002 Optimisation or 60.008 Systems Design Studio" and the gatherer keeps
// only the codes, so 40.321 read as needing both. `prereqTree` is the shape
// that can, and this is the one place that decides whether a tree is satisfied.
//
// `met` answers "is this code placed at a strictly earlier level" - a prereq in
// the same term is not a prereq met.

/** Unmet leaves, or an empty array when the tree is satisfied. */
export function unmet(tree: PrereqTree | undefined, met: (code: string) => boolean): string[] {
  if (tree === undefined) return [];
  if (typeof tree === 'string') return met(tree) ? [] : [tree];

  if ('and' in tree) return tree.and.flatMap((t) => unmet(t, met));

  if ('or' in tree) {
    // Satisfied by any one branch. When none is, the shortest unmet branch is
    // the honest thing to show: it is the least work left, not all the work.
    const branches = tree.or.map((t) => unmet(t, met));
    if (branches.some((b) => b.length === 0)) return [];
    return branches.reduce((a, b) => (b.length < a.length ? b : a), branches[0] ?? []);
  }

  const [n, choices] = tree.nOf;
  const results = choices.map((t) => unmet(t, met));
  const satisfied = results.filter((r) => r.length === 0).length;
  if (satisfied >= n) return [];
  return results
    .filter((r) => r.length > 0)
    .sort((a, b) => a.length - b.length)
    .slice(0, n - satisfied)
    .flat();
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
