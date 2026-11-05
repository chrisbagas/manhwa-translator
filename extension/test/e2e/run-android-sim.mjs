// Simulates the Android app in desktop Chromium to test its web side:
// Node plays the Kotlin code (ReaderBridge + EngineClient + AssetServer):
// - serves android/app/src/main/assets/www at https://appassets.androidplatform.net/assets/
//   (COOP/COEP for the engine page, CORS for fonts), like AssetServer.kt
// - injects shim.js + content.js into a reader page and sends {type:'start'}
// - answers the bridge: storage, health, translate-image (downloads the image with
//   the page Referer, base64 -> engine page -> result), cancel, translate-text
//
//   node scripts/build.mjs --targets android && node test/e2e/run-android-sim.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }
const { chromium } = playwright;
const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = join(HERE, '../../../android/app/src/main/assets/www');
const FIX = join(HERE, '../../../service/tests/fixtures/generated');
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const SITE_PORT = 47761, CDN_PORT = 47762;
const SITE = `http://127.0.0.1:${SITE_PORT}`, CDN = `http://localhost:${CDN_PORT}`;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const mime = (p) => ({ html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', wasm: 'application/wasm', ttf: 'font/ttf', png: 'image/png' })[p.split('.').pop()] ?? 'application/octet-stream';

const site = http.createServer((req, res) => {
  const url = new URL(req.url, SITE);
  const f = join(HERE, 'site', url.pathname);
  if (url.pathname.endsWith('.html') && existsSync(f)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(f, 'utf8').replaceAll('__CDN__', CDN));
  }
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(readFileSync(join(HERE, '../../assets/icons/icon-128.png')));
});
const cdnLog = [];
const cdn = http.createServer((req, res) => {
  const name = new URL(req.url, CDN).pathname.split('/').pop();
  cdnLog.push({ name, referer: req.headers.referer ?? '' });
  const file = join(FIX, name);
  if (!existsSync(file)) { res.writeHead(404); return res.end(); }
  if (!(req.headers.referer ?? '').startsWith(SITE)) { res.writeHead(403); return res.end(); }
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(readFileSync(file));
});
await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r));
await new Promise((r) => cdn.listen(CDN_PORT, 'localhost', r));

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'dalbit-android-')), { headless: true, channel: 'chromium', viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
// AssetServer.kt equivalent: the engine WebView gets COOP/COEP, the reader gets CORS.
const assetRoute = (isolated) => (route) => {
  const u = new URL(route.request().url());
  const file = join(WWW, u.pathname.replace(/^\/assets\/www\//, ''));
  if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
  const headers = isolated
    ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' }
    : { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
  return route.fulfill({ status: 200, headers: { 'content-type': mime(file), ...headers }, body: readFileSync(file) });
};

// In the app each WebView has its own handler; here one context route decides by
// requester: reader-page requests (fonts) get CORS, the engine and its workers COOP/COEP.
await ctx.route('https://appassets.androidplatform.net/**', async (route) => {
  const h = await route.request().allHeaders();
  const fromReader = (h.origin ?? h.referer ?? '').startsWith(SITE);
  return assetRoute(!fromReader)(route);
});

// ---------------------------------------------------------------- EngineClient
const enginePage = await ctx.newPage();
enginePage.on('console', (m) => process.env.SIM_DEBUG && console.log('[engine]', m.text()));
enginePage.on('worker', (w) => w.on('console', (m) => process.env.SIM_DEBUG && console.log('[worker]', m.text())));
const enginePending = new Map();
let engineSeq = 0;
let engineReady;
const engineReadyP = new Promise((r) => (engineReady = r));
await enginePage.exposeBinding('__engineToNative', (_src, json) => {
  const m = JSON.parse(json);
  if (m.id === 0) return engineReady(m.result);
  enginePending.get(m.id)?.(m.result);
  enginePending.delete(m.id);
});
await enginePage.addInitScript(() => { window.DalbitEngineNative = { postMessage: (s) => window.__engineToNative(s) }; });
await enginePage.goto('https://appassets.androidplatform.net/assets/www/engine.html');
const ready = await engineReadyP;
check('engine page is cross-origin isolated (threads)', ready.crossOriginIsolated === true, JSON.stringify(ready));
const engineCall = (req) => new Promise((resolve) => {
  const id = ++engineSeq;
  enginePending.set(id, resolve);
  enginePage.evaluate(([r]) => window.__engine.handle(r), [{ ...req, id }]);
});

// ---------------------------------------------------------------- ReaderBridge
const store = { settings: { engine: 'builtin', sourceLang: 'ko', targetLang: 'en', sfxMode: 'annotate', glossary: {} } };
const page = await ctx.newPage();
const deliver = (id, result) => page.evaluate(([i, r]) => window.__dalbitBridge?.deliver(i, r), [id, result]);
await page.exposeBinding('__readerToNative', async (_src, json) => {
  const m = JSON.parse(json);
  if (m.kind === 'storage-get') return deliver(m.id, m.keys ? Object.fromEntries(m.keys.filter((k) => k in store).map((k) => [k, store[k]])) : store);
  if (m.kind === 'storage-set') { Object.assign(store, Object.fromEntries(Object.entries(m.items).filter(([k]) => k !== 'settings'))); return deliver(m.id, true); }
  const msg = m.msg ?? {};
  const s = store.settings;
  if (msg.type === 'health') {
    const st = await engineCall({ op: msg.load ? 'load' : 'status' });
    return deliver(m.id, { state: st.state === 'error' ? 'error' : 'ok', engine: 'builtin', message: st.message, targets: ['en'], detail: st.info });
  }
  if (msg.type === 'translate-image') {
    let b64 = msg.dataBase64;
    if (!b64) {
      const r = await fetch(msg.url, { headers: { Referer: msg.pageUrl } });
      if (!r.ok) return deliver(m.id, { ok: false, code: 'fetch-failed', error: `image request failed with HTTP ${r.status}`, status: r.status });
      b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
    }
    const res = await engineCall({ op: 'process', req: { id: msg.id, dataBase64: b64, pageUrl: msg.pageUrl, src: s.sourceLang, tgt: s.targetLang, sfxMode: s.sfxMode, glossary: s.glossary } });
    return deliver(m.id, res);
  }
  if (msg.type === 'cancel') { await engineCall({ op: 'cancel', ids: msg.ids }); return deliver(m.id, { ok: true }); }
  if (msg.type === 'translate-text') return deliver(m.id, await engineCall({ op: 'translate-text', texts: msg.texts, glossary: s.glossary }));
  return deliver(m.id, null);
});
await page.addInitScript(() => { window.DalbitNative = { postMessage: (s) => window.__readerToNative(s) }; });

const inject = async () => {
  const code = `window.__dalbitAssetBase="https://appassets.androidplatform.net/assets/www/";\n${readFileSync(join(WWW, 'shim.js'), 'utf8')}\n${readFileSync(join(WWW, 'content.js'), 'utf8')}`;
  await page.evaluate(code);
  await page.evaluate(() => window.__dalbitBridge.command({ type: 'start' }));
};
const panel = () => page.evaluate(() => {
  const r = document.querySelector('dalbit-panel')?.shadowRoot;
  if (!r) return null;
  const n = (k) => Number(r.querySelector(`.c-${k}`).textContent);
  return { discovered: n('discovered'), done: n('done'), failed: n('failed'), queued: n('queued'), processing: n('processing'), waiting: n('waiting'), msg: r.querySelector('.msg').hidden ? '' : r.querySelector('.msg').textContent };
});
const waitSettled = async (want, timeout = 300000) => {
  const t0 = Date.now(); let st;
  while (Date.now() - t0 < timeout) {
    st = await panel();
    if (st && st.queued === 0 && st.processing === 0 && st.discovered >= want && st.done + st.failed + st.waiting === st.discovered) return st;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout: ${JSON.stringify(st)}`);
};

let code = 0;
try {
  await page.goto(`${SITE}/chapter.html`);
  const t0 = Date.now();
  await inject();
  const st = await waitSettled(6);
  check('chapter translated through the Android bridge (on-phone engine)', st.done === 6 && st.failed === 0, `${JSON.stringify(st)} in ${Date.now() - t0} ms`);
  check('images downloaded natively with the reader Referer', cdnLog.some((l) => l.referer.startsWith(`${SITE}/chapter.html`)));
  const texts = await page.evaluate(() => [...document.querySelectorAll('dalbit-layer')].flatMap((l) => [...l.shadowRoot.querySelectorAll('.box .txt')].map((t) => t.textContent)));
  check('English rendered on the mobile page', texts.length >= 6 && texts.every((t) => !/[가-힣]/.test(t)), texts.join(' | ').slice(0, 160));
  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.family.startsWith('Dalbit') && f.status === 'loaded').length);
  check('bundled fonts load from app assets (CORS)', fonts >= 3, `${fonts} faces`);
  const al = await page.evaluate(() => [...document.querySelectorAll('dalbit-layer')].map((l) => { const a = l.getBoundingClientRect(), b = l.previousElementSibling.getBoundingClientRect(); return Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width)); }));
  check('overlays aligned on a phone-sized viewport', al.every((d) => d <= 1), al.map((d) => d.toFixed(1)).join(','));
  await page.evaluate(() => window.__dalbitBridge.command({ type: 'toggle' }));
  const hidden = await page.evaluate(() => [...document.querySelectorAll('dalbit-layer')].every((l) => l.shadowRoot.querySelector('.layer').classList.contains('hidden')));
  check('menu command: original/translated toggle', hidden);
  await page.evaluate(() => window.__dalbitBridge.command({ type: 'toggle' }));
  await page.evaluate(() => document.querySelector('dalbit-panel')?.remove());
  await page.screenshot({ path: join(OUT, 'android-sim-chapter.png') });
  const eng = await engineCall({ op: 'status' });
  console.log('engine:', JSON.stringify(eng.info));
} catch (e) {
  console.error(e);
  check('run completed', false, String(e.message ?? e));
} finally {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  code = failed ? 1 : 0;
  await ctx.close(); site.close(); cdn.close();
  process.exit(code);
}
