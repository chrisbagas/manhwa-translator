// Small, dependency-free image operations used by the in-browser engine.
// Mirrors the OpenCV calls in service/dalbit/*.py closely enough that both
// engines make the same decisions (see test/unit/engine-*.test.ts).

export interface RGBA {
  w: number;
  h: number;
  data: Uint8ClampedArray; // RGBA, row-major
}

export interface Mask {
  w: number;
  h: number;
  data: Uint8Array; // 0/1
}

export const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

export function toGray(img: RGBA): Uint8Array {
  const out = new Uint8Array(img.w * img.h);
  const d = img.data;
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = Math.round(lum(d[i], d[i + 1], d[i + 2]));
  return out;
}

/** Bilinear resize of a single-channel float/uint8 plane (cv2.INTER_LINEAR semantics). */
export function resizePlane(src: ArrayLike<number>, w: number, h: number, nw: number, nh: number): Float32Array {
  const out = new Float32Array(nw * nh);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.min(h - 1, Math.floor(fy)), y1 = Math.min(h - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < nw; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      const x0 = Math.min(w - 1, Math.floor(fx)), x1 = Math.min(w - 1, x0 + 1), wx = fx - x0;
      const a = src[y0 * w + x0], b = src[y0 * w + x1], c = src[y1 * w + x0], d = src[y1 * w + x1];
      out[y * nw + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
    }
  }
  return out;
}

/** Area-average downscale (cv2.INTER_AREA for shrinking). Falls back to bilinear when enlarging. */
export function resizePlaneArea(src: ArrayLike<number>, w: number, h: number, nw: number, nh: number): Float32Array {
  if (nw >= w || nh >= h) return resizePlane(src, w, h, nw, nh);
  const out = new Float32Array(nw * nh);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const ya = y * sy, yb = ya + sy;
    for (let x = 0; x < nw; x++) {
      const xa = x * sx, xb = xa + sx;
      let sum = 0, area = 0;
      for (let yy = Math.floor(ya); yy < Math.ceil(yb); yy++) {
        const wy = Math.min(yb, yy + 1) - Math.max(ya, yy);
        for (let xx = Math.floor(xa); xx < Math.ceil(xb); xx++) {
          const wx = Math.min(xb, xx + 1) - Math.max(xa, xx);
          sum += src[yy * w + xx] * wx * wy;
          area += wx * wy;
        }
      }
      out[y * nw + x] = sum / area;
    }
  }
  return out;
}

/** Split RGBA into float planes in the given channel order ("bgr" for Paddle models). */
export function planes(img: RGBA, order: 'rgb' | 'bgr'): [Float32Array, Float32Array, Float32Array] {
  const n = img.w * img.h;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    r[j] = img.data[i];
    g[j] = img.data[i + 1];
    b[j] = img.data[i + 2];
  }
  return order === 'rgb' ? [r, g, b] : [b, g, r];
}

// ---------------------------------------------------------------- geometry

export type Pt = [number, number];

/** Homography mapping the unit rectangle (0..w,0..h) onto a quad. */
function homography(src: Pt[], dst: Pt[]): number[] {
  // Solve for H with dst = H * src (8 unknowns), Gaussian elimination.
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}

/** Perspective-crop a (possibly rotated) quad from an RGBA region to a w x h strip. */
export function warpQuad(src: RGBA, quad: Pt[], outW: number, outH: number): RGBA {
  const H = homography([[0, 0], [outW, 0], [outW, outH], [0, outH]], quad);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const { w, h, data } = src;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const X = x + 0.5, Y = y + 0.5;
      const den = H[6] * X + H[7] * Y + H[8];
      let fx = (H[0] * X + H[1] * Y + H[2]) / den - 0.5;
      let fy = (H[3] * X + H[4] * Y + H[5]) / den - 0.5;
      fx = Math.min(w - 1, Math.max(0, fx));
      fy = Math.min(h - 1, Math.max(0, fy));
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const ax = fx - x0, ay = fy - y0;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = data[(y0 * w + x0) * 4 + c], b = data[(y0 * w + x1) * 4 + c];
        const cc = data[(y1 * w + x0) * 4 + c], d = data[(y1 * w + x1) * 4 + c];
        out[o + c] = (a * (1 - ax) + b * ax) * (1 - ay) + (cc * (1 - ax) + d * ax) * ay;
      }
    }
  }
  return { w: outW, h: outH, data: out };
}

export function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Minimum-area rectangle (rotating calipers over hull edges). Returns 4 corners. */
export function minAreaRect(points: Pt[]): { box: Pt[]; w: number; h: number } {
  const hull = convexHull(points);
  if (hull.length === 1) return { box: [hull[0], hull[0], hull[0], hull[0]], w: 0, h: 0 };
  let best = { area: Infinity, box: [] as Pt[], w: 0, h: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) {
      const corner = (u: number, v: number): Pt => [u * ux - v * uy, u * uy + v * ux];
      best = { area, box: [corner(minU, minV), corner(maxU, minV), corner(maxU, maxV), corner(minU, maxV)], w: maxU - minU, h: maxV - minV };
    }
  }
  return { box: best.box, w: best.w, h: best.h };
}

/** Order 4 points clockwise from top-left (same rule as dalbit.ocr.base.order_quad). */
export function orderQuad(pts: Pt[]): Pt[] {
  const s = pts.map((p) => p[0] + p[1]);
  const d = pts.map((p) => p[1] - p[0]);
  const tl = pts[s.indexOf(Math.min(...s))], br = pts[s.indexOf(Math.max(...s))];
  const tr = pts[d.indexOf(Math.min(...d))], bl = pts[d.indexOf(Math.max(...d))];
  return [tl, tr, br, bl];
}

export function pointInPolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------- masks

/** Binary dilation / erosion with a (2r+1) square kernel (separable, prefix sums).
 *  Like OpenCV's default, pixels outside the image never cause erosion. */
function morph(m: Mask, r: number, dilate: boolean): Mask {
  if (r <= 0) return { w: m.w, h: m.h, data: m.data.slice() };
  const { w, h } = m;
  const pass = (src: Uint8Array, len: number, lines: number, stride: number, step: number): Uint8Array => {
    const out = new Uint8Array(w * h);
    const pre = new Int32Array(len + 1);
    for (let l = 0; l < lines; l++) {
      const base = l * stride;
      for (let k = 0; k < len; k++) pre[k + 1] = pre[k] + src[base + k * step];
      for (let k = 0; k < len; k++) {
        const a = Math.max(0, k - r), b = Math.min(len - 1, k + r);
        const ones = pre[b + 1] - pre[a];
        out[base + k * step] = dilate ? (ones > 0 ? 1 : 0) : (ones === b - a + 1 ? 1 : 0);
      }
    }
    return out;
  };
  const tmp = pass(m.data, w, h, w, 1); // rows
  const out = pass(tmp, h, w, 1, w); // columns
  return { w, h, data: out };
}
export const dilate = (m: Mask, r: number) => morph(m, r, true);
export const erode = (m: Mask, r: number) => morph(m, r, false);

/** 4-connected components. Returns labels (0 = not in mask) and count. */
export function components(m: Mask): { labels: Int32Array; count: number } {
  const { w, h, data } = m;
  const labels = new Int32Array(w * h);
  const stack: number[] = [];
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    if (!data[i] || labels[i]) continue;
    count++;
    labels[i] = count;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p - x) / w;
      if (x > 0 && data[p - 1] && !labels[p - 1]) { labels[p - 1] = count; stack.push(p - 1); }
      if (x < w - 1 && data[p + 1] && !labels[p + 1]) { labels[p + 1] = count; stack.push(p + 1); }
      if (y > 0 && data[p - w] && !labels[p - w]) { labels[p - w] = count; stack.push(p - w); }
      if (y < h - 1 && data[p + w] && !labels[p + w]) { labels[p + w] = count; stack.push(p + w); }
    }
  }
  return { labels, count };
}

/** Fill holes: background regions not connected to the border become foreground. */
export function fillHoles(m: Mask): Mask {
  const inv: Mask = { w: m.w, h: m.h, data: m.data.map((v) => (v ? 0 : 1)) };
  const { labels, count } = components(inv);
  const border = new Uint8Array(count + 1);
  const { w, h } = m;
  for (let x = 0; x < w; x++) { border[labels[x]] = 1; border[labels[(h - 1) * w + x]] = 1; }
  for (let y = 0; y < h; y++) { border[labels[y * w]] = 1; border[labels[y * w + w - 1]] = 1; }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = m.data[i] || (labels[i] && !border[labels[i]]) ? 1 : 0;
  return { w, h, data: out };
}

/** Two-pass chamfer (3-4) distance to the nearest zero pixel, in pixels. */
export function distanceTransform(m: Mask): Float32Array {
  const { w, h, data } = m;
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = data[i] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 3);
    if (y > 0) {
      d[i] = Math.min(d[i], d[i - w] + 3);
      if (x > 0) d[i] = Math.min(d[i], d[i - w - 1] + 4);
      if (x < w - 1) d[i] = Math.min(d[i], d[i - w + 1] + 4);
    }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + 3);
    if (y < h - 1) {
      d[i] = Math.min(d[i], d[i + w] + 3);
      if (x < w - 1) d[i] = Math.min(d[i], d[i + w + 1] + 4);
      if (x > 0) d[i] = Math.min(d[i], d[i + w - 1] + 4);
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

// ---------------------------------------------------------------- statistics

export function percentile(values: ArrayLike<number>, p: number): number {
  const a = Float64Array.from(values).sort();
  if (!a.length) return 0;
  const idx = (p / 100) * (a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

export function medianColor(img: RGBA, select: (i: number) => boolean): [number, number, number] | null {
  const r: number[] = [], g: number[] = [], b: number[] = [];
  const n = img.w * img.h;
  for (let i = 0; i < n; i++) {
    if (!select(i)) continue;
    r.push(img.data[i * 4]); g.push(img.data[i * 4 + 1]); b.push(img.data[i * 4 + 2]);
  }
  if (!r.length) return null;
  return [percentile(r, 50), percentile(g, 50), percentile(b, 50)];
}

export function otsu(gray: Uint8Array): number {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/** Fraction of pixels with a strong Sobel gradient (stand-in for Canny edge density). */
export function edgeDensity(gray: Uint8Array, w: number, h: number, thresh = 120): number {
  if (w < 3 || h < 3) return 0;
  let edges = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
    const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
    if (Math.abs(gx) + Math.abs(gy) > thresh) edges++;
  }
  return edges / (w * h);
}

export const hex = (c: ArrayLike<number>) =>
  '#' + Array.from(c).slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
