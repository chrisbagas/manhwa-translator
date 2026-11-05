// Downloads and verifies the models bundled into the extension's built-in
// engine. Everything is checked against pinned SHA-256 hashes.
//
//   node scripts/fetch-models.mjs                 # required models
//   node scripts/fetch-models.mjs --ppocr-korean  # + PaddleOCR korean_PP-OCRv5 (full Hangul set)
//
// Output: assets/models/ (git-ignored except the exported korean_g2 files).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets/models');
const sha = (b) => createHash('sha256').update(b).digest('hex');

const RAPIDOCR_WHEEL = {
  url: 'https://files.pythonhosted.org/packages/59/07/203065283bba0c5e9c10af3602dc25ab3e59ee54dc2d1d22c8faeabf5ed8/rapidocr-3.10.0-py3-none-any.whl',
  sha256: '2fc34e26cd0f48514804a94f8832283039c7334076bff60768b1fed9ad068050',
  files: {
    // PaddleOCR PP-OCRv6 small text detector (Apache-2.0)
    'rapidocr/models/PP-OCRv6_det_small.onnx': { to: 'det/PP-OCRv6_det_small.onnx', sha256: '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f' },
  },
};
const MOZ = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/models/ko-en/cjk_retrain_base-memory_QgYNtG3BTzKBFSV1wl06Pg/exported';
const BERGAMOT = [
  { url: `${MOZ}/model.koen.intgemm.alphas.bin.gz`, to: 'bergamot/koen/model.koen.intgemm.alphas.bin', sha256: '7cb30cbc0a86e242084756445268a2346136771c92b884d9b4ebb077f67d5507', gz: true },
  { url: `${MOZ}/lex.50.50.koen.s2t.bin.gz`, to: 'bergamot/koen/lex.50.50.koen.s2t.bin', sha256: 'b26291f063ce216a74239275f0485534a38111203e59d42a2a56ba62d6eeb196', gz: true },
  { url: `${MOZ}/vocab.koen.spm.gz`, to: 'bergamot/koen/vocab.koen.spm', sha256: '1c72b740ab793cdc3a8f16913dd6b4e806c77421077dd2d85edeb7be38418598', gz: true },
];
const KOREAN_G2 = { to: 'rec/korean_g2.onnx', sha256: '0a28c6f65f27' }; // prefix; exported by service/scripts/export_recognizer_onnx.py
const PPOCR_KOREAN = {
  url: 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx',
  to: 'rec/korean_PP-OCRv5_rec_mobile.onnx',
  sha256: 'cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b',
};

async function fetchBuf(url) {
  process.stdout.write(`  GET ${url}\n`);
  const r = await fetch(url, { headers: { 'user-agent': 'dalbit-model-fetch/0.2' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

function save(rel, buf, expect) {
  const got = sha(buf);
  if (expect && !got.startsWith(expect)) throw new Error(`checksum mismatch for ${rel}: ${got}`);
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
  console.log(`  ok ${rel} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

const have = (rel, expect) => existsSync(join(OUT, rel)) && sha(readFileSync(join(OUT, rel))).startsWith(expect);

/** Minimal protobuf walk: ModelProto.metadata_props (field 14) key/value strings. */
export function onnxMetadata(buf) {
  const out = {};
  let i = 0;
  const varint = () => {
    let shift = 0n, v = 0n, b;
    do { b = buf[i++]; v |= BigInt(b & 0x7f) << shift; shift += 7n; } while (b & 0x80);
    return Number(v);
  };
  while (i < buf.length) {
    const key = varint();
    const field = key >> 3, wire = key & 7;
    if (wire === 0) { varint(); continue; }
    if (wire === 1) { i += 8; continue; }
    if (wire === 5) { i += 4; continue; }
    if (wire !== 2) throw new Error(`unsupported wire type ${wire}`);
    const len = varint();
    if (field === 14) {
      const end = i + len;
      let k = '', v = '';
      while (i < end) {
        const kk = varint(); const l = varint();
        const s = buf.subarray(i, i + l).toString('utf8'); i += l;
        if ((kk >> 3) === 1) k = s; else if ((kk >> 3) === 2) v = s;
      }
      out[k] = v;
    } else {
      i += len;
    }
  }
  return out;
}

/** Write the PP-OCR character table embedded in the ONNX file as JSON. */
export function writePPOCRMeta(onnxRel, name) {
  const meta = onnxMetadata(readFileSync(join(OUT, onnxRel)));
  if (!meta.character) throw new Error(`${onnxRel} has no embedded character list`);
  const chars = meta.character.split('\n');
  const json = { family: 'ppocr', imgH: 48, characters: ['[blank]', ...chars, ' '], source: name };
  writeFileSync(join(OUT, onnxRel.replace(/\.onnx$/, '.json')), JSON.stringify(json));
  console.log(`  ok ${onnxRel.replace(/\.onnx$/, '.json')} (${chars.length} characters)`);
}

async function main() {
  const args = process.argv.slice(2);
  mkdirSync(OUT, { recursive: true });
  if (!have(KOREAN_G2.to, KOREAN_G2.sha256)) {
    throw new Error('assets/models/rec/korean_g2.onnx missing or modified (it is committed; re-export with service/scripts/export_recognizer_onnx.py)');
  }
  console.log('  ok rec/korean_g2.onnx (committed)');
  const needWheel = Object.values(RAPIDOCR_WHEEL.files).some((f) => !have(f.to, f.sha256));
  if (needWheel) {
    const whl = await fetchBuf(RAPIDOCR_WHEEL.url);
    if (sha(whl) !== RAPIDOCR_WHEEL.sha256) throw new Error('rapidocr wheel checksum mismatch');
    const files = unzipSync(new Uint8Array(whl), { filter: (f) => f.name in RAPIDOCR_WHEEL.files });
    for (const [name, spec] of Object.entries(RAPIDOCR_WHEEL.files)) save(spec.to, Buffer.from(files[name]), spec.sha256);
  } else console.log('  ok det/PP-OCRv6_det_small.onnx (cached)');
  for (const f of BERGAMOT) {
    if (have(f.to, f.sha256)) { console.log(`  ok ${f.to} (cached)`); continue; }
    const buf = await fetchBuf(f.url);
    save(f.to, f.gz ? gunzipSync(buf) : buf, f.sha256);
  }
  if (args.includes('--ppocr-korean')) {
    if (!have(PPOCR_KOREAN.to, PPOCR_KOREAN.sha256)) save(PPOCR_KOREAN.to, await fetchBuf(PPOCR_KOREAN.url), PPOCR_KOREAN.sha256);
    writePPOCRMeta(PPOCR_KOREAN.to, 'PaddleOCR korean_PP-OCRv5_rec_mobile (Apache-2.0) via RapidOCR 3.10 registry');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`fetch-models: ${e.message}`); process.exit(1); });
}
