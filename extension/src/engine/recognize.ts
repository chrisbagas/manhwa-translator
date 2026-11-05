// Line recognition (CTC) for two model families:
//   "easyocr": EasyOCR korean_g2 exported to ONNX - grey, height 64, right
//              replicate-pad to a multiple of 64, softmax + ignore mask,
//              custom_mean confidence, second pass with contrast boost.
//   "ppocr":   PaddleOCR recognisers (e.g. korean_PP-OCRv5_rec_mobile) - BGR,
//              height 48, zero-pad, mean confidence.
// Mirrors service/dalbit/ocr/onnx_rec.py and RapidOCR's ch_ppocr_rec.

import type { Infer } from './detect';
import { percentile, planes, resizePlane, resizePlaneArea, toGray, type RGBA } from './imgops';

export interface RecModelMeta {
  family: 'easyocr' | 'ppocr';
  imgH: number;
  characters: string[]; // index 0 = CTC blank
  ignore_idx?: number[];
}

export interface Recognizer {
  meta: RecModelMeta;
  recognize(crop: RGBA): Promise<{ text: string; confidence: number }>;
}

function contrastBoost(g: Uint8Array): Uint8Array {
  const high = percentile(g, 90), low = percentile(g, 10);
  const contrast = (high - low) / Math.max(10, high + low);
  if (contrast >= 0.5) return g;
  const ratio = 200 / Math.max(10, high - low);
  return g.map((v) => Math.max(0, Math.min(255, (v - low + 25) * ratio)));
}

export function easyocrInput(crop: RGBA, imgH = 64, contrast = false): { input: Float32Array; dims: number[] } {
  let g = toGray(crop);
  if (contrast) g = contrastBoost(g);
  const nw = Math.max(1, Math.ceil((imgH * crop.w) / Math.max(1, crop.h)));
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

export function ppocrInput(crop: RGBA, imgH = 48, minW = 320): { input: Float32Array; dims: number[] } {
  const ratio = crop.w / Math.max(1, crop.h);
  const imgW = Math.max(minW, Math.ceil(imgH * ratio));
  const rw = Math.min(imgW, Math.max(1, Math.ceil(imgH * ratio)));
  const input = new Float32Array(3 * imgH * imgW); // zero padded
  planes(crop, 'bgr').forEach((p, c) => {
    const r = resizePlane(p, crop.w, crop.h, rw, imgH);
    for (let y = 0; y < imgH; y++) for (let x = 0; x < rw; x++) input[c * imgH * imgW + y * imgW + x] = (r[y * rw + x] / 255 - 0.5) / 0.5;
  });
  return { input, dims: [1, 3, imgH, imgW] };
}

/** CTC greedy decode. `probsAreLogits`: apply softmax first. */
export function ctcDecode(data: Float32Array, steps: number, classes: number, meta: RecModelMeta, probsAreLogits: boolean): { text: string; confidence: number } {
  const ignore = new Set(meta.ignore_idx ?? []);
  let prev = -1;
  const chars: string[] = [];
  const maxps: number[] = [];
  const row = new Float64Array(classes);
  for (let t = 0; t < steps; t++) {
    const off = t * classes;
    let sum = 0;
    if (probsAreLogits) {
      let m = -Infinity;
      for (let c = 0; c < classes; c++) m = Math.max(m, data[off + c]);
      for (let c = 0; c < classes; c++) { row[c] = Math.exp(data[off + c] - m); sum += row[c]; }
    } else {
      for (let c = 0; c < classes; c++) { row[c] = data[off + c]; sum += row[c]; }
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
    if (best !== prev && best !== 0 && !ignore.has(best)) chars.push(meta.characters[best] ?? '');
    prev = best;
  }
  let confidence = 0;
  if (maxps.length) {
    if (meta.family === 'easyocr') {
      // custom_mean: prod(p) ** (2 / sqrt(n)), computed in log space.
      const logSum = maxps.reduce((a, p) => a + Math.log(Math.max(p, 1e-12)), 0);
      confidence = Math.exp(logSum * (2 / Math.sqrt(maxps.length)));
    } else {
      confidence = maxps.reduce((a, b) => a + b, 0) / maxps.length;
    }
  }
  return { text: chars.join(''), confidence };
}

export function makeRecognizer(meta: RecModelMeta, infer: Infer): Recognizer {
  const run = async (crop: RGBA, contrast: boolean) => {
    const { input, dims } = meta.family === 'easyocr' ? easyocrInput(crop, meta.imgH, contrast) : ppocrInput(crop, meta.imgH);
    const out = await infer(input, dims);
    const [, steps, classes] = out.dims;
    // PP-OCR models end in softmax already; EasyOCR outputs logits.
    return ctcDecode(out.data, steps, classes, meta, meta.family === 'easyocr');
  };
  return {
    meta,
    async recognize(crop) {
      let r = await run(crop, false);
      if (meta.family === 'easyocr' && r.confidence < 0.1) {
        const r2 = await run(crop, true);
        if (r2.confidence > r.confidence) r = r2;
      }
      return r;
    },
  };
}
