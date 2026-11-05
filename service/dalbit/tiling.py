"""Bounded, overlapping tiles for very tall long-scroll images.

The detector never sees more than `tile_h` x `width` pixels at once, so memory
stays bounded regardless of strip length, and text is never shrunk to fit a
whole strip into one model input.

Text lines that are cut by a tile edge are recovered by the overlap (which is
larger than any normal line), duplicates in the overlap are merged, and lines
that remain cut in every tile (e.g. huge sound effects) are re-detected in a
window centred on them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import cv2
import numpy as np

from .types import Quad

EDGE_PX = 3.0


@dataclass(frozen=True)
class TileConfig:
    tile_h: int = 1600
    overlap: int = 256
    max_det_width: int = 1600  # wider images are downscaled for DETECTION only

    def key(self) -> str:
        return f"t{self.tile_h}-o{self.overlap}-w{self.max_det_width}"


@dataclass
class Tile:
    y0: int
    y1: int  # exclusive

    @property
    def cut_top(self) -> bool:
        return self.y0 > 0


def plan_tiles(height: int, cfg: TileConfig) -> list[Tile]:
    if height <= cfg.tile_h:
        return [Tile(0, height)]
    stride = cfg.tile_h - cfg.overlap
    tiles = []
    y = 0
    while True:
        if y + cfg.tile_h >= height:
            tiles.append(Tile(max(0, height - cfg.tile_h), height))
            break
        tiles.append(Tile(y, y + cfg.tile_h))
        y += stride
    return tiles


@dataclass
class Candidate:
    quad: Quad
    score: float
    touches_cut: bool

    @property
    def box(self) -> tuple[float, float, float, float]:
        xs = [p[0] for p in self.quad]
        ys = [p[1] for p in self.quad]
        return min(xs), min(ys), max(xs), max(ys)

    @property
    def area(self) -> float:
        x0, y0, x1, y1 = self.box
        return max(0.0, x1 - x0) * max(0.0, y1 - y0)


def _intersection(a, b) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    return max(0.0, x1 - x0) * max(0.0, y1 - y0)


def merge_candidates(cands: list[Candidate]) -> list[Candidate]:
    """Overlap-aware NMS: prefer complete (not cut) and larger detections."""
    ordered = sorted(cands, key=lambda c: (c.touches_cut, -c.area))
    kept: list[Candidate] = []
    for c in ordered:
        dup = False
        for k in kept:
            inter = _intersection(c.box, k.box)
            if inter <= 0:
                continue
            small = min(c.area, k.area) or 1.0
            union = c.area + k.area - inter
            if inter / small > 0.6 or inter / union > 0.3:
                dup = True
                break
        if not dup:
            kept.append(c)
    return kept


def _detect_window(img: np.ndarray, y0: int, y1: int, detect, scale: float, height: int) -> list[Candidate]:
    window = img[y0:y1]
    if scale != 1.0:
        window = cv2.resize(window, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    out = []
    for quad, score in detect(window):
        q = [[x / scale, y / scale + y0] for x, y in quad]
        ys = [p[1] for p in q]
        touches = (y0 > 0 and min(ys) - y0 < EDGE_PX) or (y1 < height and y1 - max(ys) < EDGE_PX)
        out.append(Candidate(q, score, touches))
    return out


def detect_tiled(
    img: np.ndarray,
    detect: Callable[[np.ndarray], list[tuple[Quad, float]]],
    cfg: TileConfig = TileConfig(),
    check_cancel: Callable[[], None] = lambda: None,
    on_progress: Callable[[int, int], None] = lambda done, total: None,
) -> tuple[list[Candidate], dict]:
    h, w = img.shape[:2]
    scale = min(1.0, cfg.max_det_width / w)
    # Tile height is defined in detector pixels; convert back to image pixels.
    tile_cfg = TileConfig(int(cfg.tile_h / scale), int(cfg.overlap / scale), cfg.max_det_width)
    tiles = plan_tiles(h, tile_cfg)
    cands: list[Candidate] = []
    for i, t in enumerate(tiles):
        check_cancel()
        cands.extend(_detect_window(img, t.y0, t.y1, detect, scale, h))
        on_progress(i + 1, len(tiles))
    merged = merge_candidates(cands)

    # Re-detect lines that are cut in every tile that contains them.
    reprocessed = 0
    still_cut = [c for c in merged if c.touches_cut]
    for c in still_cut:
        check_cancel()
        x0, y0, x1, y1 = c.box
        cy = (y0 + y1) / 2
        half = max(tile_cfg.tile_h // 2, int((y1 - y0) * 0.75))
        wy0, wy1 = max(0, int(cy - half)), min(h, int(cy + half))
        fresh = _detect_window(img, wy0, wy1, detect, scale, h)
        # Only take results that overlap the cut line and are not cut themselves.
        fresh = [f for f in fresh if not f.touches_cut and _intersection(f.box, c.box) > 0]
        if fresh:
            merged = [m for m in merged if m is not c and not any(_intersection(m.box, f.box) / (min(m.area, f.area) or 1) > 0.6 for f in fresh)]
            merged.extend(fresh)
            reprocessed += 1
    merged = merge_candidates(merged)
    stats = {"tiles": len(tiles), "candidates": len(cands), "merged": len(merged), "reprocessed": reprocessed, "det_scale": round(scale, 3)}
    return merged, stats
