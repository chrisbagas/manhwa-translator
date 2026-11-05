// End-to-end test of the BUILT-IN engine in Chromium. No Python service is
// started: OCR (ONNX Runtime Web) and translation (Bergamot WASM) run inside
// the extension. Also runs the user's own sample pages if samples/user/ exists.
//
//   npm run build && node test/e2e/run-builtin.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const EXT = join(HERE, '../../dist/chrome');
const FIX = join(HERE, '../../../service/tests/fixtures/generated');
const SAMPLES = join(HERE, '../../../samples/user');
const SITE_PORT = 47721, CDN_PORT = 47722;
const SITE = `http://127.0.0.1:${SITE_PORT}`, CDN = `http://localhost:${CDN_PORT}`;
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const results = [];
const report = { phases: {} };
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userSamples = existsSync(SAMPLES) ? readdirSync(SAMPLES).filter((f) => /\.(webp|png|jpe?g)$/i.test(f)).sort() : [];
const sitePng = readFileSync(join(HERE, '../../assets/icons/icon-128.png'));
const site = http.createServer((req, res) => {
  const url = new URL(req.url, SITE);
  if (url.pathname === '/samples.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset=utf-8><title>Samples</title><style>body{margin:0;background:#111}.r{max-width:690px;margin:0 auto}.r img{display:block;width:100%}</style><div class=r>${userSamples.map((f) => `<img src="${CDN}/user/${f}" alt="${f}">`).join('')}</div>`);
  }
  if (url.pathname === '/layout.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset=utf-8><title>Layout</title><style>body{margin:0;background:#111}.r{max-width:570px;margin:0 auto}.r img{display:block;width:100%}${url.searchParams.get('css') ?? ''}</style><div class=r><img src="${CDN}/img/site_bubbles.png"><img src="${CDN}/img/system_box.png"></div>`);
  }
  if (url.pathname.endsWith('.html')) {
    const f = join(HERE, 'site', url.pathname);
    if (!existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(f, 'utf8').replaceAll('__CDN__', CDN));
  }
  if (url.pathname.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(sitePng); }
  res.writeHead(404); res.end();
});
const cdnLog = [];
const cdn = http.createServer((req, res) => {
  const url = new URL(req.url, CDN);
  cdnLog.push({ path: url.pathname, dest: req.headers['sec-fetch-dest'] ?? '', referer: req.headers.referer ?? '' });
  const name = url.pathname.split('/').pop();
  const file = url.pathname.startsWith('/user/') ? join(SAMPLES, name) : join(FIX, name);
  if (!/^[\w.-]+\.(png|webp|jpe?g)$/.test(name) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  if (!(req.headers.referer ?? '').startsWith(SITE)) { res.writeHead(403); return res.end('hotlink'); }
  res.writeHead(200, { 'content-type': name.endsWith('.webp') ? 'image/webp' : 'image/png' });
  res.end(readFileSync(file));
});
await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r));
await new Promise((r) => cdn.listen(CDN_PORT, 'localhost', r));

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'dalbit-bi-')), {
  headless: true, channel: 'chromium', viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);

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
  return { discovered: n('discovered'), queued: n('queued'), processing: n('processing'), done: n('done'), failed: n('failed'), waiting: n('waiting'), msg: msg.hidden ? '' : msg.textContent };
});
async function waitFor(page, pred, timeout, label) {
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < timeout) { st = await panelState(page); if (st && pred(st)) return st; await sleep(250); }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(st)}`);
}
const settled = (s) => s.queued === 0 && s.processing === 0 && s.discovered > 0 && s.done + s.failed + s.waiting === s.discovered;
const regionsOf = (page) => page.evaluate(() => [...document.querySelectorAll('dalbit-layer')].map((l) => ({
  img: (l.previousElementSibling.getAttribute('alt') || l.previousElementSibling.src.split('/').pop()),
  boxes: [...l.shadowRoot.querySelectorAll('.box')].map((b) => ({ kind: b.dataset.kind, text: b.querySelector('.txt').textContent.replace(/\n/g, ' '), src: b.title })),
  chips: [...l.shadowRoot.querySelectorAll('.chip,.marker')].map((c) => `${c.textContent} [${c.title}]`),
})));

let code = 0;
try {
  await popup.waitForFunction(() => document.querySelector('#status').textContent !== 'checking…', null, { timeout: 30000 });
  const status = await popup.textContent('#status');
  check('popup defaults to the built-in engine (no service, no token)', /built-in/.test(status), status);
  const isolated = await popup.evaluate(() => self.crossOriginIsolated);
  report.crossOriginIsolated = isolated;

  // Chapter page (lazy loading, late page, hotlink-protected CDN).
  const page = await ctx.newPage();
  await page.goto(`${SITE}/chapter.html`);
  await openPopupFor(page);
  let t0 = Date.now();
  await popup.click('#translate');
  let st = await waitFor(page, (s) => settled(s) && s.discovered >= 6, 300000, 'chapter');
  report.phases.chapterMs = Date.now() - t0;
  const engineInfo = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'health' }));
  report.engine = engineInfo;
  check('chapter translated by the built-in engine', st.done === 6 && st.failed === 0, JSON.stringify(st));
  const ch = await regionsOf(page);
  const texts = ch.flatMap((l) => l.boxes.map((b) => b.text));
  check('English text rendered in place (no Hangul)', texts.length >= 6 && texts.every((t) => t && !/[가-힣]/.test(t)), texts.join(' | '));
  check('hotlink-protected images fetched with the reader Referer', cdnLog.some((l) => l.dest === 'empty' && l.referer.startsWith(`${SITE}/chapter.html`)));
  await page.screenshot({ path: join(OUT, 'builtin-chapter.png') });

  // Tall strip + SFX + long translation.
  const tall = await ctx.newPage();
  await tall.goto(`${SITE}/tall.html`);
  await openPopupFor(tall);
  t0 = Date.now();
  await popup.click('#translate');
  st = await waitFor(tall, (s) => settled(s) && s.done === 5, 300000, 'tall');
  report.phases.tallPageMs = Date.now() - t0;
  const tr = await regionsOf(tall);
  report.tall = tr;
  const strip = tr.find((l) => l.img.includes('tall_strip') || l.img === '');
  check('tall strip: 8 bubbles across tile boundaries', tr.some((l) => l.img.includes('tall_strip') && l.boxes.length + l.chips.length === 8 && l.boxes.length >= 7), JSON.stringify(tr.map((l) => [l.img, l.boxes.length, l.chips.length])));
  check('rotated SFX annotated, not replaced', tr.some((l) => l.chips.length === 1));
  await tall.evaluate(() => document.querySelectorAll('img')[2].scrollIntoView());
  await tall.waitForTimeout(300);
  await tall.screenshot({ path: join(OUT, 'builtin-sfx.png') });

  // Cache: reloading and translating again is served from IndexedDB.
  await tall.reload();
  await openPopupFor(tall);
  t0 = Date.now();
  await popup.click('#translate');
  await waitFor(tall, (s) => settled(s) && s.done === 5, 60000, 'tall cached');
  report.phases.tallPageCachedMs = Date.now() - t0;
  check('second visit served from the engine cache', report.phases.tallPageCachedMs < report.phases.tallPageMs / 2, `${report.phases.tallPageCachedMs} ms vs ${report.phases.tallPageMs} ms`);

  // Real-site layouts (from user screenshots): touching bubbles + watermark, and an item
  // window with label/value lines and two stat columns, under several page styles.
  for (const [label, css] of [['plain', ''], ['zoom67', 'body{zoom:.67}'], ['scaled', '.r{transform:scale(.8);transform-origin:top center}']]) {
    const lp = await ctx.newPage();
    await lp.goto(`${SITE}/layout.html?css=${encodeURIComponent(css)}`);
    await openPopupFor(lp);
    await popup.click('#translate');
    await waitFor(lp, (s) => settled(s) && s.done === 2, 180000, `layout ${label}`);
    await lp.waitForTimeout(600);
    const m = await lp.evaluate(() => [...document.querySelectorAll('dalbit-layer')].map((l) => {
      const boxes = [...l.shadowRoot.querySelectorAll('.box')];
      return {
        img: l.previousElementSibling.src.split('/').pop(),
        boxes: boxes.map((b) => {
          const t = b.querySelector('.txt'), br = b.getBoundingClientRect(), tr = t.getBoundingClientRect();
          return { line: b.classList.contains('line'), text: t.textContent, src: b.title, fs: t.style.fontSize,
            inside: tr.left >= br.left - 2 && tr.right <= br.right + 2, tr: [tr.left, tr.top, tr.right, tr.bottom] };
        }),
      };
    }));
    const all = m.flatMap((x) => x.boxes);
    check(`[${label}] every translation stays inside its box (wraps, never runs off)`, all.length > 0 && all.every((b) => b.inside), JSON.stringify(all.filter((b) => !b.inside).map((b) => b.text)));
    const win = m.find((x) => x.img.startsWith('system_box'))?.boxes ?? [];
    const overlaps = [];
    for (let i = 0; i < win.length; i++) for (let j = i + 1; j < win.length; j++) {
      const a = win[i].tr, b = win[j].tr;
      if (Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 1 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 1) overlaps.push([win[i].text, win[j].text]);
    }
    check(`[${label}] item window: one translated line per source line, no overlaps`, win.length === 10 && win.every((b) => b.line) && !overlaps.length, `${win.length} lines; overlaps ${JSON.stringify(overlaps)}`);
    check(`[${label}] item window uses one font size`, new Set(win.map((b) => b.fs)).size === 1, [...new Set(win.map((b) => b.fs))].join(','));
    check(`[${label}] site watermark is not translated`, !all.some((b) => /웹툰|뉴토끼|469/.test(b.src)));
    const al = await lp.evaluate(() => [...document.querySelectorAll('dalbit-layer')].map((l) => {
      const a = l.getBoundingClientRect(), b = l.previousElementSibling.getBoundingClientRect();
      return Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
    }));
    check(`[${label}] overlays aligned with images`, al.every((d) => d <= 1.5), al.map((d) => d.toFixed(2)).join(','));
    if (label === 'plain') {
      await lp.evaluate(() => document.querySelector('dalbit-panel')?.remove());
      const imgs = await lp.locator('.r > img').all();
      for (const e of imgs) {
        await e.scrollIntoViewIfNeeded();
        const name = (await e.getAttribute('src')).split('/').pop().replace(/\.\w+$/, '');
        await e.screenshot({ path: join(OUT, `builtin-${name}.png`) });
      }
    }
    await lp.close();
  }

  // The user's own pages.
  if (userSamples.length) {
    const sp = await ctx.newPage();
    await sp.setViewportSize({ width: 800, height: 1000 });
    await sp.goto(`${SITE}/samples.html`);
    await openPopupFor(sp);
    t0 = Date.now();
    await popup.click('#translate');
    st = await waitFor(sp, (s) => settled(s) && s.done + s.failed === userSamples.length, 300000, 'samples');
    report.phases.userSamplesMs = Date.now() - t0;
    report.userSamples = await regionsOf(sp);
    check('user sample pages processed', st.done === userSamples.length, JSON.stringify(st));
    for (let i = 0; i < userSamples.length; i++) {
      await sp.evaluate((i) => document.querySelectorAll('img')[i].scrollIntoView(), i);
      await sp.waitForTimeout(400);
      await sp.screenshot({ path: join(OUT, `builtin-${userSamples[i].replace(/\.\w+$/, '')}.png`) });
    }
    console.log(JSON.stringify(report.userSamples, null, 1));
  }
} catch (e) {
  console.error(e);
  check('run completed', false, String(e.message ?? e));
} finally {
  const failed = results.filter((r) => !r.ok).length;
  report.results = results;
  writeFileSync(join(OUT, 'report-builtin.json'), JSON.stringify(report, null, 2));
  console.log(`\n${results.length - failed}/${results.length} checks passed. crossOriginIsolated=${report.crossOriginIsolated} timings=${JSON.stringify(report.phases)} engine=${JSON.stringify(report.engine?.detail)}`);
  if (failed) code = 1;
  await ctx.close(); site.close(); cdn.close();
  process.exit(code);
}
