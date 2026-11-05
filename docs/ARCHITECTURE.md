# Architecture

## Decision: thin extension + local service

| | 1. Fully in-browser inference | 2. Extension + local service (chosen) |
|---|---|---|
| Korean OCR | No maintained Korean recogniser ships as a ready browser package. PP-OCR ONNX works in `onnxruntime-web`, but Korean needs `korean_PP-OCRv5_rec_mobile` plus hand-written pre/post-processing in JS. | PP-OCR detection (bundled in `rapidocr`), EasyOCR / PaddleOCR Korean recognisers via mature Python packages. |
| Translation | Bergamot WASM runs in browsers (Firefox uses it), so this part is feasible in-browser. | The same Bergamot WASM engine, run by Node next to the service. |
| Image processing | Tall strips would need large canvases in the page or extension. Cross-origin pixels need workarounds. Memory is limited per tab. | NumPy/OpenCV with bounded tiles. The image is decoded once, and RAM is bounded by tile size. |
| Speed (CPU) | WASM without native GEMM is several times slower than native. Work competes with the page. | Native ONNX Runtime/PyTorch on all cores. ~0.4–0.7 s per typical page (see BENCHMARKS.md). |
| Setup | None beyond installing the extension. | Python + Node + ~70 MB of models, one setup script. |
| Android later | An extension would need an extension-capable mobile browser. | The phone can reach the desktop service over LAN, and the service code can be reused for a native app. |

The local service makes a reliable free prototype much easier, so it was chosen. The extension stays thin: discovery, scheduling, acquisition and rendering. The service-side interfaces mean an in-browser provider (for example Chrome's built-in on-device Translator API, or Bergamot WASM in an offscreen document) can be added later without changing the overlay code.

## Components

```
 Browser (Chrome / Firefox desktop)                         Your computer (loopback only)
┌──────────────────────────────────────────────┐          ┌────────────────────────────────────────┐
│ popup: status · Translate chapter · settings │          │ dalbit service (aiohttp, 127.0.0.1)    │
│                                              │          │  guard: token · origin · Host · limits │
│ content script (injected on demand)          │          │  queue: 1 worker thread, bounded       │
│  discovery ─► scheduler ─► overlay layers    │          │                                        │
│     ▲   MutationObserver / lazy attrs         │  bytes   │  pipeline                              │
│     │   viewport priority, pause/cancel/retry │ ───────► │   decode (pixel limits)                │
│     └── panel: progress / errors / scan pass  │          │   tiles ─► PP-OCRv6 detector            │
│                                              │  JSON    │   merge overlaps / re-detect cut lines  │
│ background (SW in Chrome, event page in FF)  │ ◄─────── │   recogniser (EasyOCR ko / PP-OCRv5 ko) │
│  fetch image (+Referer DNR rule) or bytes    │          │   layout: bubbles, groups, order, kind, │
│  from page fallback → POST /v1/translate     │          │           style, glyph-mask patches     │
└──────────────────────────────────────────────┘          │   translate: SFX lexicon / romanise,   │
                                                          │     glossary, Bergamot (Node WASM)     │
                                                          │   cache: analysis(OCR) + result(MT)    │
                                                          └────────────────────────────────────────┘
```

### Interfaces (where future languages and providers plug in)

| Concern | Interface | Implementations |
|---|---|---|
| Image acquisition | `background/acquire.ts` `fetchImage()`; content `readFromPage()` | background fetch with Referer rule → page canvas → page fetch → explicit error |
| Text detection | `ocr/base.py` `TextDetector.detect(img) -> [(quad, score)]` | `PPOCRDetector` (PP-OCRv6 small) |
| Text recognition | `TextRecognizer.recognize(crops) -> [(text, conf)]` | `EasyOCRRecognizer` (default), `PPOCRKoreanRecognizer` (optional) |
| Translation | `translate/base.py` `Translator.translate(texts, src, tgt)` and `version()` | `BergamotTranslator` (ko→en, plus pivot ko→en→X when en→X models are installed) |
| Background cleanup | `layout.cleanup_patch()` returns a PNG patch and its box | flat-fill glyph mask. An inpainting provider is a future slot. |
| Layout and rendering | `Region.render_box / render_mode / style` → `content/overlay.ts` + `fit.ts` | replace, overlay, annotate, marker, hidden |
| Caching and jobs | `cache.DiskCache`, `pipeline.Engine.process()`, `content/scheduler.ts` | two-level disk cache; cancellable jobs |

To add Japanese or Chinese: register a recogniser for the language (PP-OCRv6's bundled recogniser already covers Chinese and Japanese; manga-ocr is Apache-2.0 for Japanese), add Bergamot `jaen`/`zhen` models, and add the code to `SUPPORTED_SOURCES`. Reading order already switches to right-to-left for `ja` (`RTL_SOURCES`). Line joining already uses no spaces for `ja`/`zh`.

## Data model

Each image yields a `PageResult`. Each text block becomes a `Region` with:

- `id`, a stable hash of the image and box
- `order`, the reading position
- `kind`: dialogue, narration, sfx or uncertain
- `bbox`, `polygon` and `angle`
- `lines[]`, each with its quad, text, confidence and angle
- `source_text`, `translated_text` and `translation_note` (for example `sfx-lexicon`, `sfx-romanized` or `glossary`)
- `confidence` and `flags` (for example `low-confidence`, `rotated` or `untranslated`)
- `style`: foreground colour, outline colour and width, glyph size, weight, alignment and orientation
- `bubble`: outer box, interior, fill colour, `flat` and shape
- `patch` and `patch_box`
- `render_box` and `render_mode`

All coordinates are in original image pixels. The extension maps them to percentages of the displayed image.

User corrections are stored by the extension in `storage.local` under `edits:<imageSha256>`. Re-translating a corrected original calls `/v1/translate-text` only, without re-running OCR.

## Pipeline details

- **Tiling** (`tiling.py`). Detection runs on tiles at most 1600 detector-pixels tall with a 256 px overlap. Images wider than 1600 px are downscaled for detection only, and recognition always crops from the original pixels. Lines that touch a cut edge lose to their complete duplicate from the neighbouring tile (overlap-aware NMS). A line cut in every tile (taller than the overlap, such as huge SFX) is re-detected in a window centred on it. A 40,000 px strip runs in 30 tiles and adds ~100 MB to peak memory.
- **Grouping** (`layout.py`). Each line's flat-colour container is found first by colour similarity, connected components and hole filling. Lines in the same container form one block; lines in different bubbles never merge. Otherwise geometric rules apply: vertical gap, alignment and height ratio. Translation then works on whole blocks, never OCR fragments. Each bubble is split into sentences internally because Bergamot drops short exclamations when several share one input.
- **Reading order**: row bands top to bottom, then left to right (ko/zh) or right to left (ja).
- **Cleanup**. Only for flat containers. The mask is "ink" pixels near the detected lines, intersected with the eroded bubble interior. Outlines, tails and art outside the text never change. If the mask would cover more than 60% of the bubble, cleanup is refused (`cleanup-refused`). On textured backgrounds no cleanup happens: text is drawn on a semi-opaque plate (`overlay` mode).
- **Sound effects**. Big, rotated or onomatopoeic lettering is classified as `sfx`. The default mode is *preserve + annotate*: a small chip is placed beside the effect, chosen among 8 candidate positions by lowest edge density (busy art, faces, details) and least overlap with other text. If no calm spot exists, a tappable ♪ marker is used instead. The gloss comes from a hand-written Korean SFX lexicon. Unknown effects are **romanised** ("광!" → "GWANG! (sound)"), not machine-translated, because NMT invents meanings for isolated onomatopoeia. "Original only" hides them. "Replace (experimental)" currently falls back to annotation, by design (see Limitations).
- **Artwork noise**. Detections on non-flat backgrounds with no letters, or with low confidence and no Korean script, are kept out of the overlay. They are listed in `discarded`, with a warning, so nothing is hidden silently.

## Security model of the local service

- Binds to `127.0.0.1` only. A non-loopback address requires `--allow-remote` and logs a warning.
- Every API call except a minimal `/v1/health` needs the pairing token: 24 random bytes, stored with mode 0600 and compared in constant time.
- Requests carrying a web `Origin` (http/https) get 403 even with a valid token. Only `chrome-extension://`, `moz-extension://` and `safari-web-extension://` origins are accepted, and `--allow-origin` pins exact extension IDs.
- The `Host` header must be a loopback name, which blocks DNS rebinding.
- Uploads are capped at 40 MB. Image headers are checked before decoding: 60 MP and 120k px per side maximum, with an allow-list of formats. Language codes and SFX modes are validated. The glossary is size-limited.
- Work runs on one worker thread behind a 64-request queue (429 when full). Cancellation is checked between tiles and stages.
- The service never makes network requests. Models are downloaded only by `scripts/download_models.py`.
- The extension refuses non-loopback service URLs. If the service is down it shows setup guidance and sends no image anywhere (verified in the e2e test).

## Caching

1. **Analysis cache.** The key is the image SHA-256, source language, detector and recogniser versions (including weight hashes), tiling parameters and pipeline/layout versions. It holds OCR, layout and cleanup patches.
2. **Result cache.** The key is the analysis key plus the translator model hash, target language, glossary hash and SFX mode. It holds translations.

Changing the target language, glossary or SFX mode re-runs only translation, in tens of milliseconds. A model upgrade invalidates the affected layer automatically. Re-opening a chapter therefore resumes instantly for pages already done. The cache is size-capped (512 MB, oldest first) and lives in `~/.config/dalbit/cache`.
