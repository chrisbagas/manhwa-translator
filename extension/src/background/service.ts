// Client for the local Dalbit service. Images only ever go to the configured
// loopback service; if it is down we report that instead of falling back to
// any remote API.

import type { HealthInfo, PageResult, Settings, TranslateResponse } from '../shared/types';

export const SETUP_HINT =
  'Start the local service: `cd service && .venv/bin/python -m dalbit serve` (see README "Local service").';

function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export async function health(s: Settings, fetchImpl: typeof fetch = fetch): Promise<HealthInfo> {
  let r: Response;
  try {
    r = await fetchImpl(`${s.serviceUrl}/v1/health`, {
      headers: s.token ? { Authorization: `Bearer ${s.token}` } : {},
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    return { state: 'unreachable', message: `Local service not reachable at ${s.serviceUrl}. ${SETUP_HINT}` };
  }
  if (!r.ok) return { state: 'error', message: `Service answered HTTP ${r.status}` };
  const body = await r.json();
  if (!body.authenticated) {
    return {
      state: 'unauthorized',
      version: body.version,
      message: 'Service is running but the pairing token is missing or wrong. Run `python -m dalbit token` and paste it in Settings.',
    };
  }
  return {
    state: 'ok',
    version: body.version,
    message: `Connected (service ${body.version})`,
    targets: body.targets?.[s.sourceLang] ?? [],
    models: body.models,
  };
}

export async function translateImage(
  s: Settings,
  bytes: ArrayBuffer,
  mime: string,
  requestId: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<TranslateResponse> {
  const q = new URLSearchParams({ src: s.sourceLang, tgt: s.targetLang, sfx: s.sfxMode, requestId });
  let r: Response;
  try {
    r = await fetchImpl(`${s.serviceUrl}/v1/translate?${q}`, {
      method: 'POST',
      body: bytes,
      signal,
      headers: {
        Authorization: `Bearer ${s.token}`,
        'Content-Type': mime || 'application/octet-stream',
        'X-Dalbit-Options': b64utf8(JSON.stringify({ glossary: s.glossary })),
      },
    });
  } catch (e) {
    if (signal.aborted) return { ok: false, code: 'cancelled', error: 'cancelled' };
    return { ok: false, code: 'service-unreachable', error: `Local service not reachable at ${s.serviceUrl}. ${SETUP_HINT}` };
  }
  let body: { error?: string; code?: string } & Partial<PageResult> = {};
  try {
    body = await r.json();
  } catch {
    /* non-JSON error */
  }
  if (r.ok) return { ok: true, result: body as PageResult };
  if (r.status === 401) return { ok: false, code: 'unauthorized', error: body.error ?? 'unauthorized', status: 401 };
  if (r.status === 409) return { ok: false, code: 'cancelled', error: 'cancelled', status: 409 };
  if (r.status === 422) return { ok: false, code: 'image-rejected', error: body.error ?? 'image rejected', status: 422 };
  if (r.status === 503) return { ok: false, code: 'translation-unavailable', error: body.error ?? 'translation unavailable', status: 503 };
  return { ok: false, code: 'service-error', error: body.error ?? `HTTP ${r.status}`, status: r.status };
}

export async function cancelRequests(s: Settings, ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await fetch(`${s.serviceUrl}/v1/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestIds: ids }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* service gone: nothing to cancel */
  }
}

export async function translateTexts(s: Settings, texts: string[]): Promise<string[]> {
  const r = await fetch(`${s.serviceUrl}/v1/translate-text`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts, src: s.sourceLang, tgt: s.targetLang, glossary: s.glossary }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return (await r.json()).translations;
}
