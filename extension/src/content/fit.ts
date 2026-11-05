// Text fitting with measured font metrics.
//
// Order of preference when a translation does not fit its box:
//   1. re-wrap (balanced line breaks),
//   2. shrink, but never below `minPx`,
//   3. report overflow so the renderer shows an expandable caption.
// Text is never truncated here.

export type Measure = (text: string, sizePx: number) => number;

export interface FitOptions {
  maxPx: number;
  minPx: number;
  lineHeight?: number; // multiple of font size
  measure: Measure;
}

export interface FitResult {
  sizePx: number;
  lines: string[];
  overflow: boolean;
  width: number; // widest line, px
  height: number; // total block height, px
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** Greedy wrap; words wider than maxW are split at character level. */
export function greedyWrap(words: string[], maxW: number, size: number, measure: Measure): string[] {
  const lines: string[] = [];
  let cur = '';
  const pushLong = (word: string) => {
    // Hard-break an over-long word (URLs, long names) with a hyphen.
    let rest = word;
    while (rest && measure(rest, size) > maxW) {
      let n = rest.length - 1;
      while (n > 1 && measure(rest.slice(0, n) + '-', size) > maxW) n--;
      lines.push(rest.slice(0, n) + '-');
      rest = rest.slice(n);
    }
    return rest;
  };
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (measure(trial, size) <= maxW) {
      cur = trial;
      continue;
    }
    if (cur) lines.push(cur);
    cur = measure(w, size) > maxW ? pushLong(w) : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Same line count as greedy, but with the narrowest width -> balanced lines. */
export function balancedWrap(text: string, maxW: number, size: number, measure: Measure): string[] {
  if (text.includes('\n')) return text.split('\n').flatMap((p) => balancedWrap(p, maxW, size, measure));
  const words = tokenize(text);
  if (!words.length) return [];
  const greedy = greedyWrap(words, maxW, size, measure);
  if (greedy.length <= 1) return greedy;
  let lo = Math.max(...words.map((w) => Math.min(measure(w, size), maxW)));
  let hi = maxW;
  let best = greedy;
  for (let i = 0; i < 12 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    const trial = greedyWrap(words, mid, size, measure);
    if (trial.length <= greedy.length) {
      best = trial;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return best;
}

export function fitText(text: string, boxW: number, boxH: number, opts: FitOptions): FitResult {
  const lh = opts.lineHeight ?? 1.15;
  const minPx = Math.max(1, opts.minPx);
  const maxPx = Math.max(minPx, opts.maxPx);
  const layout = (size: number) => {
    const lines = balancedWrap(text, boxW, size, opts.measure);
    const width = Math.max(0, ...lines.map((l) => opts.measure(l, size)));
    return { lines, width, height: lines.length * size * lh };
  };
  // Binary search the largest size in [minPx, maxPx] that fits (fit is
  // monotonic in size for practical purposes), then confirm.
  let lo = minPx;
  let hi = maxPx;
  let best: (ReturnType<typeof layout> & { size: number }) | null = null;
  const first = layout(hi);
  if (first.height <= boxH && first.width <= boxW + 0.5) return { sizePx: hi, ...first, overflow: false };
  for (let i = 0; i < 14 && hi - lo > 0.25; i++) {
    const mid = (lo + hi) / 2;
    const l = layout(mid);
    if (l.height <= boxH && l.width <= boxW + 0.5) {
      best = { ...l, size: mid };
      lo = mid;
    } else {
      hi = mid;
    }
  }
  if (!best) {
    const l = layout(minPx);
    const fits = l.height <= boxH && l.width <= boxW + 0.5;
    return { sizePx: minPx, ...l, overflow: !fits };
  }
  const size = Math.floor(best.size * 4) / 4;
  return { sizePx: size, ...layout(size), overflow: false };
}

/** Canvas-based measurer for a CSS font family/weight. */
export function canvasMeasure(family: string, weight: number): Measure {
  const ctx = document.createElement('canvas').getContext('2d');
  const cache = new Map<string, number>();
  return (text, size) => {
    const key = `${size}|${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      if (!ctx) return text.length * size * 0.55;
      ctx.font = `${weight} ${size}px ${family}`;
      w = ctx.measureText(text).width;
      if (cache.size > 5000) cache.clear();
      cache.set(key, w);
    }
    return w;
  };
}
