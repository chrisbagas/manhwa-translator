// End-to-end test in desktop Chromium with the real extension and the real
// local service (real OCR + translation; nothing mocked).
//
//   node test/e2e/run.mjs            (after `npm run build` and service setup)
//
// Starts: the Python service on :47699, a "reader" site on 127.0.0.1:47701 and
// an image CDN on localhost:47702 (different origin, hotlink-protected: it
// rejects fetches without the reader's Referer and sends no CORS headers).

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }
const { chromium } = playwright;

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '../../dist/chrome');
const SERVICE = join(HERE, '../../../service');
const FIX = join(SERVICE, 'tests/fixtures/generated');
const SITE_PORT = 47701, CDN_PORT = 47702, SVC_PORT = 47699, DEAD_PORT = 47698;
const SITE = `http://127.0.0.1:${SITE_PORT}`, CDN = `http://localhost:${CDN_PORT}`;
const TOKEN = 'e2e-token-0123456789abcdefghij';
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const results = [];
const report = { hardware: {}, phases: {} };
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ servers
const cdnLog = [];
let flakyFailures = 0;
const sitePng = readFileSync(join(HERE, '../../assets/icons/icon-128.png'));
const siteServer = http.createServer((req, res) => {
  const url = new URL(req.url, SITE);
  if (url.pathname.endsWith('.html')) {
    const f = join(HERE, 'site', url.pathname);
    if (!existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(f, 'utf8').replaceAll('__CDN__', CDN));
  }
  if (url.pathname.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(sitePng); }
  res.writeHead(404); res.end();
});
const cdnServer = http.createServer((req, res) => {
  const url = new URL(req.url, CDN);
  const dest = req.headers['sec-fetch-dest'] ?? '';
  const referer = req.headers.referer ?? '';
  cdnLog.push({ path: url.pathname, dest, referer, t: Date.now() });
  const name = url.pathname.split('/').pop();
  const file = join(FIX, name);
  if (!/^[\w.-]+\.png$/.test(name) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  // Hotlink protection: only requests coming from the reader site.
  if (!referer.startsWith(SITE)) { res.writeHead(403); return res.end('hotlink'); }
  if (url.pathname.startsWith('/flaky/') && dest === 'empty' && flakyFailures < 1) {
    flakyFailures++;
    res.writeHead(500); return res.end('flaky');
  }
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => siteServer.listen(SITE_PORT, '127.0.0.1', r));
await new Promise((r) => cdnServer.listen(CDN_PORT, 'localhost', r));

// ------------------------------------------------------------------ service
const home = mkdtempSync(join(tmpdir(), 'dalbit-e2e-'));
const svc = spawn(join(SERVICE, '.venv/bin/python'), ['-W', 'ignore', '-m', 'dalbit', 'serve', '--port', String(SVC_PORT)], {
  cwd: SERVICE, env: { ...process.env, DALBIT_HOME: home, DALBIT_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'],
});
let svcLog = '';
svc.stdout.on('data', (d) => (svcLog += d));
svc.stderr.on('data', (d) => (svcLog += d));
const svcFetch = (p, init = {}) => fetch(`http://127.0.0.1:${SVC_PORT}${p}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
const tSvc = Date.now();
for (let i = 0; i < 240; i++) {
  try { if ((await svcFetch('/v1/health')).ok) break; } catch {}
  await sleep(500);
}
report.phases.serviceStartupMs = Date.now() - tSvc;
const svcRss = () => {
  try {
    const s = readFileSync(`/proc/${svc.pid}/status`, 'utf8');
    return { rssMB: Math.round(Number(s.match(/VmRSS:\s+(\d+)/)[1]) / 1024), peakMB: Math.round(Number(s.match(/VmHWM:\s+(\d+)/)[1]) / 1024) };
  } catch { return null; }
};

// ------------------------------------------------------------------ browser
const userDir = mkdtempSync(join(tmpdir(), 'dalbit-chrome-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: true,
  channel: 'chromium', // full Chromium in new-headless mode (the headless shell cannot load extensions)
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
const setSettings = (s) => popup.evaluate((s) => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...(settings ?? {}), ...s } })), s);

async function openPopupFor(page) {
  const tabId = await popup.evaluate((u) => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === u)?.id), page.url());
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
  await popup.waitForSelector('#translate');
}
const panelState = (page) => page.evaluate(() => {
  const root = document.querySelector('dalbit-panel')?.shadowRoot;
  if (!root) return null;
  const n = (k) => Number(root.querySelector(`.c-${k}`).textContent);
  const msg = root.querySelector('.msg');
  return { discovered: n('discovered'), queued: n('queued'), processing: n('processing'), done: n('done'), failed: n('failed'), waiting: n('waiting'),
    msg: msg.hidden ? '' : msg.textContent, note: root.querySelector('.note').textContent, pause: root.querySelector('.pause').textContent };
});
async function waitFor(page, pred, timeout = 180000, label = '') {
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < timeout) {
    st = await panelState(page);
    if (st && pred(st)) return st;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(st)}`);
}
const settled = (s) => s.queued === 0 && s.processing === 0 && s.discovered > 0 && s.done + s.failed + s.waiting === s.discovered;
const panelClick = (page, sel) => page.evaluate((sel) => document.querySelector('dalbit-panel').shadowRoot.querySelector(sel).click(), sel);
async function alignment(page) {
  return page.evaluate(() => [...document.querySelectorAll('dalbit-layer')].map((l) => {
    const prev = l.previousElementSibling;
    const img = prev?.tagName === 'PICTURE' ? prev.querySelector('img') : prev;
    const a = l.getBoundingClientRect(), b = img.getBoundingClientRect();
    return Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
  }));
}

let exitCode = 0;
try {
  // ---------------------------------------------------------------- 1. service unavailable
  await setSettings({ engine: 'service', serviceUrl: `http://127.0.0.1:${DEAD_PORT}`, token: TOKEN });
  const page = await ctx.newPage();
  if (process.env.E2E_DEBUG) page.on('console', (m) => console.log('[page]', m.text()));
  await page.goto(`${SITE}/chapter.html`);
  await page.waitForTimeout(300);
  const before = cdnLog.filter((l) => l.dest === 'empty').length;
  await openPopupFor(page);
  await popup.click('#translate');
  const down = await waitFor(page, (s) => /not reachable/.test(s.msg), 15000, 'unavailable message');
  check('service unavailable: actionable setup guidance shown', /dalbit serve/.test(down.msg) && /No images were sent/.test(down.msg), down.msg.split('\n')[0]);
  await page.waitForTimeout(1500);
  check('service unavailable: no image was fetched or sent', cdnLog.filter((l) => l.dest === 'empty').length === before);
  check('popup reports service offline', (await popup.textContent('#status')) === 'service offline');

  // ---------------------------------------------------------------- 2. chapter: discovery, lazy, retry, overlays
  await setSettings({ serviceUrl: `http://127.0.0.1:${SVC_PORT}`, token: TOKEN });
  await page.reload();
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(200);
  await openPopupFor(page);
  check('popup reports service ok', (await popup.textContent('#status')) === 'service ok');
  const t0 = Date.now();
  await popup.click('#translate');
  let st = await waitFor(page, (s) => settled(s) && s.discovered >= 6, 240000, 'chapter settled');
  report.phases.chapterFirstPassMs = Date.now() - t0;
  check('discovers 6 chapter images incl. lazy (data-src) and late-inserted page', st.discovered === 6, JSON.stringify(st));
  check('excludes logo, banner, sidebar ad and avatar', (await page.$$eval('dalbit-layer', (l) => l.length)) <= 6 && /6 chapter image/.test(st.note), st.note);
  check('flaky image fails with an explicit reason', st.failed === 1 && /HTTP 500/.test(st.msg), st.msg.replace(/\n/g, ' | '));
  await panelClick(page, '.retry');
  st = await waitFor(page, (s) => settled(s) && s.done === 6, 120000, 'retry');
  check('retry failed image succeeds', st.done === 6 && st.failed === 0);
  report.phases.chapterTotalMs = Date.now() - t0;
  check('no scroll jump while translating', (await page.evaluate(() => scrollY)) === 300);
  const layers = await page.$$eval('dalbit-layer', (ls) => ls.map((l) => l.previousElementSibling?.getAttribute('alt')));
  check('one overlay per chapter page, none on excluded images', layers.length === 6 && layers.every((a) => /^page \d$/.test(a)), layers.join(','));
  // Background fetches (DNR adds the full page URL); page-context fallbacks only send the origin.
  const extFetches = cdnLog.filter((l) => l.dest === 'empty' && l.path.startsWith('/img/chapter_'));
  check('hotlink-protected cross-origin CDN: extension fetch carried the reader Referer', extFetches.length > 0 && extFetches.every((l) => l.referer.startsWith(`${SITE}/chapter.html`)), `${extFetches.length} fetches`);
  let al = await alignment(page);
  check('overlays aligned with images (<=1px)', al.every((d) => d <= 1), al.map((d) => d.toFixed(2)).join(','));
  const texts = await page.evaluate(() => [...document.querySelectorAll('dalbit-layer')].flatMap((l) => [...l.shadowRoot.querySelectorAll('.box .txt, .chip')].map((t) => t.textContent)));
  check('translations rendered in English (no Hangul)', texts.length >= 6 && texts.every((t) => !/[가-힣]/.test(t)), texts.slice(0, 6).join(' | '));
  await page.screenshot({ path: join(OUT, 'chapter-translated.png') });

  // toggle original/translated
  await popup.click('#toggle');
  await page.waitForTimeout(200);
  const hidden = await page.evaluate(() => [...document.querySelectorAll('dalbit-layer')].every((l) => l.shadowRoot.querySelector('.layer').classList.contains('hidden')));
  await page.screenshot({ path: join(OUT, 'chapter-original.png') });
  await popup.click('#toggle');
  await page.waitForTimeout(200);
  const shown = await page.evaluate(() => [...document.querySelectorAll('dalbit-layer')].every((l) => !l.shadowRoot.querySelector('.layer').classList.contains('hidden')));
  check('original/translated toggle', hidden && shown);

  // resize + zoom
  const fontBefore = await page.evaluate(() => document.querySelector('dalbit-layer').shadowRoot.querySelector('.txt').style.fontSize);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.waitForTimeout(600);
  al = await alignment(page);
  const fontAfter = await page.evaluate(() => document.querySelector('dalbit-layer').shadowRoot.querySelector('.txt').style.fontSize);
  check('after resize: overlays re-aligned and text re-fitted', al.every((d) => d <= 1) && fontBefore !== fontAfter, `${fontBefore} -> ${fontAfter}; max misalign ${Math.max(...al).toFixed(2)}`);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 853, height: 600, deviceScaleFactor: 1.5, mobile: false }); // = 150% zoom of a 1280 px window
  await page.waitForTimeout(600);
  al = await alignment(page);
  check('at 150% zoom: overlays aligned', al.every((d) => d <= 1), Math.max(...al).toFixed(2));
  await page.screenshot({ path: join(OUT, 'chapter-zoom150.png') });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(800);

  // correction popover
  await page.evaluate(() => document.querySelector('dalbit-layer').shadowRoot.querySelector('.box').click());
  const popText = await page.evaluate(() => document.querySelector('dalbit-layer').shadowRoot.querySelector('.pop .src')?.textContent ?? '');
  check('region popover exposes the original Korean for correction', /[가-힣]/.test(popText), popText);
  await page.evaluate(() => {
    const r = document.querySelector('dalbit-layer').shadowRoot;
    r.querySelector('.pop .esrc').value = '오늘부터 이 학교에 다니게 됐어.';
    r.querySelector('.pop .retr').click();
  });
  await page.waitForFunction(() => { const v = document.querySelector('dalbit-layer').shadowRoot.querySelector('.pop .etr')?.value; return v && v !== '…'; }, null, { timeout: 30000 });
  const corrected = await page.evaluate(() => document.querySelector('dalbit-layer').shadowRoot.querySelector('.pop .etr').value);
  check('re-translate a corrected original without re-running OCR', /school/i.test(corrected), corrected);

  // ---------------------------------------------------------------- 3. tall images: cancel / retry / pause / resume
  await svcFetch('/v1/cache/clear', { method: 'POST' });
  const tall = await ctx.newPage();
  await tall.goto(`${SITE}/tall.html`);
  await openPopupFor(tall);
  await popup.click('#translate');
  await waitFor(tall, (s) => s.processing > 0, 30000, 'processing');
  await panelClick(tall, '.cancel');
  st = await waitFor(tall, (s) => s.processing === 0 && s.queued === 0, 30000, 'cancelled');
  await sleep(1500);
  const afterCancel = await panelState(tall);
  check('cancel stops in-flight and queued work', afterCancel.failed >= 4 && afterCancel.done <= 1, JSON.stringify(afterCancel));
  const tTall = Date.now();
  await panelClick(tall, '.retry');
  await waitFor(tall, (s) => s.processing > 0, 30000);
  await panelClick(tall, '.pause');
  st = await waitFor(tall, (s) => s.processing === 0, 120000, 'paused');
  await sleep(800);
  const paused = await panelState(tall);
  check('pause lets the current image finish and holds the rest', paused.queued > 0 && paused.pause === 'Resume', JSON.stringify(paused));
  await panelClick(tall, '.pause'); // resume
  st = await waitFor(tall, (s) => settled(s) && s.done === 5, 300000, 'tall done');
  report.phases.tallPageMs = Date.now() - tTall;
  check('tall strip + 4 pages all translated after resume', st.done === 5);
  const tallInfo = await tall.evaluate(() => [...document.querySelectorAll('dalbit-layer')].map((l) => ({
    alt: l.previousElementSibling.src.split('/').pop(), boxes: l.shadowRoot.querySelectorAll('.box').length, chips: l.shadowRoot.querySelectorAll('.chip,.marker').length,
    more: l.shadowRoot.querySelectorAll('.more').length })));
  const strip = tallInfo.find((i) => i.alt === 'tall_strip.png');
  check('tall strip: all 8 bubbles rendered', strip?.boxes === 8, JSON.stringify(strip));
  const sfx = tallInfo.find((i) => i.alt === 'sfx_rotated.png');
  check('rotated SFX shown as annotation/marker, not replaced', sfx?.chips === 1, JSON.stringify(sfx));
  await tall.evaluate(() => document.querySelectorAll('img')[2].scrollIntoView());
  await tall.waitForTimeout(300);
  await tall.screenshot({ path: join(OUT, 'sfx-annotated.png') });
  await tall.evaluate(() => document.querySelectorAll('img')[3].scrollIntoView());
  await tall.waitForTimeout(300);
  await tall.screenshot({ path: join(OUT, 'long-translation.png') });

  // settings change: SFX "original only" -> re-translation from cached OCR
  await setSettings({ sfxMode: 'original' });
  await sleep(500);
  await waitFor(tall, (s) => settled(s) && s.done === 5, 60000, 'requeue');
  const sfx2 = await tall.evaluate(() => [...document.querySelectorAll('dalbit-layer')].find((l) => l.previousElementSibling.src.includes('sfx_rotated')).shadowRoot.querySelectorAll('.chip,.marker').length);
  check('changing SFX mode re-renders (OCR reused from cache)', sfx2 === 0);
  await setSettings({ sfxMode: 'annotate' });

  // ---------------------------------------------------------------- 4. scan pass for lazy images without URLs
  const lazy = await ctx.newPage();
  await lazy.goto(`${SITE}/hidden-lazy.html`);
  await lazy.evaluate(() => window.scrollTo(0, 120));
  const srcs = () => lazy.evaluate(() => [...document.images].map((i) => i.src.startsWith('data:') ? '-' : i.src.split('/').pop()).join(',') + ` y=${scrollY} vis=${document.visibilityState} vh=${innerHeight}`);
  if (process.env.E2E_DEBUG) console.log('lazy before popup', await srcs());
  await openPopupFor(lazy);
  if (process.env.E2E_DEBUG) console.log('lazy after popup', await srcs());
  await popup.click('#translate');
  if (process.env.E2E_DEBUG) { await sleep(1500); console.log('lazy after start', await srcs()); }
  st = await waitFor(lazy, (s) => s.done === 1 && s.waiting === 3, 60000, 'lazy initial');
  check('lazy images without URL are counted, not claimed complete', /without a loadable URL/.test(st.note), st.note);
  await popup.click('#scan');
  st = await waitFor(lazy, (s) => settled(s) && s.done === 4 && !/Scanning/.test(s.msg), 120000, 'scan');
  check('scan pass reveals lazy images and translates them', st.done === 4 && st.waiting === 0);
  check('scan pass restores the reading position', (await lazy.evaluate(() => scrollY)) === 120);

  report.service = svcRss();
  report.health = await (await svcFetch('/v1/health')).json();
} catch (e) {
  console.error(e);
  check('e2e run completed without exceptions', false, String(e.message ?? e));
} finally {
  const failed = results.filter((r) => !r.ok).length;
  report.results = results;
  report.summary = { passed: results.length - failed, failed };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${results.length - failed}/${results.length} checks passed. Timings: ${JSON.stringify(report.phases)} Service memory: ${JSON.stringify(report.service)}`);
  if (process.env.E2E_DEBUG) console.log(JSON.stringify(cdnLog.filter((l) => l.path.includes('flaky')), null, 0));
  if (failed) { exitCode = 1; console.log(svcLog.split('\n').slice(-20).join('\n')); }
  await ctx.close();
  svc.kill();
  siteServer.close();
  cdnServer.close();
  process.exit(exitCode);
}
