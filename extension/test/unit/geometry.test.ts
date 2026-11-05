import { describe, expect, it } from 'vitest';
import { contentRect, pct } from '../../src/content/geometry';

const css = { borderLeft: 0, borderTop: 0, borderRight: 0, borderBottom: 0, padLeft: 0, padTop: 0, padRight: 0, padBottom: 0, objectFit: 'fill' };

describe('geometry', () => {
  it('subtracts borders and padding', () => {
    const r = contentRect({ left: 10, top: 20, width: 120, height: 220 }, { ...css, borderLeft: 5, borderRight: 5, padTop: 10, padBottom: 10 }, { w: 100, h: 200 });
    expect(r).toEqual({ left: 15, top: 30, width: 110, height: 200 });
  });
  it('handles object-fit: contain letterboxing', () => {
    const r = contentRect({ left: 0, top: 0, width: 400, height: 400 }, { ...css, objectFit: 'contain' }, { w: 200, h: 800 });
    expect(r).toEqual({ left: 150, top: 0, width: 100, height: 400 });
  });
  it('maps image pixels to percentages so overlays scale with zoom', () => {
    expect(pct([80, 100, 160, 50], 800, 1000)).toEqual({ left: '10%', top: '10%', width: '20%', height: '5%' });
  });
});
