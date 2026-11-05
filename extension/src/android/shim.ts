// Android app adapter: gives the extension's content script the small part of
// the WebExtension API it uses (runtime messaging, storage, resource URLs),
// backed by the Kotlin app through a JavaScript bridge.
//
// Native -> JS:  window.__dalbitBridge.deliver(id, result)
//                window.__dalbitBridge.command(cmd)            e.g. {type:'start'}
//                window.__dalbitBridge.storageChanged(changes)
// JS -> native:  DalbitNative.postMessage(JSON.stringify({id, kind, ...}))
//
// The bridge runs in the page's own JavaScript world (WebView has no isolated
// worlds), so the native side never hands secrets (service token) to it.

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void;
type StorageListener = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void;

interface NativeBridge { postMessage(json: string): void }

declare global {
  interface Window {
    DalbitNative?: NativeBridge;
    __dalbitBridge?: {
      deliver(id: number, result: unknown): void;
      command(cmd: unknown): void;
      storageChanged(changes: Record<string, { newValue?: unknown; oldValue?: unknown }>): void;
    };
    __dalbitAssetBase?: string;
  }
}

(() => {
  if (window.__dalbitBridge) return; // injected twice
  const native = window.DalbitNative;
  const pending = new Map<number, (v: unknown) => void>();
  const listeners: Listener[] = [];
  const storageListeners: StorageListener[] = [];
  let seq = 0;

  const call = (kind: string, payload: Record<string, unknown>): Promise<any> => // eslint-disable-line @typescript-eslint/no-explicit-any
    new Promise((resolve) => {
      if (!native) return resolve(undefined);
      const id = ++seq;
      pending.set(id, resolve);
      native.postMessage(JSON.stringify({ id, kind, ...payload }));
    });

  window.__dalbitBridge = {
    deliver(id, result) {
      const p = pending.get(id);
      pending.delete(id);
      p?.(result);
    },
    command(cmd) {
      for (const l of listeners) {
        let answered = false;
        const keep = l(cmd, {}, () => { answered = true; });
        if (keep || answered) break;
      }
    },
    storageChanged(changes) {
      for (const l of storageListeners) l(changes, 'local');
    },
  };

  const base = window.__dalbitAssetBase ?? 'https://appassets.androidplatform.net/assets/www/';
  const api = {
    runtime: {
      sendMessage: (msg: unknown) => call('message', { msg }),
      onMessage: { addListener: (fn: Listener) => listeners.push(fn) },
      getURL: (path: string) => base + path.replace(/^\//, ''),
    },
    storage: {
      local: {
        get: (keys?: string | string[] | null) => call('storage-get', { keys: keys == null ? null : Array.isArray(keys) ? keys : [keys] }).then((r) => r ?? {}),
        set: (items: Record<string, unknown>) => call('storage-set', { items }),
      },
      onChanged: { addListener: (fn: StorageListener) => storageListeners.push(fn) },
    },
  };
  (globalThis as unknown as { browser: unknown }).browser = api;
})();

export {};
