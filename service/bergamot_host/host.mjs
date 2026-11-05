// Dalbit Bergamot host.
//
// Runs Mozilla's Bergamot translation engine (Marian NMT compiled to WASM,
// MPL-2.0) inside Node and exposes it to the Python service over a tiny
// JSON-lines protocol on stdin/stdout. Nothing here touches the network.
//
//   request:  {"id": 1, "op": "translate", "from": "ko", "to": "en", "texts": ["..."]}
//   response: {"id": 1, "ok": true, "result": ["..."]}
//
// Usage: node host.mjs <models-dir>
//   <models-dir>/<src><tgt>/ holds model.*.intgemm.alphas.bin, lex.*.s2t.bin and
//   vocab.*.spm (or srcvocab.*.spm + trgvocab.*.spm), as published by Mozilla.

import { Worker } from 'node:worker_threads';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as readline from 'node:readline';

const modelsDir = process.argv[2];
if (!modelsDir) {
  process.stderr.write('usage: node host.mjs <models-dir>\n');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const workerPath = join(
  dirname(require.resolve('@browsermt/bergamot-translator/package.json')),
  'worker',
  'translator-worker.js',
);

// The upstream worker script is written as a classic (CommonJS-style) script
// but ships inside a "type": "module" package, so load it in eval mode with
// the CommonJS globals it expects.
const workerSource =
  `const __filename = ${JSON.stringify(workerPath)};\n` +
  `const __dirname = ${JSON.stringify(dirname(workerPath))};\n` +
  readFileSync(workerPath, 'utf8');

const worker = new Worker(workerSource, { eval: true });
let nextCallId = 0;
const pendingCalls = new Map();
worker.on('message', ({ id, result, error }) => {
  const p = pendingCalls.get(id);
  if (!p) return;
  pendingCalls.delete(id);
  if (error) p.reject(Object.assign(new Error(error.message), error));
  else p.resolve(result);
});
worker.on('error', (err) => {
  process.stderr.write(`bergamot worker crashed: ${err.stack || err}\n`);
  process.exit(1);
});

function call(name, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++nextCallId;
    pendingCalls.set(id, { resolve, reject });
    worker.postMessage({ id, name, args });
  });
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function findFile(dir, predicate, label) {
  const name = readdirSync(dir).find(predicate);
  if (!name) throw new Error(`missing ${label} in ${dir}`);
  return join(dir, name);
}

const loadedPairs = new Map(); // "koen" -> Promise<void>
let initialized = null;

function ensureInitialized() {
  if (!initialized) initialized = call('initialize', { cacheSize: 0 });
  return initialized;
}

function ensurePair(from, to) {
  const pair = `${from}${to}`;
  if (!/^[a-z]{2,3}[a-z]{2,3}$/.test(pair)) throw new Error(`invalid language pair ${pair}`);
  if (!loadedPairs.has(pair)) {
    const promise = (async () => {
      await ensureInitialized();
      const dir = join(modelsDir, pair);
      if (!existsSync(dir)) throw new Error(`no Bergamot model for ${from}->${to} in ${dir}`);
      const model = findFile(dir, (n) => n.startsWith('model.') && n.endsWith('.bin'), 'model');
      const lex = findFile(dir, (n) => n.startsWith('lex.') && n.endsWith('.bin'), 'shortlist');
      const names = readdirSync(dir);
      let vocabs;
      if (names.some((n) => n.startsWith('srcvocab.'))) {
        vocabs = [
          toArrayBuffer(readFileSync(findFile(dir, (n) => n.startsWith('srcvocab.') && n.endsWith('.spm'), 'srcvocab'))),
          toArrayBuffer(readFileSync(findFile(dir, (n) => n.startsWith('trgvocab.') && n.endsWith('.spm'), 'trgvocab'))),
        ];
      } else {
        const v = toArrayBuffer(readFileSync(findFile(dir, (n) => n.startsWith('vocab.') && n.endsWith('.spm'), 'vocab')));
        vocabs = [v, v];
      }
      await call(
        'loadTranslationModel',
        { from, to },
        { model: toArrayBuffer(readFileSync(model)), shortlist: toArrayBuffer(readFileSync(lex)), vocabs },
      );
    })();
    promise.catch(() => loadedPairs.delete(pair));
    loadedPairs.set(pair, promise);
  }
  return loadedPairs.get(pair);
}

async function handle(req) {
  switch (req.op) {
    case 'ping':
      return 'pong';
    case 'load':
      await ensurePair(req.from, req.to);
      return true;
    case 'translate': {
      if (!Array.isArray(req.texts) || req.texts.some((t) => typeof t !== 'string')) {
        throw new Error('texts must be an array of strings');
      }
      await ensurePair(req.from, req.to);
      if (req.texts.length === 0) return [];
      const out = await call('translate', {
        models: [{ from: req.from, to: req.to }],
        texts: req.texts.map((text) => ({ text, html: false, qualityScores: false })),
      });
      return out.map((r) => r.target.text);
    }
    default:
      throw new Error(`unknown op ${req.op}`);
  }
}

// Requests are processed strictly in order; the WASM engine is single threaded.
let queue = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ id: null, ok: false, error: 'invalid JSON' }) + '\n');
    return;
  }
  queue = queue.then(async () => {
    try {
      const result = await handle(req);
      process.stdout.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: String(err && err.message ? err.message : err) }) + '\n');
    }
  });
});
rl.on('close', () => {
  queue.then(() => process.exit(0));
});
