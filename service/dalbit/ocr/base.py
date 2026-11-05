"""OCR provider interfaces.

Detection and recognition are deliberately separate so a fast generic detector
can be paired with a language-specific recogniser (e.g. Korean today,
Japanese / Chinese later).
"""

from __future__ import annotations

import math
from typing import Protocol

import cv2
import numpy as np

from ..types import Quad


class TextDetector(Protocol):
    name: str
    version: str

    def detect(self, img: np.ndarray) -> list[tuple[Quad, float]]:
        """Return text-line quads (image coords of `img`) with detector scores."""


class TextRecognizer(Protocol):
    name: str
    version: str
    languages: tuple[str, ...]

    def recognize(self, crops: list[np.ndarray]) -> list[tuple[str, float]]:
        """Recognise horizontal single-line crops. Returns (text, confidence)."""


def order_quad(pts: np.ndarray) -> np.ndarray:
    """Order 4 points clockwise from top-left."""
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    tl, br = pts[np.argmin(s)], pts[np.argmax(s)]
    tr, bl = pts[np.argmin(d)], pts[np.argmax(d)]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def quad_angle(quad: Quad) -> float:
    """Baseline angle in degrees; positive = rising to the right (CCW on screen)."""
    (x0, y0), (x1, y1) = quad[0], quad[1]
    return -math.degrees(math.atan2(y1 - y0, x1 - x0))


def crop_quad(img: np.ndarray, quad: Quad, pad: float = 0.0) -> np.ndarray:
    """Perspective-crop a (possibly rotated) text quad to a horizontal strip."""
    pts = order_quad(np.array(quad))
    if pad:
        c = pts.mean(axis=0)
        pts = c + (pts - c) * (1 + pad)
    w = int(max(np.linalg.norm(pts[0] - pts[1]), np.linalg.norm(pts[3] - pts[2])))
    h = int(max(np.linalg.norm(pts[0] - pts[3]), np.linalg.norm(pts[1] - pts[2])))
    w, h = max(w, 4), max(h, 4)
    dst = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
    m = cv2.getPerspectiveTransform(pts, dst)
    return cv2.warpPerspective(img, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
