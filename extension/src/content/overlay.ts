// Non-destructive overlay layers. The original <img> is never modified: each
// translated image gets a sibling host element (shadow DOM) positioned over
// its content box. Region geometry is expressed in % of the image, so layers
// follow resize/zoom; text is re-fitted when the displayed size changes.

import type { PageResult, Region } from '../shared/types';
import { canvasMeasure, fitText, type Measure } from './fit';
import { fontFor } from './fonts';
import { clamp, contentRect, pct } from './geometry';

export interface Edit {
  source?: string;
  translation?: string;
}

export interface OverlayCallbacks {
  retranslate(text: string): Promise<string>;
  saveEdit(imageSha: string, regionId: string, edit: Edit): void;
  textScale(): number;
  minFontPx(): number;
}

const CSS = `
:host { all: initial; }
.layer { position: absolute; inset: 0; pointer-events: none; font-synthesis: none; }
.layer.hidden { display: none; }
.patch { position: absolute; pointer-events: none; image-rendering: auto; }
.box { position: absolute; display: flex; align-items: center; justify-content: center; text-align: center;
  pointer-events: auto; cursor: help; box-sizing: border-box; overflow: visible; }
.box .txt { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; box-sizing: border-box; line-height: 1.15; paint-order: stroke fill; }
.box.line { justify-content: flex-start; text-align: left; overflow: visible; }
.box.line.center { justify-content: center; text-align: center; }
.box.line .txt { white-space: nowrap; max-width: none; }
.box.line.wrap .txt { white-space: normal; }
.measure { position: absolute; left: 0; top: 0; visibility: hidden; white-space: pre; pointer-events: none; contain: layout style; }
.box.overlay { background: var(--plate, rgba(255,255,255,0.92)); border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
.box.overlay .txt { color: var(--plate-fg, #111) !important; -webkit-text-stroke: 0 !important; }
.box.overflow .txt { background: var(--plate, rgba(255,255,255,0.9)); color: var(--plate-fg, #111) !important; border-radius: 6px; padding: 2px 5px; -webkit-text-stroke: 0 !important; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
.box.overflow { align-items: flex-start; }
.box.overflow.collapsed .txt { max-height: 100%; overflow: hidden; }
.more { position: absolute; right: -4px; bottom: -10px; font: 700 11px system-ui, sans-serif; background: #ffd23f; color: #000;
  border: 1px solid #000; border-radius: 9px; padding: 0 6px; cursor: pointer; pointer-events: auto; }
.chip { position: absolute; display: flex; align-items: center; justify-content: center; pointer-events: auto; cursor: help;
  background: rgba(255,255,255,0.92); border: 2px solid var(--accent, #000); border-radius: 999px; box-sizing: border-box;
  color: #111; letter-spacing: .03em; white-space: nowrap; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.chip .unc { font: 700 0.7em system-ui, sans-serif; margin-left: .3em; opacity: .75; }
.marker { position: absolute; display: flex; align-items: center; justify-content: center; pointer-events: auto; cursor: pointer;
  background: #ffd23f; color: #000; border: 2px solid #000; border-radius: 50%; font: 800 13px system-ui, sans-serif; min-width: 20px; min-height: 20px; }
.pop { position: absolute; z-index: 5; pointer-events: auto; background: #fff; color: #111; border: 1px solid #555; border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,.35); padding: 10px; font: 13px/1.4 system-ui, sans-serif; width: min(320px, 90%); }
.pop h4 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; color: #666; letter-spacing: .05em; }
.pop .src { font-size: 15px; margin-bottom: 8px; }
.pop .meta { color: #666; font-size: 11px; margin-bottom: 8px; }
.pop textarea { width: 100%; box-sizing: border-box; font: inherit; min-height: 44px; margin-bottom: 6px; }
.pop button { font: inherit; margin-right: 6px; padding: 2px 8px; cursor: pointer; }
`;

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const L = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [L(a), L(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Keep the estimated colour unless it would be hard to read on the fill. */
export function readableColor(fg: string, fill: string | undefined): string {
  if (!fill || !/^#[0-9a-f]{6}$/i.test(fg) || !/^#[0-9a-f]{6}$/i.test(fill)) return fg;
  if (contrast(fg, fill) >= 3) return fg;
  return contrast('#111111', fill) >= contrast('#ffffff', fill) ? '#111111' : '#ffffff';
}

const UNCERTAIN = new Set(['low-confidence', 'uncertain-reading', 'no-source-script', 'untranslated']);

export class Layer {
  host: HTMLElement;
  private root: ShadowRoot;
  private layer: HTMLDivElement;
  private lastW = 0; // local CSS px (inside any page zoom/transform)
  private lastH = 0;
  private k = 1; // screen px per local CSS px of the host (ancestor transforms / zoom)
  private measureEl: HTMLSpanElement;
  private wordCache = new Map<string, number>();
  private allLineBoxes: number[][] = []; // every text line on the image (neighbouring columns)
  private ro: ResizeObserver;
  edits: Record<string, Edit> = {};

  constructor(
    public img: HTMLImageElement,
    public result: PageResult,
    private cb: OverlayCallbacks,
  ) {
    this.host = document.createElement('dalbit-layer');
    this.host.setAttribute('data-dalbit-ui', 'layer');
    this.host.style.setProperty('all', 'initial');
    Object.assign(this.host.style, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', zIndex: '10', pointerEvents: 'none', margin: '0', padding: '0', border: '0' });
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.layer = document.createElement('div');
    this.layer.className = 'layer';
    this.measureEl = document.createElement('span');
    this.measureEl.className = 'measure';
    this.root.append(style, this.layer, this.measureEl);
    this.attach();
    this.ro = new ResizeObserver(() => this.sync());
    this.ro.observe(img);
  }

  /** Insert next to the image (after <picture> when present). */
  attach() {
    const anchor = this.img.parentElement?.tagName === 'PICTURE' ? this.img.parentElement : this.img;
    if (anchor.nextSibling !== this.host) anchor.after(this.host);
  }

  get attached() {
    return this.host.isConnected && this.img.isConnected;
  }

  setHidden(hidden: boolean) {
    const was = this.layer.classList.contains('hidden');
    this.layer.classList.toggle('hidden', hidden);
    if (was && !hidden) this.render(); // measurements need a visible layer
  }

  destroy() {
    this.ro.disconnect();
    this.host.remove();
  }

  /** Align the host with the image's content box. Cheap; call often. */
  sync() {
    if (!this.img.isConnected) return;
    if (!this.host.isConnected) this.attach();
    const cs = getComputedStyle(this.img);
    const px = (v: string) => parseFloat(v) || 0;
    const target = contentRect(
      this.img.getBoundingClientRect(),
      {
        borderLeft: px(cs.borderLeftWidth), borderTop: px(cs.borderTopWidth), borderRight: px(cs.borderRightWidth), borderBottom: px(cs.borderBottomWidth),
        padLeft: px(cs.paddingLeft), padTop: px(cs.paddingTop), padRight: px(cs.paddingRight), padBottom: px(cs.paddingBottom),
        objectFit: cs.objectFit,
      },
      { w: this.img.naturalWidth || this.result.width, h: this.img.naturalHeight || this.result.height },
    );
    // Page zoom / transforms on ancestors scale our host too: work in its local px.
    if (!this.host.offsetWidth) { this.host.style.width = '100px'; this.host.style.height = '100px'; }
    const hr = this.host.getBoundingClientRect();
    const k = this.host.offsetWidth ? hr.width / this.host.offsetWidth : 1;
    if (k > 0.01 && Math.abs(k - this.k) > 1e-3) this.k = k;
    const curL = parseFloat(this.host.style.left) || 0;
    const curT = parseFloat(this.host.style.top) || 0;
    const nl = curL + (target.left - hr.left) / this.k;
    const nt = curT + (target.top - hr.top) / this.k;
    if (Math.abs(nl - curL) > 0.25) this.host.style.left = `${nl}px`;
    if (Math.abs(nt - curT) > 0.25) this.host.style.top = `${nt}px`;
    const w = target.width / this.k, h = target.height / this.k;
    this.host.style.width = `${w}px`;
    this.host.style.height = `${h}px`;
    if (Math.abs(w - this.lastW) > 0.5 || Math.abs(h - this.lastH) > 0.5) {
      this.lastW = w;
      this.lastH = h;
      this.render();
    }
  }

  /** Width of text as the browser actually lays it out (local CSS px). Words are
   *  measured once at a reference size and scaled; falls back to canvas metrics
   *  when the layer is not rendered. */
  private measurer(family: string, weight: number): Measure {
    const REF = 64;
    const el = this.measureEl;
    const canvas = canvasMeasure(family, weight);
    const word = (w: string): number => {
      const key = `${family}|${weight}|${w}`;
      let v = this.wordCache.get(key);
      if (v === undefined) {
        el.style.font = `${weight} ${REF}px ${family}`;
        el.textContent = w;
        v = el.getBoundingClientRect().width / this.k;
        if (!(v > 0)) return -1;
        if (this.wordCache.size > 4000) this.wordCache.clear();
        this.wordCache.set(key, v);
      }
      return v;
    };
    return (text, size) => {
      const parts = text.split(' ');
      let total = 0;
      for (const p of parts) {
        const w = p ? word(p) : 0;
        if (w < 0) return canvas(text, size);
        total += w;
      }
      const space = word('\u00a0');
      total += Math.max(0, parts.length - 1) * (space > 0 ? space : REF * 0.25);
      return (total * size) / REF;
    };
  }

  /** Display scale: CSS px per image px. */
  private get scale() {
    return this.lastW / this.result.width;
  }

  render() {
    const { result } = this;
    const openPop = this.layer.querySelector('.pop');
    this.layer.textContent = '';
    if (openPop) this.layer.append(openPop); // keep an open correction dialog across re-layouts
    if (!this.lastW) return;
    const regions = [...result.regions].sort((a, b) => a.order - b.order);
    this.allLineBoxes = regions.filter((r) => r.render_mode !== 'hidden').flatMap((r) => r.lines.map((l) => l.bbox));
    const caps = this.lineSizeCaps(regions);
    for (const r of regions) {
      if (r.render_mode === 'hidden') continue;
      const edit = this.edits[r.id];
      const text = edit?.translation ?? r.translated_text;
      if (r.patch && r.patch_box && r.render_mode === 'replace' && text) {
        const p = document.createElement('img');
        p.className = 'patch';
        p.src = r.patch;
        p.alt = '';
        Object.assign(p.style, pct(r.patch_box, result.width, result.height));
        this.layer.append(p);
      }
      if (r.render_mode === 'annotate' && text) this.renderChip(r, text);
      else if (r.render_mode === 'marker' || !text) this.renderMarker(r, text);
      else if (r.layout === 'lines' && (r.render_mode === 'replace' || r.render_mode === 'overlay')) this.renderLines(r, text, caps.get(r.id));
      else this.renderBox(r, text);
    }
  }

  private renderBox(r: Region, text: string) {
    const s = this.scale;
    const [, , bw, bh] = r.render_box;
    const pad = Math.max(2, Math.min(bw, bh) * 0.06) * s;
    const boxW = bw * s - 2 * pad;
    const boxH = bh * s - 2 * pad;
    const f = fontFor(r.kind);
    const minPx = this.cb.minFontPx();
    const maxPx = Math.max(minPx, r.style.font_px * s * 1.05 * this.cb.textScale());
    const measure = this.measurer(f.family, f.weight);
    let fit = fitText(text, boxW, boxH, { maxPx, minPx, measure });
    const box = document.createElement('div');
    box.className = `box ${r.render_mode === 'overlay' ? 'overlay' : ''} ${fit.overflow ? 'overflow collapsed' : ''}`;
    box.dataset.region = r.id;
    box.dataset.kind = r.kind;
    Object.assign(box.style, pct(r.render_box, this.result.width, this.result.height), { padding: `${pad}px` });
    const t = document.createElement('div');
    t.className = 'txt';
    t.textContent = fit.lines.join('\n');
    const replace = r.render_mode === 'replace';
    Object.assign(t.style, {
      fontFamily: f.family,
      fontWeight: String(r.kind === 'dialogue' && r.style.weight < 600 ? 400 : f.weight),
      fontSize: `${fit.sizePx}px`,
      color: replace ? readableColor(r.style.fg, r.bubble?.fill) : '#111',
      textAlign: r.style.align === 'left' ? 'left' : 'center',
    });
    if (!replace) {
      // Readable plate in the container's own colour when there is one.
      const fill = r.bubble?.fill && /^#[0-9a-f]{6}$/i.test(r.bubble.fill) ? r.bubble.fill : '#ffffff';
      box.style.setProperty('--plate', `${fill}eb`);
      box.style.setProperty('--plate-fg', readableColor(r.style.fg ?? '#111111', fill) === r.style.fg ? r.style.fg : (contrast('#111111', fill) >= contrast('#ffffff', fill) ? '#111111' : '#ffffff'));
    }
    if (replace && r.style.outline && r.style.outline_px) {
      t.style.setProperty('-webkit-text-stroke', `${clamp(r.style.outline_px * s * 2, 1, 6)}px ${r.style.outline}`);
    }
    box.append(t);
    box.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('more')) return;
      e.stopPropagation();
      this.openPopover(r, box);
    });
    box.title = r.source_text;
    this.layer.append(box);
    // Ground truth: shrink until the text really fits (fonts, page CSS or zoom
    // can make any prediction wrong). The browser also wraps inside the box.
    if (!this.layer.classList.contains('hidden')) {
      const fits = () => t.scrollWidth <= boxW + 1 && t.offsetHeight <= boxH + 1;
      for (let i = 0; i < 10 && !fits() && fit.sizePx > minPx; i++) {
        fit = fitText(text, boxW, boxH, { maxPx: Math.max(minPx, fit.sizePx * 0.9), minPx, measure });
        t.textContent = fit.lines.join('\n');
        t.style.fontSize = `${fit.sizePx}px`;
      }
      if (!fits() && !box.classList.contains('overflow')) box.classList.add('overflow', 'collapsed');
      box.dataset.fit = fits() ? 'ok' : 'overflow';
    }
    if (box.classList.contains('overflow')) {
      // Tier 3: never drop words; show a collapsed caption with an expander.
      const more = document.createElement('button');
      more.className = 'more';
      more.textContent = 'more';
      more.title = 'Translation is longer than the bubble';
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        const collapsed = box.classList.toggle('collapsed');
        more.textContent = collapsed ? 'more' : 'less';
      });
      box.append(more);
    }
  }

  /** Structured text (item windows, stat sheets): each translated line sits on
   *  its source line, same alignment, one shared font size. */
  /** Shared font size for line-by-line regions that belong to the same window. */
  private lineSizeCaps(regions: Region[]): Map<string, number> {
    const items = regions.filter((r) => r.layout === 'lines' && (r.render_mode === 'replace' || r.render_mode === 'overlay'));
    const plan = items.map((r) => ({ r, size: this.planLines(r, this.edits[r.id]?.translation ?? r.translated_text).size }));
    const near = (a: Region, b: Region) => {
      const pad = 2 * Math.max(a.style.font_px, b.style.font_px) / 0.78;
      return a.bbox[0] - pad < b.bbox[0] + b.bbox[2] && b.bbox[0] - pad < a.bbox[0] + a.bbox[2] && a.bbox[1] - pad < b.bbox[1] + b.bbox[3] && b.bbox[1] - pad < a.bbox[1] + a.bbox[3];
    };
    const group = plan.map((_, i) => i);
    const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
    for (let i = 0; i < plan.length; i++) for (let j = i + 1; j < plan.length; j++) if (near(plan[i].r, plan[j].r)) group[find(i)] = find(j);
    const min = new Map<number, number>();
    plan.forEach((p, i) => min.set(find(i), Math.min(min.get(find(i)) ?? Infinity, p.size)));
    return new Map(plan.map((p, i) => [p.r.id, min.get(find(i))!]));
  }

  private planLines(r: Region, text: string) {
    const s = this.scale;
    const parts = text.split('\n');
    const lines = r.lines.map((l, k) => ({ l, t: (parts.length === r.lines.length ? parts[k] : l.translated_text) ?? '' }));
    if (!lines.some((x) => x.t)) return { rows: [] as { t: string; x0: number; y0: number; w: number; h: number }[], size: 0, f: fontFor('narration'), measure: this.measurer(fontFor('narration').family, 400), minPx: this.cb.minFontPx() };
    const f = fontFor('narration');
    const measure = this.measurer(f.family, f.weight);
    const right = r.bubble?.interior ? r.bubble.interior[0] + r.bubble.interior[2] : r.render_box[0] + r.render_box[2];
    const rows = lines.map(({ l, t }) => {
      const [x0, y0, x1, y1] = l.bbox;
      // Room to the right: up to the next item on the same row, else the box edge.
      const next = this.allLineBoxes.filter((b) => b !== l.bbox && b[0] >= x1 - 2 && Math.min(y1, b[3]) - Math.max(y0, b[1]) > 0.5 * (y1 - y0));
      const limit = next.length ? Math.min(...next.map((b) => b[0])) - 0.5 * (y1 - y0) : Math.max(right, x1);
      return { t, x0, y0, w: Math.max(x1 - x0, limit - x0), h: y1 - y0 };
    });
    const minPx = this.cb.minFontPx();
    let size = Math.max(minPx, r.style.font_px * s * 1.05 * this.cb.textScale());
    for (const row of rows) {
      if (!row.t) continue;
      const unit = measure(row.t, 100) / 100;
      if (unit > 0) size = Math.min(size, (row.w * s * 0.98) / unit);
      size = Math.min(size, row.h * s * 0.85);
    }
    size = Math.max(minPx, size);
    return { rows, size, f, measure, minPx };
  }

  private renderLines(r: Region, text: string, cap = Infinity) {
    const s = this.scale;
    const plan = this.planLines(r, text);
    if (!plan.rows.length) return this.renderBox(r, text);
    const { rows, f, minPx } = plan;
    let size = Math.max(minPx, Math.min(plan.size, cap));
    // Centre only if the source lines are centred (centres agree better than left edges).
    const sd = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };
    const lefts = r.lines.map((l) => l.bbox[0]), mids = r.lines.map((l) => (l.bbox[0] + l.bbox[2]) / 2);
    const center = r.lines.length > 1 && sd(mids) + 2 < sd(lefts) && rows.every((row) => !rows.some((o) => o !== row && Math.abs(o.y0 - row.y0) < row.h * 0.5));
    const replace = r.render_mode === 'replace';
    const fill = r.bubble?.fill && /^#[0-9a-f]{6}$/i.test(r.bubble.fill) ? r.bubble.fill : '#ffffff';
    const color = replace ? readableColor(r.style.fg, r.bubble?.fill) : (contrast('#111111', fill) >= contrast('#ffffff', fill) ? '#111111' : '#ffffff');
    const els: { box: HTMLDivElement; t: HTMLDivElement; availPx: number }[] = [];
    for (const row of rows) {
      if (!row.t) continue;
      const box = document.createElement('div');
      box.className = `box line ${replace ? '' : 'overlay'} ${center ? 'center' : ''}`;
      box.dataset.region = r.id;
      box.dataset.kind = r.kind;
      Object.assign(box.style, pct([row.x0, row.y0, row.w, row.h], this.result.width, this.result.height));
      if (!replace) { box.style.setProperty('--plate', `${fill}eb`); box.style.setProperty('--plate-fg', color); }
      const t = document.createElement('div');
      t.className = 'txt';
      t.textContent = row.t;
      Object.assign(t.style, { fontFamily: f.family, fontWeight: String(f.weight), fontSize: `${size}px`, color });
      box.append(t);
      box.title = r.source_text;
      box.addEventListener('click', (e) => { e.stopPropagation(); this.openPopover(r, box); });
      this.layer.append(box);
      els.push({ box, t, availPx: row.w * s });
    }
    // Ground truth check: shrink together until every line fits its room.
    if (!this.layer.classList.contains('hidden')) {
      for (let i = 0; i < 10 && size > minPx && els.some((e) => e.t.scrollWidth > e.availPx + 1); i++) {
        size = Math.max(minPx, size * 0.92);
        for (const e of els) e.t.style.fontSize = `${size}px`;
      }
      for (const e of els) {
        if (e.t.scrollWidth > e.availPx + 1) e.box.classList.add('wrap'); // never run into the next column
        e.box.dataset.fit = e.t.scrollWidth > e.availPx + 1 ? 'wrapped' : 'ok';
      }
    }
  }

  private renderChip(r: Region, text: string) {
    const s = this.scale;
    const [, , w, h] = r.render_box;
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.dataset.region = r.id;
    chip.dataset.kind = r.kind;
    const f = fontFor('sfx');
    const uncertain = r.flags.some((x) => UNCERTAIN.has(x)) || r.translation_note === 'sfx-romanized';
    const label = text + (uncertain ? ' ?' : '');
    const fit = fitText(label, w * s * 0.9, h * s * 0.8, { maxPx: h * s * 0.7, minPx: Math.min(this.cb.minFontPx(), h * s * 0.7), measure: this.measurer(f.family, f.weight) });
    Object.assign(chip.style, pct(r.render_box, this.result.width, this.result.height), {
      fontFamily: f.family,
      fontSize: `${fit.sizePx}px`,
      // Echo the effect's tilt, but only a little so it stays readable.
      transform: `rotate(${-clamp(r.angle, -12, 12)}deg)`,
    });
    chip.style.setProperty('--accent', r.style.outline ?? r.style.fg ?? '#000');
    chip.textContent = text;
    if (uncertain) {
      const u = document.createElement('span');
      u.className = 'unc';
      u.textContent = r.translation_note === 'sfx-romanized' ? '(sound)' : '?';
      chip.append(u);
    }
    chip.title = `${r.source_text}${r.translation_note === 'sfx-romanized' ? ' — not in the sound-effect list; romanised reading' : ''}`;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPopover(r, chip);
    });
    this.layer.append(chip);
  }

  private renderMarker(r: Region, text: string) {
    const m = document.createElement('div');
    m.className = 'marker';
    m.dataset.region = r.id;
    m.dataset.kind = r.kind;
    const [x, y] = r.render_box;
    const size = 22;
    Object.assign(m.style, { left: `${(x / this.result.width) * 100}%`, top: `${(y / this.result.height) * 100}%`, width: `${size}px`, height: `${size}px` });
    m.textContent = r.kind === 'sfx' ? '♪' : '?';
    m.title = text ? `${text} (${r.source_text})` : `Unclear text: ${r.source_text}`;
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPopover(r, m);
    });
    this.layer.append(m);
  }

  private openPopover(r: Region, anchor: HTMLElement) {
    this.root.querySelector('.pop')?.remove();
    const edit = this.edits[r.id] ?? {};
    const pop = document.createElement('div');
    pop.className = 'pop';
    const conf = Math.round(r.confidence * 100);
    const flags = r.flags.length ? ` · ${r.flags.join(', ')}` : '';
    pop.innerHTML = `<h4>Original</h4><div class="src"></div><div class="meta"></div><h4>Correct</h4>
      <textarea class="esrc" aria-label="Corrected original text"></textarea>
      <textarea class="etr" aria-label="Translation"></textarea>
      <button class="retr">Re-translate</button><button class="save">Save</button><button class="close">Close</button>`;
    pop.querySelector('.src')!.textContent = edit.source ?? r.source_text;
    pop.querySelector('.meta')!.textContent = `${r.kind} · OCR confidence ${conf}%${flags}${r.translation_note ? ` · ${r.translation_note}` : ''}`;
    const esrc = pop.querySelector<HTMLTextAreaElement>('.esrc')!;
    const etr = pop.querySelector<HTMLTextAreaElement>('.etr')!;
    esrc.value = edit.source ?? r.source_text;
    etr.value = edit.translation ?? r.translated_text;
    pop.querySelector('.retr')!.addEventListener('click', async () => {
      etr.value = '…';
      try {
        etr.value = await this.cb.retranslate(esrc.value);
      } catch (e) {
        etr.value = `(failed: ${(e as Error).message})`;
      }
    });
    pop.querySelector('.save')!.addEventListener('click', () => {
      this.edits[r.id] = { source: esrc.value, translation: etr.value };
      this.cb.saveEdit(this.result.imageSha256, r.id, this.edits[r.id]);
      pop.remove();
      this.render();
    });
    pop.querySelector('.close')!.addEventListener('click', () => pop.remove());
    pop.addEventListener('click', (e) => e.stopPropagation());
    const top = parseFloat(anchor.style.top) || 0;
    pop.style.left = '5%';
    pop.style.top = `${clamp(top, 0, 85)}%`;
    this.layer.append(pop);
  }
}
