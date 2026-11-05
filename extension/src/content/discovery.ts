// Chapter-image discovery for the current page.
//
// Heuristics: rendered size, aspect ratio, ancestry (nav/header/ads),
// repeated containers (the reading column holds most of the image area) and
// document order (= reading order for vertical long-scroll). Site adapters can
// override discovery where the generic approach fails.

export interface Geometry {
  width: number; // rendered CSS px
  height: number;
  naturalWidth: number;
  naturalHeight: number;
}

export type GeomFn = (img: HTMLImageElement) => Geometry;

export interface Candidate {
  img: HTMLImageElement;
  url: string | null; // best full-resolution URL we can fetch, null = not resolvable yet
  loaded: boolean;
}

export interface DiscoveryReport {
  images: Candidate[];
  excluded: Record<string, number>;
  container: Element | null;
  adapter: string;
  explanation: string;
}

export interface SiteAdapter {
  name: string;
  matches(loc: Location): boolean;
  /** Return chapter images in reading order, or null to use generic discovery. */
  findImages?(doc: Document): HTMLImageElement[] | null;
  resolveUrl?(img: HTMLImageElement): string | null;
}

const LAZY_ATTRS = [
  'data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-lazy', 'data-echo', 'lazy-src',
  'data-cfsrc', 'data-pagespeed-lazy-src', 'data-full-src', 'data-hi-res-src',
];
const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];
const EXCLUDE_WORDS = /(^|[-_\s])(ad|ads|advert|banner|sponsor|promo|logo|avatar|icon|emoji|thumb|thumbnail|profile|comment|badge|share|social|recommend)s?($|[-_\s\d])/i;
const EXCLUDE_ANCESTORS = 'header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"], [role="complementary"], form';
// Generic reader containers used by common manga/webtoon CMS themes.
const READER_SELECTORS = [
  '.reading-content', '#readerarea', '.reader-area', '.chapter-content', '.viewer', '#viewer', '.webtoon-viewer',
  '.chapter-images', '.page-break', '.container-chapter-reader', '#chapter-reader', 'main',
];

export function isPlaceholderSrc(src: string | null | undefined): boolean {
  if (!src) return true;
  if (src.startsWith('data:image/gif') || src.startsWith('data:image/svg')) return true;
  if (src.startsWith('data:') && src.length < 400) return true;
  return /(placeholder|blank|loading|lazy|spinner|transparent|pixel)\.(gif|png|svg|webp|jpg)/i.test(src);
}

/** Largest candidate in a srcset ("a.jpg 800w, b.jpg 1600w" / "1x, 2x"). */
export function largestFromSrcset(srcset: string | null, base: string): string | null {
  if (!srcset) return null;
  let best: { url: string; score: number } | null = null;
  for (const part of srcset.split(/,\s+(?=\S)/)) {
    const [url, desc = '1x'] = part.trim().split(/\s+/);
    if (!url) continue;
    const n = parseFloat(desc) || 1;
    const score = desc.endsWith('w') ? n : n * 1000;
    if (!best || score > best.score) best = { url, score };
  }
  if (!best) return null;
  try {
    return new URL(best.url, base).href;
  } catch {
    return null;
  }
}

export function resolveImageUrl(img: HTMLImageElement, base = document.baseURI): string | null {
  const abs = (u: string | null) => {
    if (!u) return null;
    try {
      return new URL(u.trim(), base).href;
    } catch {
      return null;
    }
  };
  // 1. What the browser actually chose (handles <picture>/<source> and srcset).
  const current = img.currentSrc || img.getAttribute('src');
  if (current && !isPlaceholderSrc(current) && img.complete && img.naturalWidth > 1) return abs(current);
  // 2. Lazy-loading attributes (the real URL before the image scrolls into view).
  for (const a of LAZY_SRCSET_ATTRS) {
    const u = largestFromSrcset(img.getAttribute(a), base);
    if (u) return u;
  }
  for (const a of LAZY_ATTRS) {
    const v = img.getAttribute(a);
    if (v && !isPlaceholderSrc(v)) return abs(v);
  }
  // 3. <picture><source data-srcset/srcset>.
  const pic = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : null;
  if (pic) {
    for (const s of Array.from(pic.querySelectorAll('source'))) {
      const u = largestFromSrcset(s.getAttribute('srcset') || s.getAttribute('data-srcset'), base);
      if (u) return u;
    }
  }
  // 4. srcset / src even if not loaded yet.
  const ss = largestFromSrcset(img.getAttribute('srcset'), base);
  if (ss) return ss;
  const src = img.getAttribute('src');
  return src && !isPlaceholderSrc(src) ? abs(src) : null;
}

export function defaultGeom(img: HTMLImageElement): Geometry {
  const r = img.getBoundingClientRect();
  return { width: r.width, height: r.height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
}

function exclusionReason(img: HTMLImageElement, g: Geometry): string | null {
  const label = `${img.id} ${img.className} ${img.alt} ${img.getAttribute('src') ?? ''}`.slice(0, 600);
  if (img.closest('[data-dalbit-ui]')) return 'own-ui';
  if (img.closest(EXCLUDE_ANCESTORS)) return 'navigation/header/footer';
  let el: Element | null = img;
  for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
    const words = `${el.id} ${typeof el.className === 'string' ? el.className : ''}`;
    if (EXCLUDE_WORDS.test(words)) return 'ad/logo/avatar/icon';
  }
  if (EXCLUDE_WORDS.test(label.replace(/https?:\/\/[^/]+/, ''))) return 'ad/logo/avatar/icon';
  const w = Math.max(g.width, g.naturalWidth ? Math.min(g.naturalWidth, 4000) : 0);
  const attrW = Number(img.getAttribute('width')) || 0;
  const width = Math.max(g.width, attrW);
  if (width < 200 && w < 300) return 'too-small';
  const h = g.height || (g.naturalWidth ? (g.naturalHeight / g.naturalWidth) * width : 0);
  if (h && width && h / width < 0.3) return 'banner-shaped';
  return null;
}

/** Nearest ancestor that contains at least `min` of the given images. */
function commonContainer(imgs: HTMLImageElement[], min: number): Element | null {
  const counts = new Map<Element, number>();
  for (const img of imgs) {
    let el = img.parentElement;
    for (let d = 0; el && d < 8; d++, el = el.parentElement) counts.set(el, (counts.get(el) ?? 0) + 1);
  }
  let best: Element | null = null;
  let bestDepth = -1;
  for (const [el, n] of counts) {
    if (n < min) continue;
    let depth = 0;
    for (let p = el.parentElement; p; p = p.parentElement) depth++;
    if (depth > bestDepth) {
      best = el;
      bestDepth = depth;
    }
  }
  return best;
}

export function discover(
  doc: Document = document,
  opts: { geom?: GeomFn; adapters?: SiteAdapter[]; loc?: Location } = {},
): DiscoveryReport {
  const geom = opts.geom ?? defaultGeom;
  const adapter = (opts.adapters ?? []).find((a) => a.matches(opts.loc ?? doc.location));
  const excluded: Record<string, number> = {};
  let pool: HTMLImageElement[] | null = adapter?.findImages?.(doc) ?? null;
  const adapterName = pool ? adapter!.name : 'generic';
  if (!pool) {
    let scope: ParentNode = doc;
    for (const sel of READER_SELECTORS) {
      const el = doc.querySelector(sel);
      if (el && el.querySelectorAll('img').length >= 1 && sel !== 'main') {
        scope = el;
        break;
      }
    }
    pool = Array.from(scope.querySelectorAll('img'));
  }
  const kept: { img: HTMLImageElement; g: Geometry }[] = [];
  for (const img of pool) {
    const g = geom(img);
    const why = adapterName === 'generic' ? exclusionReason(img, g) : null;
    if (why) excluded[why] = (excluded[why] ?? 0) + 1;
    else kept.push({ img, g });
  }
  // Main reading column: the container holding most of the image area.
  let container: Element | null = null;
  let images = kept;
  if (kept.length >= 2) {
    container = commonContainer(kept.map((k) => k.img), Math.max(2, Math.ceil(kept.length * 0.5)));
    if (container) {
      const inside = kept.filter((k) => container!.contains(k.img));
      const refW = Math.max(...inside.map((k) => k.g.width), 1);
      // Outside the column only keep images as wide as the column's images.
      images = kept.filter((k) => container!.contains(k.img) || k.g.width >= 0.6 * refW);
      const dropped = kept.length - images.length;
      if (dropped) excluded['outside-reading-column'] = dropped;
    }
  }
  images.sort((a, b) => (a.img.compareDocumentPosition(b.img) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const resolve = adapter?.resolveUrl ?? ((img: HTMLImageElement) => resolveImageUrl(img, doc.baseURI));
  const cands: Candidate[] = images.map(({ img }) => ({
    img,
    url: resolve(img),
    loaded: img.complete && img.naturalWidth > 1 && !isPlaceholderSrc(img.currentSrc || img.src),
  }));
  const total = pool.length;
  let explanation: string;
  if (!cands.length) {
    const reasons = Object.entries(excluded).map(([k, v]) => `${v} ${k}`).join(', ');
    explanation = total
      ? `No chapter images found among ${total} images (${reasons}). The page may render pages into <canvas> or need a site adapter.`
      : 'No <img> elements on this page. The reader may use <canvas>/background images, or pages load after interaction.';
  } else {
    const unresolved = cands.filter((c) => !c.url).length;
    explanation = `${cands.length} chapter image(s) found${unresolved ? `, ${unresolved} without a loadable URL yet (lazy-loaded; scroll or use "Scan page")` : ''}.`;
  }
  return { images: cands, excluded, container, adapter: adapterName, explanation };
}
