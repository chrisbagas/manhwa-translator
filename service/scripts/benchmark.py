"""Measure speed, memory and OCR accuracy on the generated fixtures.

    python scripts/benchmark.py [--recognizer easyocr|ppocr-korean] [--huge]

Prints a Markdown table (paste into docs/BENCHMARKS.md). --huge also builds a
720 x 40 000 px strip to check that memory stays bounded on very long images.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import platform
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from PIL import Image  # noqa: E402

from dalbit.config import Config  # noqa: E402
from dalbit.pipeline import Engine  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "generated"


def lev(a: str, b: str) -> int:
    d = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        p, d[0] = d[0], i
        for j, cb in enumerate(b, 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (ca != cb))
    return d[-1]


def peak_mb() -> int:
    try:
        import resource  # POSIX only (Linux reports KiB)

        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    except ImportError:
        return -1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--recognizer", default="easyocr")
    ap.add_argument("--huge", action="store_true")
    args = ap.parse_args()
    if not (FIX / "tall_strip.png").exists():
        from tests.fixtures.generate import make_all

        make_all(FIX)
    os.environ["DALBIT_RECOGNIZER"] = args.recognizer
    cfg = Config(home=Path(tempfile.mkdtemp(prefix="dalbit-bench-")))
    cfg.recognizer = args.recognizer
    eng = Engine(cfg)
    t = time.perf_counter()
    warm = eng.warm_up()
    print(f"# Dalbit benchmark\n\n- CPU: {platform.processor() or platform.machine()} x{os.cpu_count()} threads\n- Python {platform.python_version()}, {platform.system()}")
    print(f"- models: {json.dumps(eng.models())}\n- model load + warm-up: {time.perf_counter() - t:.1f} s ({warm['ms']} ms), RSS after load {peak_mb()} MB\n")
    print("| image | size | regions | detect ms | recognise ms | layout ms | translate ms | total ms (cold) | total ms (cached) | OCR CER |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    tot_err = tot_len = 0
    names = ["dialogue_single", "multi_bubbles", "sfx_rotated", "long_translation", "tall_strip"] + [f"chapter_{i:02d}" for i in range(1, 7)]
    for name in names:
        data = (FIX / f"{name}.png").read_bytes()
        gt = json.loads((FIX / f"{name}.json").read_text(encoding="utf-8"))
        r = eng.process(data)
        r2 = eng.process(data)
        ref = "".join(b["text"] for b in gt["blocks"] if b["kind"] != "sfx").replace("\n", "").replace(" ", "")
        got = "".join(x["source_text"] for x in r["regions"] if x["kind"] != "sfx").replace(" ", "")
        e = lev(got, ref)
        tot_err += e
        tot_len += len(ref)
        tm = r["timingsMs"]
        print(f"| {name} | {r['width']}x{r['height']} | {len(r['regions'])} | {tm.get('detect', 0):.0f} | {tm.get('recognize', 0):.0f} | {tm.get('layout', 0):.0f} | {tm.get('translate', 0):.0f} | {tm['total']:.0f} | {r2['timingsMs']['total']:.0f} | {e / max(1, len(ref)):.3f} |")
    print(f"\nOverall OCR character error rate (dialogue/narration, spaces ignored): **{tot_err / tot_len:.3f}** ({tot_err}/{tot_len})")
    print(f"Peak RSS after fixtures: {peak_mb()} MB")

    if args.huge:
        strip = Image.open(FIX / "tall_strip.png").convert("RGB")
        reps = 40000 // strip.height + 1
        huge = Image.new("RGB", (strip.width, strip.height * reps))
        for i in range(reps):
            huge.paste(strip, (0, i * strip.height))
        huge = huge.crop((0, 0, strip.width, 40000))
        buf = io.BytesIO()
        huge.save(buf, format="PNG")
        del huge, strip
        before = peak_mb()
        t = time.perf_counter()
        r = eng.process(buf.getvalue())
        dt = time.perf_counter() - t
        print(f"\nHuge strip 720x40000 ({len(buf.getvalue()) / 1e6:.1f} MB PNG): {len(r['regions'])} regions, {r['tiling']['tiles']} tiles, {dt:.1f} s, "
              f"peak RSS {before} -> {peak_mb()} MB")
    eng.translator.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
