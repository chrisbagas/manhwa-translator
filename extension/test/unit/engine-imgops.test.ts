import { describe, expect, it } from 'vitest';
import { components, dilate, distanceTransform, erode, fillHoles, minAreaRect, otsu, warpQuad, type Mask } from '../../src/engine/imgops';
import { dbPostprocess } from '../../src/engine/detect';
import { ctcDecode, easyocrInput } from '../../src/engine/recognize';

const mask = (rows: string[]): Mask => ({ w: rows[0].length, h: rows.length, data: Uint8Array.from(rows.join('').split('').map((c) => (c === '#' ? 1 : 0))) });
const show = (m: Mask) => Array.from({ length: m.h }, (_, y) => Array.from(m.data.slice(y * m.w, y * m.w + m.w)).map((v) => (v ? '#' : '.')).join(''));

describe('binary morphology (OpenCV border semantics)', () => {
  it('dilates and erodes with a square kernel', () => {
    const m = mask(['.....', '.....', '..#..', '.....', '.....']);
    expect(show(dilate(m, 1))).toEqual(['.....', '.###.', '.###.', '.###.', '.....']);
    expect(show(erode(dilate(m, 1), 1))).toEqual(['.....', '.....', '..#..', '.....', '.....']);
  });
  it('does not erode at the image border', () => {
    expect(show(erode(mask(['###', '###']), 1))).toEqual(['###', '###']);
  });
});

describe('regions', () => {
  it('labels 4-connected components and fills holes', () => {
    const m = mask(['#####', '#...#', '#####', '.....', '##...']);
    const { count } = components(m);
    expect(count).toBe(2);
    expect(show(fillHoles(m))).toEqual(['#####', '#####', '#####', '.....', '##...']);
  });
  it('distance transform measures stroke half-width', () => {
    const d = distanceTransform(mask(['.......', '.#####.', '.#####.', '.#####.', '.......']));
    expect(d[2 * 7 + 3]).toBeCloseTo(2, 0);
  });
  it('min-area rectangle of a rotated square', () => {
    const r = minAreaRect([[0, 5], [5, 0], [10, 5], [5, 10]]);
    expect(r.w * r.h).toBeCloseTo(50, 3);
  });
  it('otsu splits a bimodal histogram', () => {
    const t = otsu(Uint8Array.from([...Array(50).fill(20), ...Array(50).fill(230)]));
    expect(t).toBeGreaterThanOrEqual(20);
    expect(t).toBeLessThan(230);
  });
});

describe('detector post-processing', () => {
  it('turns a probability blob into an unclipped quad in source pixels', () => {
    const pw = 64, ph = 32;
    const prob = new Float32Array(pw * ph);
    for (let y = 12; y < 20; y++) for (let x = 10; x < 50; x++) prob[y * pw + x] = 0.9;
    const out = dbPostprocess(prob, pw, ph, 128, 64);
    expect(out).toHaveLength(1);
    const xs = out[0].quad.map((p) => p[0]), ys = out[0].quad.map((p) => p[1]);
    // Box (x 10..49, y 12..19) at 2x scale, expanded by the unclip offset.
    expect(Math.min(...xs)).toBeLessThan(20);
    expect(Math.max(...xs)).toBeGreaterThan(98);
    expect(Math.min(...ys)).toBeLessThan(24);
    expect(Math.max(...ys)).toBeGreaterThan(38);
    expect(out[0].score).toBeGreaterThan(0.7); // dilation grows the box by a pixel, as in RapidOCR
  });
  it('drops weak or tiny blobs', () => {
    const prob = new Float32Array(32 * 32);
    for (let y = 5; y < 7; y++) for (let x = 5; x < 7; x++) prob[y * 32 + x] = 0.9;
    for (let y = 15; y < 25; y++) for (let x = 5; x < 25; x++) prob[y * 32 + x] = 0.35;
    expect(dbPostprocess(prob, 32, 32, 32, 32)).toHaveLength(0);
  });
});

describe('recognition helpers', () => {
  it('EasyOCR input: height 64, width padded to a multiple of 64 by repeating the last column', () => {
    const w = 100, h = 32;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    const { input, dims } = easyocrInput({ w, h, data });
    expect(dims).toEqual([1, 1, 64, 256]);
    expect(input[0]).toBeCloseTo(1);
    expect(input[255]).toBeCloseTo(1);
  });
  it('CTC greedy decode collapses repeats, drops blanks and ignored classes', () => {
    const chars = ['[blank]', '가', '나', 'X'];
    const steps = [[0, 9, 0, 0], [0, 9, 0, 0], [9, 0, 0, 0], [0, 9, 0, 0], [0, 0, 9, 0], [0, 0, 0, 9]];
    const data = Float32Array.from(steps.flat());
    const r = ctcDecode(data, 6, 4, { family: 'easyocr', imgH: 64, characters: chars, ignore_idx: [3] }, true);
    expect(r.text).toBe('가가나');
    expect(r.confidence).toBeGreaterThan(0.9);
  });
});

describe('warpQuad', () => {
  it('extracts an axis-aligned crop exactly', () => {
    const w = 8, h = 8;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data[i * 4] = i;
    const c = warpQuad({ w, h, data }, [[2, 2], [6, 2], [6, 6], [2, 6]], 4, 4);
    expect(c.data[0]).toBe(2 * 8 + 2);
    expect(c.data[(3 * 4 + 3) * 4]).toBe(5 * 8 + 5);
  });
});
