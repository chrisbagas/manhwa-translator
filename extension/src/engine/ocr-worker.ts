// Module worker: decodes images, runs detection + recognition + layout with
// ONNX Runtime Web (WASM). No network access: models come from the extension.

import * as ort from 'onnxruntime-web/wasm';
import { createWorker, OEM, PSM, type Worker as TessWorker } from 'tesseract.js';
import { combineReadings, makeLM, parseSpm, type PieceLM } from './lm';
import { analyze, Cancelled, type Analysis } from './pipeline';
import { BitmapRaster } from './raster';
import { makeRecognizer, type RecModelMeta, type Recognizer } from './recognize';
import type { RGBA } from './imgops';

type Req =
  | { type: 'init'; recModel: string }
  | { type: 'analyze'; id: string; bytes: ArrayBuffer; src: string; imageKey: string; maxPixels: number }
  | { type: 'cancel'; id: string };

const base = new URL('./', self.location.href).href;
let ready: Promise<{ det: Infer; rec: Recognizer; info: Record<string, unknown> }> | null = null;
const cancelled = new Set<string>();
let recModelName = 'auto';
type Infer = (input: Float32Array, dims: number[]) => Promise<{ data: Float32Array; dims: number[] }>;

// Second reader: Tesseract's Korean LSTM (full Hangul coverage, weaker on Latin
// and digits). Each line is read by both and the more plausible reading wins.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
async function initTesseract(): Promise<TessWorker> {
  const simd = WebAssembly.validate(SIMD_PROBE);
  const w = await createWorker('kor', OEM.LSTM_ONLY, {
    workerPath: `${base}tess/worker.min.js`,
    corePath: `${base}tess/tesseract-core-${simd ? 'simd-' : ''}lstm.wasm.js`,
    langPath: `${base}tess`,
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false, // extension CSP: no blob: scripts
  });
  await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, preserve_interword_spaces: '1' });
  return w;
}

function withSecondReader(primary: Recognizer, tess: TessWorker, lm: PieceLM): Recognizer {
  return {
    meta: primary.meta,
    async recognize(crop) {
      const a = await primary.recognize(crop);
      const c = new OffscreenCanvas(crop.w, crop.h);
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(crop.data), crop.w, crop.h), 0, 0);
      const { data } = await tess.recognize(c);
      const b = data.text.replace(/\s+/g, ' ').trim();
      const text = combineReadings(lm, a.text, b);
      return { text, confidence: text === a.text ? a.confidence : Math.max(a.confidence, (data.confidence ?? 0) / 100) };
    },
  };
}

async function session(path: string): Promise<Infer> {
  const s = await ort.InferenceSession.create(`${base}${path}`, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return async (input, dims) => {
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, dims) });
    const t = out[s.outputNames[0]];
    const res = { data: t.data as Float32Array, dims: [...t.dims] as number[] };
    t.dispose?.();
    return res;
  };
}

function cer(a: string, b: string): number {
  const x = [...a.replace(/\s/g, '')], y = [...b.replace(/\s/g, '')];
  const d = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= y.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[y.length] / Math.max(1, y.length);
}

async function selfTestImage(): Promise<{ img: RGBA; text: string }> {
  const [png, truth] = await Promise.all([fetch(`${base}selftest/ko_line.png`).then((r) => r.blob()), fetch(`${base}selftest/ko_line.json`).then((r) => r.json())]);
  const bmp = await createImageBitmap(png);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return { img: { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data }, text: truth.text };
}

/** Pick the first recogniser (in preference order) that passes the Korean self-test. */
function init(preference: string) {
  if (ready) return ready;
  recModelName = preference;
  ready = (async () => {
    const t0 = performance.now();
    ort.env.wasm.wasmPaths = `${base}ort/`;
    const isolated = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    ort.env.wasm.numThreads = isolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
    const manifest = (await (await fetch(`${base}models/manifest.json`)).json()) as { recognizers: string[] };
    const order = preference === 'auto' ? manifest.recognizers : [preference, ...manifest.recognizers.filter((r) => r !== preference)];
    const det = await session('models/det/PP-OCRv6_det_small.onnx');
    const test = await selfTestImage();
    let tess: TessWorker | null = null;
    let tessInfo = 'off';
    let lm: PieceLM | null = null;
    try {
      [tess, lm] = await Promise.all([
        initTesseract(),
        fetch(`${base}models/bergamot/koen/vocab.koen.spm`).then(async (r) => makeLM(parseSpm(new Uint8Array(await r.arrayBuffer())))),
      ]);
      tessInfo = 'on';
    } catch (e) {
      tessInfo = `unavailable: ${e instanceof Error ? e.message : JSON.stringify(e) ?? String(e)}`;
    }
    const tried: Record<string, unknown>[] = [];
    for (const name of order) {
      if (!manifest.recognizers.includes(name)) continue;
      const meta = (await (await fetch(`${base}models/rec/${name}.json`)).json()) as RecModelMeta;
      meta.family ??= 'easyocr';
      const infer = await session(`models/rec/${name}.onnx`);
      // PaddleOCR exports differ in input height (48 for v3-v5 mobile, 32 in some ports): try both.
      const heights = meta.family === 'ppocr' ? [meta.imgH ?? 48, 32].filter((h, i, a) => a.indexOf(h) === i) : [meta.imgH ?? 64];
      let best: { rec: Recognizer; err: number; read: string; imgH: number } | null = null;
      for (const h of heights) {
        const base_ = makeRecognizer({ ...meta, imgH: h }, infer);
        const rec = tess && lm ? withSecondReader(base_, tess, lm) : base_;
        try {
          const r = await rec.recognize(test.img);
          const err = cer(r.text, test.text);
          if (!best || err < best.err) best = { rec, err, read: r.text, imgH: h };
        } catch (e) {
          tried.push({ name, imgH: h, error: String((e as Error).message ?? e) });
        }
      }
      if (best) tried.push({ name, imgH: best.imgH, selfTestCER: Math.round(best.err * 1000) / 1000, read: best.read });
      // The verified default is always acceptable; other models must read the test line well.
      if (best && (best.err <= 0.25 || name === 'korean_g2' || order.indexOf(name) === order.length - 1)) {
        recModelName = name;
        return { det, rec: best.rec, info: { threads: ort.env.wasm.numThreads, crossOriginIsolated: isolated, loadMs: Math.round(performance.now() - t0), recognizer: tess ? `${name}+tesseract` : name, secondReader: tessInfo, family: meta.family, selfTest: tried } };
      }
    }
    throw new Error(`no usable recogniser (${JSON.stringify(tried)})`);
  })();
  ready.catch(() => (ready = null));
  return ready;
}

async function encodePng(img: RGBA): Promise<string> {
  const c = new OffscreenCanvas(img.w, img.h);
  c.getContext('2d')!.putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
  const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') { cancelled.add(msg.id); return; }
  if (msg.type === 'init') {
    try {
      const m = await init(msg.recModel);
      postMessage({ type: 'ready', info: m.info });
    } catch (e) {
      postMessage({ type: 'init-error', error: String((e as Error)?.message ?? e) });
    }
    return;
  }
  if (msg.type === 'analyze') {
    let raster: BitmapRaster | null = null;
    try {
      const m = await init(recModelName);
      const bmp = await createImageBitmap(new Blob([msg.bytes]));
      if (bmp.width * bmp.height > msg.maxPixels || bmp.width < 16 || bmp.height < 16) {
        bmp.close();
        throw Object.assign(new Error(`image size ${bmp.width}x${bmp.height} outside limits`), { code: 'image-rejected' });
      }
      raster = new BitmapRaster(bmp);
      const a: Analysis = await analyze(raster, msg.src, {
        detInfer: m.det, recognizer: m.rec, encodePng, imageKey: msg.imageKey,
        checkCancel: () => { if (cancelled.has(msg.id)) throw new Cancelled(); },
      });
      postMessage({ type: 'result', id: msg.id, analysis: a });
    } catch (e) {
      const err = e as Error & { code?: string };
      postMessage({ type: 'error', id: msg.id, code: e instanceof Cancelled ? 'cancelled' : err.code ?? (err.name === 'InvalidStateError' || /decode|source image/i.test(err.message) ? 'image-rejected' : 'engine-error'), error: err.message ?? String(e) });
    } finally {
      raster?.close();
      cancelled.delete(msg.id);
    }
  }
};
