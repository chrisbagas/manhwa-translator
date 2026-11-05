"""EasyOCR korean_g2 recogniser run through ONNX Runtime (no PyTorch needed).

Re-implements EasyOCR's preprocessing (grey, height 64, right replicate-pad to
a multiple of 64) and decoding (softmax, ignore-mask, CTC greedy, custom_mean
confidence, second pass with contrast boost). The browser engine
(extension/src/engine/recognize.ts) implements the same steps.
"""

from __future__ import annotations

import hashlib
import json
import math
import threading
from pathlib import Path

import cv2
import numpy as np


def _contrast_boost(g: np.ndarray, target: float = 0.5) -> np.ndarray:
    high, low = np.percentile(g, 90), np.percentile(g, 10)
    contrast = (high - low) / max(10.0, high + low)
    if contrast < target:
        ratio = 200.0 / max(10.0, high - low)
        g = np.clip((g.astype(np.float32) - low + 25) * ratio, 0, 255).astype(np.uint8)
    return g


def preprocess(crop_rgb: np.ndarray, img_h: int = 64, contrast: bool = False) -> np.ndarray:
    g = cv2.cvtColor(crop_rgb, cv2.COLOR_RGB2GRAY)
    if contrast:
        g = _contrast_boost(g)
    h, w = g.shape
    new_w = max(1, math.ceil(img_h * w / max(1, h)))
    g = cv2.resize(g, (new_w, img_h), interpolation=cv2.INTER_LINEAR if h < img_h else cv2.INTER_AREA)
    pad_w = max(1, math.ceil(new_w / img_h)) * img_h
    x = (g.astype(np.float32) / 255.0 - 0.5) / 0.5
    if pad_w > new_w:
        x = np.concatenate([x, np.repeat(x[:, -1:], pad_w - new_w, axis=1)], axis=1)
    return x[None, None]


def decode(logits: np.ndarray, characters: list[str], ignore_idx: list[int]) -> tuple[str, float]:
    z = logits - logits.max(axis=1, keepdims=True)
    p = np.exp(z)
    p /= p.sum(axis=1, keepdims=True)
    if ignore_idx:
        p[:, ignore_idx] = 0.0
        p /= p.sum(axis=1, keepdims=True)
    idx = p.argmax(axis=1)
    out, prev = [], -1
    for i in idx:
        if i != prev and i != 0 and i not in ignore_idx:
            out.append(characters[i])
        prev = i
    maxp = p.max(axis=1)[idx != 0]
    conf = float(maxp.prod() ** (2.0 / math.sqrt(len(maxp)))) if len(maxp) else 0.0
    return "".join(out), conf


class OnnxKoreanRecognizer:
    name = "onnx-korean_g2"
    languages = ("ko", "en")

    def __init__(self, model_dir: Path, *, threads: int = 0):
        import onnxruntime as ort

        onnx_path = model_dir / "korean_g2.onnx"
        meta_path = model_dir / "korean_g2.json"
        if not onnx_path.exists():
            raise FileNotFoundError(f"{onnx_path} missing; run scripts/download_models.py")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        self.characters: list[str] = meta["characters"]
        self.ignore_idx: list[int] = meta["ignore_idx"]
        opts = ort.SessionOptions()
        if threads:
            opts.intra_op_num_threads = threads
        self._sess = ort.InferenceSession(str(onnx_path), opts, providers=["CPUExecutionProvider"])
        self._lock = threading.Lock()
        self.version = f"korean_g2-onnx:{hashlib.sha256(onnx_path.read_bytes()).hexdigest()[:12]}"

    def _run(self, crop: np.ndarray, contrast: bool) -> tuple[str, float]:
        logits = self._sess.run(None, {"image": preprocess(crop, contrast=contrast)})[0][0]
        return decode(logits, self.characters, self.ignore_idx)

    def recognize(self, crops: list[np.ndarray]) -> list[tuple[str, float]]:
        out = []
        with self._lock:
            for crop in crops:
                text, conf = self._run(crop, False)
                if conf < 0.1:  # EasyOCR's second round with a contrast boost
                    t2, c2 = self._run(crop, True)
                    if c2 > conf:
                        text, conf = t2, c2
                out.append((text, conf))
        return out
