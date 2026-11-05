import { beforeEach, describe, expect, it } from 'vitest';
import { discover, isPlaceholderSrc, largestFromSrcset, resolveImageUrl, type Geometry } from '../../src/content/discovery';

// jsdom has no layout: give each image a size via data-w / data-h.
const geom = (img: HTMLImageElement): Geometry => ({
  width: Number(img.dataset.w ?? 0), height: Number(img.dataset.h ?? 0), naturalWidth: 0, naturalHeight: 0,
});

describe('URL resolution', () => {
  it('detects placeholders', () => {
    expect(isPlaceholderSrc('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toBe(true);
    expect(isPlaceholderSrc('/img/loading.gif')).toBe(true);
    expect(isPlaceholderSrc('https://cdn.example/ch1/001.jpg')).toBe(false);
  });
  it('picks the largest srcset candidate', () => {
    expect(largestFromSrcset('a.jpg 400w, b.jpg 1600w, c.jpg 800w', 'https://x.test/r/')).toBe('https://x.test/r/b.jpg');
    expect(largestFromSrcset('a.jpg 1x, b.jpg 2x', 'https://x.test/')).toBe('https://x.test/b.jpg');
  });
  it('uses lazy-loading attributes when src is a placeholder', () => {
    document.body.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/ch/002.webp">';
    expect(resolveImageUrl(document.querySelector('img')!, 'https://site.test/read/1')).toBe('https://site.test/ch/002.webp');
  });
  it('reads <picture> sources', () => {
    document.body.innerHTML = '<picture><source srcset="/p/3-800.avif 800w, /p/3-1600.avif 1600w"><img></picture>';
    expect(resolveImageUrl(document.querySelector('img')!, 'https://site.test/')).toBe('https://site.test/p/3-1600.avif');
  });
});

describe('discover', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <header><img src="/logo.png" data-w="300" data-h="80"></header>
      <div class="sidebar-ad"><img src="/ads/a.jpg" data-w="300" data-h="600"></div>
      <div class="comments"><img class="avatar" src="/u/1.png" data-w="48" data-h="48"></div>
      <img src="/banner.jpg" data-w="728" data-h="90">
      <div id="chapter">
        <img src="/c/001.jpg" data-w="720" data-h="2000">
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/c/002.jpg" data-w="720" data-h="0">
        <img src="/c/003.jpg" data-w="720" data-h="1800">
      </div>`;
  });
  it('finds chapter images in reading order and explains exclusions', () => {
    const r = discover(document, { geom });
    expect(r.images.map((c) => c.url)).toEqual([
      'http://localhost:3000/c/001.jpg', 'http://localhost:3000/c/002.jpg', 'http://localhost:3000/c/003.jpg',
    ].map((u) => new URL(new URL(u).pathname, document.baseURI).href));
    expect(r.excluded['navigation/header/footer']).toBe(1);
    expect(r.excluded['ad/logo/avatar/icon']).toBe(2);
    expect(r.excluded['banner-shaped']).toBe(1);
    expect(r.explanation).toMatch(/3 chapter image/);
  });
  it('explains failure instead of claiming completion', () => {
    document.body.innerHTML = '<nav><img src="/x.png" data-w="40" data-h="40"></nav>';
    const r = discover(document, { geom });
    expect(r.images).toHaveLength(0);
    expect(r.explanation).toMatch(/No chapter images found among 1 images/);
  });
  it('uses a matching site adapter', () => {
    document.body.innerHTML = '<div data-dalbit-reader><img data-page="2" data-url="/b.jpg"><img data-page="1" data-url="/a.jpg"></div>';
    const r = discover(document, {
      geom,
      adapters: [{ name: 'demo', matches: () => true, findImages: (d) => Array.from(d.querySelectorAll('img')), resolveUrl: (i) => i.dataset.url! }],
    });
    expect(r.adapter).toBe('demo');
    expect(r.images.map((c) => c.url)).toEqual(['/b.jpg', '/a.jpg']);
  });
});
