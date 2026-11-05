// Engine pipeline: tiled detection -> recognition -> layout (analysis), then
// translation (port of service/dalbit/pipeline.py). Pure logic: models,
// pixels and PNG encoding are injected so it runs in a worker or in tests.

import type { Kind, Region, RenderMode, SfxMode } from '../shared/types';
import { detect as runDetect, type Infer } from './detect';
import { orderQuad, warpQuad, type Pt, type RGBA } from './imgops';
import * as L from './layout';
import type { Raster } from './raster';
import type { Recognizer } from './recognize';
import { applyGlossary, continuesOnNextLine, looksLikeSfx, romanize, scriptOk, sfxLookup, splitAcross, splitSentences, SYSTEM_TERMS_KO } from './text';
import { DEFAULT_TILES, detectTiled, type TileConfig } from './tiling';

export const ENGINE_VERSION = 'e10';
export const RTL_SOURCES = new Set(['ja']);
const SFX_MIN_CONF = 0.6;
export const MIN_LINE_CONTRAST = 90; // luminance p95-p5 inside a line box

export class Cancelled extends Error {
  constructor() { super('cancelled'); }
}

export interface Analysis {
  width: number;
  height: number;
  tiling: Record<string, number>;
  regions: Region[];
  discarded: { bbox: number[]; text: string; confidence: number; reason: string }[];
  timingsMs: Record<string, number>;
}

export interface AnalyzeDeps {
  detInfer: Infer;
  recognizer: Recognizer;
  encodePng(rgba: RGBA): Promise<string>;
  checkCancel(): void;
  imageKey: string;
  tiles?: TileConfig;
  now?: () => number;
}

const median = (v: number[]) => {
  const a = [...v].sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** Perspective crop of a text quad straight from the raster (small window only). */
export function cropQuad(r: Raster, quad: Pt[]): RGBA {
  const q = orderQuad(quad);
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1), y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1);
  const x1 = Math.min(r.width, Math.ceil(Math.max(...xs)) + 1), y1 = Math.min(r.height, Math.ceil(Math.max(...ys)) + 1);
  const win = r.read(x0, y0, x1 - x0, y1 - y0);
  const local = q.map(([x, y]) => [x - x0, y - y0] as Pt);
  const w = Math.max(4, Math.round(Math.max(Math.hypot(local[1][0] - local[0][0], local[1][1] - local[0][1]), Math.hypot(local[2][0] - local[3][0], local[2][1] - local[3][1]))));
  const h = Math.max(4, Math.round(Math.max(Math.hypot(local[3][0] - local[0][0], local[3][1] - local[0][1]), Math.hypot(local[2][0] - local[1][0], local[2][1] - local[1][1]))));
  return warpQuad(win, local, w, h);
}

function binarizedVariants(crop: RGBA): RGBA[] {
  const n = crop.w * crop.h;
  const g = new Uint8Array(n);
  for (let i = 0; i < n; i++) g[i] = Math.round(L.lum(crop.data[i * 4], crop.data[i * 4 + 1], crop.data[i * 4 + 2]));
  // Otsu threshold
  const hist = new Array(256).fill(0);
  for (const v of g) hist[v]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sB += i * hist[i];
    const between = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  const mk = (inv: boolean) => {
    const d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) { const v = (g[i] > t) !== inv ? 255 : 0; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    return { w: crop.w, h: crop.h, data: d };
  };
  return [mk(false), mk(true)];
}

export async function analyze(r: Raster, src: string, deps: AnalyzeDeps): Promise<Analysis> {
  const now = deps.now ?? (() => performance.now());
  const timings: Record<string, number> = {};
  let t0 = now();
  const det = (img: RGBA) => runDetect(img, deps.detInfer, { limitSide: (deps.tiles ?? DEFAULT_TILES).tileH });
  const { candidates, stats } = await detectTiled(r, det, deps.tiles ?? DEFAULT_TILES, deps.checkCancel);
  timings.detect = Math.round(now() - t0);

  t0 = now();
  const lines: L.TextLine[] = [];
  for (const c of candidates) {
    const xs = c.quad.map((p) => p[0]), ys = c.quad.map((p) => p[1]);
    if (Math.max(...ys) - Math.min(...ys) < 8 || Math.max(...xs) - Math.min(...xs) < 6) continue;
    deps.checkCancel();
    const res = await deps.recognizer.recognize(L.trimFaint(cropQuad(r, c.quad), MIN_LINE_CONTRAST));
    const text = res.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const quad = orderQuad(c.quad).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as Pt);
    lines.push({ quad, text, confidence: Math.round(res.confidence * 1000) / 1000, det_score: Math.round(c.score * 1000) / 1000, angle: Math.round(L.quadAngle(quad) * 10) / 10 });
  }
  // Display lettering (big / rotated): retry on binarised variants.
  const med = median(lines.map(L.lineHeight));
  for (const ln of lines) {
    if (!(L.lineHeight(ln) > 1.8 * med || Math.abs(ln.angle) > 12) || ln.confidence > 0.9) continue;
    deps.checkCancel();
    for (const v of binarizedVariants(cropQuad(r, ln.quad))) {
      const res = await deps.recognizer.recognize(v);
      const text = res.text.replace(/\s+/g, ' ').trim();
      if (text && res.confidence > ln.confidence) { ln.text = text; ln.confidence = Math.round(res.confidence * 1000) / 1000; }
    }
  }
  timings.recognize = Math.round(now() - t0);

  // Faint lettering (site watermarks, background text): drop, but report.
  const faint: Analysis['discarded'] = [];
  const kept = lines.filter((ln) => {
    const c = L.lineContrast(r, ln);
    if (c >= MIN_LINE_CONTRAST) return true;
    const b = L.lineBox(ln);
    faint.push({ bbox: [Math.floor(b[0]), Math.floor(b[1]), Math.round(b[2] - b[0]), Math.round(b[3] - b[1])], text: ln.text, confidence: ln.confidence, reason: 'low-contrast (watermark?)' });
    return false;
  });
  t0 = now();
  const { regions, discarded } = await layoutPage(r, src, kept, deps);
  discarded.push(...faint);
  timings.layout = Math.round(now() - t0);
  return { width: r.width, height: r.height, tiling: stats, regions, discarded, timingsMs: timings };
}

async function layoutPage(r: Raster, src: string, lines: L.TextLine[], deps: AnalyzeDeps) {
  // Bubble identity per line (only used to keep different bubbles apart).
  const bubbleBoxes: number[][] = [];
  const lineInfo = new Map<L.TextLine, L.BubbleInfo>();
  const bubbleId: (number | null)[] = lines.map((ln) => {
    const info = L.findBubble(r, [L.lineBox(ln)]);
    if (!info || !info.enclosed) return null;
    lineInfo.set(ln, info);
    const bb = info.bubble.bbox;
    let k = bubbleBoxes.findIndex((ob) => {
      const ix = Math.max(0, Math.min(bb[0] + bb[2], ob[0] + ob[2]) - Math.max(bb[0], ob[0]));
      const iy = Math.max(0, Math.min(bb[1] + bb[3], ob[1] + ob[3]) - Math.max(bb[1], ob[1]));
      return ix * iy > 0.8 * Math.min(bb[2] * bb[3], ob[2] * ob[3]);
    });
    if (k < 0) { bubbleBoxes.push(bb); k = bubbleBoxes.length - 1; }
    return k;
  });
  deps.checkCancel();
  let groups = L.groupLines(lines, bubbleId);
  const containers = groups.map((g) => {
    const info = L.findBubble(r, g.map(L.lineBox));
    return info && info.enclosed && info.bubble.shape === 'rect' ? info.bubble.bbox : null;
  });
  groups = L.mergeSharedContainers(groups, containers);
  const pageMedianH = median(lines.map(L.lineHeight));
  const regions: Region[] = [];
  const discarded: Analysis['discarded'] = [];
  const joiner = src === 'ja' || src === 'zh' ? '' : ' ';
  for (const g of groups) {
    deps.checkCancel();
    const boxes = g.map(L.lineBox);
    const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1]));
    const x1 = Math.max(...boxes.map((b) => b[2])), y1 = Math.max(...boxes.map((b) => b[3]));
    const text = g.map((l) => l.text).join(joiner).trim();
    const weights = g.map((l) => Math.max(1, [...l.text].length));
    const conf = g.reduce((a, l, i) => a + l.confidence * weights[i], 0) / weights.reduce((a, b) => a + b, 0);
    let info = L.findBubble(r, boxes);
    if (!info) {
      // A watermark or texture near part of the block can fail the block-level
      // test; if most lines individually sit in the same enclosed bubble, use it.
      const per = g.map((l) => lineInfo.get(l)).filter((x): x is L.BubbleInfo => !!x);
      const same = per.filter((x) => x.bubble.bbox.join() === per[0]?.bubble.bbox.join());
      if (per.length && same.length * 2 >= g.length) info = same[0];
    }
    const { kind, flags } = L.classify(g, info, pageMedianH, text, src, conf, looksLikeSfx(text, src));
    const style = L.estimateStyle(r, g, info ? info.bg : null);
    const lh = median(g.map(L.lineHeight));
    const bbox = [Math.floor(x0), Math.floor(y0), Math.round(x1 - x0), Math.round(y1 - y0)];
    const noLetters = !/\p{L}/u.test(text);
    if (!info && [...text].length <= 6 && (noLetters || (conf < 0.5 && (flags.includes('no-source-script') || conf < 0.12)))) {
      discarded.push({ bbox, text, confidence: Math.round(conf * 1000) / 1000, reason: 'likely-artwork' });
      continue;
    }
    const region: Region = {
      id: L.regionId(deps.imageKey, bbox), order: 0, kind, bbox: bbox as Region['bbox'],
      angle: Math.round(median(g.map((l) => l.angle)) * 10) / 10,
      lines: g.map((l) => ({ quad: l.quad, text: l.text, confidence: l.confidence, angle: l.angle, bbox: L.lineBox(l).map((v) => Math.round(v * 10) / 10) })),
      source_text: text, translated_text: '', translation_note: '', confidence: Math.round(conf * 1000) / 1000,
      style, bubble: info ? info.bubble : null, patch: null, patch_box: null,
      render_box: [0, 0, 0, 0], render_mode: 'overlay', flags,
    };
    const covered = info ? Math.min(...boxes.map((b) => L.coverage(info, b))) : 0;
    if (info && covered < 0.8) region.flags.push('partly-on-artwork');
    if ((kind === 'dialogue' || kind === 'narration') && info && covered >= 0.8) {
      const p = L.cleanupPatch(r, info, boxes, lh);
      if (p) {
        region.patch = await deps.encodePng(p.rgba);
        region.patch_box = p.box as Region['patch_box'];
        region.render_mode = 'replace';
        const ib = info.bubble.interior;
        const rx0 = Math.min(ib[0], bbox[0]), ry0 = Math.min(ib[1], bbox[1]);
        const rx1 = Math.max(ib[0] + ib[2], bbox[0] + bbox[2]), ry1 = Math.max(ib[1] + ib[3], bbox[1] + bbox[3]);
        region.render_box = [rx0, ry0, rx1 - rx0, ry1 - ry0];
      } else region.flags.push('cleanup-refused');
    }
    if (!region.render_box[2]) {
      const pad = Math.floor(lh * 0.3);
      region.render_box = [Math.max(0, bbox[0] - pad), Math.max(0, bbox[1] - pad), bbox[2] + 2 * pad, bbox[3] + 2 * pad];
      region.render_mode = kind === 'dialogue' || kind === 'narration' ? 'overlay' : 'marker';
    }
    regions.push(region);
  }
  L.separateRenderBoxes(regions);
  const order = L.readingOrder(regions.map((x) => [x.bbox[0], x.bbox[1], x.bbox[0] + x.bbox[2], x.bbox[1] + x.bbox[3]]), RTL_SOURCES.has(src));
  const ordered = order.map((i) => regions[i]);
  ordered.forEach((x, n) => (x.order = n));
  const avoid = ordered.map((x) => x.bbox as number[]);
  for (const x of ordered) {
    if (x.kind !== 'sfx') continue;
    const capH = Math.floor(Math.min(64, Math.max(22, x.bbox[3] * 0.28)));
    const capW = Math.floor(capH * 4.2);
    const { box, score } = L.placeAnnotation(r, x.bbox, capW, capH, avoid.filter((a) => a !== x.bbox));
    if (box && score < 0.35) { x.render_box = box as Region['render_box']; x.render_mode = 'annotate'; }
    else {
      x.render_box = [x.bbox[0] + x.bbox[2] - capH, x.bbox[1], capH, capH];
      x.render_mode = 'marker';
      x.flags.push('no-safe-annotation-space');
    }
    avoid.push(x.render_box);
  }
  return { regions: ordered, discarded };
}

// ---------------------------------------------------------------- translation

export type TranslateFn = (texts: string[]) => Promise<string[]>;

/** Translate every bubble sentence by sentence (Bergamot drops short exclamations otherwise). */
export async function translateSegments(texts: string[], translate: TranslateFn): Promise<string[]> {
  const pieces: string[] = [], owners: number[] = [];
  texts.forEach((t, i) => splitSentences(t).forEach((s) => { pieces.push(s); owners.push(i); }));
  const out: string[][] = texts.map(() => []);
  const tr = pieces.length ? await translate(pieces) : [];
  tr.forEach((t, k) => out[owners[k]].push(t.trim()));
  return out.map((p) => p.filter(Boolean).join(' '));
}

export async function translateRegions(regions: Region[], src: string, glossary: Record<string, string>, sfxMode: SfxMode, translate: TranslateFn): Promise<Region[]> {
  const out = regions.map((r) => ({ ...r, flags: [...r.flags] }));
  const idx: number[] = [], texts: string[] = [], lineNo: number[] = [];
  const unitsOf = new Map<number, number[][]>();
  const chainOf = new Map<number, { ks: number[]; weights: number[] }>();
  const src_ = src;
  out.forEach((r, i) => {
    r.translation_note = '';
    if (r.kind === 'sfx') {
      if (sfxMode === 'original') { r.translated_text = ''; r.render_mode = 'hidden'; return; }
      const gl = sfxLookup(r.source_text, src);
      if (gl) { r.translated_text = gl; r.translation_note = 'sfx-lexicon'; return; }
      r.flags = [...new Set([...r.flags, 'sfx-unknown'])];
      r.translated_text = src === 'ko' ? romanize(r.source_text).toUpperCase() : '';
      r.translation_note = 'sfx-romanized';
      if (r.confidence < SFX_MIN_CONF) r.flags = [...new Set([...r.flags, 'uncertain-reading'])];
      return;
    }
    // Stat sheets / item windows / lists: one translated line per source line.
    const lineMode = isStructured(r);
    r.layout = lineMode ? 'lines' : 'paragraph';
    // Units: a sentence that continues over several lines is translated as one.
    const units: number[][] = [];
    if (lineMode) {
      r.lines.forEach((l, k) => {
        const prev = units[units.length - 1];
        if (prev && continuesOnNextLine(r.lines[prev[prev.length - 1]].text)) prev.push(k); else units.push([k]);
      });
    } else units.push(r.lines.map((_, k) => k));
    unitsOf.set(i, units);
    units.forEach((u) => {
      const src = lineMode ? u.map((k) => r.lines[k].text).join(' ') : r.source_text;
      // User glossary wins; system-window terms only apply in structured windows.
      const itemLine = lineMode && u.length === 1 && ITEM_LINE.test(src) && !/(다|요|죠)[.!?]?$/.test(src.trim());
      const g = applyGlossary(src, itemLine && src_ === 'ko' ? { ...SYSTEM_TERMS_KO, ...glossary } : glossary);
      if (g.used.some((t) => t in glossary)) r.translation_note = 'glossary';
      idx.push(i);
      texts.push(g.text);
      lineNo.push(u[0]);
    });
  });
  // A bubble that ends mid-sentence ("~니", "~고", "~는데", ",") continues in the
  // next bubble: translate them together, then split the English between them.
  const order = out.map((r, i) => i).filter((i) => out[i].layout === 'paragraph' && idx.includes(i)).sort((a, b) => out[a].order - out[b].order);
  const chains: number[][] = [];
  for (const i of order) {
    const last = chains[chains.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev !== undefined && out[prev].order === out[i].order - 1 && bubbleContinues(out[prev].source_text) && [out[prev].kind, out[i].kind].every((k) => k === 'dialogue' || k === 'narration')) last.push(i);
    else chains.push([i]);
  }
  for (const chain of chains.filter((c) => c.length > 1)) {
    const ks = chain.map((i) => idx.indexOf(i));
    const joinedText = ks.map((k) => texts[k]).join(' ');
    const weights = chain.map((i) => [...out[i].source_text.replace(/\s/g, '')].length);
    texts[ks[0]] = joinedText;
    for (const k of ks.slice(1)) texts[k] = '';
    chainOf.set(ks[0], { ks, weights });
  }
  const raw0 = await translateSegments(texts.map((t) => t || '.'), translate);
  const raw = raw0.map((t, k) => (texts[k] ? t : ''));
  for (const [k0, { ks, weights }] of chainOf) {
    const pieces = splitWeighted(raw[k0], weights);
    ks.forEach((k, n) => (raw[k] = pieces[n] ?? ''));
  }
  // Re-join per-line translations of list-like regions with hard line breaks.
  const joined = new Map<number, string[]>();
  raw.forEach((t, k) => joined.set(idx[k], [...(joined.get(idx[k]) ?? []), t]));
  [...joined.entries()].forEach(([i, unitTexts]) => {
    const r = out[i];
    let parts = unitTexts;
    if (r.layout === 'lines') {
      const per: string[] = r.lines.map(() => '');
      (unitsOf.get(i) ?? []).forEach((u, n) => {
        const pieces = splitAcross((parts[n] ?? '').trim(), u.length);
        u.forEach((k, j) => (per[k] = pieces[j] ?? ''));
      });
      r.lines = r.lines.map((l, k) => ({ ...l, translated_text: per[k] }));
      parts = per;
    }
    let t = parts.map((p) => p.trim()).filter(Boolean).join('\n');
    if (scriptOk(t, src) && src !== 'en') { r.flags = [...new Set([...r.flags, 'untranslated'])]; t = ''; }
    r.translated_text = t;
    if (!t) { r.translation_note = 'untranslated'; if (r.render_mode === 'annotate') r.render_mode = 'marker' as RenderMode; }
  });
  return out;
}

const ITEM_LINE = /\d|[:：%+\-−\[\]()（）【】<>·•]/;

/** Item windows, stat sheets, menus: lines are independent items, not one sentence. */
export function isStructured(r: Pick<Region, 'kind' | 'lines' | 'style'>): boolean {
  const texts = r.lines.map((l) => l.text);
  if (texts.length < 2 || r.kind === 'sfx') return false;
  if (isListLike(texts)) return true;
  const items = texts.filter((t) => ITEM_LINE.test(t)).length;
  // Speech bubbles flow as sentences however short the lines; only left-aligned
  // text with item markers on most lines (an item window over artwork) qualifies.
  if (r.kind === 'dialogue' && r.style?.align !== 'left') return false;
  return items >= Math.ceil(texts.length / 2);
}

/** Korean clause endings that continue into the next bubble. */
export function bubbleContinues(text: string): boolean {
  const t = text.trim();
  if (/[.!?…~)\]'’"”]$/.test(t)) return false;
  return /(니|고|서|지만|는데|은데|던데|면|며|니까|라서|어서|아서|해서|도|거나|든지|면서|려고|자|,)$/.test(t);
}

/** Split text into parts proportional to weights, at word boundaries. */
export function splitWeighted(text: string, weights: number[]): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (weights.length <= 1) return [words.join(' ')];
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const len = words.reduce((a, w) => a + w.length + 1, -1);
  const out: string[] = [];
  let i = 0, acc = 0, target = 0;
  for (let n = 0; n < weights.length; n++) {
    target += (weights[n] / total) * len;
    const part: string[] = [];
    const remaining = weights.length - n - 1;
    while (i < words.length - remaining && (n === weights.length - 1 || !part.length || acc + words[i].length / 2 <= target)) {
      acc += words[i].length + 1;
      part.push(words[i++]);
    }
    out.push(part.join(' '));
  }
  return out;
}

/** Short items or items with numbers on every line (stat sheets, menus, lists). */
export function isListLike(lines: string[]): boolean {
  return lines.length > 1 && lines.every((l) => /\d/.test(l) || [...l.replace(/\s/g, '')].length <= 4);
}

export type { Kind };
