// A spec must not break when someone rewords a sentence, and must break when
// behaviour changes. Three times now a reworded label or status line has failed
// a test that was not about the wording at all, so the rule is mechanical.
//
// Runs as `pree2e`, inside the existing gate. No dependencies, ~30ms.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E = join(dirname(fileURLToPath(import.meta.url)), '..', 'e2e');

// Long enough that real accessible names pass ("generate timetable", "clear",
// "post review") and only sentences trip it.
const PROSE_LEN = 28;

const problems = [];

for (const file of readdirSync(E2E).filter((f) => f.endsWith('.spec.ts'))) {
  const lines = readFileSync(join(E2E, file), 'utf8').split('\n');

  // A matcher often sits a line or two below the locator it applies to, so the
  // negative-assertion rule reads the whole statement, not the line.
  const statements = [];
  let buf = '';
  let start = 0;
  let marked = false;
  lines.forEach((line, i) => {
    if (line.includes('copy-assert')) marked = true;
    const code = line.replace(/\/\/.*$/, '').trim();
    if (!code) return;
    if (!buf) start = i + 1;
    buf += ` ${code}`;
    if (code.endsWith(';')) {
      statements.push({ at: `${file}:${start}`, text: buf.trim(), marked });
      buf = '';
      marked = false;
    }
  });

  // getByText proves nothing when the assertion is that nothing is there: the
  // day someone rewords the copy, the element can stay on screen and the test
  // still passes. Six of these were live at once, each guarding the payload of
  // its own test. Deliberate "this wording appears nowhere" checks are real -
  // they mark themselves with copy-assert.
  for (const { at, text, marked } of statements) {
    const negative = /toHaveCount\(0\)|not\.toBeVisible|toBeHidden/.test(text);
    // A mod code is /data's primary key, not a sentence - nobody rewords one.
    const args = [...text.matchAll(/getByText\(\s*(['"/])(.+?)\1/g)].map((m) => m[2]);
    const allCodes = args.length > 0 && args.every((a) => /^\W*\d{2}\.\d{3}\W*$/.test(a));
    if (negative && /getByText\(/.test(text) && !allCodes && !marked) {
      problems.push(`${at}  asserts absence via copy - passes vacuously once reworded\n    ${text.slice(0, 110)}`);
    }
  }

  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;

    // A CSS-module class is a build artefact - the hash changes when the
    // bundler feels like it, and the name changes on any refactor. There is no
    // case where this is the right selector.
    if (/\[class\*=/.test(line)) {
      problems.push(`${at}  selects by CSS-module class - use a data-act hook\n    ${line.trim()}`);
    }

    // Prose used to FIND an element. An assertion about copy is the thing under
    // test, so anything inside expect() is exempt by construction; so are
    // getByLabel and getByPlaceholder, which read the accessible name.
    if (/expect\(/.test(line)) return;
    for (const m of line.matchAll(/(?:getByText\(|hasText:\s*|name:\s*)\/?['"/]?([^'"/)]{4,})/g)) {
      const text = m[1].trim();
      if (text.length >= PROSE_LEN) {
        problems.push(`${at}  finds an element by ${text.length} chars of copy - use a data-act hook\n    ${line.trim()}`);
      }
    }
  });
}

if (problems.length) {
  console.error(`\ne2e selectors: ${problems.length} fragile\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  console.error('rules: frontend/e2e/README.md\n');
  process.exit(1);
}
console.log(`  e2e selectors ok (${readdirSync(E2E).filter((f) => f.endsWith('.spec.ts')).length} specs)`);
