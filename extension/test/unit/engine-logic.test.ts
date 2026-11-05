import { describe, expect, it } from 'vitest';
import { groupLines, readingOrder, separateRenderBoxes, sortLines, type TextLine } from '../../src/engine/layout';
import { translateRegions, translateSegments } from '../../src/engine/pipeline';
import { ArrayRaster } from '../../src/engine/raster';
import { applyGlossary, romanize, sfxLookup, splitSentences } from '../../src/engine/text';
import { detectTiled, mergeCandidates, planTiles } from '../../src/engine/tiling';
import type { Region } from '../../src/shared/types';

const line = (x0: number, y0: number, x1: number, y1: number, text = '가'): TextLine => ({ quad: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], text, confidence: 0.9, det_score: 0.9, angle: 0 });

describe('engine text helpers (parity with the Python service)', () => {
  it('sfx lexicon, romanisation, glossary, sentences', () => {
    expect(sfxLookup('쾅!')).toBe('BOOM!');
    expect(sfxLookup('쿵쿵쿵')).toBe('THUD THUD THUD');
    expect(romanize('광!')).toBe('gwang!');
    expect(applyGlossary('김민준은 민준이라고', { 민준: 'Minjun', 김민준: 'Kim Minjun' }).text).toBe('Kim Minjun은 Minjun이라고');
    expect(splitSentences('"가자!" 그가 말했다.')).toEqual(['"가자!"', '그가 말했다.']);
  });
});

describe('engine tiling', () => {
  it('covers tall strips with bounded overlapping tiles', () => {
    const t = planTiles(30000, 1600, 256);
    expect(t[0][0]).toBe(0);
    expect(t[t.length - 1][1]).toBe(30000);
    for (let i = 1; i < t.length; i++) expect(t[i][0]).toBeLessThan(t[i - 1][1]);
  });
  it('re-detects text cut in every tile', async () => {
    const H = 3000;
    const raster = new ArrayRaster(64, H, new Uint8ClampedArray(64 * H * 4));
    // Fake detector: knows where the "text" is; encodes the window offset via a call log.
    const truth = [[10, 850, 60, 1150]];
    let offsets: number[] = [];
    const origRead = raster.read.bind(raster);
    raster.read = (x, y, w, h) => { offsets.push(y); return origRead(x, y, w, h); };
    const det = async (img: { h: number }) => {
      const y0 = offsets[offsets.length - 1];
      return truth.flatMap(([a, b, c, d]) => {
        const cy0 = Math.max(b, y0), cy1 = Math.min(d, y0 + img.h);
        return cy1 - cy0 > 4 ? [{ quad: [[a, cy0 - y0], [c, cy0 - y0], [c, cy1 - y0], [a, cy1 - y0]] as [number, number][], score: 0.9 }] : [];
      });
    };
    const { candidates, stats } = await detectTiled(raster, det, { tileH: 1000, overlap: 100, maxDetWidth: 4000 }, () => {});
    expect(stats.reprocessed).toBeGreaterThanOrEqual(1);
    expect(candidates).toHaveLength(1);
    const ys = candidates[0].quad.map((p) => p[1]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([850, 1150]);
    offsets = [];
  });
  it('merge prefers the complete detection', () => {
    const q = (y0: number, y1: number) => [[0, y0], [10, y0], [10, y1], [0, y1]] as [number, number][];
    const kept = mergeCandidates([{ quad: q(100, 120), score: 1, cut: true }, { quad: q(100, 150), score: 1, cut: false }]);
    expect(kept).toHaveLength(1);
    expect(kept[0].cut).toBe(false);
  });
});

describe('engine layout', () => {
  it('reading order and bubble grouping', () => {
    expect(readingOrder([[500, 100, 700, 200], [50, 120, 250, 210], [100, 600, 400, 700]], false)).toEqual([1, 0, 2]);
    const g = groupLines([line(100, 100, 250, 140, 'A1'), line(110, 150, 240, 190, 'A2'), line(420, 110, 600, 150, 'B1')], [null, null, null]);
    expect(g.map((x) => x.map((l) => l.text).join(' ')).sort()).toEqual(['A1 A2', 'B1']);
    expect(sortLines([line(0, 50, 10, 60, 'b'), line(0, 0, 10, 10, 'a')]).map((l) => l.text)).toEqual(['a', 'b']);
  });
  it('render boxes never cover text of another region', () => {
    const a = { bbox: [100, 100, 200, 40], render_box: [50, 50, 300, 300], render_mode: 'replace' };
    const b = { bbox: [100, 200, 200, 40], render_box: [100, 200, 200, 40], render_mode: 'replace' };
    separateRenderBoxes([a, b]);
    expect(a.render_box[1] + a.render_box[3]).toBeLessThanOrEqual(198);
  });
});

describe('engine translation stage', () => {
  const base = (kind: Region['kind'], text: string, conf = 0.9): Region => ({
    id: 'r', order: 0, kind, bbox: [0, 0, 10, 10], angle: 0, lines: [], source_text: text, translated_text: '', translation_note: '', confidence: conf,
    style: { fg: '#000', outline: null, outline_px: 0, font_px: 20, weight: 600, align: 'center', orientation: 'horizontal', angle: 0 },
    bubble: null, patch: null, patch_box: null, render_box: [0, 0, 10, 10], render_mode: kind === 'sfx' ? 'annotate' : 'replace', flags: [],
  });
  it('translates sentence by sentence, uses the SFX lexicon and romanises unknown effects', async () => {
    const seen: string[] = [];
    const fake = async (xs: string[]) => { seen.push(...xs); return xs.map((_, i) => `EN${seen.length - xs.length + i}`); };
    const out = await translateRegions([base('dialogue', '기다려! 민준아 가자!'), base('sfx', '쾅!'), base('sfx', '광!', 0.4)], 'ko', { 민준: 'Minjun' }, 'annotate', fake);
    expect(seen).toEqual(['기다려!', 'Minjun아 가자!']);
    expect(out[0].translated_text).toBe('EN0 EN1');
    expect(out[0].translation_note).toBe('glossary');
    expect(out[1].translated_text).toBe('BOOM!');
    expect(out[2]).toMatchObject({ translated_text: 'GWANG!', translation_note: 'sfx-romanized' });
    expect(out[2].flags).toContain('uncertain-reading');
    const orig = await translateRegions([base('sfx', '쾅!')], 'ko', {}, 'original', fake);
    expect(orig[0].render_mode).toBe('hidden');
  });
  it('flags output that is still in the source script', async () => {
    const out = await translateRegions([base('dialogue', '텅')], 'ko', {}, 'annotate', async (xs) => xs);
    expect(out[0].flags).toContain('untranslated');
    expect(await translateSegments(['a. b.'], async (xs) => xs.map((x) => x.toUpperCase()))).toEqual(['A. B.']);
  });
});
