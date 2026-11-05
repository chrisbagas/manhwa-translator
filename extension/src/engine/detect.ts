// PP-OCR (DB) text detection: preprocessing + post-processing re-implemented
// after RapidOCR's ch_ppocr_det (Apache-2.0): resize so the long side is at
// most `limitSide` (multiples of 32), BGR, (x/255-0.5)/0.5; probability map ->
// threshold 0.3 -> 2x2 dilation -> regions -> min-area box -> mean score
// >= 0.5 -> unclip (ratio 1.6) -> box in source pixels.

import { components, dilate, minAreaRect, orderQuad, planes, pointInPolygon, resizePlane, type Pt, type RGBA } from './imgops';

export type Tensor = { data: Float32Array; dims: number[] };
export type Infer = (input: Float32Array, dims: number[]) => Promise<Tensor>;

export interface DetOptions {
  limitSide?: number;
  thresh?: number;
  boxThresh?: number;
  unclipRatio?: number;
  maxCandidates?: number;
}

export function detPreprocess(img: RGBA, limitSide = 1600): { input: Float32Array; dims: number[]; rw: number; rh: number } {
  const ratio = Math.max(img.w, img.h) > limitSide ? limitSide / Math.max(img.w, img.h) : 1;
  const rh = Math.max(32, Math.round((img.h * ratio) / 32) * 32);
  const rw = Math.max(32, Math.round((img.w * ratio) / 32) * 32);
  const input = new Float32Array(3 * rh * rw);
  planes(img, 'bgr').forEach((p, c) => {
    const r = rw === img.w && rh === img.h ? p : resizePlane(p, img.w, img.h, rw, rh);
    const off = c * rh * rw;
    for (let i = 0; i < rh * rw; i++) input[off + i] = (r[i] / 255 - 0.5) / 0.5;
  });
  return { input, dims: [1, 3, rh, rw], rw, rh };
}

export function dbPostprocess(prob: Float32Array, pw: number, ph: number, srcW: number, srcH: number, o: DetOptions = {}): { quad: Pt[]; score: number }[] {
  const thresh = o.thresh ?? 0.3, boxThresh = o.boxThresh ?? 0.5, unclip = o.unclipRatio ?? 1.6, maxC = o.maxCandidates ?? 1000;
  const bin = new Uint8Array(pw * ph);
  for (let i = 0; i < bin.length; i++) bin[i] = prob[i] > thresh ? 1 : 0;
  // RapidOCR dilates with a 2x2 kernel; a radius-1 box is the nearest symmetric equivalent.
  const mask = dilate({ w: pw, h: ph, data: bin }, 1);
  const { labels, count } = components(mask);
  const pts: Pt[][] = Array.from({ length: count + 1 }, () => []);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const l = labels[y * pw + x];
    if (!l) continue;
    // Boundary pixels only (enough for the hull).
    const i = y * pw + x;
    if (x === 0 || y === 0 || x === pw - 1 || y === ph - 1 || labels[i - 1] !== l || labels[i + 1] !== l || labels[i - pw] !== l || labels[i + pw] !== l) {
      pts[l].push([x, y]); // pixel coordinates, like cv2.findContours
    }
  }
  const out: { quad: Pt[]; score: number }[] = [];
  for (let l = 1; l <= Math.min(count, maxC); l++) {
    if (pts[l].length < 3) continue;
    const r = minAreaRect(pts[l]);
    if (Math.min(r.w, r.h) < 3) continue;
    // Mean probability inside the box (box_score_fast).
    const xs = r.box.map((p) => p[0]), ys = r.box.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(pw - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(ph - 1, Math.ceil(Math.max(...ys)));
    let sum = 0, n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, r.box)) { sum += prob[y * pw + x]; n++; }
    }
    const score = n ? sum / n : 0;
    if (score < boxThresh) continue;
    // Unclip: offset the rectangle outward by area * ratio / perimeter.
    const d = (r.w * r.h * unclip) / (2 * (r.w + r.h));
    if (Math.min(r.w, r.h) + 2 * d < 5) continue;
    const cx = xs.reduce((a, b) => a + b) / 4, cy = ys.reduce((a, b) => a + b) / 4;
    const ux = (r.box[1][0] - r.box[0][0]) / (r.w || 1), uy = (r.box[1][1] - r.box[0][1]) / (r.w || 1);
    const vx = (r.box[3][0] - r.box[0][0]) / (r.h || 1), vy = (r.box[3][1] - r.box[0][1]) / (r.h || 1);
    const hw = r.w / 2 + d, hh = r.h / 2 + d;
    const corners: Pt[] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([a, b]) => [cx + a * ux + b * vx, cy + a * uy + b * vy]);
    const sx = srcW / pw, sy = srcH / ph;
    const quad = orderQuad(corners.map(([x, y]) => [Math.min(srcW, Math.max(0, x * sx)), Math.min(srcH, Math.max(0, y * sy))] as Pt));
    const qw = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
    const qh = Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]);
    if (qw <= 3 || qh <= 3) continue;
    out.push({ quad, score });
  }
  return out;
}

export async function detect(img: RGBA, infer: Infer, o: DetOptions = {}): Promise<{ quad: Pt[]; score: number }[]> {
  const { input, dims, rw, rh } = detPreprocess(img, o.limitSide ?? 1600);
  const res = await infer(input, dims);
  const [, , ph, pw] = res.dims;
  return dbPostprocess(res.data, pw ?? rw, ph ?? rh, img.w, img.h, o);
}
