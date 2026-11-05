# Dalbit (달빛): a local manhwa translator

Open a chapter, press **Translate chapter** once, and read it in English. Dalbit finds the chapter's images, including lazy-loaded and very tall long-scroll strips. It processes them nearest-first and draws translations over the original art without changing it. OCR and translation run **on your own computer** with free, commercially usable models. There are no API keys, accounts or usage limits, and images never leave your machine.

- Browsers: **Chrome 116+** and **Firefox 128+** on desktop, from one codebase.
- Default pair: **Korean → English**. The interfaces are ready for Japanese and Chinese.
- Docs: [architecture](docs/ARCHITECTURE.md) · [models, licences and hardware](docs/MODELS.md) · [measurements and tests](docs/BENCHMARKS.md) · [Android options](docs/ANDROID.md)

![Translated chapter page with the Dalbit panel](docs/img/chapter-translated.png)

## What you get

- **Whole-chapter flow.** One click translates the chapter.
  - Discovery handles `src`/`srcset`/`<picture>`, common lazy-load attributes and pages added later. It skips logos, avatars, banners and ads, and explains when it finds nothing.
  - An optional **Scan page** pass loads lazy images and then returns you to exactly where you were.
- **Long-scroll ready.**
  - Tall strips are processed in bounded, overlapping tiles. A 40,000 px strip adds ~100 MB of RAM.
  - Duplicates in the overlap are merged, and text cut by a tile edge is re-detected.
  - Images near your reading position go first.
- **Controls.** A progress panel (found, queued, working, done, failed, lazy) with pause, resume, cancel, retry failed and an original/translated toggle. Settings: target language, text size, sound-effect mode and glossary.
- **Readable, non-destructive lettering.**
  - In flat bubbles, only the glyph pixels are covered with the bubble colour. Outlines and tails stay untouched.
  - Text is fitted with real font metrics, then balanced wrapping, then a bounded shrink. If it still doesn't fit, you get an expandable "more" caption rather than lost words.
  - Text on artwork gets a readable plate.
  - Everything is an overlay. The page's image is never modified.
- **Sound effects: preserve + annotate.**
  - The original lettering stays. A small English chip is placed in the calmest nearby space, slightly tilted like the effect.
  - Known effects come from a Korean SFX lexicon. Unknown ones are shown as a romanised reading ("GWANG! (sound)") rather than an invented meaning.
  - A "?" marks uncertainty. "Original only" hides the chips.
- **Corrections.** Click any translation to see the Korean original and OCR confidence, fix the Korean, re-translate just that bubble, or edit the English. Edits are saved per image.

## Requirements

- Python 3.10+ and Node.js 18+ (tested with Python 3.13 and Node 22)
- About 2 GB free RAM while translating
- About 1.3 GB of disk: Python environment with CPU PyTorch plus ~70 MB of models
- Any recent 64-bit CPU. A GPU is not used. On a 4-thread 2.1 GHz Xeon a 720×1400 page takes ~0.5–0.7 s, and a 720×9000 strip ~3.8 s ([details](docs/BENCHMARKS.md)).

## Setup

### 1. Local service (once)

```bash
cd service
bash scripts/setup.sh          # Windows: powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

This creates `service/.venv` with CPU-only PyTorch, installs the Bergamot engine (`bergamot_host/`) and downloads the models with SHA-256 verification ([what and from where](docs/MODELS.md)). To do the same steps by hand:

```bash
cd service
python3 -m venv .venv
.venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install -r requirements.txt
(cd bergamot_host && npm ci)
.venv/bin/python scripts/download_models.py            # add --ppocr-korean for the optional recogniser
.venv/bin/python -m dalbit doctor --warm
```

### 2. Run the service

```bash
cd service
.venv/bin/python -m dalbit serve      # http://127.0.0.1:47615, loopback only
.venv/bin/python -m dalbit token      # pairing token to paste into the extension
```

Keep it running while you read. If it is not running, the extension says so, shows these commands and sends nothing anywhere.

You can also try one image without a browser:

```bash
.venv/bin/python -m dalbit translate page.png      # writes page.dalbit.json and page.preview.png
```

### 3. Build the extension

```bash
cd extension
npm ci
npm run build          # -> dist/chrome and dist/firefox
npm run package        # optional: dist/packages/*.zip
```

### 4. Install it

**Chrome (desktop)**: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick `extension/dist/chrome`. An unpacked extension stays installed across restarts. Chrome only installs packaged `.crx` files from the Chrome Web Store (or by enterprise policy), so for personal use keep it unpacked. A store upload would use `dist/packages/dalbit-chrome-*.zip`.

**Firefox (desktop)** has two routes:

- **Temporary (development)**: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…** and pick `extension/dist/firefox/manifest.json`. It is removed when Firefox restarts.
- **Permanent**: Firefox Release and ESR only install **signed** add-ons. Sign it for self-distribution ("unlisted") with free AMO API credentials, then install the resulting `.xpi` by dragging it into Firefox:
  ```bash
  cd extension
  npx web-ext sign --source-dir dist/firefox --channel unlisted --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
  ```
  Alternatively, Firefox Developer Edition or Nightly can install unsigned add-ons after setting `xpinstall.signatures.required` to `false` in `about:config`.
- On Firefox, click **Allow access to page images** in the popup the first time. Firefox treats MV3 host permissions as opt-in.

### 5. Use it

1. Click the Dalbit icon, open **Settings**, paste the token and save. The status turns to *service ok*.
2. Open a chapter and press **Translate chapter** (or **Alt+Shift+T**). **Alt+Shift+O** toggles original/translated.
3. If the panel says images are "lazy" and have no URL yet, press **Scan page**.
4. Click a translation to correct it.

Scope is the current page only. Dalbit never navigates to the next chapter.

## Tests

```bash
cd service && bash scripts/fetch_test_fonts.sh && .venv/bin/python tests/fixtures/generate.py && .venv/bin/python -m pytest   # 41 tests, real models
cd extension && npm test                          # 26 unit tests
cd extension && npm run build && npm run test:e2e # 27 checks in Chromium with the real service
cd extension && npm run lint:firefox              # Mozilla add-ons linter
```

What each test covers, and what is **not** tested (Firefox at runtime, real sites, Windows/macOS, Android), is in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Known limitations

- **OCR accuracy is the weakest link.** EasyOCR's Korean recogniser makes ~10% character errors on clean synthetic pages. It confuses complex syllables (봐→화, 었→없), and those errors reach the translation. Real scans with stylised fonts will be worse. The likely-better PP-OCRv5 Korean recogniser is implemented but was not run here.
- **Translation is sentence-level NMT.** There is no story context. Pronouns and tone can be off, and names stay consistent only through the glossary.
- **Sound effects.** Heavy display lettering is often misread. Unknown effects are romanised, not translated. "Replace" mode is not implemented yet and falls back to annotation. Vertical stacked Korean text is not handled.
- **Cleanup** only happens in flat-colour containers. Text over illustrations gets a readable plate instead of inpainting.
- **Sites.** Readers that draw pages into `<canvas>`, scramble tiles or use CSS background images are not discovered (the panel says so). Cross-origin images without CORS that the background cannot fetch fail with an explicit reason.
- **Firefox** shares all code with Chrome and passes the linter, but was not run in a real Firefox here.

## Next three improvements

1. **Better Korean OCR.** Benchmark `korean_PP-OCRv5_rec_mobile` against EasyOCR on real, user-supplied pages and switch the default if it wins. Add a small confidence-based re-read step that tries both recognisers on low-confidence lines.
2. **Context-aware translation option.** An optional local LLM provider: Apache-2.0 Qwen3 4B/8B via llama.cpp, with a chapter-level glossary and the previous bubbles as context. Keep Bergamot as the fast default.
3. **Site robustness and Firefox verification.** Run the e2e suite in Firefox (web-ext + Selenium/geckodriver). Add `<canvas>` capture for canvas-based readers. Collect adapters for the reader sites you actually use.

## Licences

Dalbit's own code is currently **all rights reserved** (see `LICENSE`). Pick a licence before sharing or selling it. Bundled fonts are SIL OFL 1.1. Models and libraries are Apache-2.0, MPL-2.0, MIT or BSD; see `THIRD_PARTY_NOTICES.md` and [docs/MODELS.md](docs/MODELS.md). Before a commercial release, also check the name "Dalbit" for trademark conflicts.
