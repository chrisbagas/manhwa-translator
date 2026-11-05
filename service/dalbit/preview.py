"""Render a translated page to a PNG with Pillow (CLI preview / tests).

The browser extension does the real, non-destructive rendering with HTML; this
mirrors its rules closely enough to eyeball results and to test fitting.
"""

from __future__ import annotations

import base64
import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_DIR = Path(__file__).resolve().parents[2] / "extension" / "assets" / "fonts"
FONTS = {
    "dialogue": FONT_DIR / "ComicNeue-Bold.ttf",
    "narration": FONT_DIR / "AtkinsonHyperlegible-Regular.ttf",
    "sfx": FONT_DIR / "Bangers-Regular.ttf",
    "uncertain": FONT_DIR / "AtkinsonHyperlegible-Regular.ttf",
}
MIN_PX = 11


def wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: float) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=font) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def fit(draw, text: str, font_path: Path, box_w: float, box_h: float, start_px: float, min_px: float = MIN_PX):
    """Largest size (<= start_px) at which wrapped text fits; (font, lines, fits)."""
    size = int(max(min_px, start_px))
    while True:
        font = ImageFont.truetype(str(font_path), size)
        lines = wrap(draw, text, font, box_w)
        lh = size * 1.15
        widest = max((draw.textlength(l, font=font) for l in lines), default=0)
        if (len(lines) * lh <= box_h and widest <= box_w) or size <= min_px:
            return font, lines, len(lines) * lh <= box_h and widest <= box_w
        size -= 1


def render(image_path: Path, result: dict, out_path: Path, text_scale: float = 1.0) -> None:
    img = Image.open(image_path).convert("RGBA")
    draw = ImageDraw.Draw(img)
    for r in result["regions"]:
        mode = r.get("render_mode")
        text = r.get("translated_text") or ""
        if mode == "hidden":
            continue
        if r.get("patch") and mode == "replace":
            raw = base64.b64decode(r["patch"].split(",", 1)[1])
            patch = Image.open(io.BytesIO(raw)).convert("RGBA")
            img.alpha_composite(patch, tuple(r["patch_box"][:2]))
        x, y, w, h = r["render_box"]
        font_path = FONTS.get(r["kind"], FONTS["dialogue"])
        style = r.get("style") or {}
        if mode in ("replace", "overlay"):
            pad = max(2, int(h * 0.06))
            start = max(MIN_PX, style.get("font_px", 24) * 1.05 * text_scale)
            font, lines, ok = fit(draw, text, font_path, w - 2 * pad, h - 2 * pad, start)
            lh = font.size * 1.15
            ty = y + (h - len(lines) * lh) / 2
            if mode == "overlay" or not ok:
                bh = max(h, len(lines) * lh + 2 * pad)
                draw.rounded_rectangle([x, ty - pad, x + w, ty - pad + bh], radius=6, fill=(255, 255, 255, 225))
            fg = style.get("fg", "#111111") if mode == "replace" else "#111111"
            for i, line in enumerate(lines):
                draw.text((x + w / 2, ty + i * lh + lh / 2), line, font=font, fill=fg, anchor="mm")
        elif mode == "annotate":
            font, lines, _ = fit(draw, text, FONTS["sfx"], w - 8, h - 4, h * 0.8)
            draw.rounded_rectangle([x, y, x + w, y + h], radius=h // 3, fill=(255, 255, 255, 230), outline=style.get("fg", "#000"), width=2)
            draw.text((x + w / 2, y + h / 2), " ".join(lines), font=font, fill="#111", anchor="mm")
        elif mode == "marker":
            draw.ellipse([x, y, x + w, y + h], fill=(255, 210, 0, 230), outline="#000", width=2)
            draw.text((x + w / 2, y + h / 2), "?", font=ImageFont.truetype(str(FONTS["sfx"]), int(h * 0.7)), fill="#000", anchor="mm")
    img.convert("RGB").save(out_path)
