# Android: options (investigation only, nothing built)

Status: **untested assumptions**. No Android device or emulator was used for this document.

## The three candidates

| | A. Extension in an extension-capable Android browser | B. Native reader / share-target app | C. Phone as a thin client of the desktop service |
|---|---|---|---|
| Works without the computer? | Only if inference also moves onto the phone (not the case today) | **Yes**, if models run on-device | **No**: the computer must be on, running `dalbit serve`, on the same network |
| How | Install the extension in a Chromium-based browser that supports desktop extensions (several Chromium forks do), or Firefox for Android (deliberately not assumed: the add-on would need AMO listing and Android testing) | Kotlin app: Android share sheet ("Share image to Dalbit") or a built-in WebView reader, OCR + translation on-device, overlay rendered natively | Same extension or a small web/native client; the service runs with `--allow-remote` on the LAN with the token |
| OCR on phone | — | PP-OCR det + Korean rec as ONNX via ONNX Runtime Mobile (~25 MB). Plausible on mid-range phones; latency unmeasured | runs on desktop |
| Translation on phone | — | Bergamot has native Android builds (Firefox for Android ships it); ~50 MB model | runs on desktop |
| Whole-chapter UX | Same as desktop (discovery, overlays), if the browser supports MV3 content scripts and `scripting` | Must reimplement discovery (WebView) or work on shared images/screenshots one at a time | Same as desktop extension in an extension-capable browser |
| Main risks | Browser support for MV3 APIs varies; image fetching and host permissions unclear; memory limits | Most work: native UI, model packaging, battery and thermals; but best long-term product | LAN exposure (needs pairing, TLS or a tunnel); the computer must stay awake |
| Effort | Low (reuse) | High | Low |

## Recommendation (to verify before building)

1. **Prototype C first.** It is cheapest. It requires keeping the computer running, which is fine for personal use at home. Before relying on it, add TLS or pair-and-pin, because the token travels over the LAN.
2. **Evaluate A on one or two real extension-capable browsers** with a test checklist: content-script injection, `<all_urls>` fetch, overlay rendering, memory on a long chapter.
3. **For phone-only use, B is the only real path.** The service architecture was kept portable for this:
   - Detector and recogniser are ONNX-exportable.
   - Translation is Bergamot.
   - Layout logic is plain NumPy and could be ported.

   Measure on-device latency for one tall page before committing to it.
