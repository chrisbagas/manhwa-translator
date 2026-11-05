// Page layout analysis (port of service/dalbit/layout.py): bubbles, grouping,
// reading order, classification, style, glyph-only cleanup, SFX placement.

import { components, dilate, distanceTransform, edgeDensity, erode, fillHoles, hex, lum, medianColor, otsu, toGray, type Mask, type Pt, type RGBA } from './imgops';
export type { RGBA };
import type { Raster } from './raster';
import { scriptOk } from './text';
import type { Bubble, Kind, Style } from '../shared/types';

export interface TextLine {
  quad: Pt[];
  text: string;
  confidence: number;
  det_score: number;
  angle: number;
}

export type Box4 = [number, number, number, number]; // x0, y0, x1, y1

export function lineBox(l: TextLine): Box4 {
  const xs = l.quad.map((p) => p[0]), ys = l.quad.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function lineHeight(l: TextLine): number {
  const [a, , , d] = l.quad;
  const side = Math.hypot(d[0] - a[0], d[1] - a[1]);
  const b = lineBox(l);
  return side > 0 ? side : b[3] - b[1];
}

export function quadAngle(q: Pt[]): number {
  return (-Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180) / Math.PI;
}

const median = (v: number[]) => {
  const a = [...v].sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const clipBox = (x0: number, y0: number, x1: number, y1: number, w: number, h: number): Box4 =>
  [Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)), Math.min(w, Math.ceil(x1)), Math.min(h, Math.ceil(y1))];

// ---------------------------------------------------------------- grouping

function sameBlock(a: TextLine, b: TextLine, ba: number | null, bb: number | null): boolean {
  // Different bubbles never merge; the same bubble still needs line geometry
  // (two lobes of a double bubble are one white shape but separate speeches).
  if (ba !== null && bb !== null && ba !== bb) return false;
  const A = lineBox(a), B = lineBox(b);
  const ha = Math.max(1, Math.min(A[3] - A[1], lineHeight(a))), hb = Math.max(1, Math.min(B[3] - B[1], lineHeight(b)));
  const hmax = Math.max(ha, hb), hmin = Math.min(ha, hb);
  if (hmax / hmin > 1.7) return false;
  if (Math.abs(a.angle - b.angle) > 12) return false;
  const [top, bot] = A[1] <= B[1] ? [A, B] : [B, A];
  const gap = bot[1] - top[3];
  const xOverlap = Math.min(A[2], B[2]) - Math.max(A[0], B[0]);
  if (gap > -0.5 * hmin && gap < 0.9 * hmax && xOverlap > -0.2 * hmax) {
    // Stacked lines of one block overlap horizontally (centred) or share a left edge.
    const narrower = Math.max(1, Math.min(A[2] - A[0], B[2] - B[0]));
    return xOverlap / narrower >= 0.5 || Math.abs(A[0] - B[0]) < hmax;
  }
  const vOverlap = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
  if (vOverlap > 0.6 * hmin) return Math.max(A[0], B[0]) - Math.min(A[2], B[2]) < 1.2 * hmax;
  return false;
}

class UnionFind {
  p: number[];
  constructor(n: number) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(i: number): number { while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i]; } return i; }
  union(a: number, b: number) { this.p[this.find(a)] = this.find(b); }
  groups<T>(items: T[]): T[][] {
    const m = new Map<number, T[]>();
    items.forEach((it, i) => { const r = this.find(i); m.set(r, [...(m.get(r) ?? []), it]); });
    return [...m.values()];
  }
}

export function sortLines(lines: TextLine[], rtl = false): TextLine[] {
  const rows: TextLine[][] = [];
  for (const ln of [...lines].sort((a, b) => (lineBox(a)[1] + lineBox(a)[3]) / 2 - (lineBox(b)[1] + lineBox(b)[3]) / 2)) {
    const [, y0, , y1] = lineBox(ln);
    const row = rows.find((r) => {
      const ry0 = Math.min(...r.map((l) => lineBox(l)[1])), ry1 = Math.max(...r.map((l) => lineBox(l)[3]));
      return Math.min(y1, ry1) - Math.max(y0, ry0) > 0.5 * Math.min(y1 - y0, ry1 - ry0);
    });
    if (row) row.push(ln); else rows.push([ln]);
  }
  return rows.flatMap((r) => r.sort((a, b) => (rtl ? lineBox(b)[0] - lineBox(a)[0] : lineBox(a)[0] - lineBox(b)[0])));
}

export function groupLines(lines: TextLine[], bubbleId: (number | null)[]): TextLine[][] {
  const uf = new UnionFind(lines.length);
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    if (sameBlock(lines[i], lines[j], bubbleId[i], bubbleId[j])) uf.union(i, j);
  }
  return uf.groups(lines).map((g) => sortLines(g));
}

export function readingOrder(boxes: Box4[], rtl: boolean): number[] {
  const idx = boxes.map((_, i) => i).sort((a, b) => boxes[a][1] - boxes[b][1]);
  const bands: number[][] = [];
  for (const i of idx) {
    const [, y0, , y1] = boxes[i];
    const band = bands.find((b) => {
      const by0 = Math.min(...b.map((j) => boxes[j][1])), by1 = Math.max(...b.map((j) => boxes[j][3]));
      return Math.min(y1, by1) - Math.max(y0, by0) > 0.4 * Math.min(y1 - y0, by1 - by0);
    });
    if (band) band.push(i); else bands.push([i]);
  }
  return bands.flatMap((b) => b.sort((p, q) => (rtl ? -1 : 1) * ((boxes[p][0] + boxes[p][2]) / 2 - (boxes[q][0] + boxes[q][2]) / 2)));
}

const iou = (a: number[], b: number[]) => {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy, u = a[2] * a[3] + b[2] * b[3] - i;
  return u ? i / u : 0;
};

/** Paragraphs inside one rectangular box (system window, caption box) become one
 *  block. Round / free-form bubbles are not merged (double bubbles = two speeches). */
export function mergeSharedContainers(groups: TextLine[][], containers: (number[] | null)[]): TextLine[][] {
  const uf = new UnionFind(groups.length);
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    const a = containers[i], b = containers[j];
    if (a && b && iou(a, b) > 0.7) uf.union(i, j);
  }
  return uf.groups(groups).map((gs) => sortLines(gs.flat()));
}

/** Colour contrast of the strongest ink in a line: 95th percentile of each
 *  pixel's max-channel difference from the line's median colour. Watermarks
 *  and faint background lettering score low; real lettering (also coloured
 *  text such as yellow on white) scores high. */
export function lineContrast(r: Raster, l: TextLine): number {
  const [x0, y0, x1, y1] = lineBox(l);
  return inkContrast(r.read(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)));
}

export function inkContrast(img: RGBA): number {
  const n = img.w * img.h;
  const bg = medianColor(img, () => true)!;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = maxDiff(img.data, i, bg);
  v.sort();
  return v[Math.floor(0.95 * (n - 1))];
}

/** Trim faint columns (e.g. a watermark glued to the end of a line by the
 *  detector) from both ends of a horizontal line crop. */
export function trimFaint(crop: RGBA, minDiff = 90): RGBA {
  const { w, h, data } = crop;
  const bg = medianColor(crop, () => true)!;
  let first = -1, last = -1;
  for (let x = 0; x < w; x++) {
    let strong = 0;
    for (let y = 0; y < h; y++) if (maxDiff(data, y * w + x, bg) >= minDiff) strong++;
    if (strong >= 2) { if (first < 0) first = x; last = x; }
  }
  if (first < 0) return crop; // nothing strong: leave it to the contrast filter
  const margin = Math.ceil(h * 0.2);
  const a = Math.max(0, first - margin), b = Math.min(w - 1, last + margin);
  if (a === 0 && b === w - 1) return crop;
  const out = new Uint8ClampedArray((b - a + 1) * h * 4);
  for (let y = 0; y < h; y++) out.set(data.subarray((y * w + a) * 4, (y * w + b + 1) * 4), y * (b - a + 1) * 4);
  return { w: b - a + 1, h, data: out };
}

/** Fraction of a line's box inside a bubble component (window coords). */
export function coverage(info: BubbleInfo, b: Box4): number {
  const [wx0, wy0] = info.window;
  const m = info.component;
  let inside = 0, total = 0;
  const step = Math.max(1, Math.floor((b[3] - b[1]) / 12));
  for (let y = Math.floor(b[1]); y < b[3]; y += step) for (let x = Math.floor(b[0]); x < b[2]; x += step) {
    total++;
    const lx = x - wx0, ly = y - wy0;
    if (lx >= 0 && ly >= 0 && lx < m.w && ly < m.h && m.data[ly * m.w + lx]) inside++;
  }
  return total ? inside / total : 0;
}

// ---------------------------------------------------------------- bubbles

export interface BubbleInfo {
  bubble: Bubble;
  component: Mask; // filled bubble, window coords
  window: Box4;
  bg: [number, number, number];
  enclosed: boolean;
}

const maxDiff = (d: Uint8ClampedArray, i: number, c: number[]) =>
  Math.max(Math.abs(d[i * 4] - c[0]), Math.abs(d[i * 4 + 1] - c[1]), Math.abs(d[i * 4 + 2] - c[2]));

export function findBubble(r: Raster, boxes: Box4[], tol = 28): BubbleInfo | null {
  const W = r.width, H = r.height;
  const lh = median(boxes.map((b) => b[3] - b[1]));
  const bx0 = Math.min(...boxes.map((b) => b[0])), by0 = Math.min(...boxes.map((b) => b[1]));
  const bx1 = Math.max(...boxes.map((b) => b[2])), by1 = Math.max(...boxes.map((b) => b[3]));
  // Ring around the lines -> background colour + flatness.
  const p = Math.max(3, Math.floor(lh * 0.45));
  const [rx0, ry0, rx1, ry1] = clipBox(bx0 - p, by0 - p, bx1 + p, by1 + p, W, H);
  const ringImg = r.read(rx0, ry0, rx1 - rx0, ry1 - ry0);
  const inLine = (x: number, y: number) => boxes.some((b) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3]);
  const ringSel = (i: number) => !inLine(rx0 + (i % ringImg.w), ry0 + Math.floor(i / ringImg.w));
  const bg = medianColor(ringImg, ringSel);
  if (!bg) return null;
  let n = 0, near = 0, faint = 0;
  for (let i = 0; i < ringImg.w * ringImg.h; i++) if (ringSel(i)) {
    n++;
    const d = maxDiff(ringImg.data, i, bg);
    if (d < tol) near++; else if (d < 70) faint++;
  }
  // Textured / illustrated background -> no cleanup. Faint pixels (a site
  // watermark across a white bubble, anti-aliasing) do not make it textured.
  if (!n || (near / n < 0.85 && !(near / n >= 0.6 && (near + faint) / n >= 0.95))) return null;

  let enclosed = false;
  let comp: Mask | null = null;
  let win: Box4 = [0, 0, 0, 0];
  for (const grow of [1.2, 3.0]) {
    const m = Math.max(lh * 2, grow * Math.max(bx1 - bx0, by1 - by0) * 0.5);
    win = clipBox(bx0 - m, by0 - m, bx1 + m, by1 + m, W, H);
    const [x0, y0, x1, y1] = win;
    const sub = r.read(x0, y0, x1 - x0, y1 - y0);
    const sim: Mask = { w: sub.w, h: sub.h, data: new Uint8Array(sub.w * sub.h) };
    for (let i = 0; i < sim.data.length; i++) sim.data[i] = maxDiff(sub.data, i, bg) < tol ? 1 : 0;
    const { labels } = components(sim);
    const counts = new Map<number, number>();
    const pad = Math.max(2, Math.floor(lh * 0.25));
    for (const b of boxes) {
      const [sx0, sy0, sx1, sy1] = clipBox(b[0] - x0 - pad, b[1] - y0 - pad, b[2] - x0 + pad, b[3] - y0 + pad, sub.w, sub.h);
      for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) {
        const l = labels[y * sub.w + x];
        if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
      }
    }
    if (!counts.size) return null;
    const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const cd = new Uint8Array(sub.w * sub.h);
    for (let i = 0; i < cd.length; i++) cd[i] = labels[i] === main ? 1 : 0;
    comp = { w: sub.w, h: sub.h, data: cd };
    let borderOn = 0, borderN = 0;
    for (let x = 0; x < sub.w; x++) { borderN += 2; borderOn += comp.data[x] + comp.data[(sub.h - 1) * sub.w + x]; }
    for (let y = 0; y < sub.h; y++) { borderN += 2; borderOn += comp.data[y * sub.w] + comp.data[y * sub.w + sub.w - 1]; }
    if (borderOn === 0 || borderOn / borderN < 0.02) { enclosed = true; break; }
  }
  if (!comp) return null;
  const [x0, y0] = win;
  const filled = fillHoles(comp);
  let fx0 = Infinity, fy0 = Infinity, fx1 = -1, fy1 = -1, area = 0;
  for (let y = 0; y < filled.h; y++) for (let x = 0; x < filled.w; x++) if (filled.data[y * filled.w + x]) {
    area++; fx0 = Math.min(fx0, x); fy0 = Math.min(fy0, y); fx1 = Math.max(fx1, x); fy1 = Math.max(fy1, y);
  }
  if (!area) return null;
  const fb = [fx0 + x0, fy0 + y0, fx1 - fx0 + 1, fy1 - fy0 + 1];
  const fill = area / (fb[2] * fb[3]);
  const shape = !enclosed ? 'none' : fill > 0.9 ? 'rect' : fill > 0.7 ? 'ellipse' : 'free';
  const interior = interiorRect(filled, [bx0 - x0, by0 - y0, bx1 - x0, by1 - y0], Math.max(3, Math.floor(lh * 0.25)));
  return {
    bubble: {
      bbox: enclosed ? fb : [Math.floor(bx0), Math.floor(by0), Math.floor(bx1 - bx0), Math.floor(by1 - by0)],
      interior: [interior[0] + x0, interior[1] + y0, interior[2], interior[3]],
      fill: hex(bg), flat: true, shape,
    },
    component: filled, window: win, bg, enclosed,
  };
}

function interiorRect(mask: Mask, textBox: number[], margin: number): number[] {
  const inner = erode(mask, margin);
  const W = inner.w, H = inner.h;
  let [x0, y0, x1, y1] = textBox.map(Math.floor);
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W - 1, x1); y1 = Math.min(H - 1, y1);
  if (x1 <= x0 || y1 <= y0) return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
  const step = Math.max(1, Math.floor((y1 - y0) / 20));
  const col = (x: number, a: number, b: number) => { for (let y = a; y <= b; y++) if (!inner.data[y * W + x]) return false; return true; };
  const row = (y: number, a: number, b: number) => { for (let x = a; x <= b; x++) if (!inner.data[y * W + x]) return false; return true; };
  for (let grew = true; grew;) {
    grew = false;
    if (x0 - step >= 0 && col(x0 - step, y0, y1)) { x0 -= step; grew = true; }
    if (x1 + step < W && col(x1 + step, y0, y1)) { x1 += step; grew = true; }
    if (y0 - step >= 0 && row(y0 - step, x0, x1)) { y0 -= step; grew = true; }
    if (y1 + step < H && row(y1 + step, x0, x1)) { y1 += step; grew = true; }
  }
  return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/** Glyph-only cleanup mask, as RGBA patch + box (image coords). */
export function cleanupPatch(r: Raster, info: BubbleInfo, boxes: Box4[], lh: number): { rgba: RGBA; box: number[] } | null {
  const [x0, y0, x1, y1] = info.window;
  const sub = r.read(x0, y0, x1 - x0, y1 - y0);
  const W = sub.w, H = sub.h;
  const pad = Math.max(2, Math.floor(lh * 0.2));
  const near = new Uint8Array(W * H);
  for (const b of boxes) {
    const [sx0, sy0, sx1, sy1] = clipBox(b[0] - x0 - pad, b[1] - y0 - pad, b[2] - x0 + pad, b[3] - y0 + pad, W, H);
    for (let y = sy0; y < sy1; y++) near.fill(1, y * W + sx0, y * W + sx1);
  }
  const safe = erode(info.component, Math.max(2, Math.floor(lh * 0.08)));
  const m: Mask = { w: W, h: H, data: new Uint8Array(W * H) };
  let any = false;
  for (let i = 0; i < W * H; i++) {
    if (near[i] && safe.data[i] && maxDiff(sub.data, i, info.bg) >= 28) { m.data[i] = 1; any = true; }
  }
  if (!any) return null;
  const d = dilate(m, Math.max(1, Math.floor(lh * 0.06)));
  let count = 0, compArea = 0, px0 = W, py0 = H, px1 = -1, py1 = -1;
  for (let i = 0; i < W * H; i++) {
    compArea += info.component.data[i];
    d.data[i] &= safe.data[i];
    if (d.data[i]) { count++; const x = i % W, y = (i - x) / W; px0 = Math.min(px0, x); py0 = Math.min(py0, y); px1 = Math.max(px1, x); py1 = Math.max(py1, y); }
  }
  if (!count || count > 0.6 * compArea) return null;
  const pw = px1 - px0 + 1, ph = py1 - py0 + 1;
  // Fill masked pixels from their surroundings, ring by ring ("onion peel"),
  // so gradients and texture continue instead of a flat blotch. Ink pixels
  // outside the mask (outlines, other lettering) are never used as sources.
  const col = new Float32Array(W * H * 3);
  const known = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    col[i * 3] = sub.data[i * 4]; col[i * 3 + 1] = sub.data[i * 4 + 1]; col[i * 3 + 2] = sub.data[i * 4 + 2];
    known[i] = !d.data[i] && maxDiff(sub.data, i, info.bg) < 28 ? 1 : 0;
  }
  let todo: number[] = [];
  for (let i = 0; i < W * H; i++) if (d.data[i]) todo.push(i);
  for (let iter = 0; iter < 64 && todo.length; iter++) {
    const next: number[] = [], filled: number[] = [];
    for (const i of todo) {
      const x = i % W, y = (i - x) / W;
      let n = 0, r = 0, g = 0, b = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if ((dx || dy) && xx >= 0 && yy >= 0 && xx < W && yy < H && known[yy * W + xx]) {
          const j = (yy * W + xx) * 3; r += col[j]; g += col[j + 1]; b += col[j + 2]; n++;
        }
      }
      if (n) { col[i * 3] = r / n; col[i * 3 + 1] = g / n; col[i * 3 + 2] = b / n; filled.push(i); } else next.push(i);
    }
    for (const i of filled) known[i] = 1;
    if (!filled.length) break;
    todo = next;
  }
  for (const i of todo) { col[i * 3] = info.bg[0]; col[i * 3 + 1] = info.bg[1]; col[i * 3 + 2] = info.bg[2]; }
  const out = new Uint8ClampedArray(pw * ph * 4);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const o = (y * pw + x) * 4, i = (py0 + y) * W + px0 + x;
    out[o] = col[i * 3]; out[o + 1] = col[i * 3 + 1]; out[o + 2] = col[i * 3 + 2];
    out[o + 3] = d.data[i] ? 255 : 0;
  }
  return { rgba: { w: pw, h: ph, data: out }, box: [px0 + x0, py0 + y0, pw, ph] };
}

// ---------------------------------------------------------------- style

export function estimateStyle(r: Raster, lines: TextLine[], bgHint: number[] | null): Style {
  const boxes = lines.map(lineBox);
  const [cx0, cy0, cx1, cy1] = clipBox(Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3])), r.width, r.height);
  const lh = median(lines.map(lineHeight));
  const style: Style = { fg: '#111111', outline: null, outline_px: 0, font_px: Math.round(lh * 0.78 * 10) / 10, weight: 600, align: 'center', orientation: 'horizontal', angle: Math.round(median(lines.map((l) => l.angle)) * 10) / 10 };
  if (cx1 - cx0 < 2 || cy1 - cy0 < 2) return style;
  const sub = r.read(cx0, cy0, cx1 - cx0, cy1 - cy0);
  const N = sub.w * sub.h;
  const ink: Mask = { w: sub.w, h: sub.h, data: new Uint8Array(N) };
  if (bgHint) {
    // Keep only the dominant contrast direction (light-on-dark or dark-on-light):
    // textured boxes also contain pixels that differ the other way.
    const bgL = lum(bgHint[0], bgHint[1], bgHint[2]);
    let lighter = 0, darker = 0;
    const L0 = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      L0[i] = lum(sub.data[i * 4], sub.data[i * 4 + 1], sub.data[i * 4 + 2]);
      if (maxDiff(sub.data, i, bgHint) >= 40) { if (L0[i] > bgL) lighter++; else darker++; }
    }
    const wantLighter = lighter >= darker;
    for (let i = 0; i < N; i++) ink.data[i] = maxDiff(sub.data, i, bgHint) >= 40 && (L0[i] > bgL) === wantLighter ? 1 : 0;
  } else {
    const g = toGray(sub);
    const t = otsu(g);
    let dark = 0;
    for (const v of g) if (v <= t) dark++;
    const darkIsInk = dark / N < 0.5;
    for (let i = 0; i < N; i++) ink.data[i] = (g[i] <= t) === darkIsInk ? 1 : 0;
  }
  let inkN = 0;
  for (const v of ink.data) inkN += v;
  if (inkN < 10) return style;
  const core = erode(ink, 1);
  let coreN = 0;
  for (const v of core.data) coreN += v;
  const src = coreN > 20 ? core : ink;
  // Strongest-contrast half of the stroke pixels (anti-aliased edges pull the median toward the background).
  const dists: number[] = [];
  for (let i = 0; i < N; i++) if (src.data[i]) dists.push(bgHint ? maxDiff(sub.data, i, bgHint) : 0);
  dists.sort((a, b) => a - b);
  const cut = bgHint ? dists[Math.floor(dists.length / 2)] : -1;
  const fg = medianColor(sub, (i) => !!src.data[i] && (!bgHint || maxDiff(sub.data, i, bgHint) >= cut))!;
  style.fg = hex(fg);
  const ringM = dilate(src, 2);
  const ringSel = (i: number) => !!ringM.data[i] && !src.data[i];
  let ringN = 0;
  for (let i = 0; i < N; i++) if (ringSel(i)) ringN++;
  if (ringN > 20) {
    const rc = medianColor(sub, ringSel)!;
    const bgc = bgHint ?? medianColor(sub, (i) => !ink.data[i]) ?? rc;
    // A ring halfway between text and background is anti-aliasing, not an outline.
    const blend = Math.max(...rc.map((v, k) => Math.abs(v - (fg[k] + bgc[k]) / 2)));
    if (Math.max(...rc.map((v, k) => Math.abs(v - fg[k]))) > 60 && Math.max(...rc.map((v, k) => Math.abs(v - bgc[k]))) > 40 && blend > 40) {
      style.outline = hex(rc);
      style.outline_px = Math.round(Math.max(1, lh * 0.06) * 10) / 10;
    }
  }
  const dt = distanceTransform(ink);
  const inkD: number[] = [];
  for (let i = 0; i < N; i++) if (ink.data[i]) inkD.push(dt[i]);
  inkD.sort((a, b) => a - b);
  const stroke = 2 * (inkD[Math.floor(0.9 * (inkD.length - 1))] ?? 0);
  style.weight = stroke > 0.16 * lh ? 800 : stroke > 0.11 * lh ? 700 : 500;
  if (lines.length > 1) {
    const sd = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };
    if (sd(boxes.map((b) => b[0])) + 2 < sd(boxes.map((b) => (b[0] + b[2]) / 2))) style.align = 'left';
  }
  return style;
}

// ---------------------------------------------------------------- classification

export function classify(lines: TextLine[], info: BubbleInfo | null, pageMedianH: number, text: string, lang: string, conf: number, sfxHint: boolean): { kind: Kind; flags: string[] } {
  const flags: string[] = [];
  const lh = median(lines.map(lineHeight));
  const angle = Math.abs(median(lines.map((l) => l.angle)));
  const chars = [...text.replace(/\s|[!?.,~…-]/g, '')].length;
  const big = pageMedianH ? lh > 2.2 * pageMedianH : false;
  if (!text.trim() || !scriptOk(text, lang)) flags.push('no-source-script');
  if (conf < 0.35) flags.push('low-confidence');
  if (angle > 12) flags.push('rotated');
  const flat = info !== null;
  const sfxLike = (big && chars <= 6) || (angle > 12 && chars <= 8) || (sfxHint && !(info && info.enclosed));
  if (sfxLike && (!flat || big || angle > 12)) return { kind: 'sfx', flags };
  if (flags.includes('no-source-script') || (flags.includes('low-confidence') && !flat)) return { kind: 'uncertain', flags };
  if (info && info.enclosed) return { kind: info.bubble.shape === 'rect' ? 'narration' : 'dialogue', flags };
  if (flat) return { kind: 'narration', flags };
  return { kind: 'dialogue', flags: [...flags, 'on-artwork'] };
}

// ---------------------------------------------------------------- placement

export function placeAnnotation(r: Raster, sfx: number[], capW: number, capH: number, avoid: number[][]): { box: number[] | null; score: number } {
  const [x, y, bw, bh] = sfx;
  const gap = Math.max(6, Math.floor(Math.min(bw, bh) * 0.08));
  const cands: [number, number][] = [
    [x + bw + gap, y + Math.floor((bh - capH) / 2)], [x - capW - gap, y + Math.floor((bh - capH) / 2)],
    [x + Math.floor((bw - capW) / 2), y + bh + gap], [x + Math.floor((bw - capW) / 2), y - capH - gap],
    [x + bw - Math.floor(capW / 2), y + bh - Math.floor(capH / 2)], [x - Math.floor(capW / 2), y - Math.floor(capH / 2)],
    [x + bw - Math.floor(capW / 2), y - Math.floor(capH / 2)], [x - Math.floor(capW / 2), y + bh - Math.floor(capH / 2)],
  ];
  let best: number[] | null = null, bestS = 1e9;
  for (const [cx, cy] of cands) {
    if (cx < 0 || cy < 0 || cx + capW > r.width || cy + capH > r.height) continue;
    const patch = r.read(cx, cy, capW, capH);
    let s = edgeDensity(toGray(patch), patch.w, patch.h) * 4; // ~ comparable to the Canny-based score
    for (const a of avoid) {
      const inter = Math.max(0, Math.min(cx + capW, a[0] + a[2]) - Math.max(cx, a[0])) * Math.max(0, Math.min(cy + capH, a[1] + a[3]) - Math.max(cy, a[1]));
      s += (2 * inter) / (capW * capH);
    }
    if (s < bestS) { best = [cx, cy, capW, capH]; bestS = s; }
  }
  return { box: best, score: bestS };
}

export interface RegionDraft {
  bbox: number[];
  render_box: number[];
  render_mode: string;
}

export function separateRenderBoxes(regions: RegionDraft[]): void {
  for (const r of regions) {
    if (['marker', 'hidden', 'annotate'].includes(r.render_mode)) continue;
    let [x0, y0] = r.render_box;
    let x1 = x0 + r.render_box[2], y1 = y0 + r.render_box[3];
    const [rx0, ry0] = r.bbox, rx1 = rx0 + r.bbox[2], ry1 = ry0 + r.bbox[3];
    for (const o of regions) {
      if (o === r) continue;
      const [ox0, oy0] = o.bbox, ox1 = ox0 + o.bbox[2], oy1 = oy0 + o.bbox[3];
      if (Math.min(x1, ox1) <= Math.max(x0, ox0) || Math.min(y1, oy1) <= Math.max(y0, oy0)) continue;
      if (oy0 >= ry1) y1 = Math.min(y1, oy0 - 2);
      else if (oy1 <= ry0) y0 = Math.max(y0, oy1 + 2);
      else if (ox0 >= rx1) x1 = Math.min(x1, ox0 - 2);
      else if (ox1 <= rx0) x0 = Math.max(x0, ox1 + 2);
    }
    x0 = Math.min(x0, rx0); y0 = Math.min(y0, ry0); x1 = Math.max(x1, rx1); y1 = Math.max(y1, ry1);
    r.render_box = [Math.floor(x0), Math.floor(y0), Math.floor(x1 - x0), Math.floor(y1 - y0)];
  }
  // Two drawing boxes must not overlap either: split the overlap between the texts.
  const drawn = regions.filter((r) => !['marker', 'hidden', 'annotate'].includes(r.render_mode));
  for (let i = 0; i < drawn.length; i++) for (let j = i + 1; j < drawn.length; j++) {
    const a = drawn[i], b = drawn[j];
    const A = [a.render_box[0], a.render_box[1], a.render_box[0] + a.render_box[2], a.render_box[1] + a.render_box[3]];
    const B = [b.render_box[0], b.render_box[1], b.render_box[0] + b.render_box[2], b.render_box[1] + b.render_box[3]];
    if (Math.min(A[2], B[2]) <= Math.max(A[0], B[0]) || Math.min(A[3], B[3]) <= Math.max(A[1], B[1])) continue;
    const at = [a.bbox[0], a.bbox[1], a.bbox[0] + a.bbox[2], a.bbox[1] + a.bbox[3]];
    const bt = [b.bbox[0], b.bbox[1], b.bbox[0] + b.bbox[2], b.bbox[1] + b.bbox[3]];
    if (at[2] <= bt[0] || bt[2] <= at[0]) {
      const [l, rr, lt, rt] = at[2] <= bt[0] ? [A, B, at, bt] : [B, A, bt, at];
      const mid = Math.floor((lt[2] + rt[0]) / 2);
      l[2] = Math.max(lt[2], Math.min(l[2], mid - 1)); rr[0] = Math.min(rt[0], Math.max(rr[0], mid + 1));
    } else {
      const [t, bo, tt, btt] = at[3] <= bt[1] ? [A, B, at, bt] : [B, A, bt, at];
      const mid = Math.floor((tt[3] + btt[1]) / 2);
      t[3] = Math.max(tt[3], Math.min(t[3], mid - 1)); bo[1] = Math.min(btt[1], Math.max(bo[1], mid + 1));
    }
    a.render_box = [A[0], A[1], A[2] - A[0], A[3] - A[1]];
    b.render_box = [B[0], B[1], B[2] - B[0], B[3] - B[1]];
  }
}

/** Stable short id (FNV-1a) for a region of an image. */
export function regionId(imageKey: string, bbox: number[]): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const ch of `${imageKey}:${bbox.map((v) => Math.floor(v)).join(',')}`) {
    const c = ch.codePointAt(0)!;
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + 0x9e37), 0x85ebca6b) >>> 0;
  }
  return 'r' + (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 10);
}

export { lum };
