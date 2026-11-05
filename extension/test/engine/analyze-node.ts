// Runs the browser engine's analysis in Node (ONNX Runtime Web, WASM backend)
// on raw RGBA test images, printing JSON. Used to compare with the Python service.
import * as ort from 'onnxruntime-web';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../../src/engine/pipeline';
import { ArrayRaster } from '../../src/engine/raster';
import { makeRecognizer, type RecModelMeta } from '../../src/engine/recognize';

const [dataDir, modelsDir, threads, recName, ...names] = process.argv.slice(2);
ort.env.wasm.numThreads = Number(threads || 1);

async function session(path: string) {
  const s = await ort.InferenceSession.create(readFileSync(path));
  return async (input: Float32Array, dims: number[]) => {
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, dims) });
    const t = out[s.outputNames[0]];
    return { data: t.data as Float32Array, dims: t.dims as number[] };
  };
}

const t0 = performance.now();
const det = await session(join(modelsDir, 'det/PP-OCRv6_det_small.onnx'));
const meta = JSON.parse(readFileSync(join(modelsDir, `rec/${recName}.json`), 'utf8')) as RecModelMeta;
meta.family ??= 'easyocr';
const rec = makeRecognizer(meta, await session(join(modelsDir, `rec/${recName}.onnx`)));
const loadMs = Math.round(performance.now() - t0);
const results: Record<string, unknown> = {};
for (const name of names) {
  const { w, h } = JSON.parse(readFileSync(join(dataDir, `${name}.size.json`), 'utf8'));
  const raster = new ArrayRaster(w, h, new Uint8ClampedArray(readFileSync(join(dataDir, `${name}.rgba`))));
  const t = performance.now();
  const a = await analyze(raster, 'ko', { detInfer: det, recognizer: rec, encodePng: async () => 'data:image/png;base64,', checkCancel: () => {}, imageKey: name });
  results[name] = { ms: Math.round(performance.now() - t), ...a, regions: a.regions.map((r) => ({ kind: r.kind, bbox: r.bbox, text: r.source_text, conf: r.confidence, mode: r.render_mode, patch: !!r.patch, render_box: r.render_box, flags: r.flags, bubble: r.bubble })) };
}
console.log(JSON.stringify({ loadMs, rssMB: Math.round(process.memoryUsage().rss / 1e6), results }));
