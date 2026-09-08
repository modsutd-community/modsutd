import { describe, it, expect } from 'vitest';
import { buildBody, ORDER } from './reviewBody';

describe('buildBody', () => {
  it('leaves out every field the student did not answer', () => {
    const out = buildBody({ 'Tips for future students': 'a' }, 'a');
    expect(out).toBe('**Tips for future students**: a\n\n---\na\n');
    for (const field of ORDER) {
      if (field !== 'Tips for future students') expect(out).not.toContain(field);
    }
  });

  it('treats whitespace-only answers as unanswered', () => {
    expect(buildBody({ 'Best part': '   \n ', 'Worst part': 'queues' }, '')).toBe(
      '**Worst part**: queues\n',
    );
  });

  it('trims the answers it does keep', () => {
    expect(buildBody({ 'Best part': '  the labs  ' }, '')).toBe('**Best part**: the labs\n');
  });

  it('keeps the fixed order regardless of insertion order', () => {
    const out = buildBody({ 'Worst part': 'w', 'Term taken': 'T4, 2026', 'Best part': 'b' }, '');
    expect(out).toBe('**Term taken**: T4, 2026\n**Best part**: b\n**Worst part**: w\n');
  });

  it('drops the rule when there are no structured answers to separate', () => {
    expect(buildBody({}, 'just my thoughts')).toBe('just my thoughts\n');
  });

  it('drops the rule when there is no free text', () => {
    expect(buildBody({ 'Difficulty (1-5)': '4' }, '  ')).toBe('**Difficulty (1-5)**: 4\n');
  });

  it('is empty when nothing was filled in, so the caller can refuse to post', () => {
    expect(buildBody({}, '')).toBe('');
    expect(buildBody({ 'Best part': ' ' }, '\n\n')).toBe('');
  });

  it('does not leave a stray comma when only half the term is chosen', () => {
    expect(buildBody({ 'Term taken': 'T4, ' }, '')).toBe('**Term taken**: T4\n');
    expect(buildBody({ 'Term taken': ', 2026' }, '')).toBe('**Term taken**: 2026\n');
    expect(buildBody({ 'Term taken': 'T4, 2026' }, '')).toBe('**Term taken**: T4, 2026\n');
  });

  it('treats a term with neither half chosen as unanswered', () => {
    expect(buildBody({ 'Term taken': ', ' }, '')).toBe('');
  });

  it('leaves commas alone in prose fields', () => {
    // Spacing the normaliser would "fix", and a trailing comma it would strip -
    // with evenly spaced prose this test passes even when clean() is wrongly
    // applied to every field, which is how it first shipped.
    expect(buildBody({ 'Best part': 'labs,lectures, and the studio,' }, '')).toBe(
      '**Best part**: labs,lectures, and the studio,\n',
    );
  });

  it('ignores keys that are not review fields', () => {
    expect(buildBody({ 'Best part': 'b', smuggled: 'x' }, '')).toBe('**Best part**: b\n');
  });
});
