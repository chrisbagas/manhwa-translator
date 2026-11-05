import { describe, expect, it, vi } from 'vitest';
(globalThis as any).chrome = { storage: { local: { get: vi.fn(), set: vi.fn() } } };
const { parseGlossary, formatGlossary } = await import('../../src/shared/browser');
const { isLoopbackUrl, health, translateImage } = await import('../../src/background/service');
import { DEFAULT_SETTINGS } from '../../src/shared/types';

describe('settings + service client', () => {
  it('parses glossary lines', () => {
    expect(parseGlossary('민준 = Minjun\n# comment\n서진 -> Seojin\nbad line')).toEqual({ 민준: 'Minjun', 서진: 'Seojin' });
    expect(parseGlossary(formatGlossary({ a: 'b' }))).toEqual({ a: 'b' });
  });
  it('only allows loopback service URLs', () => {
    expect(isLoopbackUrl('http://127.0.0.1:47615')).toBe(true);
    expect(isLoopbackUrl('http://localhost:1')).toBe(true);
    expect(isLoopbackUrl('https://api.example.com')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.5:47615')).toBe(false);
  });
  it('reports an unreachable service with setup guidance', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const h = await health(DEFAULT_SETTINGS, f as unknown as typeof fetch);
    expect(h.state).toBe('unreachable');
    expect(h.message).toMatch(/python -m dalbit serve/);
    const r = await translateImage(DEFAULT_SETTINGS, new ArrayBuffer(4), 'image/png', 'x', new AbortController().signal, f as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, code: 'service-unreachable' });
    expect(f).toHaveBeenCalledTimes(2);
    expect(String(f.mock.calls[1][0])).toMatch(/^http:\/\/127\.0\.0\.1:47615\/v1\/translate\?/);
  });
  it('sends settings that affect the cache key', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ regions: [] }), { status: 200 }));
    await translateImage({ ...DEFAULT_SETTINGS, token: 't', targetLang: 'es', sfxMode: 'original', glossary: { 민준: 'Minjun' } }, new ArrayBuffer(4), 'image/png', 'id1', new AbortController().signal, f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0];
    expect(url).toMatch(/tgt=es/); expect(url).toMatch(/sfx=original/); expect(url).toMatch(/requestId=id1/);
    const opts = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(init.headers['X-Dalbit-Options']), (c) => c.charCodeAt(0))));
    expect(opts.glossary).toEqual({ 민준: 'Minjun' });
    expect(init.headers.Authorization).toBe('Bearer t');
  });
});
