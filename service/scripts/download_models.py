"""Download the local models Dalbit needs, verifying SHA-256 checksums.

    python scripts/download_models.py               # required models (~65 MB download)
    python scripts/download_models.py --ppocr-korean # + optional PP-OCRv5 Korean recogniser
    python scripts/download_models.py --pivot es    # + en->es model for ko->en->es

Everything is fetched once from the publishers' own hosting and then used
offline. Nothing is uploaded anywhere.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"
MOZ = "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/models"

# Mozilla Firefox Translations models (MPL-2.0). The ko-en entry is the
# "base-memory" model Mozilla evaluated in mozilla/firefox-translations-models
# (FLORES COMET 0.863 vs OPUS-MT 0.827); hashes are of the UNCOMPRESSED files.
BERGAMOT = {
    "koen": {
        "base": f"{MOZ}/ko-en/cjk_retrain_base-memory_QgYNtG3BTzKBFSV1wl06Pg/exported",
        "files": {
            "model.koen.intgemm.alphas.bin": "7cb30cbc0a86e242084756445268a2346136771c92b884d9b4ebb077f67d5507",
            "lex.50.50.koen.s2t.bin": "b26291f063ce216a74239275f0485534a38111203e59d42a2a56ba62d6eeb196",
            "vocab.koen.spm": "1c72b740ab793cdc3a8f16913dd6b4e806c77421077dd2d85edeb7be38418598",
        },
    },
}

EASYOCR = {
    # EasyOCR (Apache-2.0) Korean recogniser, published on the project's GitHub releases.
    "url": "https://github.com/JaidedAI/EasyOCR/releases/download/v1.3/korean_g2.zip",
    "zip_sha256": "3cdaad22676723040ceb5c6fe72089d656b3bc1f630889c373ade86f3ab38c2e",
    "file": "korean_g2.pth",
    "sha256": "ecdead53c909748aad74bc2f2beeab3e3ad751134db6335e97ea19f879ca407e",
}

PPOCR_KOREAN = {
    # Official PaddleOCR korean_PP-OCRv5_rec_mobile (Apache-2.0) ONNX export as
    # listed in RapidOCR 3.10's model registry (same SHA-256 as listed there).
    "url": "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx",
    "file": "korean_PP-OCRv5_rec_mobile.onnx",
    "sha256": "cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b",
}


def fetch(url: str) -> bytes:
    print(f"  GET {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "dalbit-model-downloader/0.1"})
    with urllib.request.urlopen(req, timeout=120) as r:
        total = int(r.headers.get("Content-Length") or 0)
        buf = io.BytesIO()
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            buf.write(chunk)
            if total:
                print(f"\r    {buf.tell() / 1e6:6.1f} / {total / 1e6:.1f} MB", end="", flush=True)
        print()
        return buf.getvalue()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def check(data: bytes, expected: str | None, what: str) -> None:
    if expected and sha256(data) != expected:
        sys.exit(f"checksum mismatch for {what}: got {sha256(data)}, expected {expected}")


def bergamot_pair(pair: str, spec: dict | None = None) -> None:
    dest = MODELS / "bergamot" / pair
    if spec is None:
        # Discover the newest exported model for an extra pair (e.g. en->es pivot).
        s, t = pair[:2], pair[2:]
        listing = json.loads(fetch(f"https://storage.googleapis.com/storage/v1/b/moz-fx-translations-data--303e-prod-translations-data/o?prefix=models/{s}-{t}/&fields=items(name,updated)&maxResults=1000"))
        metas = sorted((i for i in listing.get("items", []) if i["name"].endswith("/exported/metadata.json")), key=lambda i: i["updated"])
        if not metas:
            sys.exit(f"no exported Mozilla model found for {s}-{t}")
        base = "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/" + metas[-1]["name"].rsplit("/", 1)[0]
        spec = {"base": base, "files": {f"model.{pair}.intgemm.alphas.bin": None, f"lex.50.50.{pair}.s2t.bin": None, f"vocab.{pair}.spm": None}}
        print(f"  using {base} (unpinned: verify before relying on it)")
    dest.mkdir(parents=True, exist_ok=True)
    meta = fetch(f"{spec['base']}/metadata.json")
    (dest / "metadata.json").write_bytes(meta)
    for name, digest in spec["files"].items():
        if (dest / name).exists() and (digest is None or sha256((dest / name).read_bytes()) == digest):
            print(f"  {pair}/{name} present")
            continue
        raw = gzip.decompress(fetch(f"{spec['base']}/{name}.gz"))
        if digest is None and name.startswith("model."):
            digest = json.loads(meta).get("hash")
        check(raw, digest, name)
        (dest / name).write_bytes(raw)
    print(f"  Bergamot {pair} ready ({sum(f.stat().st_size for f in dest.iterdir()) / 1e6:.0f} MB)")


def easyocr() -> None:
    dest = MODELS / "easyocr"
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / EASYOCR["file"]
    if target.exists() and sha256(target.read_bytes()) == EASYOCR["sha256"]:
        print("  EasyOCR korean_g2 present")
        return
    z = fetch(EASYOCR["url"])
    check(z, EASYOCR["zip_sha256"], "korean_g2.zip")
    with zipfile.ZipFile(io.BytesIO(z)) as zf:
        data = zf.read(EASYOCR["file"])
    check(data, EASYOCR["sha256"], EASYOCR["file"])
    target.write_bytes(data)
    print("  EasyOCR korean_g2 ready (16 MB)")


def ppocr_korean() -> None:
    dest = MODELS / "ppocr"
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / PPOCR_KOREAN["file"]
    if target.exists() and sha256(target.read_bytes()) == PPOCR_KOREAN["sha256"]:
        print("  PP-OCRv5 Korean present")
        return
    data = fetch(PPOCR_KOREAN["url"])
    check(data, PPOCR_KOREAN["sha256"], PPOCR_KOREAN["file"])
    target.write_bytes(data)
    print("  PP-OCRv5 Korean ready; enable with DALBIT_RECOGNIZER=ppocr-korean")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ppocr-korean", action="store_true", help="also fetch the optional PaddleOCR Korean recogniser")
    ap.add_argument("--pivot", action="append", default=[], help="extra target language via English, e.g. --pivot es")
    ap.add_argument("--skip-required", action="store_true")
    args = ap.parse_args()
    if not args.skip_required:
        print("EasyOCR Korean recogniser (Apache-2.0)")
        easyocr()
        print("Mozilla Bergamot ko->en (MPL-2.0)")
        bergamot_pair("koen", BERGAMOT["koen"])
    if args.ppocr_korean:
        print("PaddleOCR PP-OCRv5 Korean recogniser (Apache-2.0)")
        ppocr_korean()
    for t in args.pivot:
        print(f"Mozilla Bergamot en->{t} (MPL-2.0)")
        bergamot_pair(f"en{t}")
    print("The PP-OCRv6 text detector ships inside the `rapidocr` Python package; nothing to download.")
    shutil.disk_usage(MODELS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
