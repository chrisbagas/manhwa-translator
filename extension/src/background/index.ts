// Background: routes messages, acquires images, talks to the local service.
// Chrome runs this as an MV3 service worker, Firefox as an event page.

import { ext, loadSettings } from '../shared/browser';
import type { BgMessage, ContentCommand, TranslateResponse } from '../shared/types';
import { base64ToBytes, fetchImage } from './acquire';
import { cancelRequests, health, isLoopbackUrl, translateImage, translateTexts } from './service';

const inflight = new Map<string, AbortController>();
const BG_TYPES = new Set(['translate-image', 'cancel', 'health', 'translate-text']);

async function handleTranslate(msg: Extract<BgMessage, { type: 'translate-image' }>): Promise<TranslateResponse> {
  const s = await loadSettings();
  if (!isLoopbackUrl(s.serviceUrl)) {
    return { ok: false, code: 'service-error', error: 'Service URL must be a loopback address (127.0.0.1 / localhost).' };
  }
  const ctl = new AbortController();
  inflight.set(msg.id, ctl);
  try {
    let bytes: ArrayBuffer;
    let mime = msg.mime ?? 'application/octet-stream';
    if (msg.dataBase64) {
      bytes = base64ToBytes(msg.dataBase64);
    } else if (msg.url) {
      const got = await fetchImage(msg.url, msg.pageUrl, ctl.signal, (msg.attempt ?? 1) > 1);
      if (!got.ok) {
        if (ctl.signal.aborted) return { ok: false, code: 'cancelled', error: 'cancelled' };
        return { ok: false, code: 'fetch-failed', error: got.error, status: got.status };
      }
      bytes = got.bytes;
      mime = got.mime;
    } else {
      return { ok: false, code: 'no-source', error: 'no image source' };
    }
    return await translateImage(s, bytes, mime, msg.id, ctl.signal);
  } finally {
    inflight.delete(msg.id);
  }
}

ext.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as BgMessage;
  const run = async () => {
    switch (msg.type) {
      case 'translate-image':
        return handleTranslate(msg);
      case 'cancel': {
        for (const id of msg.ids) inflight.get(id)?.abort();
        await cancelRequests(await loadSettings(), msg.ids);
        return { ok: true };
      }
      case 'health':
        return health(await loadSettings());
      case 'translate-text':
        try {
          return { ok: true, translations: await translateTexts(await loadSettings(), msg.texts) };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      default:
        return undefined;
    }
  };
  if (!msg || typeof msg !== 'object' || !BG_TYPES.has((msg as { type?: string }).type ?? '')) return false;
  run().then(sendResponse, (e) => sendResponse({ ok: false, code: 'service-error', error: String(e) }));
  return true; // async response
});

/** Inject the content script (idempotent) and send it a command. */
export async function commandTab(tabId: number, cmd: ContentCommand): Promise<unknown> {
  await ext.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  return ext.tabs.sendMessage(tabId, cmd);
}

ext.commands?.onCommand.addListener(async (command: string) => {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === 'translate-chapter') await commandTab(tab.id, { type: 'start' });
  if (command === 'toggle-original') await commandTab(tab.id, { type: 'toggle' });
});

// The popup asks the background to run commands so injection uses one code path.
ext.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as { type: string; tabId?: number; cmd?: ContentCommand };
  if (msg?.type !== 'command-tab' || typeof msg.tabId !== 'number' || !msg.cmd) return false;
  commandTab(msg.tabId, msg.cmd).then(
    (r) => sendResponse({ ok: true, result: r }),
    (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
  );
  return true;
});
