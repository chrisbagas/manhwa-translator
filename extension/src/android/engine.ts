// Android app: the built-in engine runs in a hidden WebView that loads this page
// from the app's own assets (https://appassets.androidplatform.net/...), served
// with COOP/COEP headers so ONNX Runtime can use threads.
//
// Native -> JS:  window.__engine.handle({id, op, ...})
// JS -> native:  DalbitEngineNative.postMessage(JSON.stringify({id, result}))

import { EngineHost, type EngineRequest } from '../engine/host';

declare global {
  interface Window {
    DalbitEngineNative?: { postMessage(json: string): void };
    __engine?: { handle(msg: EngineMessage): void };
  }
}

type EngineMessage =
  | { id: number; op: 'process'; req: EngineRequest }
  | { id: number; op: 'translate-text'; texts: string[]; glossary: Record<string, string> }
  | { id: number; op: 'cancel'; ids: string[] }
  | { id: number; op: 'status' | 'load' | 'clear-cache' };

const host = new EngineHost((p) => new URL(p, location.href).href);

function reply(id: number, result: unknown) {
  window.DalbitEngineNative?.postMessage(JSON.stringify({ id, result }));
}

window.__engine = {
  handle(msg) {
    const run = async () => {
      switch (msg.op) {
        case 'process': return host.process(msg.req); // the app always sends image bytes (dataBase64)
        case 'translate-text': return { ok: true, translations: await host.translateTexts(msg.texts, msg.glossary) };
        case 'cancel': host.cancel(msg.ids); return { ok: true };
        case 'load': await host.load().catch(() => {}); return host.status;
        case 'clear-cache': await host.clearCache(); return { ok: true };
        default: return host.status;
      }
    };
    run().then((r) => reply(msg.id, r), (e) => reply(msg.id, { ok: false, code: 'service-error', error: String(e?.message ?? e) }));
  },
};

window.DalbitEngineNative?.postMessage(JSON.stringify({ id: 0, result: { ready: true, crossOriginIsolated: self.crossOriginIsolated } }));
