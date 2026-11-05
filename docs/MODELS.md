# Models, licences and hardware

> **v0.2 summary:** the default Korean recogniser is EasyOCR's korean_g2, **exported to ONNX** (`service/scripts/export_recognizer_onnx.py`; max logit difference to PyTorch 1.2e-4). It is used by both engines, so PyTorch is no longer required. The exported file is committed at `extension/assets/models/rec/korean_g2.onnx` (16 MB, Apache-2.0 weights, SHA-256 `0a28c6f6…4e09`).
>
> **Important finding from real pages:** korean_g2's character table contains only **913 Hangul syllables**. Very common ones are missing: 었, 았, 봐, 뭘, 됩. The model *cannot* output them; this explains most remaining OCR errors. The full-Hangul `korean_PP-OCRv5_rec_mobile` is supported by both engines (`--ppocr-korean`). In the extension it is preferred automatically **if** it reads a bundled Korean test line ("뭘 봐? 살아 있었습니다! 단축됩니다") with ≤25% character error; otherwise the engine falls back and reports why. The PaddleOCR code path was verified identical to RapidOCR on six English lines with PP-OCRv6; the Korean model itself could not be downloaded in my environment.
>
> **Extension size:** about 97 MB unpacked:
>
> | Part | Size |
> |---|---|
> | ONNX Runtime WASM | 15 MB |
> | Detector | 10 MB |
> | Recogniser | 16 MB |
> | Bergamot engine | 5 MB |
> | Translation model | 54 MB |


Everything runs locally on CPU. A GPU is not needed.

## Models in use

| Role | Model | Source | Download | On disk | Code licence | Weights licence | Commercial use |
|---|---|---|---|---|---|---|---|
| Text detection | PaddleOCR **PP-OCRv6 small det** (ONNX) | ships inside the `rapidocr` 3.x wheel (PyPI) | 0 (part of pip install) | 10 MB | Apache-2.0 | Apache-2.0 | ✅ |
| Korean recognition (default) | EasyOCR **korean_g2** | `github.com/JaidedAI/EasyOCR/releases/download/v1.3/korean_g2.zip` | 15 MB | 16 MB | Apache-2.0 | Apache-2.0 | ✅ |
| Korean recognition (optional) | PaddleOCR **korean_PP-OCRv5_rec_mobile** (ONNX) | RapidOCR model registry (ModelScope), SHA-256 `cd6e2ea5…3c9b` | ~13 MB | ~13 MB | Apache-2.0 | Apache-2.0 | ✅ (**not run in my environment**, see below) |
| Translation ko→en | Mozilla **Firefox Translations** ko-en `base-memory` | Mozilla's public GCS bucket `moz-fx-translations-data--303e-prod-translations-data` | 37 MB (gz) | 54 MB | MPL-2.0 (bergamot-translator) | MPL-2.0 | ✅ (keep notices; MPL is file-level copyleft only if you modify MPL files) |
| Translation engine | `@browsermt/bergamot-translator` 0.4.9 WASM | npm | 5 MB | 5 MB | MPL-2.0 | — | ✅ |

Exact hashes are pinned in `service/scripts/download_models.py`. Download and verify them with:

```bash
cd service && .venv/bin/python scripts/download_models.py                 # required (~52 MB transfer)
cd service && .venv/bin/python scripts/download_models.py --ppocr-korean  # optional recogniser
cd service && .venv/bin/python scripts/download_models.py --pivot es      # e.g. ko→en→es
```

Fonts bundled in the extension: Comic Neue (dialogue), Atkinson Hyperlegible (narration/uncertain) and Bangers (SFX captions), all SIL OFL 1.1. Licence texts are in `extension/assets/fonts/`. Test-only fonts (Noto Sans KR and Black Han Sans, also OFL) are fetched by `service/scripts/fetch_test_fonts.sh` and not shipped.

## Why these (evidence)

**Translation.** Mozilla's own evaluation in `mozilla/firefox-translations-models`, `evaluation/ko-en/`:

| ko→en system | FLORES-test COMET | FLORES BLEU | IWSLT17 COMET |
|---|---|---|---|
| Google Translate | 0.889 | 33.8 | 0.834 |
| Microsoft | 0.888 | 33.8 | 0.826 |
| **Bergamot base-memory (used)** | **0.863** | **27.7** | **0.805** |
| NLLB-200 | 0.852 | 25.3 | 0.801 |
| OPUS-MT (Helsinki-NLP) | 0.827 | 20.6 | 0.796 |
| Argos | 0.738 | 15.1 | 0.668 |

The Bergamot model was the best freely-licensed option that runs fast on CPU: 7 sentences in ~0.3 s once loaded, ~300 MB RAM. OPUS-MT (CC-BY-4.0 weights) is permissive but scores lower. NLLB-200 is **CC-BY-NC-4.0, so no commercial use**, and was rejected for that reason.

**OCR.** Checked against current packages, not assumed:

- The newest **PP-OCRv6 recogniser has zero Hangul syllables** in its dictionary (I counted 18,708 entries, 0 Hangul), so it cannot read Korean. Korean needs the v5 Korean model. Detection is script-agnostic and v6 detection works well on Hangul.
- **manga-ocr** is Japanese-only. Don't use it for Korean.
- On the generated fixtures, PP-OCRv6 detection took 0.68 s per 800×2000 page versus 4.5 s for EasyOCR's CRAFT, with equivalent boxes. CRAFT is not used, and its 83 MB weights are not downloaded.
- EasyOCR korean_g2 reaches ~10% character error rate on the synthetic pages (BENCHMARKS.md). It confuses some complex syllables (봐→화, 었→없, 워→위). This is the weakest link in the pipeline.
- **korean_PP-OCRv5_rec_mobile** is likely more accurate (PaddleOCR reports large gains over v3 for Korean). However, its hosts (Hugging Face, ModelScope, Baidu BOS) were blocked by this sandbox's network policy, so it is implemented but **has not been run or measured** here. On your machine, run `download_models.py --ppocr-korean` and compare with `DALBIT_RECOGNIZER=ppocr-korean .venv/bin/python scripts/benchmark.py --recognizer ppocr-korean`.

### Rejected or flagged components

| Component | Reason |
|---|---|
| NLLB-200 (all sizes) | CC-BY-NC-4.0: non-commercial |
| LG EXAONE (Korean LLMs) | EXAONE licence: non-commercial |
| Qwen2.5-3B / 72B | Qwen Research/Qwen licence restrictions (other Qwen2.5 and Qwen3 sizes are Apache-2.0 and are a good future context-aware translator) |
| manga-image-translator detectors/OCR | GPL-3.0 code |
| Surya OCR | GPL code and weight-licence revenue limits |
| "Anime Ace"-style comic fonts | free for personal use only; replaced by OFL fonts |

## Hardware, disk and memory (honest numbers)

Measured on a 4-thread Intel Xeon @ 2.1 GHz cloud VM with 15 GB RAM and no GPU (see BENCHMARKS.md):

- **RAM**: service ~770 MB after model load, ~1.1–1.2 GB peak while processing (including a 720×40,000 px strip). Budget 2 GB free RAM. The browser side adds only small overlays.
- **Disk**:
  - Models: ~70 MB.
  - Python environment with CPU-only PyTorch: ~1.2 GB. With the default CUDA PyTorch from PyPI it is ~5 GB, which is why setup uses the CPU wheel index.
  - Cache: ≤512 MB (configurable).
- **CPU**: any 64-bit x86 or Apple Silicon CPU from the last ~8 years. Expect roughly 0.4–0.7 s per normal 720×1400 page and ~3.5 s per 720×9000 strip on 4 threads. Older dual-core laptops will be roughly 2–3× slower.
- **Software**: Python 3.10+ (tested 3.13), Node.js 18+ (tested 22), Chrome 116+ or Firefox 128+ on desktop.
- **Apple Silicon / Windows**: the dependencies publish wheels for both, but **I only ran Linux x86-64**. Bergamot uses its portable WASM GEMM, so it is architecture-independent.
