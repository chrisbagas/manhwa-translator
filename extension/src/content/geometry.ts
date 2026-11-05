// Pure geometry helpers (unit-tested).

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Content box of a replaced element, honouring object-fit contain/cover/none. */
export function contentRect(
  border: Rect,
  css: { borderLeft: number; borderTop: number; borderRight: number; borderBottom: number; padLeft: number; padTop: number; padRight: number; padBottom: number; objectFit: string },
  natural: { w: number; h: number },
): Rect {
  const left = border.left + css.borderLeft + css.padLeft;
  const top = border.top + css.borderTop + css.padTop;
  const width = Math.max(0, border.width - css.borderLeft - css.borderRight - css.padLeft - css.padRight);
  const height = Math.max(0, border.height - css.borderTop - css.borderBottom - css.padTop - css.padBottom);
  if (!natural.w || !natural.h || !width || !height) return { left, top, width, height };
  const fit = css.objectFit;
  if (fit === 'contain' || fit === 'scale-down' || fit === 'none') {
    let s = Math.min(width / natural.w, height / natural.h);
    if (fit === 'none') s = 1;
    if (fit === 'scale-down') s = Math.min(1, s);
    const w = natural.w * s;
    const h = natural.h * s;
    return { left: left + (width - w) / 2, top: top + (height - h) / 2, width: w, height: h };
  }
  // fill / cover: cover crops, but percentage placement still maps to the box
  // closely enough only for fill; for cover we map to the scaled image.
  if (fit === 'cover') {
    const s = Math.max(width / natural.w, height / natural.h);
    const w = natural.w * s;
    const h = natural.h * s;
    return { left: left + (width - w) / 2, top: top + (height - h) / 2, width: w, height: h };
  }
  return { left, top, width, height };
}

/** Express an image-pixel box as percentages of the image. */
export function pct(box: number[], w: number, h: number) {
  return {
    left: `${(box[0] / w) * 100}%`,
    top: `${(box[1] / h) * 100}%`,
    width: `${(box[2] / w) * 100}%`,
    height: `${(box[3] / h) * 100}%`,
  };
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
