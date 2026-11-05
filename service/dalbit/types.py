"""Structured data shared by every pipeline stage.

Coordinates are always in ORIGINAL image pixels (x right, y down), even when a
stage works on a tile or a resized copy. Each stage maps its results back.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

Kind = Literal["dialogue", "narration", "sfx", "uncertain"]
Quad = list[list[float]]  # 4 points, clockwise from top-left


@dataclass
class TextLine:
    """One detected + recognised line of text."""

    quad: Quad
    text: str = ""
    confidence: float = 0.0  # recognition confidence 0..1 (provider-specific scale)
    det_score: float = 0.0
    angle: float = 0.0  # degrees, positive = counter-clockwise (text tilts up to the right)

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        xs = [p[0] for p in self.quad]
        ys = [p[1] for p in self.quad]
        return min(xs), min(ys), max(xs), max(ys)

    @property
    def height(self) -> float:
        x0, y0, x1, y1 = self.bbox
        import math

        # Height measured perpendicular to the baseline.
        (ax, ay), (bx, by), _, (dx, dy) = self.quad
        side = math.hypot(dx - ax, dy - ay)
        return side if side > 0 else y1 - y0


@dataclass
class Style:
    """Estimated lettering style, used to render a visually compatible overlay."""

    fg: str = "#111111"  # text colour
    outline: str | None = None  # outline colour, None = no visible outline
    outline_px: float = 0.0  # outline thickness in image px
    font_px: float = 24.0  # glyph height of the ORIGINAL text, image px
    weight: int = 600
    align: Literal["left", "center", "right"] = "center"
    orientation: Literal["horizontal", "vertical"] = "horizontal"
    angle: float = 0.0


@dataclass
class Bubble:
    """Container the text lives in (speech bubble / narration box), if found."""

    bbox: list[int]  # outer bounds [x, y, w, h]
    interior: list[int]  # safe text area [x, y, w, h] (inset from the border)
    fill: str  # background colour
    flat: bool  # True when the background around the text is uniform
    shape: Literal["ellipse", "rect", "free", "none"] = "free"


@dataclass
class Region:
    """A coherent text block (bubble / narration / sound effect)."""

    id: str
    order: int
    kind: Kind
    bbox: list[int]  # union of line boxes [x, y, w, h]
    polygon: Quad
    angle: float
    lines: list[TextLine]
    source_text: str
    confidence: float
    translated_text: str = ""
    translation_note: str = ""  # e.g. "sfx-lexicon", "glossary", "untranslated"
    style: Style = field(default_factory=Style)
    bubble: Bubble | None = None
    # Non-destructive cleanup: a PNG patch (data URL) to place at patch_box that
    # covers ONLY the original text pixels with the bubble fill. None = keep art.
    patch: str | None = None
    patch_box: list[int] | None = None
    # Where to draw: for bubbles the interior, for SFX a nearby annotation box.
    render_box: list[int] = field(default_factory=list)
    render_mode: Literal["replace", "overlay", "annotate", "marker"] = "overlay"
    flags: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        d = asdict(self)
        for ln, line in zip(d["lines"], self.lines):
            ln["bbox"] = [round(v, 1) for v in line.bbox]
        return d


@dataclass
class PageResult:
    image_sha256: str
    width: int
    height: int
    source_lang: str
    target_lang: str
    regions: list[Region]
    models: dict[str, str]
    timings_ms: dict[str, float]
    cache: dict[str, bool]
    warnings: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "imageSha256": self.image_sha256,
            "width": self.width,
            "height": self.height,
            "sourceLang": self.source_lang,
            "targetLang": self.target_lang,
            "regions": [r.to_json() for r in self.regions],
            "models": self.models,
            "timingsMs": self.timings_ms,
            "cache": self.cache,
            "warnings": self.warnings,
        }
