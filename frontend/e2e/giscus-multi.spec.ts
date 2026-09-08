import { test, expect } from '@playwright/test';

// Regression: giscus's client.js supports one widget per page (global
// .giscus container + unscoped resize listener) - two open panels blanked
// each other until the embed was hand-rolled per-instance.
test('two giscus widgets coexist', async ({ page, isMobile }) => {
  test.skip(!!isMobile);
  await page.goto('/mods/50.001');
  await page.locator('button[aria-label="Discuss"]').click();
  const modFrame = page.locator('[data-panel="mod"] iframe[title="Comments"]');
  const discussFrame = page.locator('[data-panel="discuss"] iframe[title="Comments"]');
  await modFrame.scrollIntoViewIfNeeded();
  await expect(modFrame).toBeAttached();
  await expect(discussFrame).toBeAttached();
  const modSrc = await modFrame.getAttribute('src');
  const discussSrc = await discussFrame.getAttribute('src');
  expect(modSrc).toContain('term=mod-50.001');
  expect(discussSrc).toContain('term=features');
  // The mod wall is read-and-reply only: its theme is a self-contained
  // data: URI whose CSS hides the top-level comment box.
  const modTheme = decodeURIComponent(new URL(modSrc!).searchParams.get('theme') ?? '');
  expect(modTheme).toMatch(/^data:text\/css;base64,/);
  expect(atob(modTheme.split(',')[1])).toContain('.gsc-comments > .gsc-comment-box');
  // Both panels ship their own theme: reviews hides the top-level comment box,
  // and both carry the workbench palette and amber headings. Each is a
  // self-contained data: URI, because an origin-hosted file is unreachable from
  // the https iframe over http://localhost.
  const discussTheme = new URL(discussSrc!).searchParams.get('theme')!;
  expect(discussTheme).toMatch(/^data:text\/css;base64,/);
  // Both carry the workbench palette. Neither restyles the markdown body: an
  // amber heading was tried and did not take, and a rule that does nothing is
  // worse than no rule.
  expect(atob(discussTheme.split(',')[1])).toContain('--color-canvas-default');
  expect(atob(discussTheme.split(',')[1])).not.toContain('.markdown-body');
});
