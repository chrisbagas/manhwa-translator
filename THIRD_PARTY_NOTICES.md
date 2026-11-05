# Third-party notices

Components bundled in the browser extension:

| Component | Files | License |
|---|---|---|
| Comic Neue (Craig Rozynski, Hrant Papazian) | fonts/ComicNeue-*.ttf | SIL Open Font License 1.1 (fonts/OFL-ComicNeue.txt) |
| Atkinson Hyperlegible (Braille Institute) | fonts/AtkinsonHyperlegible-*.ttf | SIL Open Font License 1.1 (fonts/OFL-AtkinsonHyperlegible.txt) |
| Bangers (Vernon Adams) | fonts/Bangers-Regular.ttf | SIL Open Font License 1.1 (fonts/OFL-Bangers.txt) |

Components used by the local service (downloaded or installed separately, not bundled
in the extension). See docs/MODELS.md for versions, checksums and details.

| Component | Use | Code license | Weights / data license |
|---|---|---|---|
| RapidOCR + PP-OCRv6 detector (PaddlePaddle) | text detection | Apache-2.0 | Apache-2.0 |
| EasyOCR korean_g2 (Jaided AI) | Korean recognition | Apache-2.0 | Apache-2.0 |
| PaddleOCR korean_PP-OCRv5_rec_mobile (optional) | Korean recognition | Apache-2.0 | Apache-2.0 |
| bergamot-translator WASM (@browsermt) | translation engine | MPL-2.0 | — |
| Mozilla Firefox Translations ko→en model | translation model | — | MPL-2.0 |
| PyTorch, ONNX Runtime, OpenCV, Pillow, NumPy, aiohttp | runtime | BSD/MIT/Apache-2.0/HPND | — |
