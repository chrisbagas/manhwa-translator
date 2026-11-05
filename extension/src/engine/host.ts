// Built-in engine host. Runs in Chrome's offscreen document or Firefox's
// background page; owns the OCR worker (ONNX Runtime) and the translation
// worker (Mozilla Bergamot WASM), a sequential job queue and an IndexedDB
// cache keyed like the local service (analysis vs. translation settings).

import type { PageResult, SfxMode, TranslateResponse } from '../shared/types';
import { ENGINE_VERSION, translateRegions, translateSegments, type Analysis } from './pipeline';
import { applyGlossary, glossaryKey } from './text';

export interface EngineRequest {
  id: string;
  url?: string;
  dataBase64?: string;
  pageUrl?: string;
  attempt?: number;
  src: string;
  tgt: string;
  sfxMode: SfxMode;
  glossary: Record<string, string>;
}

export interface EngineStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  message: string;
  info?: Record<string, unknown>;
}

const MAX_PIXELS = 60_000_000;
const MAX_BYTES = 40 * 1024 * 1024;
const REC_PREFERENCE = 'auto';
const BERGAMOT_FILES = { model: 'model.koen.intgemm.alphas.bin', lex: 'lex.50.50.koen.s2t.bin', vocab: 'vocab.koen.spm' };

// ---------------------------------------------------------------- cache (IndexedDB)

class Cache {
  private db: Promise<IDBDatabase> | null = null;
  constructor(private max = 400) {}
  private open() {
    this.db ??= new Promise((ok, err) => {
      const r = indexedDB.open('dalbit-engine', 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore('entries');
        s.createIndex('at', 'at');
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => err(r.error);
    });
    return this.db;
  }
  async get<T>(key: string): Promise<T | null> {
    try {
      const db = await this.open();
      return await new Promise((ok) => {
        const q = db.transaction('entries').objectStore('entries').get(key);
        q.onsuccess = () => ok((q.result?.value as T) ?? null);
        q.onerror = () => ok(null);
      });
    } catch {
      return null;
    }
  }
  async put(key: string, value: unknown) {
    try {
      const db = await this.open();
      const tx = db.transaction('entries', 'readwrite');
      const store = tx.objectStore('entries');
      store.put({ value, at: Date.now() }, key);
      const countReq = store.count();
      countReq.onsuccess = () => {
        let extra = countReq.result - this.max;
        if (extra <= 0) return;
        store.index('at').openCursor().onsuccess = (e) => {
          const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (cur && extra-- > 0) { cur.delete(); cur.continue(); }
        };
      };
    } catch {
      /* cache is best-effort */
    }
  }
  async clear() {
    const db = await this.open();
    db.transaction('entries', 'readwrite').objectStore('entries').clear();
  }
}

async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// ---------------------------------------------------------------- host

export class EngineHost {
  private ocr: Worker | null = null;
  private mt: Worker | null = null;
  private seq = 0;
  private pending = new Map<string | number, { ok: (v: any) => void; err: (e: any) => void }>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  private loading: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private cancelled = new Set<string>();
  private cache = new Cache();
  status: EngineStatus = { state: 'idle', message: 'Built-in engine not loaded yet (loads on first use, ~2 s).' };

  constructor(private resolveUrl: (path: string) => string, private fetchImage?: (url: string, pageUrl: string, retry: boolean) => Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; status?: number; error: string }>) {}

  private mtCall(name: string, ...args: unknown[]): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const id = ++this.seq;
    return new Promise((ok, err) => {
      this.pending.set(id, { ok, err });
      this.mt!.postMessage({ id, name, args });
    });
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.status = { state: 'loading', message: 'Loading built-in OCR and translation models…' };
    this.loading = (async () => {
      const t0 = performance.now();
      this.ocr = new Worker(this.resolveUrl('engine-ocr.js'), { type: 'module' });
      this.ocr.onmessage = (e) => this.onOcr(e.data);
      const ocrReady = new Promise<Record<string, unknown>>((ok, err) => this.pending.set('ocr-init', { ok, err }));
      this.ocr.postMessage({ type: 'init', recModel: REC_PREFERENCE });
      this.mt = new Worker(this.resolveUrl('bergamot/translator-worker.js'));
      this.mt.onmessage = (e) => {
        const { id, result, error } = e.data;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (error) p.err(new Error(error.message)); else p.ok(result);
      };
      await this.mtCall('initialize', { cacheSize: 0 });
      const fetchBuf = async (f: string) => (await fetch(this.resolveUrl(`models/bergamot/koen/${f}`))).arrayBuffer();
      const [model, lex, vocab] = await Promise.all([fetchBuf(BERGAMOT_FILES.model), fetchBuf(BERGAMOT_FILES.lex), fetchBuf(BERGAMOT_FILES.vocab)]);
      await this.mtCall('loadTranslationModel', { from: 'ko', to: 'en' }, { model, shortlist: lex, vocabs: [vocab, vocab] });
      const info = await ocrReady;
      this.status = { state: 'ready', message: 'Built-in engine ready (runs entirely in your browser).', info: { ...info, totalLoadMs: Math.round(performance.now() - t0) } };
    })();
    this.loading.catch((e) => {
      this.status = { state: 'error', message: `Built-in engine failed to load: ${e?.message ?? e}` };
      this.ocr?.terminate(); this.mt?.terminate();
      this.ocr = this.mt = null;
      this.loading = null;
    });
    return this.loading;
  }

  private onOcr(m: { type: string; id?: string; info?: Record<string, unknown>; error?: string; code?: string; analysis?: Analysis }) {
    if (m.type === 'ready' || m.type === 'init-error') {
      const p = this.pending.get('ocr-init');
      this.pending.delete('ocr-init');
      if (m.type === 'ready') p?.ok(m.info); else p?.err(new Error(m.error));
      return;
    }
    const p = this.pending.get(`ocr:${m.id}`);
    if (!p) return;
    this.pending.delete(`ocr:${m.id}`);
    if (m.type === 'result') p.ok(m.analysis); else p.err(Object.assign(new Error(m.error), { code: m.code }));
  }

  translateTexts(texts: string[], glossary: Record<string, string>): Promise<string[]> {
    return this.enqueue(async () => {
      await this.load();
      const prepped = texts.map((t) => applyGlossary(t, glossary).text);
      return translateSegments(prepped, (xs) => this.mt_(xs));
    });
  }

  private async mt_(texts: string[]): Promise<string[]> {
    const out = (await this.mtCall('translate', { models: [{ from: 'ko', to: 'en' }], texts: texts.map((text) => ({ text, html: false, qualityScores: false })) })) as { target: { text: string } }[];
    return out.map((r) => r.target.text);
  }

  cancel(ids: string[]) {
    for (const id of ids) {
      this.cancelled.add(id);
      this.ocr?.postMessage({ type: 'cancel', id });
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  process(req: EngineRequest): Promise<TranslateResponse> {
    return this.enqueue(() => this.run(req));
  }

  private async run(req: EngineRequest): Promise<TranslateResponse> {
    const t0 = performance.now();
    if (this.cancelled.delete(req.id)) return { ok: false, code: 'cancelled', error: 'cancelled' };
    if (req.src !== 'ko' || req.tgt !== 'en') {
      return { ok: false, code: 'translation-unavailable', error: `The built-in engine currently supports Korean → English only (asked ${req.src} → ${req.tgt}).` };
    }
    try {
      await this.load();
    } catch (e) {
      return { ok: false, code: 'service-error', error: this.status.message };
    }
    let bytes: ArrayBuffer;
    if (req.dataBase64) bytes = b64ToBuf(req.dataBase64);
    else if (req.url && this.fetchImage) {
      const got = await this.fetchImage(req.url, req.pageUrl ?? '', (req.attempt ?? 1) > 1);
      if (!got.ok) return { ok: false, code: 'fetch-failed', error: got.error, status: got.status };
      bytes = got.bytes;
    } else return { ok: false, code: 'no-source', error: 'no image source' };
    if (bytes.byteLength > MAX_BYTES) return { ok: false, code: 'image-rejected', error: `image larger than ${MAX_BYTES / 1e6} MB` };

    const sha = await sha256Hex(bytes);
    const recName = String(this.status.info?.recognizer ?? 'unknown');
    const akey = await sha256Hex(['analysis', sha, req.src, recName, ENGINE_VERSION].join('|'));
    const rkey = await sha256Hex(['result', akey, 'bergamot-koen-7cb30cbc0a86', req.tgt, glossaryKey(req.glossary), req.sfxMode === 'replace' ? 'annotate' : req.sfxMode].join('|'));
    const cachedResult = await this.cache.get<PageResult>(rkey);
    if (cachedResult) return { ok: true, result: { ...cachedResult, cache: { analysis: true, result: true }, timingsMs: { total: Math.round(performance.now() - t0) } } };

    let analysis = await this.cache.get<Analysis>(akey);
    const analysisHit = !!analysis;
    if (!analysis) {
      try {
        analysis = await new Promise<Analysis>((ok, err) => {
          this.pending.set(`ocr:${req.id}`, { ok, err });
          this.ocr!.postMessage({ type: 'analyze', id: req.id, bytes, src: req.src, imageKey: sha, maxPixels: MAX_PIXELS }, [bytes]);
        });
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err.code === 'cancelled') return { ok: false, code: 'cancelled', error: 'cancelled' };
        if (err.code === 'image-rejected') return { ok: false, code: 'image-rejected', error: err.message };
        return { ok: false, code: 'service-error', error: `engine error: ${err.message}` };
      }
      await this.cache.put(akey, analysis);
    }
    if (this.cancelled.delete(req.id)) return { ok: false, code: 'cancelled', error: 'cancelled' };
    const tTr = performance.now();
    const effSfx: SfxMode = req.sfxMode === 'replace' ? 'annotate' : req.sfxMode;
    let regions;
    try {
      regions = await translateRegions(analysis.regions, req.src, req.glossary, effSfx, (xs) => this.mt_(xs));
    } catch (e) {
      return { ok: false, code: 'translation-unavailable', error: `translation failed: ${(e as Error).message}` };
    }
    const warnings: string[] = [];
    if (req.sfxMode === 'replace') warnings.push('Experimental SFX replacement is not available yet; showing annotations instead.');
    if (analysis.discarded.length) warnings.push(`${analysis.discarded.length} unreadable detection(s) on artwork were not shown.`);
    if (!regions.length) warnings.push('No text was detected in this image.');
    const result: PageResult = {
      imageSha256: sha, width: analysis.width, height: analysis.height, sourceLang: req.src, targetLang: req.tgt, sfxMode: effSfx,
      regions, warnings, models: { engine: `builtin-${ENGINE_VERSION}`, detector: 'PP-OCRv6_det_small', recognizer: recName, translator: 'bergamot koen base-memory' },
      timingsMs: { ...(analysisHit ? {} : analysis.timingsMs), translate: Math.round(performance.now() - tTr), total: Math.round(performance.now() - t0) },
      cache: { analysis: analysisHit, result: false },
    };
    await this.cache.put(rkey, result);
    return { ok: true, result };
  }

  clearCache() {
    return this.cache.clear();
  }
}
