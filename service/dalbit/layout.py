"""Page analysis: lines -> blocks, bubbles, reading order, kinds, styles, cleanup.

Everything here is classical image processing (OpenCV/NumPy), deterministic
and cheap compared with OCR.
"""

from __future__ import annotations

import base64
import hashlib
import io
import math
import re
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

from .types import Bubble, Region, Style, TextLine

ANALYSIS_VERSION = "layout-8"

HANGUL = re.compile(r"[가-힣ᄀ-ᇿ㄰-㆏]")
KANA = re.compile(r"[぀-ヿ]")
HAN = re.compile(r"[一-鿿]")


# ---------------------------------------------------------------- utilities

def _hex(c) -> str:
    r, g, b = (int(max(0, min(255, round(v)))) for v in c[:3])
    return f"#{r:02x}{g:02x}{b:02x}"


def _lum(c) -> float:
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def _clip_box(x0, y0, x1, y1, w, h):
    return max(0, int(x0)), max(0, int(y0)), min(w, int(math.ceil(x1))), min(h, int(math.ceil(y1)))


def _png_data_url(rgba: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def script_ok(text: str, lang: str) -> bool:
    if lang == "ko":
        return bool(HANGUL.search(text))
    if lang == "ja":
        return bool(KANA.search(text) or HAN.search(text))
    if lang == "zh":
        return bool(HAN.search(text))
    return bool(text.strip())


# ---------------------------------------------------------------- grouping

@dataclass
class _Line:
    line: TextLine
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def h(self) -> float:
        return max(1.0, min(self.y1 - self.y0, self.line.height))

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2


def _same_block(a: _Line, b: _Line, bubble_id: dict[int, int | None], ia: int, ib: int) -> bool:
    ba, bb = bubble_id.get(ia), bubble_id.get(ib)
    if ba is not None and bb is not None and ba != bb:
        return False  # different bubbles never merge; same bubble still needs geometry
    hmax, hmin = max(a.h, b.h), min(a.h, b.h)
    if hmax / hmin > 1.7:
        return False
    if abs(a.line.angle - b.line.angle) > 12:
        return False
    top, bot = (a, b) if a.y0 <= b.y0 else (b, a)
    gap = bot.y0 - top.y1
    x_overlap = min(a.x1, b.x1) - max(a.x0, b.x0)
    # Stacked lines of one block.
    if -0.5 * hmin < gap < 0.9 * hmax and x_overlap > -0.2 * hmax:
        narrower = max(1.0, min(a.x1 - a.x0, b.x1 - b.x0))
        return x_overlap / narrower >= 0.5 or abs(a.x0 - b.x0) < hmax
    # Fragments of one line split by the detector.
    v_overlap = min(a.y1, b.y1) - max(a.y0, b.y0)
    if v_overlap > 0.6 * hmin:
        h_gap = max(a.x0, b.x0) - min(a.x1, b.x1)
        return h_gap < 1.2 * hmax
    return False


def group_lines(lines: list[TextLine], bubble_id: dict[int, int | None]) -> list[list[TextLine]]:
    items = []
    for ln in lines:
        x0, y0, x1, y1 = ln.bbox
        items.append(_Line(ln, x0, y0, x1, y1))
    parent = list(range(len(items)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if _same_block(items[i], items[j], bubble_id, i, j):
                parent[find(i)] = find(j)
    groups: dict[int, list[TextLine]] = {}
    for i, it in enumerate(items):
        groups.setdefault(find(i), []).append(it.line)
    return [sort_lines(g) for g in groups.values()]


def sort_lines(lines: list[TextLine], rtl: bool = False) -> list[TextLine]:
    """Top-to-bottom rows (by vertical overlap), fragments within a row by x."""
    rows: list[list[TextLine]] = []
    for ln in sorted(lines, key=lambda l: (l.bbox[1] + l.bbox[3]) / 2):
        y0, y1 = ln.bbox[1], ln.bbox[3]
        for row in rows:
            ry0 = min(r.bbox[1] for r in row); ry1 = max(r.bbox[3] for r in row)
            if min(y1, ry1) - max(y0, ry0) > 0.5 * min(y1 - y0, ry1 - ry0):
                row.append(ln)
                break
        else:
            rows.append([ln])
    out: list[TextLine] = []
    for row in rows:
        out.extend(sorted(row, key=lambda l: l.bbox[0], reverse=rtl))
    return out


def reading_order(boxes: list[tuple[float, float, float, float]], rtl: bool) -> list[int]:
    """Row bands top-to-bottom; within a band left-to-right (or right-to-left)."""
    idx = sorted(range(len(boxes)), key=lambda i: boxes[i][1])
    bands: list[list[int]] = []
    for i in idx:
        x0, y0, x1, y1 = boxes[i]
        placed = False
        for band in bands:
            by0 = min(boxes[j][1] for j in band)
            by1 = max(boxes[j][3] for j in band)
            ov = min(y1, by1) - max(y0, by0)
            if ov > 0.4 * min(y1 - y0, by1 - by0):
                band.append(i)
                placed = True
                break
        if not placed:
            bands.append([i])
    order = []
    for band in bands:
        band.sort(key=lambda j: (boxes[j][0] + boxes[j][2]) / 2, reverse=rtl)
        order.extend(band)
    return order


# ---------------------------------------------------------------- faint text (watermarks)

MIN_LINE_CONTRAST = 90  # p95 of max-channel difference from the line's median colour


def ink_contrast(sub: np.ndarray) -> float:
    bg = np.median(sub.reshape(-1, 3), axis=0)
    d = np.abs(sub.astype(np.int16) - bg.astype(np.int16)).max(axis=2)
    return float(np.percentile(d, 95))


def line_contrast(img: np.ndarray, line: TextLine) -> float:
    h, w = img.shape[:2]
    x0, y0, x1, y1 = _clip_box(*line.bbox, w, h)
    sub = img[y0:max(y0 + 1, y1), x0:max(x0 + 1, x1)]
    return ink_contrast(sub)


def trim_faint(crop: np.ndarray, min_diff: float = MIN_LINE_CONTRAST) -> np.ndarray:
    """Trim faint columns (e.g. a watermark glued to a line) from both ends."""
    bg = np.median(crop.reshape(-1, 3), axis=0)
    strong = (np.abs(crop.astype(np.int16) - bg.astype(np.int16)).max(axis=2) >= min_diff).sum(axis=0) >= 2
    cols = np.nonzero(strong)[0]
    if cols.size == 0:
        return crop
    m = int(np.ceil(crop.shape[0] * 0.2))
    a, b = max(0, cols[0] - m), min(crop.shape[1] - 1, cols[-1] + m)
    return crop[:, a:b + 1]


def coverage(info: "BubbleInfo", box) -> float:
    x0, y0 = info.window[0], info.window[1]
    m = info.component
    bx0, by0, bx1, by1 = (int(v) for v in box)
    step = max(1, (by1 - by0) // 12)
    ys = np.arange(by0, by1, step) - y0
    xs = np.arange(bx0, bx1, step) - x0
    if not len(ys) or not len(xs):
        return 0.0
    yy, xx = np.meshgrid(ys, xs, indexing="ij")
    ok = (yy >= 0) & (xx >= 0) & (yy < m.shape[0]) & (xx < m.shape[1])
    inside = np.zeros_like(ok)
    inside[ok] = m[yy[ok], xx[ok]]
    return float(inside.mean())


# ---------------------------------------------------------------- bubbles

@dataclass
class BubbleInfo:
    bubble: Bubble
    component: np.ndarray  # bool mask (window coords) of the filled bubble
    window: tuple[int, int, int, int]  # x0, y0, x1, y1 in image coords
    bg: np.ndarray
    enclosed: bool


def _line_ring(img: np.ndarray, boxes, pad: float):
    """Pixels in a thin ring around the given line boxes (image coords)."""
    h, w = img.shape[:2]
    xs0 = min(b[0] for b in boxes); ys0 = min(b[1] for b in boxes)
    xs1 = max(b[2] for b in boxes); ys1 = max(b[3] for b in boxes)
    lh = float(np.median([b[3] - b[1] for b in boxes]))
    p = max(3, int(lh * pad))
    x0, y0, x1, y1 = _clip_box(xs0 - p, ys0 - p, xs1 + p, ys1 + p, w, h)
    sub = img[y0:y1, x0:x1]
    m = np.ones(sub.shape[:2], bool)
    for b in boxes:
        bx0, by0, bx1, by1 = _clip_box(b[0] - x0, b[1] - y0, b[2] - x0, b[3] - y0, x1 - x0, y1 - y0)
        m[by0:by1, bx0:bx1] = False
    return sub[m], (x0, y0, x1, y1)


def find_bubble(img: np.ndarray, boxes, *, tol: float = 28.0) -> BubbleInfo | None:
    """Find a flat-coloured container (speech bubble / caption box) around text.

    Returns None when the background around the text is not uniform (text on
    artwork), in which case cleanup must not be attempted.
    """
    h, w = img.shape[:2]
    ring, _ = _line_ring(img, boxes, 0.45)
    if ring.size == 0:
        return None
    bg = np.median(ring.reshape(-1, 3), axis=0)
    dist = np.abs(ring.reshape(-1, 3).astype(np.float32) - bg).max(axis=1)
    near, faint = (dist < tol).mean(), ((dist >= tol) & (dist < 70)).mean()
    if near < 0.85 and not (near >= 0.6 and near + faint >= 0.95):
        return None  # textured background (faint watermark pixels do not count)

    bx0 = min(b[0] for b in boxes); by0 = min(b[1] for b in boxes)
    bx1 = max(b[2] for b in boxes); by1 = max(b[3] for b in boxes)
    lh = float(np.median([b[3] - b[1] for b in boxes]))
    enclosed = False
    comp = None
    win = None
    for grow in (1.2, 3.0):
        m = max(lh * 2, grow * max(bx1 - bx0, by1 - by0) * 0.5)
        win = _clip_box(bx0 - m, by0 - m, bx1 + m, by1 + m, w, h)
        x0, y0, x1, y1 = win
        sub = img[y0:y1, x0:x1].astype(np.int16)
        sim = (np.abs(sub - bg.astype(np.int16)).max(axis=2) < tol).astype(np.uint8)
        n, labels = cv2.connectedComponents(sim, connectivity=4)
        # Components touched by the ring around the text.
        seeds = np.zeros_like(sim, bool)
        for b in boxes:
            pad = max(2, int(lh * 0.25))
            sx0, sy0, sx1, sy1 = _clip_box(b[0] - x0 - pad, b[1] - y0 - pad, b[2] - x0 + pad, b[3] - y0 + pad, x1 - x0, y1 - y0)
            seeds[sy0:sy1, sx0:sx1] = True
        ids, counts = np.unique(labels[seeds & (sim > 0)], return_counts=True)
        if ids.size == 0:
            return None
        main = ids[np.argmax(counts)]
        comp = labels == main
        touches = comp[0, :].any() or comp[-1, :].any() or comp[:, 0].any() or comp[:, -1].any()
        # A border of the window that is also the image border does not count.
        edge_frac = 0.0
        if touches:
            border = np.concatenate([comp[0, :], comp[-1, :], comp[:, 0], comp[:, -1]])
            edge_frac = border.mean()
        if not touches or edge_frac < 0.02:
            enclosed = True
            break
    assert comp is not None and win is not None
    x0, y0, x1, y1 = win

    # Fill holes (the glyphs) to get the full interior.
    filled = comp.astype(np.uint8)
    inv = 1 - filled
    n, labels = cv2.connectedComponents(inv, connectivity=4)
    border_labels = set(np.unique(np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])).tolist())
    holes = np.isin(labels, [l for l in range(1, n) if l not in border_labels])
    filled = comp | holes

    ys, xs = np.nonzero(filled)
    if xs.size == 0:
        return None
    fb = [int(xs.min()) + x0, int(ys.min()) + y0, int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]
    fill_ratio = filled.sum() / float(fb[2] * fb[3])
    if not enclosed:
        shape = "none"
    elif fill_ratio > 0.9:
        shape = "rect"
    elif 0.7 < fill_ratio <= 0.9:
        shape = "ellipse"
    else:
        shape = "free"

    interior = _interior_rect(filled, (bx0 - x0, by0 - y0, bx1 - x0, by1 - y0), margin=max(3, int(lh * 0.25)))
    interior = [interior[0] + x0, interior[1] + y0, interior[2], interior[3]]
    bubble = Bubble(bbox=fb if enclosed else [int(bx0), int(by0), int(bx1 - bx0), int(by1 - by0)],
                    interior=interior, fill=_hex(bg), flat=True, shape=shape)
    return BubbleInfo(bubble, filled, win, bg, enclosed)


def _interior_rect(mask: np.ndarray, text_box, margin: int) -> list[int]:
    """Grow the text box while it stays inside the (eroded) bubble mask."""
    k = np.ones((2 * margin + 1, 2 * margin + 1), np.uint8)
    inner = cv2.erode(mask.astype(np.uint8), k) > 0
    hh, ww = inner.shape
    x0, y0, x1, y1 = (int(v) for v in text_box)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(ww - 1, x1), min(hh - 1, y1)
    if x1 <= x0 or y1 <= y0:
        return [x0, y0, max(1, x1 - x0), max(1, y1 - y0)]
    step = max(1, (y1 - y0) // 20)
    grew = True
    while grew:
        grew = False
        if x0 - step >= 0 and inner[y0:y1 + 1, x0 - step].all():
            x0 -= step; grew = True
        if x1 + step < ww and inner[y0:y1 + 1, x1 + step].all():
            x1 += step; grew = True
        if y0 - step >= 0 and inner[y0 - step, x0:x1 + 1].all():
            y0 -= step; grew = True
        if y1 + step < hh and inner[y1 + step, x0:x1 + 1].all():
            y1 += step; grew = True
    return [x0, y0, x1 - x0 + 1, y1 - y0 + 1]


def cleanup_patch(img: np.ndarray, info: BubbleInfo, boxes, lh: float) -> tuple[str, list[int]] | None:
    """Mask only the glyph pixels inside the bubble and paint them with the fill.

    Outline, tail and anything outside the text lines are left untouched.
    """
    x0, y0, x1, y1 = info.window
    sub = img[y0:y1, x0:x1].astype(np.int16)
    ink = np.abs(sub - info.bg.astype(np.int16)).max(axis=2) >= 28
    near_text = np.zeros(ink.shape, bool)
    pad = max(2, int(lh * 0.2))
    for b in boxes:
        sx0, sy0, sx1, sy1 = _clip_box(b[0] - x0 - pad, b[1] - y0 - pad, b[2] - x0 + pad, b[3] - y0 + pad, x1 - x0, y1 - y0)
        near_text[sy0:sy1, sx0:sx1] = True
    erode = max(2, int(lh * 0.08))
    safe = cv2.erode(info.component.astype(np.uint8), np.ones((2 * erode + 1, 2 * erode + 1), np.uint8)) > 0
    mask = ink & near_text & safe
    if not mask.any():
        return None
    d = max(1, int(lh * 0.06))
    mask = cv2.dilate(mask.astype(np.uint8), np.ones((2 * d + 1, 2 * d + 1), np.uint8)) > 0
    mask &= safe
    # Refuse if the mask would cover too much of the bubble (likely art, not text).
    if mask.sum() > 0.6 * info.component.sum():
        return None
    ys, xs = np.nonzero(mask)
    px0, py0, px1, py1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    m = mask[py0:py1, px0:px1]
    # Continue the surroundings into the erased glyphs (texture/gradients) rather
    # than painting a flat blotch; ink outside the mask is never a source.
    src = img[y0:y1, x0:x1].copy()
    other_ink = (np.abs(sub - info.bg.astype(np.int16)).max(axis=2) >= 28) & ~mask
    src[other_ink] = info.bg.astype(np.uint8)
    filled_px = cv2.inpaint(src, mask.astype(np.uint8), 3, cv2.INPAINT_TELEA)
    rgba = np.zeros((py1 - py0, px1 - px0, 4), np.uint8)
    rgba[..., :3] = filled_px[py0:py1, px0:px1]
    rgba[..., 3] = np.where(m, 255, 0).astype(np.uint8)
    return _png_data_url(rgba), [int(px0 + x0), int(py0 + y0), int(px1 - px0), int(py1 - py0)]


# ---------------------------------------------------------------- style

def estimate_style(img: np.ndarray, lines: list[TextLine], bg_hint: np.ndarray | None) -> Style:
    h, w = img.shape[:2]
    boxes = [l.bbox for l in lines]
    x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
    cx0, cy0, cx1, cy1 = _clip_box(x0, y0, x1, y1, w, h)
    sub = img[cy0:cy1, cx0:cx1]
    lh = float(np.median([l.height for l in lines]))
    style = Style(font_px=round(lh * 0.78, 1), angle=round(float(np.median([l.angle for l in lines])), 1))
    if sub.size == 0:
        return style
    gray = cv2.cvtColor(sub, cv2.COLOR_RGB2GRAY)
    if bg_hint is not None:
        diff = np.abs(sub.astype(np.int16) - bg_hint.astype(np.int16)).max(axis=2)
        cand = diff >= 40
        lum_px = sub[..., 0] * 0.299 + sub[..., 1] * 0.587 + sub[..., 2] * 0.114
        bg_l = _lum(bg_hint)
        lighter = cand & (lum_px > bg_l)
        # Keep the dominant contrast direction only (textured boxes contain both).
        ink = lighter if lighter.sum() >= (cand & ~lighter).sum() else cand & ~lighter
    else:
        _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        # Minority class = ink.
        ink = th == 0 if (th == 0).mean() < 0.5 else th == 255
    if ink.sum() < 10:
        return style
    # Text colour: the "core" of the strokes (eroded ink) to skip outlines.
    core = cv2.erode(ink.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    src = core if core.sum() > 20 else ink
    if bg_hint is not None:
        d = np.abs(sub.astype(np.int16) - bg_hint.astype(np.int16)).max(axis=2)
        strong = src & (d >= np.median(d[src]))
        src = strong if strong.any() else src
    fg = np.median(sub[src], axis=0)
    style.fg = _hex(fg)
    # Outline: pixels just outside the core that differ from both fg and bg.
    ring = (cv2.dilate(src.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & ~src
    if ring.sum() > 20:
        rc = np.median(sub[ring], axis=0)
        bgc = bg_hint if bg_hint is not None else np.median(sub[~ink], axis=0) if (~ink).any() else rc
        blend = np.abs(rc - (fg + bgc) / 2).max()  # halfway colour = anti-aliasing, not an outline
        if np.abs(rc - fg).max() > 60 and np.abs(rc - bgc).max() > 40 and blend > 40:
            style.outline = _hex(rc)
            style.outline_px = round(max(1.0, lh * 0.06), 1)
    # Weight from stroke thickness (distance transform of the ink mask).
    dt = cv2.distanceTransform(ink.astype(np.uint8), cv2.DIST_L2, 3)
    stroke = 2 * float(np.percentile(dt[ink], 90)) if ink.any() else 0
    style.weight = 800 if stroke > 0.16 * lh else 700 if stroke > 0.11 * lh else 500
    # Alignment: compare spread of left edges vs centres.
    if len(lines) > 1:
        lefts = np.std([b[0] for b in boxes]); centers = np.std([(b[0] + b[2]) / 2 for b in boxes])
        style.align = "left" if lefts + 2 < centers else "center"
    if (y1 - y0) > 2.2 * (x1 - x0) and len(lines) == 1 and lines[0].height > 0 and (y1 - y0) / max(1, lines[0].height) > 2.5:
        style.orientation = "vertical"
    return style


# ---------------------------------------------------------------- classification

def classify(lines: list[TextLine], info: BubbleInfo | None, page_median_h: float, text: str, lang: str,
             conf: float, sfx_hint: bool) -> tuple[str, list[str]]:
    flags: list[str] = []
    lh = float(np.median([l.height for l in lines]))
    angle = abs(float(np.median([l.angle for l in lines])))
    chars = len(re.sub(r"\s|[!?.,~…\-]", "", text))
    big = lh > 2.2 * page_median_h if page_median_h else False
    if not text.strip() or not script_ok(text, lang):
        flags.append("no-source-script")
    if conf < 0.35:
        flags.append("low-confidence")
    if angle > 12:
        flags.append("rotated")
    flat = info is not None
    sfx_like = (big and chars <= 6) or (angle > 12 and chars <= 8) or (sfx_hint and not (info and info.enclosed))
    if sfx_like and (not flat or big or angle > 12):
        return "sfx", flags
    if "no-source-script" in flags or ("low-confidence" in flags and not flat):
        return "uncertain", flags
    if info is not None and info.enclosed:
        return ("narration" if info.bubble.shape == "rect" else "dialogue"), flags
    if flat:
        return "narration", flags
    return "dialogue", flags + ["on-artwork"]


# ---------------------------------------------------------------- annotations

def place_annotation(img: np.ndarray, sfx_box, cap_w: int, cap_h: int, avoid: list[list[int]]) -> tuple[list[int] | None, float]:
    """Find a calm spot next to a sound effect for a small caption.

    Scores candidate boxes by edge density (busy art, faces, details) and by
    overlap with other text. Returns (box or None, score).
    """
    h, w = img.shape[:2]
    x, y, bw, bh = sfx_box
    gap = max(6, int(min(bw, bh) * 0.08))
    cands = [
        (x + bw + gap, y + (bh - cap_h) // 2), (x - cap_w - gap, y + (bh - cap_h) // 2),
        (x + (bw - cap_w) // 2, y + bh + gap), (x + (bw - cap_w) // 2, y - cap_h - gap),
        (x + bw - cap_w // 2, y + bh - cap_h // 2), (x - cap_w // 2, y - cap_h // 2),
        (x + bw - cap_w // 2, y - cap_h // 2), (x - cap_w // 2, y + bh - cap_h // 2),
    ]
    best, best_s = None, 1e9
    for cx, cy in cands:
        if cx < 0 or cy < 0 or cx + cap_w > w or cy + cap_h > h:
            continue
        patch = cv2.cvtColor(img[cy:cy + cap_h, cx:cx + cap_w], cv2.COLOR_RGB2GRAY)
        edges = cv2.Canny(patch, 60, 160)
        s = edges.mean() / 255.0
        for a in avoid:
            inter = max(0, min(cx + cap_w, a[0] + a[2]) - max(cx, a[0])) * max(0, min(cy + cap_h, a[1] + a[3]) - max(cy, a[1]))
            s += 2.0 * inter / float(cap_w * cap_h)
        if s < best_s:
            best, best_s = [int(cx), int(cy), int(cap_w), int(cap_h)], s
    return best, best_s


def region_id(image_sha: str, bbox) -> str:
    return "r" + hashlib.sha1(f"{image_sha}:{','.join(str(int(v)) for v in bbox)}".encode()).hexdigest()[:10]


def _iou(a, b) -> float:
    ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union else 0.0


def merge_shared_containers(groups: list[list[TextLine]], containers: list[list[int] | None]) -> list[list[TextLine]]:
    """Blocks inside the same enclosed bubble/box become one block (one render box)."""
    parent = list(range(len(groups)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(groups)):
        for j in range(i + 1, len(groups)):
            a, b = containers[i], containers[j]
            if a is not None and b is not None and _iou(a, b) > 0.7:
                parent[find(i)] = find(j)
    merged: dict[int, list[TextLine]] = {}
    for i, g in enumerate(groups):
        merged.setdefault(find(i), []).extend(g)
    return [sort_lines(g) for g in merged.values()]


def separate_render_boxes(regions) -> None:
    """A region's drawing box must never cover another region's text."""
    for r in regions:
        if r.render_mode in ("marker", "hidden", "annotate"):
            continue
        x, y, w, h = r.render_box
        x0, y0, x1, y1 = x, y, x + w, y + h
        for o in regions:
            if o is r:
                continue
            ox0, oy0 = o.bbox[0], o.bbox[1]
            ox1, oy1 = ox0 + o.bbox[2], oy0 + o.bbox[3]
            if min(x1, ox1) <= max(x0, ox0) or min(y1, oy1) <= max(y0, oy0):
                continue
            # Cut along the axis with the clearer separation from our own text.
            rx0, ry0 = r.bbox[0], r.bbox[1]
            rx1, ry1 = rx0 + r.bbox[2], ry0 + r.bbox[3]
            if oy0 >= ry1:
                y1 = min(y1, oy0 - 2)
            elif oy1 <= ry0:
                y0 = max(y0, oy1 + 2)
            elif ox0 >= rx1:
                x1 = min(x1, ox0 - 2)
            elif ox1 <= rx0:
                x0 = max(x0, ox1 + 2)
        # Never smaller than our own text box.
        x0, y0 = min(x0, r.bbox[0]), min(y0, r.bbox[1])
        x1, y1 = max(x1, r.bbox[0] + r.bbox[2]), max(y1, r.bbox[1] + r.bbox[3])
        r.render_box = [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]
    # Drawing boxes must not overlap each other either: split between the texts.
    drawn = [r for r in regions if r.render_mode not in ("marker", "hidden", "annotate")]
    for i in range(len(drawn)):
        for j in range(i + 1, len(drawn)):
            a, b = drawn[i], drawn[j]
            A = [a.render_box[0], a.render_box[1], a.render_box[0] + a.render_box[2], a.render_box[1] + a.render_box[3]]
            B = [b.render_box[0], b.render_box[1], b.render_box[0] + b.render_box[2], b.render_box[1] + b.render_box[3]]
            if min(A[2], B[2]) <= max(A[0], B[0]) or min(A[3], B[3]) <= max(A[1], B[1]):
                continue
            at = [a.bbox[0], a.bbox[1], a.bbox[0] + a.bbox[2], a.bbox[1] + a.bbox[3]]
            bt = [b.bbox[0], b.bbox[1], b.bbox[0] + b.bbox[2], b.bbox[1] + b.bbox[3]]
            if at[2] <= bt[0] or bt[2] <= at[0]:
                l, rr, lt, rt = (A, B, at, bt) if at[2] <= bt[0] else (B, A, bt, at)
                mid = (lt[2] + rt[0]) // 2
                l[2] = max(lt[2], min(l[2], mid - 1)); rr[0] = min(rt[0], max(rr[0], mid + 1))
            else:
                t, bo, tt, btt = (A, B, at, bt) if at[3] <= bt[1] else (B, A, bt, at)
                mid = (tt[3] + btt[1]) // 2
                t[3] = max(tt[3], min(t[3], mid - 1)); bo[1] = min(btt[1], max(bo[1], mid + 1))
            a.render_box = [int(A[0]), int(A[1]), int(A[2] - A[0]), int(A[3] - A[1])]
            b.render_box = [int(B[0]), int(B[1]), int(B[2] - B[0]), int(B[3] - B[1])]
