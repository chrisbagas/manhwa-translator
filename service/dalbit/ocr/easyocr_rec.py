"""EasyOCR Korean recogniser (Apache-2.0 code and weights).

Only the recognition network (`korean_g2`, ~16 MB) is loaded; detection is done
by the PP-OCR detector, which is ~7x faster than EasyOCR's CRAFT on CPU.
"""

from __future__ import annotations

import hashlib
import threading
from pathlib import Path

import numpy as np

KOREAN_G2_SHA256 = "ecdead53c909748aad74bc2f2beeab3e3ad751134db6335e97ea19f879ca407e"


class EasyOCRRecognizer:
    name = "easyocr-korean_g2"
    languages = ("ko", "en")

    def __init__(self, model_dir: Path, *, threads: int = 0):
        weights = model_dir / "korean_g2.pth"
        if not weights.exists():
            raise FileNotFoundError(f"{weights} missing; run scripts/download_models.py")
        import torch
        import easyocr

        if threads:
            torch.set_num_threads(threads)
        self._reader = easyocr.Reader(
            ["ko", "en"],
            gpu=False,
            detector=False,
            model_storage_directory=str(model_dir),
            download_enabled=False,
            verbose=False,
        )
        self._lock = threading.Lock()
        digest = hashlib.sha256(weights.read_bytes()).hexdigest()
        self.version = f"korean_g2:{digest[:12]}@easyocr-{easyocr.__version__}"

    def recognize(self, crops: list[np.ndarray]) -> list[tuple[str, float]]:
        out: list[tuple[str, float]] = []
        with self._lock:
            for crop in crops:
                h, w = crop.shape[:2]
                res = self._reader.recognize(
                    crop,
                    horizontal_list=[[0, w, 0, h]],
                    free_list=[],
                    detail=1,
                    paragraph=False,
                )
                if res:
                    _, text, conf = res[0]
                    out.append((str(text), float(conf)))
                else:
                    out.append(("", 0.0))
        return out
