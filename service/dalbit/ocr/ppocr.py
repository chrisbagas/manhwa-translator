"""PaddleOCR models run through RapidOCR's ONNX Runtime pipeline (Apache-2.0).

* Detection: PP-OCRv6 small detector, shipped inside the `rapidocr` wheel, so it
  needs no extra download. Detection is script-agnostic and works on Hangul.
* Recognition (optional): the official `korean_PP-OCRv5_rec_mobile` ONNX
  export. NOTE: the newest PP-OCRv6 recogniser does NOT include Hangul (its
  dictionary has zero Hangul syllables), so Korean needs this v5 model.
"""

from __future__ import annotations

import threading
from pathlib import Path

import numpy as np

from ..types import Quad

KOREAN_V5_SHA256 = "cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b"


def _quiet_params(extra: dict) -> dict:
    return {"Global.log_level": "error", **extra}


class PPOCRDetector:
    name = "ppocr-det"

    def __init__(self, *, limit_side_len: int = 1600, box_thresh: float = 0.5, unclip_ratio: float = 1.6, threads: int = 0):
        from rapidocr import RapidOCR
        import rapidocr

        params = {
            "Global.use_cls": False,
            "Global.use_rec": False,
            "Global.max_side_len": 4000,
            "Det.limit_type": "max",
            "Det.limit_side_len": limit_side_len,
            "Det.box_thresh": box_thresh,
            "Det.unclip_ratio": unclip_ratio,
        }
        if threads:
            params["EngineConfig.onnxruntime.intra_op_num_threads"] = threads
        self._engine = RapidOCR(params=_quiet_params(params))
        self._lock = threading.Lock()
        self.version = f"PP-OCRv6_det_small@rapidocr-{rapidocr.__version__ if hasattr(rapidocr, '__version__') else 'x'}/l{limit_side_len}"

    def detect(self, img: np.ndarray) -> list[tuple[Quad, float]]:
        with self._lock:
            out = self._engine(img, use_det=True, use_cls=False, use_rec=False)
        if out.boxes is None or len(out.boxes) == 0:
            return []
        scores = out.scores if out.scores is not None else [1.0] * len(out.boxes)
        return [([[float(x), float(y)] for x, y in box], float(s)) for box, s in zip(out.boxes, scores)]


class PPOCRKoreanRecognizer:
    """Optional recogniser; requires models/ppocr/korean_PP-OCRv5_rec_mobile.onnx."""

    name = "ppocr-korean-v5"
    languages = ("ko", "en")

    def __init__(self, model_path: Path):
        from rapidocr import RapidOCR

        if not model_path.exists():
            raise FileNotFoundError(f"{model_path} missing; run scripts/download_models.py --ppocr-korean")
        self._engine = RapidOCR(params=_quiet_params({
            "Global.use_det": False,
            "Global.use_cls": False,
            "Rec.model_path": str(model_path),
            "Rec.lang_type": "korean",
            "Rec.ocr_version": "PP-OCRv5",
            "Rec.model_type": "mobile",
        }))
        self._lock = threading.Lock()
        self.version = f"korean_PP-OCRv5_rec_mobile:{KOREAN_V5_SHA256[:12]}"

    def recognize(self, crops: list[np.ndarray]) -> list[tuple[str, float]]:
        results = []
        with self._lock:
            for crop in crops:
                out = self._engine(crop, use_det=False, use_cls=False, use_rec=True)
                txts = getattr(out, "txts", None) or ("",)
                scores = getattr(out, "scores", None) or (0.0,)
                results.append((str(txts[0]), float(scores[0])))
        return results
