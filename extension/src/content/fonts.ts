// Bundled OFL fonts, loaded from extension resources as ArrayBuffers so page
// CSP font-src rules cannot block them. Family names are namespaced.

import { ext } from '../shared/browser';
import type { Kind } from '../shared/types';

const FACES: { family: string; file: string; weight: string }[] = [
  { family: 'DalbitDialogue', file: 'fonts/ComicNeue-Bold.ttf', weight: '700' },
  { family: 'DalbitDialogue', file: 'fonts/ComicNeue-Regular.ttf', weight: '400' },
  { family: 'DalbitNarration', file: 'fonts/AtkinsonHyperlegible-Regular.ttf', weight: '400' },
  { family: 'DalbitNarration', file: 'fonts/AtkinsonHyperlegible-Bold.ttf', weight: '700' },
  { family: 'DalbitSfx', file: 'fonts/Bangers-Regular.ttf', weight: '400' },
];

const FALLBACK = '"Comic Sans MS", "Trebuchet MS", system-ui, sans-serif';

export function fontFor(kind: Kind): { family: string; weight: number } {
  switch (kind) {
    case 'narration':
      return { family: `DalbitNarration, ${FALLBACK}`, weight: 400 };
    case 'sfx':
      return { family: `DalbitSfx, Impact, ${FALLBACK}`, weight: 400 };
    case 'uncertain':
      return { family: `DalbitNarration, ${FALLBACK}`, weight: 400 };
    default:
      return { family: `DalbitDialogue, ${FALLBACK}`, weight: 700 };
  }
}

let loading: Promise<void> | null = null;

export function loadFonts(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    await Promise.all(
      FACES.map(async (f) => {
        try {
          const buf = await (await fetch(ext.runtime.getURL(f.file))).arrayBuffer();
          const face = new FontFace(f.family, buf, { weight: f.weight });
          await face.load();
          document.fonts.add(face);
        } catch {
          /* fall back to system fonts */
        }
      }),
    );
  })();
  return loading;
}
