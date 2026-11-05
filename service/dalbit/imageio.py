"""Safe image decoding with resource limits."""

from __future__ import annotations

import hashlib
import io
import warnings

import numpy as np
from PIL import Image, ImageOps

ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP", "GIF", "BMP", "AVIF"}


class ImageRejected(ValueError):
    """The upload is not an image we are willing to decode."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def decode(data: bytes, *, max_pixels: int, max_side: int) -> np.ndarray:
    """Decode to an RGB uint8 array, refusing oversized or unexpected input.

    The header is inspected before pixels are decoded, so decompression bombs
    are rejected without allocating the full bitmap.
    """
    if not data:
        raise ImageRejected("empty body")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            img = Image.open(io.BytesIO(data))
        except Exception as exc:  # noqa: BLE001 - Pillow raises many types
            raise ImageRejected(f"not a decodable image ({type(exc).__name__})") from exc
        if img.format not in ALLOWED_FORMATS:
            raise ImageRejected(f"unsupported image format {img.format}")
        w, h = img.size
        if w < 16 or h < 16:
            raise ImageRejected(f"image too small ({w}x{h})")
        if w > max_side or h > max_side or w * h > max_pixels:
            raise ImageRejected(f"image too large ({w}x{h}); limit {max_pixels} px, {max_side} px per side")
        Image.MAX_IMAGE_PIXELS = max_pixels
        try:
            img.seek(0)  # first frame of animated GIF/WebP
            img = ImageOps.exif_transpose(img)
            if img.mode in ("RGBA", "LA", "P"):
                img = img.convert("RGBA")
                bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
                img = Image.alpha_composite(bg, img)
            rgb = img.convert("RGB")
        except Image.DecompressionBombError as exc:
            raise ImageRejected("image too large") from exc
        except Exception as exc:  # noqa: BLE001
            raise ImageRejected(f"failed to decode image ({type(exc).__name__})") from exc
    return np.asarray(rgb)
