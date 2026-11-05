// Content script controller: discovery -> scheduler -> overlays, scoped to
// the current page. Injected on demand (popup button or keyboard command).

import { ext, loadSettings } from '../shared/browser';
import type { ContentCommand, PageResult, Settings, TranslateResponse } from '../shared/types';
import { ADAPTERS } from './adapters';
import { discover, isPlaceholderSrc, resolveImageUrl } from './discovery';
import { loadFonts } from './fonts';
import { Layer, type Edit } from './overlay';
import { Panel } from './panel';
import { Scheduler, type Job } from './scheduler';

const SERVICE_HINT = 'Start it with:\n  cd service && .venv/bin/python -m dalbit serve\nthen press Resume.';

class Controller {
  settings!: Settings;
  scheduler: Scheduler;
  panel: Panel | null = null;
  layers = new Map<HTMLImageElement, Layer>();
  results = new Map<string, PageResult>(); // url -> result (dedupe identical images)
  showingOriginal = false;
  notes: string[] = [];
  private mo: MutationObserver | null = null;
  private rediscoverTimer = 0;
  private syncQueued = false;
  private scanning = false;
  private started = false;

  constructor() {
    this.scheduler = new Scheduler({
      translate: (job) => this.translate(job),
      cancelRemote: (ids) => void ext.runtime.sendMessage({ type: 'cancel', ids }),
      priority: (job) => this.priority(job),
      onDone: (job) => this.show(job),
      onChange: () => this.updatePanel(),
      concurrency: () => this.settings?.concurrency ?? 2,
    });
  }

  async start() {
    this.settings = await loadSettings();
    if (!this.panel) {
      this.panel = new Panel({
        pauseResume: () => (this.scheduler.paused ? this.resume() : this.scheduler.pause()),
        cancel: () => this.scheduler.cancel(),
        toggle: () => this.toggle(),
        retry: () => this.scheduler.retryFailed(),
        scan: () => void this.scan(),
        close: () => this.closePanel(),
      });
    }
    void loadFonts().then(() => this.layers.forEach((l) => l.render()));
    if (!this.started) {
      this.started = true;
      this.observe();
    }
    this.rediscover();
    if (this.settings.engine === 'builtin') {
      this.message = 'Loading the built-in engine (first time only takes a few seconds)…';
      this.updatePanel();
    }
    const health = (await ext.runtime.sendMessage({ type: 'health', load: true })) as { state: string; message: string };
    if (health?.state !== 'ok') {
      // Do not send anything anywhere; explain how to fix it instead.
      this.scheduler.running = true;
      this.scheduler.pause();
      this.message = `${health?.message ?? 'Local service unavailable.'}${health?.state === 'unreachable' ? `\n${SERVICE_HINT}` : ''}\nNo images were sent anywhere.`;
      this.updatePanel();
      return;
    }
    this.message = null;
    this.scheduler.start();
  }

  message: string | null = null;

  resume() {
    this.message = null;
    // Images that failed only because the service was down get another go.
    for (const j of this.scheduler.jobs) {
      if (j.state === 'failed' && (j.code === 'service-unreachable' || j.code === 'unauthorized')) {
        j.state = 'queued';
        j.error = undefined;
      }
    }
    this.scheduler.resume();
  }

  rediscover() {
    const report = discover(document, { adapters: ADAPTERS });
    for (const c of report.images) {
      const existing = this.scheduler.byElement(c.img);
      if (existing?.url && c.url && existing.url !== c.url && this.stillReferences(c.img, existing.url)) continue;
      if (existing?.url && c.url && existing.url !== c.url) this.dropLayer(c.img); // image content changed
      this.scheduler.upsert(c.img, c.url);
    }
    this.notes = [report.explanation + (report.adapter !== 'generic' ? ` (adapter: ${report.adapter})` : '')];
    this.updatePanel();
  }

  /** True when the element still points at `url` somewhere (lazy attr, srcset, current). */
  private stillReferences(img: HTMLImageElement, url: string) {
    const attrs = Array.from(img.attributes).map((a) => a.value).join(' ');
    const file = url.split('/').pop() ?? url;
    return (img.currentSrc === url) || attrs.includes(url) || (file.length > 8 && attrs.includes(file));
  }

  private observe() {
    this.mo = new MutationObserver((muts) => {
      const relevant = muts.some((m) => {
        const t = m.target as Element;
        if (t.closest?.('[data-dalbit-ui]')) return false;
        if (m.type === 'attributes') return t.tagName === 'IMG' || t.tagName === 'SOURCE';
        return Array.from(m.addedNodes).some((n) => n.nodeType === 1 && ((n as Element).tagName === 'IMG' || (n as Element).querySelector?.('img')))
          || Array.from(m.removedNodes).some((n) => n.nodeType === 1 && !(n as Element).hasAttribute?.('data-dalbit-ui'));
      });
      if (!relevant) return;
      clearTimeout(this.rediscoverTimer);
      this.rediscoverTimer = window.setTimeout(() => {
        this.rediscover();
        for (const l of this.layers.values()) if (!l.host.isConnected && l.img.isConnected) l.attach();
        this.queueSync();
      }, 250);
    });
    this.mo.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src', 'data-srcset', 'data-lazy-src', 'data-original', 'class', 'style'],
    });
    document.addEventListener('load', (e) => {
      if ((e.target as Element)?.tagName === 'IMG') { this.queueSync(); this.scheduleRediscover(); }
    }, true);
    window.addEventListener('scroll', () => { this.queueSync(); }, { passive: true, capture: true });
    window.addEventListener('resize', () => this.queueSync(), { passive: true });
    // Catch layout shifts that move images without resizing them (late ads etc.).
    window.setInterval(() => this.queueSync(), 700);
    ext.storage.onChanged.addListener((changes) => {
      if (!changes.settings) return;
      const prev = this.settings;
      this.settings = { ...prev, ...(changes.settings.newValue as Settings) };
      const s = this.settings;
      if (s.textScale !== prev.textScale || s.minFontPx !== prev.minFontPx) this.layers.forEach((l) => l.render());
      if (s.targetLang !== prev.targetLang || s.sfxMode !== prev.sfxMode || JSON.stringify(s.glossary) !== JSON.stringify(prev.glossary)) {
        this.results.clear();
        this.scheduler.requeueDone(); // OCR is cached by the service; only translation reruns
      }
    });
  }

  private scheduleRediscover() {
    clearTimeout(this.rediscoverTimer);
    this.rediscoverTimer = window.setTimeout(() => this.rediscover(), 250);
  }

  private queueSync() {
    if (this.syncQueued) return;
    this.syncQueued = true;
    requestAnimationFrame(() => {
      this.syncQueued = false;
      const vh = innerHeight;
      for (const l of this.layers.values()) {
        const r = l.img.getBoundingClientRect();
        if (r.bottom > -vh && r.top < 2 * vh) l.sync();
      }
    });
  }

  private priority(job: Job): number {
    if (!job.el.isConnected) return 1e12;
    const r = job.el.getBoundingClientRect();
    const vh = innerHeight;
    if (r.bottom >= 0 && r.top <= vh) return r.top / 1000; // visible: top first
    if (r.top > vh) return r.top - vh; // below: next to read
    return (-r.bottom) * 1.5 + 50; // above: already read
  }

  private async translate(job: Job): Promise<TranslateResponse> {
    const cached = job.url ? this.results.get(job.url) : undefined;
    if (cached) return { ok: true, result: cached };
    const pageUrl = location.href;
    let res: TranslateResponse | null = null;
    if (job.url && /^(https?|data):/i.test(job.url)) {
      res = (await ext.runtime.sendMessage({ type: 'translate-image', id: job.id, url: job.url, pageUrl, attempt: job.attempts })) as TranslateResponse;
      if (res.ok || res.code !== 'fetch-failed') return this.remember(job, res);
    }
    // Fallback: read the pixels the page already has (works for same-origin,
    // CORS-enabled and blob: images; fails explicitly for tainted canvases).
    const page = await this.readFromPage(job);
    if (!page.ok) {
      const prior = res && !res.ok ? `${res.error}; ` : '';
      return { ok: false, code: page.code, error: `${prior}${page.error}` };
    }
    res = (await ext.runtime.sendMessage({ type: 'translate-image', id: job.id, dataBase64: page.b64, mime: page.mime, pageUrl })) as TranslateResponse;
    return this.remember(job, res);
  }

  private remember(job: Job, res: TranslateResponse) {
    if (res.ok && job.url) this.results.set(job.url, res.result);
    if (!res.ok && (res.code === 'service-unreachable' || res.code === 'unauthorized')) {
      this.message = `${res.error}${res.code === 'service-unreachable' ? `\n${SERVICE_HINT}` : ''}`;
    }
    return res;
  }

  private async readFromPage(job: Job): Promise<{ ok: true; b64: string; mime: string } | { ok: false; code: 'cross-origin' | 'fetch-failed' | 'no-source'; error: string }> {
    const img = job.el;
    if (img.complete && img.naturalWidth > 1 && !isPlaceholderSrc(img.currentSrc)) {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d')!.drawImage(img, 0, 0);
        const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/png'));
        c.width = c.height = 0; // release the bitmap
        if (blob) return { ok: true, b64: await blobToB64(blob), mime: 'image/png' };
      } catch {
        /* tainted canvas: try fetching from the page context */
      }
    }
    const url = job.url ?? img.currentSrc;
    if (!url) return { ok: false, code: 'no-source', error: 'image has no loadable source yet (lazy-loaded); scroll to it or use Scan page' };
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) return { ok: false, code: 'fetch-failed', error: `page-context fetch failed with HTTP ${r.status}` };
      const blob = await r.blob();
      return { ok: true, b64: await blobToB64(blob), mime: blob.type || 'application/octet-stream' };
    } catch {
      return { ok: false, code: 'cross-origin', error: 'cross-origin image could not be read (no CORS, canvas tainted). A site adapter or site permission may be needed.' };
    }
  }

  private async show(job: Job) {
    const result = job.result!;
    let layer = this.layers.get(job.el);
    if (layer) layer.destroy();
    layer = new Layer(job.el, result, {
      retranslate: async (text) => {
        const r = (await ext.runtime.sendMessage({ type: 'translate-text', texts: [text] })) as { ok: boolean; translations?: string[]; error?: string };
        if (!r.ok) throw new Error(r.error);
        return r.translations![0];
      },
      saveEdit: (sha, id, edit) => void saveEdit(sha, id, edit),
      textScale: () => this.settings.textScale,
      minFontPx: () => this.settings.minFontPx,
    });
    layer.edits = await loadEdits(result.imageSha256);
    layer.setHidden(this.showingOriginal);
    this.layers.set(job.el, layer);
    layer.sync();
    layer.render();
  }

  private dropLayer(img: HTMLImageElement) {
    this.layers.get(img)?.destroy();
    this.layers.delete(img);
  }

  toggle() {
    this.showingOriginal = !this.showingOriginal;
    this.layers.forEach((l) => l.setHidden(this.showingOriginal));
    this.updatePanel();
  }

  /** Clearly-labelled pass that scrolls through the page to trigger lazy
   *  loading, then restores the reader's exact position. Stops if the user
   *  scrolls or presses a key. */
  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    const sx = scrollX;
    const sy = scrollY;
    let interrupted = false;
    const stop = () => { interrupted = true; };
    const opts = { capture: true, passive: true } as const;
    addEventListener('wheel', stop, opts);
    addEventListener('keydown', stop, opts);
    addEventListener('touchstart', stop, opts);
    this.message = 'Scanning page for lazy-loaded images…';
    this.updatePanel();
    try {
      const step = Math.max(200, innerHeight * 0.9);
      for (let y = 0; y < document.documentElement.scrollHeight && !interrupted; y += step) {
        scrollTo({ left: sx, top: y, behavior: 'instant' as ScrollBehavior });
        await new Promise((r) => setTimeout(r, 200));
      }
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      removeEventListener('wheel', stop, opts);
      removeEventListener('keydown', stop, opts);
      removeEventListener('touchstart', stop, opts);
      if (!interrupted) scrollTo({ left: sx, top: sy, behavior: 'instant' as ScrollBehavior });
      this.scanning = false;
      this.message = interrupted ? 'Scan stopped because you scrolled.' : null;
      this.rediscover();
    }
  }

  closePanel() {
    this.panel?.remove();
    this.panel = null;
  }

  updatePanel() {
    if (!this.panel) return;
    const p = this.scheduler.progress(this.notes, this.showingOriginal);
    let msg = this.message;
    const failed = this.scheduler.jobs.filter((j) => j.state === 'failed');
    if (!msg && failed.length) {
      const reasons = [...new Set(failed.map((j) => j.error ?? j.code))].slice(0, 3);
      msg = `${failed.length} image(s) failed:\n- ${reasons.join('\n- ')}`;
    }
    this.panel.update(p, msg);
    (window as unknown as { __dalbitProgress: unknown }).__dalbitProgress = p;
  }

  status() {
    return this.scheduler.progress(this.notes, this.showingOriginal);
  }
}

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((ok, err) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).split(',', 2)[1] ?? '');
    fr.onerror = () => err(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function loadEdits(sha: string): Promise<Record<string, Edit>> {
  const key = `edits:${sha}`;
  return ((await ext.storage.local.get(key)) as Record<string, Record<string, Edit>>)[key] ?? {};
}

async function saveEdit(sha: string, id: string, edit: Edit) {
  const key = `edits:${sha}`;
  const all = await loadEdits(sha);
  all[id] = edit;
  await ext.storage.local.set({ [key]: all });
}

// Idempotent injection: reuse the controller if the script runs twice.
const w = window as unknown as { __dalbit?: Controller };
if (!w.__dalbit) {
  const c = new Controller();
  w.__dalbit = c;
  ext.runtime.onMessage.addListener((raw: unknown, _s, sendResponse) => {
    const cmd = raw as ContentCommand;
    switch (cmd?.type) {
      case 'start': void c.start().then(() => sendResponse(c.status())); return true;
      case 'toggle': c.toggle(); break;
      case 'pause': c.scheduler.pause(); break;
      case 'resume': c.resume(); break;
      case 'cancel': c.scheduler.cancel(); break;
      case 'retry-failed': c.scheduler.retryFailed(); break;
      case 'scan': void c.scan(); break;
      case 'status': break;
      default: return false;
    }
    sendResponse(c.status());
    return false;
  });
}
export { resolveImageUrl };
