import { readFileSync } from 'node:fs';
import { combineReadings, makeLM, parseSpm } from '../../src/engine/lm';
const lm = makeLM(parseSpm(new Uint8Array(readFileSync('assets/models/bergamot/koen/vocab.koen.spm'))));
const idx = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out: Record<string, string[]> = {};
for (const [k, rows] of Object.entries(idx) as [string, { korean_g2: string; tess_best: string }[]][]) out[k] = rows.map((r) => combineReadings(lm, r.korean_g2, r.tess_best));
console.log(JSON.stringify(out));
