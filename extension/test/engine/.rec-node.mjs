// test/engine/rec-node.ts
import * as ort from "onnxruntime-web";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// src/engine/imgops.ts
var lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
function toGray(img) {
  const out2 = new Uint8Array(img.w * img.h);
  const d = img.data;
  for (let i = 0, j = 0; j < out2.length; i += 4, j++) out2[j] = Math.round(lum(d[i], d[i + 1], d[i + 2]));
  return out2;
}
function resizePlane(src, w, h, nw, nh) {
  const out2 = new Float32Array(nw * nh);
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
      out2[y * nw + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
    }
  }
  return out2;
}
function resizePlaneArea(src, w, h, nw, nh) {
  if (nw >= w || nh >= h) return resizePlane(src, w, h, nw, nh);
  const out2 = new Float32Array(nw * nh);
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
      out2[y * nw + x] = sum / area;
    }
  }
  return out2;
}
function planes(img, order) {
  const n = img.w * img.h;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    r[j] = img.data[i];
    g[j] = img.data[i + 1];
    b[j] = img.data[i + 2];
  }
  return order === "rgb" ? [r, g, b] : [b, g, r];
}
function percentile(values, p) {
  const a = Float64Array.from(values).sort();
  if (!a.length) return 0;
  const idx = p / 100 * (a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

// src/engine/recognize.ts
function contrastBoost(g) {
  const high = percentile(g, 90), low = percentile(g, 10);
  const contrast = (high - low) / Math.max(10, high + low);
  if (contrast >= 0.5) return g;
  const ratio = 200 / Math.max(10, high - low);
  return g.map((v) => Math.max(0, Math.min(255, (v - low + 25) * ratio)));
}
function easyocrInput(crop, imgH = 64, contrast = false) {
  let g = toGray(crop);
  if (contrast) g = contrastBoost(g);
  const nw = Math.max(1, Math.ceil(imgH * crop.w / Math.max(1, crop.h)));
  const r = crop.h > imgH ? resizePlaneArea(g, crop.w, crop.h, nw, imgH) : resizePlane(g, crop.w, crop.h, nw, imgH);
  const padW = Math.max(1, Math.ceil(nw / imgH)) * imgH;
  const input = new Float32Array(imgH * padW);
  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < padW; x++) {
      const v = r[y * nw + Math.min(x, nw - 1)];
      input[y * padW + x] = (v / 255 - 0.5) / 0.5;
    }
  }
  return { input, dims: [1, 1, imgH, padW] };
}
function ppocrInput(crop, imgH = 48, minW = 320) {
  const ratio = crop.w / Math.max(1, crop.h);
  const imgW = Math.max(minW, Math.ceil(imgH * ratio));
  const rw = Math.min(imgW, Math.max(1, Math.ceil(imgH * ratio)));
  const input = new Float32Array(3 * imgH * imgW);
  planes(crop, "bgr").forEach((p, c) => {
    const r = resizePlane(p, crop.w, crop.h, rw, imgH);
    for (let y = 0; y < imgH; y++) for (let x = 0; x < rw; x++) input[c * imgH * imgW + y * imgW + x] = (r[y * rw + x] / 255 - 0.5) / 0.5;
  });
  return { input, dims: [1, 3, imgH, imgW] };
}
function ctcDecode(data, steps, classes, meta, probsAreLogits) {
  const ignore = new Set(meta.ignore_idx ?? []);
  let prev = -1;
  const chars = [];
  const maxps = [];
  const row = new Float64Array(classes);
  for (let t = 0; t < steps; t++) {
    const off = t * classes;
    let sum = 0;
    if (probsAreLogits) {
      let m = -Infinity;
      for (let c = 0; c < classes; c++) m = Math.max(m, data[off + c]);
      for (let c = 0; c < classes; c++) {
        row[c] = Math.exp(data[off + c] - m);
        sum += row[c];
      }
    } else {
      for (let c = 0; c < classes; c++) {
        row[c] = data[off + c];
        sum += row[c];
      }
    }
    for (let c = 0; c < classes; c++) row[c] /= sum;
    if (ignore.size) {
      let s2 = 0;
      for (const c of ignore) row[c] = 0;
      for (let c = 0; c < classes; c++) s2 += row[c];
      for (let c = 0; c < classes; c++) row[c] /= s2;
    }
    let best = 0;
    for (let c = 1; c < classes; c++) if (row[c] > row[best]) best = c;
    if (best !== 0) maxps.push(row[best]);
    if (best !== prev && best !== 0 && !ignore.has(best)) chars.push(meta.characters[best] ?? "");
    prev = best;
  }
  let confidence = 0;
  if (maxps.length) {
    if (meta.family === "easyocr") {
      const logSum = maxps.reduce((a, p) => a + Math.log(Math.max(p, 1e-12)), 0);
      confidence = Math.exp(logSum * (2 / Math.sqrt(maxps.length)));
    } else {
      confidence = maxps.reduce((a, b) => a + b, 0) / maxps.length;
    }
  }
  return { text: chars.join(""), confidence };
}
function makeRecognizer(meta, infer2) {
  const run = async (crop, contrast) => {
    const { input, dims } = meta.family === "easyocr" ? easyocrInput(crop, meta.imgH, contrast) : ppocrInput(crop, meta.imgH);
    const out2 = await infer2(input, dims);
    const [, steps, classes] = out2.dims;
    return ctcDecode(out2.data, steps, classes, meta, meta.family === "easyocr");
  };
  return {
    meta,
    async recognize(crop) {
      let r = await run(crop, false);
      if (meta.family === "easyocr" && r.confidence < 0.1) {
        const r2 = await run(crop, true);
        if (r2.confidence > r.confidence) r = r2;
      }
      return r;
    }
  };
}

// test/engine/rec-node.ts
var [dataDir, modelsDir, recName, ...names] = process.argv.slice(2);
var s = await ort.InferenceSession.create(readFileSync(join(modelsDir, `rec/${recName}.onnx`)));
var infer = async (input, dims) => {
  const o = (await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", input, dims) }))[s.outputNames[0]];
  return { data: o.data, dims: o.dims };
};
var rec = makeRecognizer(JSON.parse(readFileSync(join(modelsDir, `rec/${recName}.json`), "utf8")), infer);
var out = {};
for (const n of names) {
  const { w, h } = JSON.parse(readFileSync(join(dataDir, `${n}.size.json`), "utf8"));
  const r = await rec.recognize({ w, h, data: new Uint8ClampedArray(readFileSync(join(dataDir, `${n}.rgba`))) });
  out[n] = [r.text, Math.round(r.confidence * 1e3) / 1e3];
}
console.log(JSON.stringify(out));
