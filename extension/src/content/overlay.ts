// Non-destructive overlay layers. The original <img> is never modified: each
// translated image gets a sibling host element (shadow DOM) positioned over
// its content box. Region geometry is expressed in % of the image, so layers
// follow resize/zoom; text is re-fitted when the displayed size changes.

import type { PageResult, Region } from '../shared/types';
import { canvasMeasure, fitText } from './fit';
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
.box .txt { white-space: pre; line-height: 1.15; paint-order: stroke fill; }
.box.overlay .txt, .box.overflow .txt { background: rgba(255,255,255,0.9); color: #111 !important; border-radius: 6px; padding: 2px 5px; -webkit-text-stroke: 0 !important; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
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
  private lastW = 0;
  private lastH = 0;
  private ro: ResizeObserver;
  edits: Record<string, Edit> = {};

  constructor(
    public img: HTMLImageElement,
    public result: PageResult,
    private cb: OverlayCallbacks,
  ) {
    this.host = document.createElement('dalbit-layer');
    this.host.setAttribute('data-dalbit-ui', 'layer');
    Object.assign(this.host.style, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', zIndex: '10', pointerEvents: 'none', margin: '0', padding: '0', border: '0' });
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.layer = document.createElement('div');
    this.layer.className = 'layer';
    this.root.append(style, this.layer);
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
    this.layer.classList.toggle('hidden', hidden);
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
    const hr = this.host.getBoundingClientRect();
    const curL = parseFloat(this.host.style.left) || 0;
    const curT = parseFloat(this.host.style.top) || 0;
    const nl = curL + (target.left - hr.left);
    const nt = curT + (target.top - hr.top);
    if (Math.abs(nl - curL) > 0.25) this.host.style.left = `${nl}px`;
    if (Math.abs(nt - curT) > 0.25) this.host.style.top = `${nt}px`;
    this.host.style.width = `${target.width}px`;
    this.host.style.height = `${target.height}px`;
    if (Math.abs(target.width - this.lastW) > 0.5 || Math.abs(target.height - this.lastH) > 0.5) {
      this.lastW = target.width;
      this.lastH = target.height;
      this.render();
    }
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
    const fit = fitText(text, boxW, boxH, { maxPx, minPx, measure: canvasMeasure(f.family, f.weight) });
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
    if (replace && r.style.outline && r.style.outline_px) {
      t.style.setProperty('-webkit-text-stroke', `${clamp(r.style.outline_px * s * 2, 1, 6)}px ${r.style.outline}`);
    }
    box.append(t);
    if (fit.overflow) {
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
    box.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('more')) return;
      e.stopPropagation();
      this.openPopover(r, box);
    });
    box.title = r.source_text;
    this.layer.append(box);
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
    const fit = fitText(label, w * s * 0.9, h * s * 0.8, { maxPx: h * s * 0.7, minPx: Math.min(this.cb.minFontPx(), h * s * 0.7), measure: canvasMeasure(f.family, f.weight) });
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
