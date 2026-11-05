"""Dalbit local service CLI.

    python -m dalbit serve                 # start the loopback service
    python -m dalbit token                 # print the pairing token
    python -m dalbit translate page.png    # one image -> JSON + preview PNG
    python -m dalbit doctor                # check models / Node / settings
"""

from __future__ import annotations

import argparse
import json
import logging
import resource
import shutil
import sys
import time
from pathlib import Path

from .config import Config


def _cmd_translate(args, cfg: Config) -> int:
    from .pipeline import Engine
    from .preview import render
    from .translate.glossary import normalize_glossary

    engine = Engine(cfg)
    glossary = normalize_glossary(json.loads(Path(args.glossary).read_text(encoding="utf-8"))) if args.glossary else {}
    for path in args.images:
        p = Path(path)
        t = time.perf_counter()
        result = engine.process(p.read_bytes(), src=args.source, tgt=args.target, glossary=glossary, sfx_mode=args.sfx)
        dt = time.perf_counter() - t
        out_json = p.with_suffix(".dalbit.json") if not args.out_dir else Path(args.out_dir) / (p.stem + ".dalbit.json")
        out_png = out_json.with_suffix("").with_suffix(".preview.png")
        out_json.parent.mkdir(parents=True, exist_ok=True)
        out_json.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        render(p, result, out_png)
        print(f"{p.name}: {len(result['regions'])} regions in {dt:.2f}s  cache={result['cache']}  -> {out_png}")
        for r in result["regions"]:
            print(f"  #{r['order']} [{r['kind']:9s}] conf={r['confidence']:.2f} {r['source_text']!r} -> {r['translated_text']!r} ({r['render_mode']})")
    print(f"max RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024} MB")
    return 0


def _cmd_doctor(args, cfg: Config) -> int:
    ok = True
    print(f"models dir: {cfg.models_dir}")
    checks = {
        "EasyOCR korean_g2": cfg.models_dir / "easyocr" / "korean_g2.pth",
        "Bergamot ko->en model": cfg.models_dir / "bergamot" / "koen" / "model.koen.intgemm.alphas.bin",
        "Bergamot host deps": Path(__file__).resolve().parents[1] / "bergamot_host" / "node_modules" / "@browsermt" / "bergamot-translator",
        "(optional) PP-OCRv5 Korean": cfg.models_dir / "ppocr" / "korean_PP-OCRv5_rec_mobile.onnx",
    }
    for name, path in checks.items():
        present = path.exists()
        ok &= present or name.startswith("(optional)")
        print(f"  [{'ok' if present else '--'}] {name}: {path}")
    node = shutil.which("node")
    print(f"  [{'ok' if node else '--'}] node: {node}")
    ok &= bool(node)
    print(f"token file: {cfg.token_file}")
    print(f"cache dir: {cfg.cache_dir}")
    if ok and args.warm:
        from .pipeline import Engine

        e = Engine(cfg)
        print("warm-up:", e.warm_up(), e.models())
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="dalbit")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="run the local service")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=None)
    s.add_argument("--allow-remote", action="store_true", help="allow binding to a non-loopback address (LAN only; see docs)")
    s.add_argument("--allow-origin", action="append", default=[], help="restrict to this exact extension origin (repeatable)")
    s.add_argument("--no-warm", action="store_true")
    sub.add_parser("token", help="print the pairing token")
    t = sub.add_parser("translate", help="translate image files (stage A CLI)")
    t.add_argument("images", nargs="+")
    t.add_argument("--source", default="ko")
    t.add_argument("--target", default="en")
    t.add_argument("--sfx", default="annotate", choices=["annotate", "original", "replace"])
    t.add_argument("--glossary", help="JSON file {\"민준\": \"Minjun\"}")
    t.add_argument("--out-dir")
    d = sub.add_parser("doctor", help="check installation")
    d.add_argument("--warm", action="store_true", help="also load models and run a test translation")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = Config()
    if args.cmd == "token":
        print(cfg.load_or_create_token())
        return 0
    if args.cmd == "translate":
        return _cmd_translate(args, cfg)
    if args.cmd == "doctor":
        return _cmd_doctor(args, cfg)
    if args.cmd == "serve":
        from .server import run

        cfg.host = args.host
        if args.port:
            cfg.port = args.port
        cfg.allow_remote = args.allow_remote
        cfg.allowed_origins = tuple(args.allow_origin)
        return run(cfg, warm=not args.no_warm)
    return 2


if __name__ == "__main__":
    sys.exit(main())
