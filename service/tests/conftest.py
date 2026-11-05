from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
FIXTURES = ROOT / "tests" / "fixtures" / "generated"
MODELS = ROOT / "models"

HAVE_MODELS = (MODELS / "onnx" / "korean_g2.onnx").exists() and (MODELS / "bergamot" / "koen").is_dir() and bool(shutil.which("node"))
needs_models = pytest.mark.skipif(not HAVE_MODELS, reason="models not downloaded (scripts/download_models.py) or node missing")


@pytest.fixture(scope="session")
def fixtures() -> Path:
    if not (FIXTURES / "tall_strip.png").exists():
        from tests.fixtures.generate import make_all

        make_all(FIXTURES)
    return FIXTURES


def load_gt(fixtures: Path, name: str) -> dict:
    return json.loads((fixtures / f"{name}.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def engine(tmp_path_factory):
    from dalbit.config import Config
    from dalbit.pipeline import Engine

    cfg = Config(home=tmp_path_factory.mktemp("dalbit-home"))
    cfg.models_dir = MODELS
    e = Engine(cfg)
    yield e
    e.translator.close()


def center(box):
    x, y, w, h = box
    return x + w / 2, y + h / 2


def inside(pt, box, slack=0):
    x, y, w, h = box
    return x - slack <= pt[0] <= x + w + slack and y - slack <= pt[1] <= y + h + slack


def match_regions(result: dict, gt: dict) -> dict[int, list[dict]]:
    """GT block index -> result regions whose centre lies in that block's box."""
    out: dict[int, list[dict]] = {i: [] for i in range(len(gt["blocks"]))}
    for r in result["regions"]:
        c = center(r["bbox"])
        for i, b in enumerate(gt["blocks"]):
            if inside(c, b["box"]):
                out[i].append(r)
    return out
