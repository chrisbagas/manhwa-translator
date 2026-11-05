// Bounded, overlapping tiles for tall strips (port of service/dalbit/tiling.py).

import type { Pt, RGBA } from './imgops';
import { resizePlaneArea } from './imgops';
import type { Raster } from './raster';

export interface TileConfig {
  tileH: number;
  overlap: number;
  maxDetWidth: number;
}
export const DEFAULT_TILES: TileConfig = { tileH: 1600, overlap: 256, maxDetWidth: 1600 };
export const tileKey = (c: TileConfig) => `t${c.tileH}-o${c.overlap}-w${c.maxDetWidth}`;

export function planTiles(height: number, tileH: number, overlap: number): [number, number][] {
  if (height <= tileH) return [[0, height]];
  const stride = tileH - overlap;
  const tiles: [number, number][] = [];
  for (let y = 0; ; y += stride) {
    if (y + tileH >= height) {
      tiles.push([Math.max(0, height - tileH), height]);
      break;
    }
    tiles.push([y, y + tileH]);
  }
  return tiles;
}

export interface Candidate {
  quad: Pt[];
  score: number;
  cut: boolean;
}

const box = (c: Candidate): [number, number, number, number] => {
  const xs = c.quad.map((p) => p[0]), ys = c.quad.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const area = (b: number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const inter = (a: number[], b: number[]) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
export const candBox = box;

export function mergeCandidates(cands: Candidate[]): Candidate[] {
  const ordered = [...cands].sort((a, b) => Number(a.cut) - Number(b.cut) || area(box(b)) - area(box(a)));
  const kept: Candidate[] = [];
  for (const c of ordered) {
    const cb = box(c);
    const dup = kept.some((k) => {
      const kb = box(k);
      const i = inter(cb, kb);
      if (i <= 0) return false;
      const small = Math.min(area(cb), area(kb)) || 1;
      return i / small > 0.6 || i / (area(cb) + area(kb) - i) > 0.3;
    });
    if (!dup) kept.push(c);
  }
  return kept;
}

type Detect = (img: RGBA) => Promise<{ quad: Pt[]; score: number }[]>;

/** Scale an RGBA image (area average) for detection on very wide images. */
function scaleRGBA(img: RGBA, s: number): RGBA {
  if (s === 1) return img;
  const nw = Math.max(1, Math.round(img.w * s)), nh = Math.max(1, Math.round(img.h * s));
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let c = 0; c < 4; c++) {
    const p = new Float32Array(img.w * img.h);
    for (let i = 0; i < p.length; i++) p[i] = img.data[i * 4 + c];
    const r = resizePlaneArea(p, img.w, img.h, nw, nh);
    for (let i = 0; i < r.length; i++) out[i * 4 + c] = r[i];
  }
  return { w: nw, h: nh, data: out };
}

async function detectWindow(r: Raster, y0: number, y1: number, detect: Detect, scale: number): Promise<Candidate[]> {
  const win = scaleRGBA(r.read(0, y0, r.width, y1 - y0), scale);
  const out: Candidate[] = [];
  for (const { quad, score } of await detect(win)) {
    const q = quad.map(([x, y]) => [x / scale, y / scale + y0] as Pt);
    const ys = q.map((p) => p[1]);
    const cut = (y0 > 0 && Math.min(...ys) - y0 < 3) || (y1 < r.height && y1 - Math.max(...ys) < 3);
    out.push({ quad: q, score, cut });
  }
  return out;
}

export async function detectTiled(r: Raster, detect: Detect, cfg: TileConfig, checkCancel: () => void) {
  const scale = Math.min(1, cfg.maxDetWidth / r.width);
  const tileH = Math.floor(cfg.tileH / scale), overlap = Math.floor(cfg.overlap / scale);
  const tiles = planTiles(r.height, tileH, overlap);
  let cands: Candidate[] = [];
  for (const [y0, y1] of tiles) {
    checkCancel();
    cands = cands.concat(await detectWindow(r, y0, y1, detect, scale));
  }
  let merged = mergeCandidates(cands);
  let reprocessed = 0;
  for (const c of merged.filter((m) => m.cut)) {
    checkCancel();
    const [, by0, , by1] = box(c);
    const cy = (by0 + by1) / 2;
    const half = Math.max(Math.floor(tileH / 2), Math.floor((by1 - by0) * 0.75));
    const wy0 = Math.max(0, Math.floor(cy - half)), wy1 = Math.min(r.height, Math.floor(cy + half));
    const fresh = (await detectWindow(r, wy0, wy1, detect, scale)).filter((f) => !f.cut && inter(box(f), box(c)) > 0);
    if (fresh.length) {
      merged = merged.filter((m) => m !== c && !fresh.some((f) => inter(box(m), box(f)) / (Math.min(area(box(m)), area(box(f))) || 1) > 0.6));
      merged.push(...fresh);
      reprocessed++;
    }
  }
  merged = mergeCandidates(merged);
  return { candidates: merged, stats: { tiles: tiles.length, candidates: cands.length, merged: merged.length, reprocessed, det_scale: Math.round(scale * 1000) / 1000 } };
}
