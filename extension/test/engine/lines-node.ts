// Print detected line boxes + bubble info for an image (debugging grouping).
import * as ort from 'onnxruntime-web';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detect } from '../../src/engine/detect';
import * as L from '../../src/engine/layout';
import { ArrayRaster } from '../../src/engine/raster';
const [dataDir, modelsDir, name] = process.argv.slice(2);
const s = await ort.InferenceSession.create(readFileSync(join(modelsDir, 'det/PP-OCRv6_det_small.onnx')));
const infer = async (input: Float32Array, dims: number[]) => { const o = (await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, dims) }))[s.outputNames[0]]; return { data: o.data as Float32Array, dims: o.dims as number[] }; };
const { w, h } = JSON.parse(readFileSync(join(dataDir, `${name}.size.json`), 'utf8'));
const r = new ArrayRaster(w, h, new Uint8ClampedArray(readFileSync(join(dataDir, `${name}.rgba`))));
const boxes = await detect(r.read(0, 0, w, h), infer);
for (const b of boxes) {
  const line = { quad: b.quad, text: '', confidence: 1, det_score: b.score, angle: L.quadAngle(b.quad) };
  const bb = L.lineBox(line).map(Math.round);
  const info = L.findBubble(r, [L.lineBox(line)]);
  console.log(bb, 'contrast', Math.round(L.lineContrast(r, line)), info ? { enclosed: info.enclosed, bbox: info.bubble.bbox, shape: info.bubble.shape } : 'not flat');
}
