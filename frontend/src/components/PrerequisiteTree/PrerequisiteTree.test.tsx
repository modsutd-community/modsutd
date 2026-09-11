// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PrerequisiteTree } from './PrerequisiteTree';
import type { PrereqTree } from '@/types';

// Node() ends in `return null`, so a leaf shape it does not handle draws an
// empty bullet instead of failing - which is how 50.057's three alternatives
// became a "one of" with nothing under it while typecheck stayed green.
const show = (tree: PrereqTree) =>
  render(
    <MemoryRouter>
      <PrerequisiteTree modCode="50.057" tree={tree} />
    </MemoryRouter>,
  );

describe('prerequisite tree leaves', () => {
  it('still renders a plain code leaf', () => {
    show('50.003');
    expect(screen.getByText('50.003')).toBeTruthy();
  });

  it('renders a named requirement that has no code', () => {
    show({ name: 'Algorithmic Thinking and Object-Based Abstraction' });
    expect(screen.getByText('Algorithmic Thinking and Object-Based Abstraction')).toBeTruthy();
  });

  it('renders a coded leaf that carries a name, and links it', () => {
    show({ code: '10.014', name: 'Computational Thinking for Design' });
    expect(screen.getByText('10.014')).toBeTruthy();
    expect(screen.getByText('Computational Thinking for Design')).toBeTruthy();
    expect(screen.getByRole('link')).toHaveProperty('href', expect.stringContaining('10.014'));
  });

  it('says which cohorts a leaf applies to', () => {
    show({ code: '10.025', name: 'Computational Thinking for Design', cohort: ['ay2025'] });
    expect(screen.getByText('AY2025')).toBeTruthy();
  });

  // The real shape, from data/courses/50_057.json. Every alternative has to be
  // on screen: the whole point of the change was that one of them was missing.
  it('draws every branch of 50.057, including the uncoded one', () => {
    show({
      and: ['50.003', { or: [
        { code: '10.014', name: 'Computational Thinking for Design', cohort: ['ay2024'] },
        { code: '10.025', name: 'Computational Thinking for Design', cohort: ['ay2025'] },
        { name: 'Algorithmic Thinking and Object-Based Abstraction', cohort: ['ay2026'] },
      ] }],
    });
    for (const t of ['50.003', '10.014', '10.025',
      'Algorithmic Thinking and Object-Based Abstraction']) {
      expect(screen.getByText(t), t).toBeTruthy();
    }
  });
});
