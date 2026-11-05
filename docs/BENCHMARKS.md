# Measurements and test matrix

All numbers come from one run on the hardware below (2026-11-05). They are measured, not estimated. Inputs are the generated fixtures in `service/tests/fixtures/` (procedural art, original Korean sentences, OFL fonts), **not real manhwa scans**. Expect lower OCR accuracy on real stylised lettering.

**Hardware**: cloud VM, Intel Xeon @ 2.10 GHz, 4 threads, 15 GB RAM, no GPU, Linux x86-64. Python 3.13.18, Node 22.23, Chromium 147 (Playwright build).
**Models**: PP-OCRv6 small detector, EasyOCR korean_g2, Bergamot ko-en base-memory.

## Service: `scripts/benchmark.py --huge`

Model load and warm-up: 3.7 s. RSS after load: 767 MB.

| image | size | regions | detect ms | recognise ms | layout ms | translate ms | total ms (cold) | total ms (cached) | OCR CER |
|---|---|---|---|---|---|---|---|---|---|
| dialogue_single | 800x1100 | 1 | 465 | 87 | 69 | 32 | 678 | 0 | 0.071 |
| multi_bubbles | 800x2000 | 5 | 1151 | 198 | 134 | 131 | 1635 | 0 | 0.085 |
| sfx_rotated | 800x1300 | 2 | 497 | 92 | 207 | 21 | 832 | 0 | 0.000 |
| long_translation | 700x900 | 1 | 223 | 112 | 51 | 50 | 446 | 0 | 0.000 |
| tall_strip | 720x9000 | 8 | 3074 | 241 | 221 | 182 | 3811 | 1 | 0.136 |
| chapter_01 | 720x1400 | 1 | 484 | 87 | 56 | 35 | 677 | 0 | 0.071 |
| chapter_02 | 720x1400 | 1 | 380 | 125 | 57 | 31 | 611 | 0 | 0.100 |
| chapter_03 | 720x1400 | 1 | 354 | 69 | 48 | 34 | 517 | 0 | 0.091 |
| chapter_04 | 720x1400 | 1 | 454 | 47 | 25 | 24 | 561 | 0 | 0.143 |
| chapter_05 | 720x1400 | 1 | 413 | 73 | 42 | 25 | 570 | 0 | 0.222 |
| chapter_06 | 720x1400 | 1 | 346 | 64 | 15 | 18 | 456 | 0 | 0.000 |

- Overall OCR character error rate (dialogue and narration, spaces ignored): **9.8%** (20 of 205 characters).
- Peak RSS after all fixtures: 1106 MB.
- **720 × 40,000 px strip** (2.3 MB PNG): 37 regions in 30 tiles, 15.7 s, peak RSS **1106 → 1208 MB**. Memory stays bounded by tile size, not strip length.
- Detection dominates the time, at ~0.35 s per 1600 px tile. Translation is 20–180 ms per page.
- "cached" is a repeat of the same bytes with the same settings, served from the result cache.

## Browser: `extension/test/e2e/run.mjs` (Chromium, real extension + real service)

| Measured | Value |
|---|---|
| Service start incl. model warm-up | 4.0–4.5 s |
| 6-image chapter (720×1400 each), first pass incl. one forced failure | 3.3–3.6 s |
| Same chapter including manual retry of the failed image | 4.1–4.4 s |
| 5 images incl. a 720×9000 strip (after cancel + retry + pause/resume) | 8.4–8.7 s |
| Service RSS at end of the e2e run (current / peak) | 959 MB / 1174 MB |

## What is tested where

### Python service: unit and integration tests

`cd service && .venv/bin/python -m pytest`: **41 tests**, real models, no mocks for OCR or translation.

| Requirement | Test |
|---|---|
| Korean dialogue | `test_pipeline::test_single_dialogue_bubble`, `test_translate::test_bergamot_korean_dialogue_real_model` |
| Multiple bubbles + reading order | `test_pipeline::test_multiple_bubbles_reading_order_and_kinds`, `test_layout::test_reading_order_*` |
| Very tall image, text across tile boundaries | `test_pipeline::test_tall_strip_text_across_tile_boundaries`, `test_tiling::*` (incl. re-detection of text taller than the overlap) |
| Rotated sound effects | `test_pipeline::test_rotated_sound_effect_is_annotated_not_replaced` |
| Translation too long for a bubble | `test_pipeline::test_long_translation_gets_render_box_inside_bubble` (render box) + extension `fit.test.ts` (fitting/overflow) |
| Cancel | `test_tiling::test_cancel_stops_between_tiles`, `test_pipeline::test_cancel_before_start` |
| Cache invalidation when settings change | `test_pipeline::test_cache_invalidation_when_settings_change` |
| Cleanup never touches bubble outlines | `test_layout::test_find_bubble_detects_ellipse_and_cleanup_spares_outline` |
| Artwork false positives | `test_pipeline::test_chapter_pages_have_no_artwork_false_positives` |
| Service security (token, web origins, DNS rebinding, limits) | `test_server::*` |
| Service unavailable / unknown language | `test_server::test_unknown_target_language_is_explicit`, extension `settings.test.ts` |

### Extension: unit tests

`cd extension && npm test`: **26 tests** (vitest + jsdom). Covers fitting, geometry, discovery (lazy attributes, srcset, `<picture>`, exclusions, adapters, explained failure), the scheduler (priority, pause/resume, cancel, retry, dedupe, self-pause when the service is down) and the service client.

### Desktop browser tests

`cd extension && npm run test:e2e`: **27 checks**, Chromium only.

- Discovery: 6 pages including `data-src` lazy pages and a page inserted later; logo, banner, ad and avatar excluded.
- Lazy pages with no URL in the DOM are counted, not claimed complete. The scan pass reveals them and restores the reading position.
- Hotlink-protected cross-origin CDN: the Referer rule works.
- A failed image shows its reason, and retry fixes it.
- No scroll jumps.
- Overlay alignment ≤1 px at 1280 px, after resize to 600 px, and at 150% zoom (DPR 1.5, 853 px viewport).
- The original/translated toggle works.
- Correction popover and re-translation.
- Cancel, pause and resume.
- Changing the SFX mode re-renders using cached OCR.
- Service unavailable: guidance is shown and no image is fetched or sent.

### Not tested

- **Firefox, at runtime.** No Firefox binary could be installed in this environment. The Firefox build passes `web-ext lint` with 0 errors and 0 warnings, and shares all code with the Chrome build. Its background runs as an event page instead of a service worker. Firefox-specific behaviour is therefore unverified, notably DNR Referer rules, `permissions.request` and fonts.
- **Real manhwa sites and real scans.** Only generated fixtures and local test pages were used.
- **Windows, macOS and Apple Silicon.**
- **Android.** Everything in `docs/ANDROID.md` is an untested assumption.
- **The optional PP-OCRv5 Korean recogniser.** Its download hosts were blocked here, so it was never run.
