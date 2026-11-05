// Recognise line crops listed in an index.json with Tesseract (tesseract.js, Korean LSTM).
//   node test/engine/tesseract-lines.mjs <index.json> <best|fast>
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { createWorker, OEM, PSM } = require('tesseract.js');
const [indexPath, variant = 'best'] = process.argv.slice(2);
const dataDir = join(dirname(require.resolve('@tesseract.js-data/kor/package.json')), variant === 'best' ? '4.0.0_best_int' : '4.0.0');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
const worker = await createWorker('kor', OEM.LSTM_ONLY, { langPath: dataDir, cacheMethod: 'none', gzip: true });
await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, preserve_interword_spaces: '1' });
const t0 = Date.now();
let n = 0;
for (const rows of Object.values(index)) {
  for (const r of rows) {
    const { data } = await worker.recognize(r.file);
    r[`tess_${variant}`] = data.text.replace(/\s+/g, ' ').trim();
    r[`tess_${variant}_conf`] = data.confidence;
    n++;
  }
}
console.log(`${n} lines in ${Date.now() - t0} ms (${((Date.now() - t0) / n).toFixed(0)} ms/line)`);
await worker.terminate();
writeFileSync(indexPath, JSON.stringify(index, null, 1));
