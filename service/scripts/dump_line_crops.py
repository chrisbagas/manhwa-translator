"""Dump detected text-line crops (+ the default recogniser's reading) for OCR comparisons.

    python scripts/dump_line_crops.py OUT_DIR image...

Writes OUT_DIR/<image>/NNN.png and OUT_DIR/index.json:
{image: [{"file", "box", "korean_g2", "conf"}...]} in reading order.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dalbit import layout  # noqa: E402
from dalbit.config import Config  # noqa: E402
from dalbit.ocr.base import crop_quad  # noqa: E402
from dalbit.pipeline import Engine  # noqa: E402
from dalbit.tiling import detect_tiled  # noqa: E402
from dalbit.types import TextLine  # noqa: E402


def main() -> int:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    eng = Engine(Config())
    index = {}
    for p in map(Path, sys.argv[2:]):
        img = np.asarray(Image.open(p).convert("RGB"))
        cands, _ = detect_tiled(img, eng.detector.detect, eng.tiles)
        lines = [TextLine(quad=c.quad) for c in cands if (c.box[3] - c.box[1]) >= 8]
        lines = [l for l in lines if layout.line_contrast(img, l) >= layout.MIN_LINE_CONTRAST]
        lines = layout.sort_lines(lines)
        d = out / p.stem
        d.mkdir(exist_ok=True)
        rows = []
        for i, l in enumerate(lines):
            crop = layout.trim_faint(crop_quad(img, l.quad))
            f = d / f"{i:03d}.png"
            Image.fromarray(crop).save(f)
            text, conf = eng.recognizer.recognize([crop])[0]
            rows.append({"file": str(f), "box": [round(v) for v in l.bbox], "korean_g2": text, "conf": round(conf, 3)})
        index[p.stem] = rows
        print(p.stem, len(rows))
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
