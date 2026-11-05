# Dalbit: progress and next steps

_Last updated: 2026-11-05. Branch `claude/practical-wozniak-p9fmgm`._

Dalbit translates Korean manhwa (Korean → English) **in place**, on your own devices, with no paid APIs. It comes in three forms:

1. a **browser extension** for Chrome and Firefox desktop,
2. an **Android app**, a small browser for reader sites,
3. an optional **local service** (Python) on your laptop.

The extension and the Android app share one engine.

---

## What has been built

### 1. Extension (Chrome / Firefox desktop): working, latest build 0.2.2

- **One-click chapter translation.**
  - It finds chapter images, including lazy-loaded pages, very tall strips and pages inserted later.
  - It skips logos, ads and avatars, and handles hotlink-protected image hosts.
  - Images near where you're reading go first.
- **Controls.** A progress panel, pause, resume, cancel, retry failed, an original/translated toggle, and a "Scan page" pass for lazy images that returns you to where you were.
- **Built-in engine.** Everything runs inside the browser; no server is needed. It's about 106 MB unpacked, models included.
  - Text detection: PaddleOCR PP-OCRv6 (ONNX Runtime Web, 3–4 threads).
  - Korean reading uses **two readers combined**: EasyOCR korean_g2, exported to ONNX, and Tesseract's Korean LSTM.
    - They're combined with a language score taken from the translation model's own vocabulary.
    - Character error rate: **10.4% → 5.1%** on test pages, **3.2%** on real pages.
  - Translation: Mozilla's Firefox Translations ko→en model (Bergamot WASM).
- **Layout and lettering.**
  - Bubbles are cleaned at the glyph level: outlines and tails are kept, and the erase continues the surrounding texture.
  - Text is fitted using what the browser actually draws, so it can never run off the bubble. This was a bug on real sites; it now works under page zoom and scaled reader layouts.
  - **Item windows and stat sheets are translated line by line**: same positions, one font size, columns kept, and a sentence spanning two lines is translated once. A system-term glossary (스탯, 민첩, 방어력…) applies only on item lines.
  - **Sentences continuing across bubbles** ("…강하니" → next bubble) are translated together and split back. Double bubbles stay two speeches.
  - Sound effects: the art is kept and a small English label is added beside it. Unknown effects are shown romanised ("GWANG! (sound)").
  - Site watermarks (faint text) are ignored and reported, never translated.
  - Overlays use a backing plate where text sits on artwork, and switch to black or white text when contrast is poor.
- **Corrections.** Click a translation to see the Korean, fix it, re-translate just that bubble, or edit the English. Plus a glossary for names and terms.

### 2. Local service (Python, optional): working

- The same pipeline in Python, now **without PyTorch** (ONNX recogniser, about 300–500 MB of RAM).
- Secure by default: loopback only, pairing token, rejects web origins and DNS rebinding, upload and pixel limits.
- `--allow-remote` lets a phone use it over a private network such as Tailscale.

### 3. Android app: base built, APK compiles

- `android/` holds a Kotlin app: a **reader browser** with an address bar, a **Translate** button and a ⋮ menu (toggle original, scan page, retry, auto-translate, settings).
- It works with "Open with Dalbit" from links and "Share → Dalbit" from Chrome.
- It injects the **same content script** as the extension, through a small adapter (`extension/src/android/shim.ts`) that bridges to Kotlin.
- **On-phone engine:** a hidden WebView runs the same built-in engine from the app's own files. Those files are served with the isolation headers that allow multiple threads, so no computer is needed.
- **Laptop/service mode:** set the service address and pairing token in Settings. The token stays in native code and is never visible to web pages.
- Images are downloaded natively, with the page's cookies and Referer, so hotlink protection works.
- **GitHub Actions builds the APK** on every push. The first run succeeded:
  <https://github.com/chrisbagas/manhwa-translator/actions/runs/41989913297>, under the artifact **dalbit-android-apk**.

---

## Test status

| Suite | Result |
|---|---|
| Extension unit tests (vitest) | 57 / 57 |
| Python service tests (real models) | 46 / 46 |
| Built-in engine e2e in Chromium (no service; includes zoom, scaled layouts, item window, double bubble, watermark) | 26 / 26 |
| Service-mode e2e in Chromium | 27 / 27 |
| Firefox build lint | 0 errors (4 warnings from ONNX Runtime and tesseract.js loaders) |
| Android APK build (GitHub Actions) | ✅ success |
| Android web side, simulated in Chromium (`extension/test/e2e/run-android-sim.mjs`) | Chapter translated through the bridge; Referer download, fonts, alignment and toggle all pass. **In progress:** cross-origin isolation of the engine page and Tesseract start-up inside the simulator (see below). |

**Not tested yet:**
- The APK on a real phone or emulator.
- Firefox at runtime.
- Real reader sites beyond the user's screenshots.
- The optional full-Hangul PaddleOCR model.
- Any AI (LLM) translator.

---

## Known issues

- **Translation quality is the main limit.** The Bergamot model is small and translates sentence by sentence with no story context. Examples: 마수 → "horse", 사신 dropped. The glossary helps; an AI translator is the real fix (next steps).
- **OCR** still slips on stylised fonts. Large artistic sound effects (화르륵, outlined 콰앙) are often not detected at all.
- **Android:**
  - Unverified on a device. Performance and memory on a phone are unknown, and the on-phone engine loads about 100 MB of models.
  - In the simulator, after switching to the real isolation headers, the engine didn't finish loading. That was being debugged when work stopped. The likely cause is test routing (worker requests not intercepted), not the app, but it must be confirmed.
  - The self-test reported Tesseract as "unavailable" in the simulator, so that needs checking too.
- **Untested reader site:** `newxtoon5.com` can't be reached from the build sandbox, so that chapter hasn't been tested. Save a few page images or screenshots and attach them.

---

## Next steps (in order)

1. **Finish verifying the Android base.**
   - Fix the simulator routing (context route that picks headers by requester; a draft is in `run-android-sim.mjs`) and confirm the engine loads with threads and Tesseract in the isolated page.
   - Add an emulator smoke test to GitHub Actions: install the APK, open a test page, tap Translate, check the overlays.
   - Then install on your phone: download the artifact, enable "Install unknown apps", and install.
2. **AI translator (biggest quality gain).**
   - Add an LLM provider to the service through the standard OpenAI-style interface (Ollama, LM Studio, llama.cpp).
   - It translates a whole page's bubbles in reading order, with the glossary, character names and previous-page context, and falls back to Bergamot automatically.
   - Suggested model for your Intel Core Ultra laptop (16 GB, Arc graphics): Qwen3 4B (Apache-2.0, ~2.5 GB); 8B if speed allows.
3. **Phone ↔ laptop setup.** Document Tailscale with `python -m dalbit serve --host <tailscale-ip> --allow-remote`, and a one-tap "Use my laptop" option in the app.
4. **Real-site hardening.** Test on pages you send (the newxtoon chapter), add site adapters if discovery fails, and tune OCR and layout.
5. **Later:**
   - The full-Hangul PaddleOCR recogniser (`npm run fetch-models -- --ppocr-korean` on a machine that can reach ModelScope).
   - Sound-effect detection.
   - Firefox runtime testing.
   - Optional hosting on Oracle Cloud's free ARM server.

---

## Where things are

| Path | What |
|---|---|
| `extension/` | Browser extension + shared engine (TypeScript). `npm run build` creates `dist/chrome`, `dist/firefox` and the Android assets |
| `extension/src/engine/` | Built-in engine: detection, recognisers, tiling, layout, translation stage, language score |
| `extension/src/android/` | Android adapter (`shim.ts`) and engine page (`engine.ts`) |
| `android/` | Kotlin app (`MainActivity`, `ReaderBridge`, `EngineClient`, `AssetServer`) |
| `service/` | Python local service (`python -m dalbit serve`) |
| `.github/workflows/android.yml` | APK build |
| `docs/` | Architecture, models and licences, benchmarks, Android notes, this file |
| `samples/user/` | Your own test pages (git-ignored, never committed) |
