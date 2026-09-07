// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { rememberContributed, awaitingDeploy } from './contributed';

const KEY = 'modsutd.contributed.v1';

// A batch chat needs crowdsourced schedules, and those only reach the browser
// through the deployed bundle. Between pasting and the next deploy, the mod
// just contributed looked exactly like one nobody is taking.
describe('a mod this browser contributed, waiting on the next deploy', () => {
  beforeEach(() => localStorage.clear());

  it('knows nothing about a mod nobody here pasted', () => {
    expect(awaitingDeploy('60.006', false)).toBe(false);
  });

  it('waits for a mod this browser pasted', () => {
    rememberContributed(['60.006', '01.400']);
    expect(awaitingDeploy('60.006', false)).toBe(true);
    expect(awaitingDeploy('01.400', false)).toBe(true);
    expect(awaitingDeploy('10.013', false)).toBe(false);
  });

  // The whole point of keying on the deployed data: the note cannot outlive
  // the thing it is describing.
  it('forgets the moment the deployed data has schedules', () => {
    rememberContributed(['60.006']);
    expect(awaitingDeploy('60.006', true)).toBe(false);
    // and stays forgotten, so it cannot come back on the next render
    expect(awaitingDeploy('60.006', false)).toBe(false);
  });

  it('ages out, so slots that were rejected stop promising a button', () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(KEY, JSON.stringify({ '60.006': old }));
    expect(awaitingDeploy('60.006', false)).toBe(false);
  });

  it('survives junk in the key rather than throwing at render', () => {
    localStorage.setItem(KEY, 'not json');
    expect(awaitingDeploy('60.006', false)).toBe(false);
    localStorage.setItem(KEY, JSON.stringify({ '60.006': 'yesterday' }));
    expect(awaitingDeploy('60.006', false)).toBe(false);
  });

  it('clears the key when the last entry goes, rather than leaving {}', () => {
    rememberContributed(['60.006']);
    awaitingDeploy('60.006', true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
