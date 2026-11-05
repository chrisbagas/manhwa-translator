"""Export EasyOCR's korean_g2 recogniser (Apache-2.0) to ONNX for in-browser use.

    python scripts/export_recognizer_onnx.py [--out ../extension/assets/models]

Writes korean_g2.onnx and korean_g2.json (character table + characters to
ignore, matching easyocr.Reader(['ko', 'en'])), then checks that ONNX Runtime
reproduces PyTorch's output on the generated fixtures.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class ImageOnly(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, image):
        # Same maths as easyocr.model.vgg_model.Model.forward, with the
        # AdaptiveAvgPool2d((None, 1)) written as a mean so the width can vary.
        m = self.model
        f = m.FeatureExtraction(image).permute(0, 3, 1, 2)
        f = f.mean(dim=3)
        return m.Prediction(m.SequenceModeling(f).contiguous())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT.parent / "extension" / "assets" / "models"))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    import easyocr

    reader = easyocr.Reader(["ko", "en"], gpu=False, detector=False, quantize=False,
                            model_storage_directory=str(ROOT / "models" / "easyocr"), download_enabled=False, verbose=False)
    model = ImageOnly(reader.recognizer).eval()
    dummy = torch.zeros(1, 1, 64, 256)
    onnx_path = out / "korean_g2.onnx"
    torch.onnx.export(model, (dummy,), str(onnx_path), input_names=["image"], output_names=["logits"],
                      dynamic_axes={"image": {0: "batch", 3: "width"}, "logits": {0: "batch", 1: "steps"}},
                      opset_version=17, dynamo=False)
    character = ["[blank]"] + list(reader.character)
    ignore_chars = set(reader.character) - set(reader.lang_char)
    ignore_idx = sorted(i for i, c in enumerate(character) if c in ignore_chars)
    meta = {
        "source": "EasyOCR korean_g2 (Apache-2.0), exported by scripts/export_recognizer_onnx.py",
        "weights_sha256": hashlib.sha256((ROOT / "models" / "easyocr" / "korean_g2.pth").read_bytes()).hexdigest(),
        "onnx_sha256": hashlib.sha256(onnx_path.read_bytes()).hexdigest(),
        "imgH": 64,
        "characters": character,
        "ignore_idx": ignore_idx,
    }
    (out / "korean_g2.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {onnx_path} ({onnx_path.stat().st_size / 1e6:.1f} MB), {len(character)} classes, {len(ignore_idx)} ignored")

    # Parity check against PyTorch on random-width inputs.
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    worst = 0.0
    for w in (64, 192, 448, 960):
        x = rng.uniform(-1, 1, (1, 1, 64, w)).astype(np.float32)
        with torch.no_grad():
            ref = reader.recognizer(torch.from_numpy(x), None).numpy()  # original module
        got = sess.run(None, {"image": x})[0]
        worst = max(worst, float(np.abs(ref - got).max()))
    print(f"max |torch - onnx| logit difference: {worst:.2e}")
    return 0 if worst < 1e-3 else 1


if __name__ == "__main__":
    sys.exit(main())
