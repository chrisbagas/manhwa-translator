"""The page pipeline: decode -> tiled detection -> recognition -> layout ->
translation, with two cache layers so changing translation settings never
re-runs OCR.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from typing import Callable

import cv2
import numpy as np

from . import imageio, layout
from .cache import DiskCache
from .config import Config
from .ocr.base import crop_quad, quad_angle
from .tiling import TileConfig, detect_tiled
from .translate import glossary as gloss
from .translate import sfx as sfxlex
from .translate.base import TranslationUnavailable
from .translate.romanize import romanize
from .types import Region, TextLine

log = logging.getLogger("dalbit")

PIPELINE_VERSION = "p5"
TRANSLATE_VERSION = "t4"
SUPPORTED_SOURCES = ("ko",)  # interfaces are language-agnostic; see docs/ARCHITECTURE.md
RTL_SOURCES = {"ja"}
SFX_MODES = ("annotate", "original", "replace")
SFX_MIN_CONF = 0.6


class Cancelled(Exception):
    pass


_SENT_END = re.compile(r"[.!?…~♡♥]+[\"'”’」』)]*(?=\s)")


def split_sentences(text: str) -> list[str]:
    text = text.strip()
    parts, start = [], 0
    for m in _SENT_END.finditer(text):
        parts.append(text[start:m.end()].strip())
        start = m.end()
    parts.append(text[start:].strip())
    return [p for p in parts if p] or [text]


class Engine:
    def __init__(self, config: Config):
        self.config = config
        self.cache = DiskCache(config.cache_dir, max_bytes=config.cache_max_bytes)
        self.tiles = TileConfig()
        self._detector = None
        self._recognizer = None
        self._translator = None
        self._load_lock = threading.Lock()

    # ---------------------------------------------------------------- providers
    @property
    def detector(self):
        with self._load_lock:
            if self._detector is None:
                from .ocr.ppocr import PPOCRDetector

                self._detector = PPOCRDetector(limit_side_len=self.tiles.tile_h, threads=self.config.threads)
            return self._detector

    @property
    def recognizer(self):
        with self._load_lock:
            if self._recognizer is None:
                choice = self.config.recognizer
                ppocr_path = self.config.models_dir / "ppocr" / "korean_PP-OCRv5_rec_mobile.onnx"
                if choice == "ppocr-korean":
                    from .ocr.ppocr import PPOCRKoreanRecognizer

                    self._recognizer = PPOCRKoreanRecognizer(ppocr_path)
                else:
                    from .ocr.easyocr_rec import EasyOCRRecognizer

                    self._recognizer = EasyOCRRecognizer(self.config.models_dir / "easyocr", threads=self.config.threads)
            return self._recognizer

    @property
    def translator(self):
        with self._load_lock:
            if self._translator is None:
                from .translate.bergamot import BergamotTranslator

                self._translator = BergamotTranslator(self.config.models_dir / "bergamot")
            return self._translator

    def warm_up(self) -> dict:
        t = time.perf_counter()
        _ = self.detector, self.recognizer
        self.translator.translate(["준비"], "ko", "en")
        return {"ms": round((time.perf_counter() - t) * 1000)}

    def models(self, src: str = "ko", tgt: str = "en") -> dict[str, str]:
        out = {"detector": self.detector.version, "recognizer": self.recognizer.version}
        try:
            out["translator"] = self.translator.version(src, tgt)
        except Exception as exc:  # noqa: BLE001
            out["translator"] = f"unavailable: {exc}"
        return out

    # ---------------------------------------------------------------- analysis
    def analysis_key(self, sha: str, src: str) -> str:
        return DiskCache.make_key("analysis", sha, src, self.detector.version, self.recognizer.version,
                                  self.tiles.key(), layout.ANALYSIS_VERSION, PIPELINE_VERSION)

    def analyze(self, img: np.ndarray, sha: str, src: str, check_cancel: Callable[[], None], timings: dict) -> dict:
        h, w = img.shape[:2]
        t0 = time.perf_counter()
        cands, tstats = detect_tiled(img, self.detector.detect, self.tiles, check_cancel)
        timings["detect"] = round((time.perf_counter() - t0) * 1000, 1)

        cands = [c for c in cands if (c.box[3] - c.box[1]) >= 8 and (c.box[2] - c.box[0]) >= 6]
        t0 = time.perf_counter()
        lines: list[TextLine] = []
        batch = 16
        for i in range(0, len(cands), batch):
            check_cancel()
            chunk = cands[i:i + batch]
            crops = [crop_quad(img, c.quad) for c in chunk]
            for c, (text, conf) in zip(chunk, self.recognizer.recognize(crops)):
                text = re.sub(r"\s+", " ", text).strip()
                if not text:
                    continue
                lines.append(TextLine(quad=[[round(x, 1), round(y, 1)] for x, y in c.quad], text=text,
                                      confidence=round(conf, 3), det_score=round(c.score, 3),
                                      angle=round(quad_angle(c.quad), 1)))
            del crops
        self._retry_display_lettering(img, lines, check_cancel)
        timings["recognize"] = round((time.perf_counter() - t0) * 1000, 1)

        t0 = time.perf_counter()
        regions = self._layout(img, sha, src, lines, check_cancel)
        timings["layout"] = round((time.perf_counter() - t0) * 1000, 1)
        return {"width": w, "height": h, "tiling": tstats, "regions": [r.to_json() for r in regions]}

    def _retry_display_lettering(self, img: np.ndarray, lines: list[TextLine], check_cancel) -> None:
        """Big / rotated / outlined lettering (sound effects) often reads better
        after binarisation; keep whichever variant the recogniser is surest of."""
        if not lines:
            return
        med = float(np.median([l.height for l in lines]))
        for ln in lines:
            if not (ln.height > 1.8 * med or abs(ln.angle) > 12) or ln.confidence > 0.9:
                continue
            check_cancel()
            crop = crop_quad(img, ln.quad)
            g = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
            otsu = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
            variants = [cv2.cvtColor(otsu, cv2.COLOR_GRAY2RGB), cv2.cvtColor(255 - otsu, cv2.COLOR_GRAY2RGB)]
            for text, conf in self.recognizer.recognize(variants):
                text = re.sub(r"\s+", " ", text).strip()
                if text and conf > ln.confidence:
                    ln.text, ln.confidence = text, round(conf, 3)

    def _layout(self, img: np.ndarray, sha: str, src: str, lines: list[TextLine], check_cancel) -> list[Region]:
        # 1. Which bubble does each line sit in? (Bubble identity drives grouping.)
        bubble_boxes: list[list[int]] = []
        bubble_id: dict[int, int | None] = {}
        for i, ln in enumerate(lines):
            info = layout.find_bubble(img, [ln.bbox])
            if info is None or not info.enclosed:
                bubble_id[i] = None
                continue
            bb = info.bubble.bbox
            match = None
            for j, ob in enumerate(bubble_boxes):
                inter = max(0, min(bb[0] + bb[2], ob[0] + ob[2]) - max(bb[0], ob[0])) * max(0, min(bb[1] + bb[3], ob[1] + ob[3]) - max(bb[1], ob[1]))
                if inter > 0.8 * min(bb[2] * bb[3], ob[2] * ob[3]):
                    match = j
                    break
            if match is None:
                bubble_boxes.append(bb)
                match = len(bubble_boxes) - 1
            bubble_id[i] = match
        check_cancel()
        groups = layout.group_lines(lines, bubble_id)
        heights = [l.height for l in lines]
        page_median_h = float(np.median(heights)) if heights else 0.0

        regions: list[Region] = []
        for g in groups:
            check_cancel()
            boxes = [l.bbox for l in g]
            x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes)
            x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
            joiner = "" if src in ("ja", "zh") else " "
            text = joiner.join(l.text for l in g).strip()
            weights = [max(1, len(l.text)) for l in g]
            conf = float(np.average([l.confidence for l in g], weights=weights))
            info = layout.find_bubble(img, boxes)
            kind, flags = layout.classify(g, info, page_median_h, text, src, conf, sfxlex.looks_like_sfx(text, src))
            style = layout.estimate_style(img, g, info.bg if info is not None else None)
            lh = float(np.median([l.height for l in g]))
            bbox = [int(x0), int(y0), int(round(x1 - x0)), int(round(y1 - y0))]
            angle = float(np.median([l.angle for l in g]))
            region = Region(
                id=layout.region_id(sha, bbox), order=0, kind=kind, bbox=bbox,
                polygon=[[x0, y0], [x1, y0], [x1, y1], [x0, y1]] if len(g) > 1 else g[0].quad,
                angle=round(angle, 1), lines=g, source_text=text, confidence=round(conf, 3),
                style=style, bubble=info.bubble if info is not None else None, flags=flags,
            )
            if kind in ("dialogue", "narration") and info is not None:
                patch = layout.cleanup_patch(img, info, boxes, lh)
                if patch is not None:
                    region.patch, region.patch_box = patch
                    region.render_mode = "replace"
                    ib = info.bubble.interior
                    # The interior always contains the text box; never smaller.
                    rx0, ry0 = min(ib[0], bbox[0]), min(ib[1], bbox[1])
                    rx1, ry1 = max(ib[0] + ib[2], bbox[0] + bbox[2]), max(ib[1] + ib[3], bbox[1] + bbox[3])
                    region.render_box = [rx0, ry0, rx1 - rx0, ry1 - ry0]
                else:
                    region.flags.append("cleanup-refused")
            if not region.render_box:
                pad = int(lh * 0.3)
                region.render_box = [max(0, bbox[0] - pad), max(0, bbox[1] - pad), bbox[2] + 2 * pad, bbox[3] + 2 * pad]
                region.render_mode = "overlay" if kind in ("dialogue", "narration") else "marker"
            regions.append(region)

        # Reading order (Korean / Chinese: left-to-right within a row band).
        order = layout.reading_order([(r.bbox[0], r.bbox[1], r.bbox[0] + r.bbox[2], r.bbox[1] + r.bbox[3]) for r in regions],
                                     rtl=src in RTL_SOURCES)
        regions = [regions[i] for i in order]
        for n, r in enumerate(regions):
            r.order = n

        # Sound-effect annotations: find calm space next to each effect.
        avoid = [r.bbox for r in regions]
        for r in regions:
            if r.kind != "sfx":
                continue
            sh = r.bbox[3]
            cap_h = int(min(64, max(22, sh * 0.28)))
            cap_w = int(cap_h * 4.2)
            box, score = layout.place_annotation(img, r.bbox, cap_w, cap_h, [a for a in avoid if a is not r.bbox])
            if box is not None and score < 0.35:
                r.render_box, r.render_mode = box, "annotate"
            else:
                r.render_box = [r.bbox[0] + r.bbox[2] - cap_h, r.bbox[1], cap_h, cap_h]
                r.render_mode = "marker"
                r.flags.append("no-safe-annotation-space")
            avoid.append(r.render_box)
        return regions

    # ---------------------------------------------------------------- translation
    def translate_regions(self, regions: list[dict], src: str, tgt: str, glossary: dict[str, str], sfx_mode: str) -> None:
        nmt_idx, nmt_texts = [], []
        for i, r in enumerate(regions):
            r["translationNote"] = ""
            text = r["source_text"]
            if r["kind"] == "sfx":
                if sfx_mode == "original":
                    r["translated_text"] = ""
                    r["render_mode"] = "hidden"
                    continue
                gl = sfxlex.lookup(text, src)
                if gl:
                    r["translated_text"] = gl
                    r["translation_note"] = "sfx-lexicon"
                    continue
                # Unknown effect: machine-translating an isolated (often misread)
                # onomatopoeia invents meanings ("광" -> "LIGHT"). Show the sound
                # that was read instead, romanised, and mark uncertainty.
                r["flags"] = sorted(set(r["flags"]) | {"sfx-unknown"})
                roman = romanize(text).upper() if src == "ko" else ""
                r["translated_text"] = roman
                r["translation_note"] = "sfx-romanized"
                if r["confidence"] < SFX_MIN_CONF:
                    r["flags"] = sorted(set(r["flags"]) | {"uncertain-reading"})
                continue
            g_text, used = gloss.apply(text, glossary)
            if used:
                r["translation_note"] = "glossary"
            nmt_idx.append(i)
            nmt_texts.append(g_text)
        if nmt_texts:
            out = self._translate_segments(nmt_texts, src, tgt)
            for i, t in zip(nmt_idx, out):
                r = regions[i]
                t = t.strip()
                if r["kind"] == "sfx":
                    t = t.upper().rstrip(".")
                if layout.script_ok(t, src) and src != "en":
                    # Output still in the source script: the model gave up.
                    r["flags"] = sorted(set(r["flags"]) | {"untranslated"})
                    t = ""
                r["translated_text"] = t
                if not t:
                    r["translation_note"] = "untranslated"
                    if r["render_mode"] in ("annotate",):
                        r["render_mode"] = "marker"
        for r in regions:
            r.pop("translationNote", None)

    def _translate_segments(self, texts: list[str], src: str, tgt: str) -> list[str]:
        """Translate each bubble sentence-by-sentence, then rejoin.

        Bergamot tends to drop short exclamations when several sentences share
        one input ("기다려! 나도 같이 갈래!" -> only the second); translating the
        sentences of a bubble separately keeps every one of them.
        """
        pieces: list[str] = []
        owners: list[int] = []
        for i, t in enumerate(texts):
            for sent in split_sentences(t):
                pieces.append(sent)
                owners.append(i)
        translated = self.translator.translate(pieces, src, tgt) if pieces else []
        out = [[] for _ in texts]
        for i, t in zip(owners, translated):
            out[i].append(t.strip())
        return [" ".join(p for p in parts if p) for parts in out]

    def translate_texts(self, texts: list[str], src: str, tgt: str, glossary: dict[str, str]) -> list[str]:
        prepped = [gloss.apply(t, glossary)[0] for t in texts]
        return self._translate_segments(prepped, src, tgt)

    # ---------------------------------------------------------------- entry point
    def process(self, data: bytes, *, src: str = "ko", tgt: str = "en", glossary: dict[str, str] | None = None,
                sfx_mode: str = "annotate", cancel: threading.Event | None = None) -> dict:
        if src not in SUPPORTED_SOURCES:
            raise ValueError(f"source language '{src}' is not supported yet (supported: {', '.join(SUPPORTED_SOURCES)})")
        if sfx_mode not in SFX_MODES:
            raise ValueError(f"unknown sfx mode {sfx_mode}")
        glossary = glossary or {}
        cancel = cancel or threading.Event()

        def check_cancel():
            if cancel.is_set():
                raise Cancelled()

        timings: dict[str, float] = {}
        t_all = time.perf_counter()
        sha = imageio.sha256(data)
        if not self.translator.supports(src, tgt):
            raise TranslationUnavailable(f"no translation model installed for {src}->{tgt}")
        # Replacement of sound effects is experimental; it currently falls back
        # to annotation (see docs/ARCHITECTURE.md), so it shares the cache key.
        eff_sfx = "annotate" if sfx_mode == "replace" else sfx_mode
        result_key = DiskCache.make_key("result", self.analysis_key(sha, src), self.translator.version(src, tgt), tgt,
                                        gloss.glossary_hash(glossary), eff_sfx, TRANSLATE_VERSION)
        cached = self.cache.get("result", result_key)
        if cached is not None:
            cached["cache"] = {"analysis": True, "result": True}
            cached["timingsMs"] = {"total": round((time.perf_counter() - t_all) * 1000, 1)}
            return cached

        akey = self.analysis_key(sha, src)
        analysis = self.cache.get("analysis", akey)
        analysis_hit = analysis is not None
        if analysis is None:
            t0 = time.perf_counter()
            img = imageio.decode(data, max_pixels=self.config.max_pixels, max_side=self.config.max_side)
            timings["decode"] = round((time.perf_counter() - t0) * 1000, 1)
            check_cancel()
            analysis = self.analyze(img, sha, src, check_cancel, timings)
            del img
            self.cache.put("analysis", akey, analysis)
        check_cancel()
        regions = [dict(r) for r in analysis["regions"]]
        t0 = time.perf_counter()
        self.translate_regions(regions, src, tgt, glossary, eff_sfx)
        timings["translate"] = round((time.perf_counter() - t0) * 1000, 1)
        timings["total"] = round((time.perf_counter() - t_all) * 1000, 1)
        warnings = []
        if sfx_mode == "replace":
            warnings.append("Experimental SFX replacement is not available yet; showing annotations instead.")
        if not regions:
            warnings.append("No text was detected in this image.")
        result = {
            "imageSha256": sha,
            "width": analysis["width"],
            "height": analysis["height"],
            "sourceLang": src,
            "targetLang": tgt,
            "sfxMode": eff_sfx,
            "regions": regions,
            "tiling": analysis.get("tiling"),
            "models": self.models(src, tgt),
            "pipeline": {"pipeline": PIPELINE_VERSION, "layout": layout.ANALYSIS_VERSION, "translate": TRANSLATE_VERSION},
            "timingsMs": timings,
            "warnings": warnings,
        }
        self.cache.put("result", result_key, result)
        result["cache"] = {"analysis": analysis_hit, "result": False}
        return result
