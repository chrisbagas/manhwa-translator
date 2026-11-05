// Optional site adapters for readers where generic discovery fails.
//
// An adapter can return the chapter images in reading order and/or resolve
// the real image URL. Keep adapters small and declarative; add one only after
// generic discovery has been shown to fail on that site.

import type { SiteAdapter } from './discovery';

export const ADAPTERS: SiteAdapter[] = [
  {
    // Example: a reader that marks pages with data-page and stores the real
    // URL in data-url. Matches any site using this convention; it is also
    // what the end-to-end test page uses to exercise the adapter path.
    name: 'data-page-reader',
    matches: (loc) => loc.search.includes('dalbit-adapter-demo') || !!document.querySelector('[data-dalbit-reader]'),
    findImages: (doc) => {
      const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>('[data-dalbit-reader] img[data-page]'));
      return imgs.length ? imgs.sort((a, b) => Number(a.dataset.page) - Number(b.dataset.page)) : null;
    },
    resolveUrl: (img) => img.dataset.url ?? img.currentSrc ?? img.src ?? null,
  },
];
