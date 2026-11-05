// Image acquisition from the background context.
//
// With host permissions the background can fetch cross-origin images without
// CORS (and usually hits the HTTP cache). Many manhwa CDNs reject requests
// without the reader page as Referer; where declarativeNetRequest is
// available we add a short-lived session rule that sets Referer for
// extension-initiated requests to that image host only.

import { ext } from '../shared/browser';

const RULE_BASE = 4200;
let ruleSeq = 0;

export type Acquired = { ok: true; bytes: ArrayBuffer; mime: string } | { ok: false; status?: number; error: string };

export async function withReferer<T>(imageUrl: string, pageUrl: string, fn: () => Promise<T>): Promise<T> {
  const dnr = (ext as typeof chrome).declarativeNetRequest;
  if (!dnr?.updateSessionRules) return fn();
  const id = RULE_BASE + (ruleSeq++ % 500);
  let host: string;
  try {
    host = new URL(imageUrl).hostname;
  } catch {
    return fn();
  }
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1,
          action: {
            type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: [{ header: 'referer', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: pageUrl }],
          },
          condition: {
            requestDomains: [host],
            tabIds: [-1], // requests not made by a tab, i.e. by this extension
            resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType, 'other' as chrome.declarativeNetRequest.ResourceType],
          },
        },
      ],
    });
  } catch {
    return fn(); // DNR unsupported for this condition: plain fetch
  }
  try {
    return await fn();
  } finally {
    dnr.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }
}

export async function fetchImage(url: string, pageUrl: string, signal: AbortSignal, retry = false): Promise<Acquired> {
  if (!/^(https?|data):/i.test(url)) return { ok: false, error: `unsupported URL scheme for background fetch: ${url.slice(0, 30)}` };
  try {
    const r = await withReferer(url, pageUrl, () => fetch(url, { credentials: 'include', cache: retry ? 'no-cache' : 'default', signal }));
    if (!r.ok) return { ok: false, status: r.status, error: `image request failed with HTTP ${r.status}` };
    const mime = r.headers.get('content-type') ?? 'application/octet-stream';
    if (!/^image\//i.test(mime) && !/octet-stream/i.test(mime)) {
      return { ok: false, status: r.status, error: `server returned ${mime}, not an image` };
    }
    return { ok: true, bytes: await r.arrayBuffer(), mime };
  } catch (e) {
    if (signal.aborted) return { ok: false, error: 'cancelled' };
    return { ok: false, error: `network error fetching image (${(e as Error).message})` };
  }
}

export function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
