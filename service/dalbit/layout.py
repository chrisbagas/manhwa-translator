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

ANALYSIS_VERSION = "layout-3"

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
    if ba is not None and bb is not None:
        return ba == bb  # both inside detected bubbles: bubble identity decides
    if (ba is None) != (bb is None):
        return False
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
        return abs(a.cx - b.cx) < 0.75 * max(a.x1 - a.x0, b.x1 - b.x0) or abs(a.x0 - b.x0) < hmax
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
    if (dist < tol).mean() < 0.85:
        return None  # textured / illustrated background

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
    rgba = np.zeros((py1 - py0, px1 - px0, 4), np.uint8)
    rgba[..., :3] = info.bg.astype(np.uint8)
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
        ink = np.abs(sub.astype(np.int16) - bg_hint.astype(np.int16)).max(axis=2) >= 40
    else:
        _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        # Minority class = ink.
        ink = th == 0 if (th == 0).mean() < 0.5 else th == 255
    if ink.sum() < 10:
        return style
    # Text colour: the "core" of the strokes (eroded ink) to skip outlines.
    core = cv2.erode(ink.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    src = core if core.sum() > 20 else ink
    fg = np.median(sub[src], axis=0)
    style.fg = _hex(fg)
    # Outline: pixels just outside the core that differ from both fg and bg.
    ring = (cv2.dilate(src.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & ~src
    if ring.sum() > 20:
        rc = np.median(sub[ring], axis=0)
        bgc = bg_hint if bg_hint is not None else np.median(sub[~ink], axis=0) if (~ink).any() else rc
        if np.abs(rc - fg).max() > 60 and np.abs(rc - bgc).max() > 40:
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
