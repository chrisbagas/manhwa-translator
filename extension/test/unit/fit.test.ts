import { describe, expect, it } from 'vitest';
import { balancedWrap, fitText, greedyWrap, type Measure } from '../../src/content/fit';

// Deterministic metric: every character is 0.5em wide.
const mono: Measure = (t, size) => t.length * size * 0.5;

describe('fitText', () => {
  it('keeps the preferred size when the text fits', () => {
    const r = fitText('Who is it?', 200, 60, { maxPx: 20, minPx: 10, measure: mono });
    expect(r.sizePx).toBe(20);
    expect(r.lines).toEqual(['Who is it?']);
    expect(r.overflow).toBe(false);
  });

  it('re-wraps before shrinking', () => {
    const r = fitText('It is okay, I will protect you.', 120, 120, { maxPx: 16, minPx: 10, measure: mono });
    expect(r.sizePx).toBe(16);
    expect(r.lines.length).toBeGreaterThan(1);
    expect(Math.max(...r.lines.map((l) => mono(l, r.sizePx)))).toBeLessThanOrEqual(120);
  });

  it('shrinks within bounds when wrapping is not enough', () => {
    const r = fitText('What?! No way! How could you do that?', 100, 50, { maxPx: 20, minPx: 6, measure: mono });
    expect(r.overflow).toBe(false);
    expect(r.sizePx).toBeLessThan(20);
    expect(r.sizePx).toBeGreaterThanOrEqual(6);
    expect(r.height).toBeLessThanOrEqual(50);
  });

  it('never goes below the readable minimum and reports overflow instead of truncating', () => {
    const text = 'What?! No way! How could you possibly do something like that to me?';
    const r = fitText(text, 60, 30, { maxPx: 20, minPx: 11, measure: mono });
    expect(r.sizePx).toBe(11);
    expect(r.overflow).toBe(true);
    expect(r.lines.join(' ').replace(/-\s?/g, '')).toBe(text.replace(/-/g, ''));
  });

  it('balances lines instead of leaving a widow', () => {
    const greedy = greedyWrap('aaaa bbbb cccc dd'.split(' '), 70, 10, mono);
    const bal = balancedWrap('aaaa bbbb cccc dd', 70, 10, mono);
    expect(bal.length).toBe(greedy.length);
    const spread = (ls: string[]) => Math.max(...ls.map((l) => l.length)) - Math.min(...ls.map((l) => l.length));
    expect(spread(bal)).toBeLessThanOrEqual(spread(greedy));
  });

  it('hard-breaks a single word wider than the box', () => {
    const lines = greedyWrap(['Supercalifragilistic'], 50, 10, mono);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => mono(l, 10) <= 50)).toBe(true);
  });
});
