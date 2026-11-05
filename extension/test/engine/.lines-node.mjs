// test/engine/lines-node.ts
import * as ort from "onnxruntime-web";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// src/engine/imgops.ts
function resizePlane(src, w2, h2, nw, nh) {
  const out = new Float32Array(nw * nh);
  const sx = w2 / nw, sy = h2 / nh;
  for (let y = 0; y < nh; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.min(h2 - 1, Math.floor(fy)), y1 = Math.min(h2 - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < nw; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      const x0 = Math.min(w2 - 1, Math.floor(fx)), x1 = Math.min(w2 - 1, x0 + 1), wx = fx - x0;
      const a = src[y0 * w2 + x0], b = src[y0 * w2 + x1], c = src[y1 * w2 + x0], d = src[y1 * w2 + x1];
      out[y * nw + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
    }
  }
  return out;
}
function planes(img, order) {
  const n = img.w * img.h;
  const r2 = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    r2[j] = img.data[i];
    g[j] = img.data[i + 1];
    b[j] = img.data[i + 2];
  }
  return order === "rgb" ? [r2, g, b] : [b, g, r2];
}
function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length === 1) return { box: [hull[0], hull[0], hull[0], hull[0]], w: 0, h: 0 };
  let best = { area: Infinity, box: [], w: 0, h: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) {
      const corner = (u, v) => [u * ux - v * uy, u * uy + v * ux];
      best = { area, box: [corner(minU, minV), corner(maxU, minV), corner(maxU, maxV), corner(minU, maxV)], w: maxU - minU, h: maxV - minV };
    }
  }
  return { box: best.box, w: best.w, h: best.h };
}
function orderQuad(pts) {
  const s2 = pts.map((p) => p[0] + p[1]);
  const d = pts.map((p) => p[1] - p[0]);
  const tl = pts[s2.indexOf(Math.min(...s2))], br = pts[s2.indexOf(Math.max(...s2))];
  const tr = pts[d.indexOf(Math.min(...d))], bl = pts[d.indexOf(Math.max(...d))];
  return [tl, tr, br, bl];
}
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function morph(m, r2, dilate2) {
  if (r2 <= 0) return { w: m.w, h: m.h, data: m.data.slice() };
  const { w: w2, h: h2 } = m;
  const pass = (src, len, lines, stride, step) => {
    const out2 = new Uint8Array(w2 * h2);
    const pre = new Int32Array(len + 1);
    for (let l = 0; l < lines; l++) {
      const base = l * stride;
      for (let k = 0; k < len; k++) pre[k + 1] = pre[k] + src[base + k * step];
      for (let k = 0; k < len; k++) {
        const a = Math.max(0, k - r2), b = Math.min(len - 1, k + r2);
        const ones = pre[b + 1] - pre[a];
        out2[base + k * step] = dilate2 ? ones > 0 ? 1 : 0 : ones === b - a + 1 ? 1 : 0;
      }
    }
    return out2;
  };
  const tmp = pass(m.data, w2, h2, w2, 1);
  const out = pass(tmp, h2, w2, 1, w2);
  return { w: w2, h: h2, data: out };
}
var dilate = (m, r2) => morph(m, r2, true);
var erode = (m, r2) => morph(m, r2, false);
function components(m) {
  const { w: w2, h: h2, data } = m;
  const labels = new Int32Array(w2 * h2);
  const stack = [];
  let count = 0;
  for (let i = 0; i < w2 * h2; i++) {
    if (!data[i] || labels[i]) continue;
    count++;
    labels[i] = count;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      const x = p % w2, y = (p - x) / w2;
      if (x > 0 && data[p - 1] && !labels[p - 1]) {
        labels[p - 1] = count;
        stack.push(p - 1);
      }
      if (x < w2 - 1 && data[p + 1] && !labels[p + 1]) {
        labels[p + 1] = count;
        stack.push(p + 1);
      }
      if (y > 0 && data[p - w2] && !labels[p - w2]) {
        labels[p - w2] = count;
        stack.push(p - w2);
      }
      if (y < h2 - 1 && data[p + w2] && !labels[p + w2]) {
        labels[p + w2] = count;
        stack.push(p + w2);
      }
    }
  }
  return { labels, count };
}
function fillHoles(m) {
  const inv = { w: m.w, h: m.h, data: m.data.map((v) => v ? 0 : 1) };
  const { labels, count } = components(inv);
  const border = new Uint8Array(count + 1);
  const { w: w2, h: h2 } = m;
  for (let x = 0; x < w2; x++) {
    border[labels[x]] = 1;
    border[labels[(h2 - 1) * w2 + x]] = 1;
  }
  for (let y = 0; y < h2; y++) {
    border[labels[y * w2]] = 1;
    border[labels[y * w2 + w2 - 1]] = 1;
  }
  const out = new Uint8Array(w2 * h2);
  for (let i = 0; i < out.length; i++) out[i] = m.data[i] || labels[i] && !border[labels[i]] ? 1 : 0;
  return { w: w2, h: h2, data: out };
}
function percentile(values, p) {
  const a = Float64Array.from(values).sort();
  if (!a.length) return 0;
  const idx = p / 100 * (a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}
function medianColor(img, select) {
  const r2 = [], g = [], b = [];
  const n = img.w * img.h;
  for (let i = 0; i < n; i++) {
    if (!select(i)) continue;
    r2.push(img.data[i * 4]);
    g.push(img.data[i * 4 + 1]);
    b.push(img.data[i * 4 + 2]);
  }
  if (!r2.length) return null;
  return [percentile(r2, 50), percentile(g, 50), percentile(b, 50)];
}
var hex = (c) => "#" + Array.from(c).slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

// src/engine/detect.ts
function detPreprocess(img, limitSide = 1600) {
  const ratio = Math.max(img.w, img.h) > limitSide ? limitSide / Math.max(img.w, img.h) : 1;
  const rh = Math.max(32, Math.round(img.h * ratio / 32) * 32);
  const rw = Math.max(32, Math.round(img.w * ratio / 32) * 32);
  const input = new Float32Array(3 * rh * rw);
  planes(img, "bgr").forEach((p, c) => {
    const r2 = rw === img.w && rh === img.h ? p : resizePlane(p, img.w, img.h, rw, rh);
    const off = c * rh * rw;
    for (let i = 0; i < rh * rw; i++) input[off + i] = (r2[i] / 255 - 0.5) / 0.5;
  });
  return { input, dims: [1, 3, rh, rw], rw, rh };
}
function dbPostprocess(prob, pw, ph, srcW, srcH, o = {}) {
  const thresh = o.thresh ?? 0.3, boxThresh = o.boxThresh ?? 0.5, unclip = o.unclipRatio ?? 1.6, maxC = o.maxCandidates ?? 1e3;
  const bin = new Uint8Array(pw * ph);
  for (let i = 0; i < bin.length; i++) bin[i] = prob[i] > thresh ? 1 : 0;
  const mask = dilate({ w: pw, h: ph, data: bin }, 1);
  const { labels, count } = components(mask);
  const pts = Array.from({ length: count + 1 }, () => []);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const l = labels[y * pw + x];
    if (!l) continue;
    const i = y * pw + x;
    if (x === 0 || y === 0 || x === pw - 1 || y === ph - 1 || labels[i - 1] !== l || labels[i + 1] !== l || labels[i - pw] !== l || labels[i + pw] !== l) {
      pts[l].push([x, y]);
    }
  }
  const out = [];
  for (let l = 1; l <= Math.min(count, maxC); l++) {
    if (pts[l].length < 3) continue;
    const r2 = minAreaRect(pts[l]);
    if (Math.min(r2.w, r2.h) < 3) continue;
    const xs = r2.box.map((p) => p[0]), ys = r2.box.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(pw - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(ph - 1, Math.ceil(Math.max(...ys)));
    let sum = 0, n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, r2.box)) {
        sum += prob[y * pw + x];
        n++;
      }
    }
    const score = n ? sum / n : 0;
    if (score < boxThresh) continue;
    const d = r2.w * r2.h * unclip / (2 * (r2.w + r2.h));
    if (Math.min(r2.w, r2.h) + 2 * d < 5) continue;
    const cx = xs.reduce((a, b) => a + b) / 4, cy = ys.reduce((a, b) => a + b) / 4;
    const ux = (r2.box[1][0] - r2.box[0][0]) / (r2.w || 1), uy = (r2.box[1][1] - r2.box[0][1]) / (r2.w || 1);
    const vx = (r2.box[3][0] - r2.box[0][0]) / (r2.h || 1), vy = (r2.box[3][1] - r2.box[0][1]) / (r2.h || 1);
    const hw = r2.w / 2 + d, hh = r2.h / 2 + d;
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([a, b]) => [cx + a * ux + b * vx, cy + a * uy + b * vy]);
    const sx = srcW / pw, sy = srcH / ph;
    const quad = orderQuad(corners.map(([x, y]) => [Math.min(srcW, Math.max(0, x * sx)), Math.min(srcH, Math.max(0, y * sy))]));
    const qw = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
    const qh = Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]);
    if (qw <= 3 || qh <= 3) continue;
    out.push({ quad, score });
  }
  return out;
}
async function detect(img, infer2, o = {}) {
  const { input, dims, rw, rh } = detPreprocess(img, o.limitSide ?? 1600);
  const res = await infer2(input, dims);
  const [, , ph, pw] = res.dims;
  return dbPostprocess(res.data, pw ?? rw, ph ?? rh, img.w, img.h, o);
}

// src/engine/layout.ts
function lineBox(l) {
  const xs = l.quad.map((p) => p[0]), ys = l.quad.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function quadAngle(q) {
  return -Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180 / Math.PI;
}
var median = (v) => {
  const a = [...v].sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
var clipBox = (x0, y0, x1, y1, w2, h2) => [Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)), Math.min(w2, Math.ceil(x1)), Math.min(h2, Math.ceil(y1))];
function lineContrast(r2, l) {
  const [x0, y0, x1, y1] = lineBox(l);
  return inkContrast(r2.read(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)));
}
function inkContrast(img) {
  const n = img.w * img.h;
  const bg = medianColor(img, () => true);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = maxDiff(img.data, i, bg);
  v.sort();
  return v[Math.floor(0.95 * (n - 1))];
}
var maxDiff = (d, i, c) => Math.max(Math.abs(d[i * 4] - c[0]), Math.abs(d[i * 4 + 1] - c[1]), Math.abs(d[i * 4 + 2] - c[2]));
function findBubble(r2, boxes2, tol = 28) {
  const W = r2.width, H = r2.height;
  const lh = median(boxes2.map((b) => b[3] - b[1]));
  const bx0 = Math.min(...boxes2.map((b) => b[0])), by0 = Math.min(...boxes2.map((b) => b[1]));
  const bx1 = Math.max(...boxes2.map((b) => b[2])), by1 = Math.max(...boxes2.map((b) => b[3]));
  const p = Math.max(3, Math.floor(lh * 0.45));
  const [rx0, ry0, rx1, ry1] = clipBox(bx0 - p, by0 - p, bx1 + p, by1 + p, W, H);
  const ringImg = r2.read(rx0, ry0, rx1 - rx0, ry1 - ry0);
  const inLine = (x, y) => boxes2.some((b) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3]);
  const ringSel = (i) => !inLine(rx0 + i % ringImg.w, ry0 + Math.floor(i / ringImg.w));
  const bg = medianColor(ringImg, ringSel);
  if (!bg) return null;
  let n = 0, near = 0;
  for (let i = 0; i < ringImg.w * ringImg.h; i++) if (ringSel(i)) {
    n++;
    if (maxDiff(ringImg.data, i, bg) < tol) near++;
  }
  if (!n || near / n < 0.85) return null;
  let enclosed = false;
  let comp = null;
  let win = [0, 0, 0, 0];
  for (const grow of [1.2, 3]) {
    const m = Math.max(lh * 2, grow * Math.max(bx1 - bx0, by1 - by0) * 0.5);
    win = clipBox(bx0 - m, by0 - m, bx1 + m, by1 + m, W, H);
    const [x02, y02, x1, y1] = win;
    const sub = r2.read(x02, y02, x1 - x02, y1 - y02);
    const sim = { w: sub.w, h: sub.h, data: new Uint8Array(sub.w * sub.h) };
    for (let i = 0; i < sim.data.length; i++) sim.data[i] = maxDiff(sub.data, i, bg) < tol ? 1 : 0;
    const { labels } = components(sim);
    const counts = /* @__PURE__ */ new Map();
    const pad = Math.max(2, Math.floor(lh * 0.25));
    for (const b of boxes2) {
      const [sx0, sy0, sx1, sy1] = clipBox(b[0] - x02 - pad, b[1] - y02 - pad, b[2] - x02 + pad, b[3] - y02 + pad, sub.w, sub.h);
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
    for (let x = 0; x < sub.w; x++) {
      borderN += 2;
      borderOn += comp.data[x] + comp.data[(sub.h - 1) * sub.w + x];
    }
    for (let y = 0; y < sub.h; y++) {
      borderN += 2;
      borderOn += comp.data[y * sub.w] + comp.data[y * sub.w + sub.w - 1];
    }
    if (borderOn === 0 || borderOn / borderN < 0.02) {
      enclosed = true;
      break;
    }
  }
  if (!comp) return null;
  const [x0, y0] = win;
  const filled = fillHoles(comp);
  let fx0 = Infinity, fy0 = Infinity, fx1 = -1, fy1 = -1, area = 0;
  for (let y = 0; y < filled.h; y++) for (let x = 0; x < filled.w; x++) if (filled.data[y * filled.w + x]) {
    area++;
    fx0 = Math.min(fx0, x);
    fy0 = Math.min(fy0, y);
    fx1 = Math.max(fx1, x);
    fy1 = Math.max(fy1, y);
  }
  if (!area) return null;
  const fb = [fx0 + x0, fy0 + y0, fx1 - fx0 + 1, fy1 - fy0 + 1];
  const fill = area / (fb[2] * fb[3]);
  const shape = !enclosed ? "none" : fill > 0.9 ? "rect" : fill > 0.7 ? "ellipse" : "free";
  const interior = interiorRect(filled, [bx0 - x0, by0 - y0, bx1 - x0, by1 - y0], Math.max(3, Math.floor(lh * 0.25)));
  return {
    bubble: {
      bbox: enclosed ? fb : [Math.floor(bx0), Math.floor(by0), Math.floor(bx1 - bx0), Math.floor(by1 - by0)],
      interior: [interior[0] + x0, interior[1] + y0, interior[2], interior[3]],
      fill: hex(bg),
      flat: true,
      shape
    },
    component: filled,
    window: win,
    bg,
    enclosed
  };
}
function interiorRect(mask, textBox, margin) {
  const inner = erode(mask, margin);
  const W = inner.w, H = inner.h;
  let [x0, y0, x1, y1] = textBox.map(Math.floor);
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(W - 1, x1);
  y1 = Math.min(H - 1, y1);
  if (x1 <= x0 || y1 <= y0) return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
  const step = Math.max(1, Math.floor((y1 - y0) / 20));
  const col = (x, a, b) => {
    for (let y = a; y <= b; y++) if (!inner.data[y * W + x]) return false;
    return true;
  };
  const row = (y, a, b) => {
    for (let x = a; x <= b; x++) if (!inner.data[y * W + x]) return false;
    return true;
  };
  for (let grew = true; grew; ) {
    grew = false;
    if (x0 - step >= 0 && col(x0 - step, y0, y1)) {
      x0 -= step;
      grew = true;
    }
    if (x1 + step < W && col(x1 + step, y0, y1)) {
      x1 += step;
      grew = true;
    }
    if (y0 - step >= 0 && row(y0 - step, x0, x1)) {
      y0 -= step;
      grew = true;
    }
    if (y1 + step < H && row(y1 + step, x0, x1)) {
      y1 += step;
      grew = true;
    }
  }
  return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

// src/engine/raster.ts
var ArrayRaster = class {
  constructor(width, height, data) {
    this.width = width;
    this.height = height;
    this.data = data;
  }
  read(x, y, w2, h2) {
    x = Math.max(0, Math.floor(x));
    y = Math.max(0, Math.floor(y));
    w2 = Math.max(1, Math.min(this.width - x, Math.ceil(w2)));
    h2 = Math.max(1, Math.min(this.height - y, Math.ceil(h2)));
    const out = new Uint8ClampedArray(w2 * h2 * 4);
    for (let r2 = 0; r2 < h2; r2++) out.set(this.data.subarray(((y + r2) * this.width + x) * 4, ((y + r2) * this.width + x + w2) * 4), r2 * w2 * 4);
    return { w: w2, h: h2, data: out };
  }
};

// test/engine/lines-node.ts
var [dataDir, modelsDir, name] = process.argv.slice(2);
var s = await ort.InferenceSession.create(readFileSync(join(modelsDir, "det/PP-OCRv6_det_small.onnx")));
var infer = async (input, dims) => {
  const o = (await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", input, dims) }))[s.outputNames[0]];
  return { data: o.data, dims: o.dims };
};
var { w, h } = JSON.parse(readFileSync(join(dataDir, `${name}.size.json`), "utf8"));
var r = new ArrayRaster(w, h, new Uint8ClampedArray(readFileSync(join(dataDir, `${name}.rgba`))));
var boxes = await detect(r.read(0, 0, w, h), infer);
for (const b of boxes) {
  const line = { quad: b.quad, text: "", confidence: 1, det_score: b.score, angle: quadAngle(b.quad) };
  const bb = lineBox(line).map(Math.round);
  const info = findBubble(r, [lineBox(line)]);
  console.log(bb, "contrast", Math.round(lineContrast(r, line)), info ? { enclosed: info.enclosed, bbox: info.bubble.bbox, shape: info.bubble.shape } : "not flat");
}
