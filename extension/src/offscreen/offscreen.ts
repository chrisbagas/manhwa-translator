// Chrome only: MV3 service workers cannot start Web Workers, so the built-in
// engine lives in this hidden offscreen document.
import { EngineHost, type EngineRequest } from '../engine/host';

const host = new EngineHost(
  (p) => chrome.runtime.getURL(p),
  async (url, _pageUrl, retry) => {
    // The background sets a session rule that adds the reader page as Referer.
    try {
      const r = await fetch(url, { credentials: 'include', cache: retry ? 'no-cache' : 'default' });
      if (!r.ok) return { ok: false, status: r.status, error: `image request failed with HTTP ${r.status}` };
      return { ok: true, bytes: await r.arrayBuffer() };
    } catch (e) {
      return { ok: false, error: `network error fetching image (${(e as Error).message})` };
    }
  },
);

chrome.runtime.onMessage.addListener((msg: { target?: string; op?: string; req?: EngineRequest; ids?: string[]; texts?: string[]; glossary?: Record<string, string> }, _s, send) => {
  if (msg?.target !== 'engine') return false;
  const run = async () => {
    switch (msg.op) {
      case 'process': return host.process(msg.req!);
      case 'cancel': host.cancel(msg.ids ?? []); return { ok: true };
      case 'translate-text': return { ok: true, translations: await host.translateTexts(msg.texts ?? [], msg.glossary ?? {}) };
      case 'status': return host.status;
      case 'load': await host.load().catch(() => {}); return host.status;
      case 'clear-cache': await host.clearCache(); return { ok: true };
      default: return { ok: false, error: `unknown op ${msg.op}` };
    }
  };
  run().then(send, (e) => send({ ok: false, code: 'service-error', error: String(e?.message ?? e) }));
  return true;
});
