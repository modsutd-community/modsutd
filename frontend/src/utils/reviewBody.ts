// The review's markdown shape, kept out of the component so it can be tested
// on its own.
//
// A blank field is left out entirely rather than emitted as an empty label.
// Posting `**Results (optional)**: ` says nothing, but it reads on the thread
// as though the student answered and had nothing to say - and a review of six
// empty labels around one real answer buries the answer.
export const ORDER = [
  'Term taken', 'Results (optional)', 'Difficulty (1-5)',
  'Workload (lighter / as-stated / heavier)', 'Best part', 'Worst part',
  'Tips for future students',
] as const;

// "Term taken" is two pickers stored in one value ("T4, 2026"), so choosing only
// one half arrives as "T4, " or ", 2026". A stray comma in someone's review is
// exactly the kind of blank this change is meant to stop showing.
const clean = (field: string, v: string) =>
  field === 'Term taken' ? v.split(',').map((s) => s.trim()).filter(Boolean).join(', ') : v;

export function buildBody(vals: Record<string, string>, extra: string): string {
  const head = ORDER
    .map((field) => [field, clean(field, (vals[field] ?? '').trim())] as const)
    .filter(([, v]) => v)
    .map(([field, v]) => `**${field}**: ${v}`)
    .join('\n');
  const tail = extra.trim();

  if (!head) return tail ? `${tail}\n` : '';
  // The rule exists to separate the structured answers from free prose, so with
  // nothing on one side of it there is nothing to separate.
  return tail ? `${head}\n\n---\n${tail}\n` : `${head}\n`;
}
