"""Grouping, reading order, bubble detection and non-destructive cleanup."""

from __future__ import annotations

import base64
import io

import numpy as np
from PIL import Image

from dalbit import layout
from dalbit.types import TextLine
from tests.conftest import load_gt


def _line(x0, y0, x1, y1, text="가", angle=0.0):
    return TextLine(quad=[[x0, y0], [x1, y0], [x1, y1], [x0, y1]], text=text, confidence=0.9, angle=angle)


def test_reading_order_rows_then_left_to_right_for_korean():
    boxes = [(500, 100, 700, 200), (50, 120, 250, 210), (100, 600, 400, 700), (60, 20, 300, 60)]
    assert layout.reading_order(boxes, rtl=False) == [3, 1, 0, 2]


def test_reading_order_right_to_left_for_japanese():
    boxes = [(500, 100, 700, 200), (50, 120, 250, 210)]
    assert layout.reading_order(boxes, rtl=True) == [0, 1]


def test_group_lines_keeps_side_by_side_bubbles_apart():
    lines = [_line(100, 100, 250, 140, "A1"), _line(110, 150, 240, 190, "A2"),
             _line(420, 110, 600, 150, "B1"), _line(430, 160, 590, 200, "B2")]
    groups = layout.group_lines(lines, {i: None for i in range(4)})
    texts = sorted(" ".join(l.text for l in g) for g in groups)
    assert texts == ["A1 A2", "B1 B2"]


def test_sort_lines_orders_rows_top_to_bottom():
    a = _line(100, 300, 200, 340, "second")
    b = _line(90, 250, 210, 290, "first")
    c = _line(220, 302, 300, 338, "second-b")
    assert [l.text for l in layout.sort_lines([a, c, b])] == ["first", "second", "second-b"]


def test_find_bubble_detects_ellipse_and_cleanup_spares_outline(fixtures):
    gt = load_gt(fixtures, "dialogue_single")
    img = np.asarray(Image.open(fixtures / "dialogue_single.png").convert("RGB"))
    block = gt["blocks"][0]
    tx, ty, tw, th = block["text_box"]
    # Two "detected" lines covering the text box halves.
    boxes = [(tx, ty, tx + tw, ty + th / 2), (tx, ty + th / 2, tx + tw, ty + th)]
    info = layout.find_bubble(img, boxes)
    assert info is not None and info.enclosed
    assert info.bubble.shape in ("ellipse", "free")
    bx, by, bw, bh = block["box"]
    fb = info.bubble.bbox
    assert abs(fb[0] - bx) < 12 and abs(fb[2] - bw) < 24, (fb, block["box"])
    ix, iy, iw, ih = info.bubble.interior
    assert ix >= bx and iy >= by and ix + iw <= bx + bw and iy + ih <= by + bh

    patch = layout.cleanup_patch(img, info, boxes, th / 2)
    assert patch is not None
    url, (px, py, pw, ph) = patch
    rgba = np.asarray(Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))))
    painted = rgba[..., 3] > 0
    # Every painted pixel must lie on a pixel that is NOT the dark outline,
    # i.e. strictly inside the bubble's white interior / text.
    cx, cy = bx + bw / 2, by + bh / 2
    ys, xs = np.nonzero(painted)
    ex = ((xs + px - cx) / (bw / 2)) ** 2 + ((ys + py - cy) / (bh / 2)) ** 2
    assert ex.max() < 0.95, "cleanup mask reached the bubble outline"
    # And the patch fills with the bubble's own colour (white).
    assert (rgba[painted][:, :3] > 240).all()


def test_find_bubble_refuses_textured_background():
    rng = np.random.default_rng(0)
    img = rng.integers(0, 255, (400, 400, 3), dtype=np.uint8)
    assert layout.find_bubble(img, [(150, 180, 250, 220)]) is None


def test_sfx_on_open_background_is_not_an_enclosed_bubble(fixtures):
    gt = load_gt(fixtures, "sfx_rotated")
    img = np.asarray(Image.open(fixtures / "sfx_rotated.png").convert("RGB"))
    sfx = [b for b in gt["blocks"] if b["kind"] == "sfx"][0]
    x, y, w, h = sfx["box"]
    info = layout.find_bubble(img, [(x, y, x + w, y + h)])
    assert info is None or not info.enclosed


def test_narration_box_is_rect(fixtures):
    gt = load_gt(fixtures, "multi_bubbles")
    img = np.asarray(Image.open(fixtures / "multi_bubbles.png").convert("RGB"))
    nar = [b for b in gt["blocks"] if b["kind"] == "narration"][0]
    tx, ty, tw, th = nar["text_box"]
    info = layout.find_bubble(img, [(tx, ty, tx + tw, ty + th)])
    assert info is not None and info.enclosed and info.bubble.shape == "rect"
    assert info.bubble.fill.lower() != "#ffffff"


def test_place_annotation_avoids_busy_art():
    img = np.full((600, 600, 3), 255, np.uint8)
    # Busy hatching to the right of the effect; calm space to the left.
    for x in range(380, 600, 4):
        img[:, x] = 0
    box, score = layout.place_annotation(img, [200, 250, 150, 100], 120, 30, [])
    assert box is not None
    assert box[0] + box[2] <= 380, f"annotation placed on busy art: {box}"
    assert score < 0.1
