// Builds dist/chrome and dist/firefox from one codebase.
import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const base = JSON.parse(readFileSync(join(root, 'manifests/base.json'), 'utf8'));

const entries = {
  background: 'src/background/index.ts',
  content: 'src/content/index.ts',
  popup: 'src/popup/popup.ts',
  offscreen: 'src/offscreen/offscreen.ts',
};
const MODEL_FILES = [
  'det/PP-OCRv6_det_small.onnx',
  'rec/korean_g2.onnx', 'rec/korean_g2.json',
  'bergamot/koen/model.koen.intgemm.alphas.bin', 'bergamot/koen/lex.50.50.koen.s2t.bin', 'bergamot/koen/vocab.koen.spm',
];
for (const f of MODEL_FILES) {
  if (!existsSync(join(root, 'assets/models', f))) {
    console.error(`missing assets/models/${f}: run \`npm run fetch-models\` first`);
    process.exit(1);
  }
}

for (const target of ['chrome', 'firefox']) {
  const out = join(root, 'dist', target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const manifest = { ...base, ...JSON.parse(readFileSync(join(root, `manifests/${target}.json`), 'utf8')), version: pkg.version };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  cpSync(join(root, 'assets/fonts'), join(out, 'fonts'), { recursive: true });
  cpSync(join(root, 'assets/icons'), join(out, 'icons'), { recursive: true });
  cpSync(join(root, 'src/popup/popup.html'), join(out, 'popup.html'));
  cpSync(join(root, 'src/popup/popup.css'), join(out, 'popup.css'));
  if (target === 'chrome') cpSync(join(root, 'src/offscreen/offscreen.html'), join(out, 'offscreen.html'));
  for (const f of MODEL_FILES) cpSync(join(root, 'assets/models', f), join(out, 'models', f));
  // Optional full-Hangul recogniser (npm run fetch-models -- --ppocr-korean); preferred when it passes the self-test.
  const recognizers = ['korean_g2'];
  if (existsSync(join(root, 'assets/models/rec/korean_PP-OCRv5_rec_mobile.json'))) {
    for (const e of ['onnx', 'json']) cpSync(join(root, `assets/models/rec/korean_PP-OCRv5_rec_mobile.${e}`), join(out, `models/rec/korean_PP-OCRv5_rec_mobile.${e}`));
    recognizers.unshift('korean_PP-OCRv5_rec_mobile');
  }
  // Test hook: DALBIT_EXTRA_REC=<name> adds another assets/models/rec/<name> candidate (first in order).
  const extra = process.env.DALBIT_EXTRA_REC;
  if (extra && existsSync(join(root, `assets/models/rec/${extra}.json`))) {
    for (const e of ['onnx', 'json']) cpSync(join(root, `assets/models/rec/${extra}.${e}`), join(out, `models/rec/${extra}.${e}`));
    recognizers.unshift(extra);
  }
  writeFileSync(join(out, 'models/manifest.json'), JSON.stringify({ recognizers }));
  cpSync(join(root, 'assets/selftest'), join(out, 'selftest'), { recursive: true });
  const ortDist = join(root, 'node_modules/onnxruntime-web/dist');
  for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) cpSync(join(ortDist, f), join(out, 'ort', f));
  const bt = join(root, 'node_modules/@browsermt/bergamot-translator/worker');
  for (const f of ['translator-worker.js', 'bergamot-translator-worker.js', 'bergamot-translator-worker.wasm']) cpSync(join(bt, f), join(out, 'bergamot', f));
  cpSync(join(root, '../LICENSE'), join(out, 'LICENSE'));
  cpSync(join(root, '../THIRD_PARTY_NOTICES.md'), join(out, 'THIRD_PARTY_NOTICES.md'));
  const opts = {
    entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, join(root, v)])),
    outdir: out,
    bundle: true,
    format: 'iife',
    target: target === 'chrome' ? 'chrome116' : 'firefox128',
    sourcemap: false,
    minify: false, // readable output simplifies Mozilla source review
    legalComments: 'inline',
    logLevel: 'warning',
  };
  const entryPoints = Object.fromEntries(Object.entries(entries).filter(([k]) => target === 'chrome' || k !== 'offscreen').map(([k, v]) => [k, join(root, v)]));
  const workerOpts = { ...opts, entryPoints: { 'engine-ocr': join(root, 'src/engine/ocr-worker.ts') }, format: 'esm' };
  if (watch) { await (await context({ ...opts, entryPoints })).watch(); await (await context(workerOpts)).watch(); }
  else { await build({ ...opts, entryPoints }); await build(workerOpts); }
  console.log(`built ${target} -> ${out}`);
}
