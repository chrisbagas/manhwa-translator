"""Tiling of very tall images: coverage, overlap merging, boundary reprocessing."""

from __future__ import annotations

import numpy as np

from dalbit.tiling import Candidate, TileConfig, detect_tiled, merge_candidates, plan_tiles


def test_plan_tiles_covers_whole_strip_with_overlap():
    cfg = TileConfig(tile_h=1600, overlap=256)
    for height in (100, 1600, 1601, 5000, 30000):
        tiles = plan_tiles(height, cfg)
        assert tiles[0].y0 == 0 and tiles[-1].y1 == height
        for a, b in zip(tiles, tiles[1:]):
            assert b.y0 < a.y1, "consecutive tiles must overlap"
            assert a.y1 - b.y0 >= 256 or b.y1 == height
        assert all(t.y1 - t.y0 <= 1600 for t in tiles), "tiles must stay bounded"


def _quad(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def test_merge_prefers_complete_detection_over_cut_duplicate():
    full = Candidate(_quad(100, 1500, 300, 1550), 0.9, touches_cut=False)
    cut = Candidate(_quad(100, 1500, 300, 1520), 0.9, touches_cut=True)
    other = Candidate(_quad(400, 100, 500, 140), 0.9, touches_cut=False)
    kept = merge_candidates([cut, full, other])
    assert len(kept) == 2
    assert full in kept and other in kept


class FakeDetector:
    """Returns ground-truth boxes clipped to the window, like a real detector
    sees text that is cut by the window edge."""

    def __init__(self, boxes):
        self.boxes = boxes
        self.calls = []

    def __call__(self, window: np.ndarray):
        # The window's absolute offset is recovered from a marker column.
        y_off = int(window[0, 0, 0]) * 256 + int(window[0, 0, 1])
        h = window.shape[0]
        self.calls.append((y_off, h))
        out = []
        for x0, y0, x1, y1 in self.boxes:
            cy0, cy1 = max(y0, y_off), min(y1, y_off + h)
            if cy1 - cy0 > 4:
                out.append((_quad(x0, cy0 - y_off, x1, cy1 - y_off), 0.9))
        return out


def _marker_image(height: int, width: int = 64) -> np.ndarray:
    img = np.zeros((height, width, 3), np.uint8)
    rows = np.arange(height)
    img[:, 0, 0] = rows // 256
    img[:, 0, 1] = rows % 256
    return img


def test_text_across_tile_edge_detected_once_with_full_extent():
    cfg = TileConfig(tile_h=1000, overlap=200, max_det_width=4000)
    # Line straddles the first cut (tile 0 ends at 1000, tile 1 starts at 800).
    boxes = [(10, 950, 50, 1010), (10, 300, 50, 340), (10, 1700, 50, 1740)]
    det = FakeDetector(boxes)
    merged, stats = detect_tiled(_marker_image(2500), det, cfg)
    ys = sorted((round(c.box[1]), round(c.box[3])) for c in merged)
    assert ys == [(300, 340), (950, 1010), (1700, 1740)]
    assert stats["tiles"] == 3


def test_text_taller_than_overlap_is_reprocessed():
    cfg = TileConfig(tile_h=1000, overlap=100, max_det_width=4000)
    # A 300 px tall sound effect crossing the cut at y=1000 (overlap is only 100 px):
    # no single tile contains it, so a re-centred window must recover it.
    boxes = [(10, 850, 60, 1150)]
    det = FakeDetector(boxes)
    merged, stats = detect_tiled(_marker_image(3000), det, cfg)
    assert stats["reprocessed"] >= 1
    assert len(merged) == 1
    x0, y0, x1, y1 = merged[0].box
    assert (round(y0), round(y1)) == (850, 1150)


def test_cancel_stops_between_tiles():
    cfg = TileConfig(tile_h=1000, overlap=100, max_det_width=4000)
    det = FakeDetector([])
    calls = {"n": 0}

    class Stop(Exception):
        pass

    def check():
        calls["n"] += 1
        if calls["n"] > 2:
            raise Stop()

    try:
        detect_tiled(_marker_image(10000), det, cfg, check_cancel=check)
    except Stop:
        pass
    assert len(det.calls) == 2, "work must stop at the next tile checkpoint"
