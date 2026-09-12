// The review's markdown shape, kept out of the component so it can be tested
// on its own.
//
// A blank line goes after a field whose answer is on its own line, because
// markdown reads the line after a list as part of the last bullet and the next
// label vanished into it. Short fields stay one per line, a compact block.
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

// Fields whose answer goes on its own line under the label.
//
// GitHub will not render a list that starts on the same line as other text:
// `**Best part**: - one` is one paragraph reading "- one", not a bullet. These
// three are the free-text ones, they are where a student writes several things,
// and the form turns each Enter into a bullet - so the label has to end the
// line for any of that to show up as a list.
const OWN_LINE = new Set<string>(['Best part', 'Worst part', 'Tips for future students']);

export function buildBody(vals: Record<string, string>, extra: string): string {
  const answered = ORDER
    .map((field) => [field, clean(field, (vals[field] ?? '').trim())] as const)
    .filter(([, v]) => v);
  const head = answered
    .map(([field, v], i) => {
      const line = OWN_LINE.has(field) ? `**${field}**:\n${v}` : `**${field}**: ${v}`;
      // A blank line ONLY after a field whose answer is on its own line,
      // and only when something follows it. Markdown reads the line after a
      // list as part of the last bullet, so `**Worst part**:` directly under
      // one disappeared into it. Between two short fields a blank line is not
      // needed, and would turn a compact block of labelled rows into
      // paragraphs for every review that has no list in it at all.
      const needsGap = OWN_LINE.has(field) && i < answered.length - 1;
      return needsGap ? `${line}\n` : line;
    })
    .join('\n');
  const tail = extra.trim();

  if (!head) return tail ? `${tail}\n` : '';
  // The rule exists to separate the structured answers from free prose, so with
  // nothing on one side of it there is nothing to separate.
  return tail ? `${head}\n\n---\n${tail}\n` : `${head}\n`;
}
