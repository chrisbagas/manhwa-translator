// Bridge from the background to the built-in engine.
//  Chrome: service worker -> offscreen document (Web Workers are not available in SWs).
//  Firefox: the background page can start workers itself, so the host runs here.

import { ext } from '../shared/browser';
import type { HealthInfo, Settings, TranslateResponse } from '../shared/types';
import type { EngineHost, EngineRequest, EngineStatus } from '../engine/host';
import { fetchImage, withReferer } from './acquire';

const inServiceWorker = typeof document === 'undefined';
let localHost: Promise<EngineHost> | null = null;
let offscreenReady: Promise<void> | null = null;

function getLocalHost(): Promise<EngineHost> {
  localHost ??= import('../engine/host').then(({ EngineHost }) => new EngineHost(
    (p) => ext.runtime.getURL(p),
    async (url, pageUrl, retry) => {
      const got = await fetchImage(url, pageUrl, new AbortController().signal, retry);
      return got.ok ? { ok: true, bytes: got.bytes } : got;
    },
  ));
  return localHost;
}

async function ensureOffscreen(): Promise<void> {
  offscreenReady ??= (async () => {
    const c = chrome as typeof chrome & { runtime: { getContexts?: (f: object) => Promise<unknown[]> } };
    const existing = (await c.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] })) ?? [];
    if (!existing.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Run the local OCR and translation models in Web Workers.',
      });
    }
  })();
  offscreenReady.catch(() => (offscreenReady = null));
  return offscreenReady;
}

async function call<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!inServiceWorker) {
    const h = await getLocalHost();
    switch (op) {
      case 'process': return (await h.process(payload.req as EngineRequest)) as T;
      case 'cancel': h.cancel(payload.ids as string[]); return { ok: true } as T;
      case 'translate-text': return { ok: true, translations: await h.translateTexts(payload.texts as string[], payload.glossary as Record<string, string>) } as T;
      case 'load': await h.load().catch(() => {}); return h.status as T;
      default: return h.status as T;
    }
  }
  await ensureOffscreen();
  return (await chrome.runtime.sendMessage({ target: 'engine', op, ...payload })) as T;
}

export async function engineProcess(s: Settings, msg: { id: string; url?: string; dataBase64?: string; pageUrl: string; attempt?: number }): Promise<TranslateResponse> {
  const req: EngineRequest = { id: msg.id, url: msg.url, dataBase64: msg.dataBase64, pageUrl: msg.pageUrl, attempt: msg.attempt,
    src: s.sourceLang, tgt: s.targetLang, sfxMode: s.sfxMode, glossary: s.glossary };
  const run = () => call<TranslateResponse>('process', { req });
  try {
    // In Chrome the offscreen document fetches the image; give it the reader's Referer.
    return inServiceWorker && msg.url ? await withReferer(msg.url, msg.pageUrl, run) : await run();
  } catch (e) {
    return { ok: false, code: 'service-error', error: `built-in engine unavailable: ${(e as Error).message}` };
  }
}

export const engineCancel = (ids: string[]) => call('cancel', { ids }).catch(() => {});
export const engineTranslateTexts = (texts: string[], glossary: Record<string, string>) =>
  call<{ ok: boolean; translations?: string[]; error?: string }>('translate-text', { texts, glossary });

export async function engineHealth(load = false): Promise<HealthInfo> {
  try {
    const st = await call<EngineStatus>(load ? 'load' : 'status');
    if (st.state === 'error') return { state: 'error', engine: 'builtin', message: st.message };
    return { state: 'ok', engine: 'builtin', message: st.message, targets: ['en'], detail: st.info };
  } catch (e) {
    return { state: 'error', engine: 'builtin', message: `Built-in engine could not start: ${(e as Error).message}` };
  }
}
