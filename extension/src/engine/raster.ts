// Pixel access without ever materialising one huge canvas: regions of the
// decoded image are copied out on demand (tiles, crops, analysis windows).

import type { RGBA } from './imgops';

export interface Raster {
  width: number;
  height: number;
  read(x: number, y: number, w: number, h: number): RGBA;
  close?(): void;
}

/** In-memory RGBA buffer (tests, Node). */
export class ArrayRaster implements Raster {
  constructor(public width: number, public height: number, private data: Uint8ClampedArray) {}
  read(x: number, y: number, w: number, h: number): RGBA {
    x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
    w = Math.max(1, Math.min(this.width - x, Math.ceil(w))); h = Math.max(1, Math.min(this.height - y, Math.ceil(h)));
    const out = new Uint8ClampedArray(w * h * 4);
    for (let r = 0; r < h; r++) out.set(this.data.subarray(((y + r) * this.width + x) * 4, ((y + r) * this.width + x + w) * 4), r * w * 4);
    return { w, h, data: out };
  }
}

/** Browser: an ImageBitmap read through a small reusable OffscreenCanvas. */
export class BitmapRaster implements Raster {
  width: number;
  height: number;
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;

  constructor(private bmp: ImageBitmap) {
    this.width = bmp.width;
    this.height = bmp.height;
  }

  read(x: number, y: number, w: number, h: number): RGBA {
    x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
    w = Math.max(1, Math.min(this.width - x, Math.ceil(w))); h = Math.max(1, Math.min(this.height - y, Math.ceil(h)));
    if (!this.canvas || this.canvas.width < w || this.canvas.height < h) {
      this.canvas = new OffscreenCanvas(Math.max(w, this.canvas?.width ?? 0), Math.max(h, this.canvas?.height ?? 0));
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    const ctx = this.ctx!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.bmp, x, y, w, h, 0, 0, w, h);
    return { w, h, data: ctx.getImageData(0, 0, w, h).data };
  }

  close() {
    this.bmp.close();
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    this.canvas = null;
  }
}
