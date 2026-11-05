// Recognise whole images as single lines with a given recogniser (Node, ORT WASM).
import * as ort from 'onnxruntime-web';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRecognizer, type RecModelMeta } from '../../src/engine/recognize';
const [dataDir, modelsDir, recName, ...names] = process.argv.slice(2);
const s = await ort.InferenceSession.create(readFileSync(join(modelsDir, `rec/${recName}.onnx`)));
const infer = async (input: Float32Array, dims: number[]) => {
  const o = (await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, dims) }))[s.outputNames[0]];
  return { data: o.data as Float32Array, dims: o.dims as number[] };
};
const rec = makeRecognizer(JSON.parse(readFileSync(join(modelsDir, `rec/${recName}.json`), 'utf8')) as RecModelMeta, infer);
const out: Record<string, unknown> = {};
for (const n of names) {
  const { w, h } = JSON.parse(readFileSync(join(dataDir, `${n}.size.json`), 'utf8'));
  const r = await rec.recognize({ w, h, data: new Uint8ClampedArray(readFileSync(join(dataDir, `${n}.rgba`))) });
  out[n] = [r.text, Math.round(r.confidence * 1000) / 1000];
}
console.log(JSON.stringify(out));
