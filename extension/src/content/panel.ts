// Compact floating control panel (shadow DOM, fixed bottom-right).

import type { Progress } from '../shared/types';

export interface PanelActions {
  pauseResume(): void;
  cancel(): void;
  toggle(): void;
  retry(): void;
  scan(): void;
  close(): void;
}

const CSS = `
:host { all: initial; }
.p { position: fixed; right: 12px; bottom: 12px; z-index: 2147483600; width: 248px; background: #16161d; color: #f2f2f5;
  font: 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; border-radius: 10px; box-shadow: 0 6px 22px rgba(0,0,0,.45);
  padding: 10px 12px; box-sizing: border-box; }
.p.min .body { display: none; }
.hd { display: flex; align-items: center; gap: 6px; font-weight: 700; }
.hd .t { flex: 1; } .hd button { background: none; border: 0; color: #aaa; cursor: pointer; font-size: 14px; padding: 0 2px; }
.bar { height: 5px; background: #33333d; border-radius: 3px; margin: 8px 0 6px; overflow: hidden; }
.bar i { display: block; height: 100%; background: #f5c542; width: 0; transition: width .2s; }
.counts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px 6px; color: #c9c9d2; }
.counts b { color: #fff; font-weight: 600; }
.btns { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.btns button { flex: 1 1 auto; background: #2b2b36; color: #fff; border: 1px solid #44444f; border-radius: 6px; padding: 4px 6px; cursor: pointer; font: inherit; }
.btns button:hover { background: #383845; }
.btns button[hidden] { display: none; }
.msg { margin-top: 8px; color: #ffcf66; white-space: pre-wrap; word-break: break-word; }
.msg code { background: #2b2b36; padding: 0 3px; border-radius: 3px; }
.note { margin-top: 6px; color: #9a9aa6; }
`;

export class Panel {
  host: HTMLElement;
  private root: ShadowRoot;
  private el: Record<string, HTMLElement> = {};

  constructor(private actions: PanelActions) {
    this.host = document.createElement('dalbit-panel');
    this.host.setAttribute('data-dalbit-ui', 'panel');
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = `<div class="p" role="region" aria-label="Dalbit translator">
        <div class="hd"><span class="t">Dalbit · chapter</span>
          <button class="min" title="Minimise">–</button><button class="x" title="Close panel (translations stay)">×</button></div>
        <div class="body">
          <div class="bar"><i></i></div>
          <div class="counts">
            <span>found <b class="c-discovered">0</b></span><span>queued <b class="c-queued">0</b></span><span>working <b class="c-processing">0</b></span>
            <span>done <b class="c-done">0</b></span><span>failed <b class="c-failed">0</b></span><span>lazy <b class="c-waiting">0</b></span>
          </div>
          <div class="btns">
            <button class="pause">Pause</button><button class="toggle">Show original</button>
            <button class="retry" hidden>Retry failed</button><button class="scan" title="Scrolls through the page to load lazy images, then returns to where you were">Scan page</button>
            <button class="cancel">Cancel</button>
          </div>
          <div class="msg" hidden></div>
          <div class="note"></div>
        </div>
      </div>`;
    const style = document.createElement('style');
    style.textContent = CSS;
    this.root.prepend(style);
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    for (const k of ['discovered', 'queued', 'processing', 'done', 'failed', 'waiting']) this.el[k] = q(`.c-${k}`);
    this.el.bar = q('.bar i');
    this.el.msg = q('.msg');
    this.el.note = q('.note');
    this.el.pause = q('.pause');
    this.el.toggle = q('.toggle');
    this.el.retry = q('.retry');
    q('.pause').addEventListener('click', () => actions.pauseResume());
    q('.cancel').addEventListener('click', () => actions.cancel());
    q('.toggle').addEventListener('click', () => actions.toggle());
    q('.retry').addEventListener('click', () => actions.retry());
    q('.scan').addEventListener('click', () => actions.scan());
    q('.x').addEventListener('click', () => actions.close());
    q('.min').addEventListener('click', () => q('.p').classList.toggle('min'));
    document.documentElement.append(this.host);
  }

  update(p: Progress, message: string | null) {
    for (const k of ['discovered', 'queued', 'processing', 'done', 'failed', 'waiting'] as const) this.el[k].textContent = String(p[k]);
    const total = Math.max(1, p.discovered);
    this.el.bar.style.width = `${Math.round(((p.done + p.failed) / total) * 100)}%`;
    this.el.pause.textContent = p.paused ? 'Resume' : 'Pause';
    this.el.toggle.textContent = p.showingOriginal ? 'Show translation' : 'Show original';
    this.el.retry.hidden = p.failed === 0;
    this.el.retry.textContent = `Retry failed (${p.failed})`;
    this.el.msg.hidden = !message;
    this.el.msg.textContent = message ?? '';
    this.el.note.textContent = p.notes.join('\n');
  }

  remove() {
    this.host.remove();
  }
}
