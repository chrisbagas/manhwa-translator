"""End-to-end pipeline on generated pages with REAL local OCR + translation."""

from __future__ import annotations

import re

import pytest

from tests.conftest import load_gt, match_regions, needs_models

HANGUL = re.compile(r"[가-힣]")
pytestmark = needs_models


def _run(engine, fixtures, name, **kw):
    return engine.process((fixtures / f"{name}.png").read_bytes(), **kw)


def test_single_dialogue_bubble(engine, fixtures):
    res = _run(engine, fixtures, "dialogue_single")
    assert len(res["regions"]) == 1
    r = res["regions"][0]
    assert r["kind"] == "dialogue"
    assert HANGUL.search(r["source_text"])
    assert r["translated_text"] and not HANGUL.search(r["translated_text"])
    assert r["render_mode"] == "replace" and r["patch"].startswith("data:image/png;base64,")
    assert r["bubble"]["shape"] in ("ellipse", "free") and r["bubble"]["flat"]
    # Structured data is preserved for every line.
    assert all({"quad", "text", "confidence", "angle", "bbox"} <= set(ln) for ln in r["lines"])
    assert r["id"].startswith("r") and isinstance(r["order"], int)


def test_multiple_bubbles_reading_order_and_kinds(engine, fixtures):
    gt = load_gt(fixtures, "multi_bubbles")
    res = _run(engine, fixtures, "multi_bubbles")
    matched = match_regions(res, gt)
    for i, block in enumerate(gt["blocks"]):
        assert len(matched[i]) == 1, f"block {i} ({block['text']!r}) matched {len(matched[i])} regions"
    # Reading order of matched regions equals ground-truth order.
    orders = [matched[i][0]["order"] for i in range(len(gt["blocks"]))]
    assert orders == sorted(orders)
    kinds = [matched[i][0]["kind"] for i in range(len(gt["blocks"]))]
    assert kinds == [b["kind"] for b in gt["blocks"]]
    # Two-line bubbles are translated as ONE block, not fragment by fragment.
    two_line = matched[2][0]
    assert len(two_line["lines"]) == 2 and two_line["translated_text"].count(".") >= 1


def test_tall_strip_text_across_tile_boundaries(engine, fixtures):
    gt = load_gt(fixtures, "tall_strip")
    res = _run(engine, fixtures, "tall_strip")
    assert res["tiling"]["tiles"] >= 6
    matched = match_regions(res, gt)
    for i, block in enumerate(gt["blocks"]):
        assert len(matched[i]) == 1, f"bubble {i} at y={block['box'][1]} found {len(matched[i])} times"
        r = matched[i][0]
        # Region coordinates are in ORIGINAL image space.
        bx, by, bw, bh = block["box"]
        x, y, w, h = r["bbox"]
        assert bx <= x and by <= y and x + w <= bx + bw and y + h <= by + bh
        assert len(r["lines"]) == block["text"].count("\n") + 1
    orders = [matched[i][0]["order"] for i in range(len(gt["blocks"]))]
    assert orders == sorted(orders)


def test_rotated_sound_effect_is_annotated_not_replaced(engine, fixtures):
    gt = load_gt(fixtures, "sfx_rotated")
    res = _run(engine, fixtures, "sfx_rotated")
    sfx_gt = [b for b in gt["blocks"] if b["kind"] == "sfx"][0]
    matched = match_regions(res, gt)
    r = matched[gt["blocks"].index(sfx_gt)]
    assert len(r) == 1
    r = r[0]
    assert r["kind"] == "sfx"
    assert abs(r["angle"] - sfx_gt["angle"]) < 6
    assert r["render_mode"] in ("annotate", "marker")
    assert r["patch"] is None, "artistic lettering must never be painted over by default"
    assert r["translated_text"], "an annotation (gloss or romanised reading) must be present"
    assert r["translation_note"] in ("sfx-lexicon", "sfx-romanized")
    # Annotation box must not cover the effect itself.
    if r["render_mode"] == "annotate":
        ax, ay, aw, ah = r["render_box"]
        sx, sy, sw, sh = r["bbox"]
        inter = max(0, min(ax + aw, sx + sw) - max(ax, sx)) * max(0, min(ay + ah, sy + sh) - max(ay, sy))
        assert inter < 0.25 * aw * ah
    # "Original only" hides SFX entirely.
    res2 = _run(engine, fixtures, "sfx_rotated", sfx_mode="original")
    r2 = [x for x in res2["regions"] if x["kind"] == "sfx"][0]
    assert r2["render_mode"] == "hidden"


def test_long_translation_gets_render_box_inside_bubble(engine, fixtures):
    gt = load_gt(fixtures, "long_translation")
    res = _run(engine, fixtures, "long_translation")
    assert len(res["regions"]) == 1
    r = res["regions"][0]
    bx, by, bw, bh = gt["blocks"][0]["box"]
    x, y, w, h = r["render_box"]
    assert bx <= x and by <= y and x + w <= bx + bw and y + h <= by + bh
    # Translation is longer than the bubble's original text area: fitting is the
    # renderer's job (tests in extension/), but nothing may be dropped here.
    assert len(r["translated_text"]) > len(r["source_text"])
    assert r["translated_text"].count("?") + r["translated_text"].count("!") >= 2


def test_cache_invalidation_when_settings_change(engine, fixtures):
    data = (fixtures / "chapter_02.png").read_bytes()
    engine.cache.clear()
    a = engine.process(data, tgt="en")
    assert a["cache"] == {"analysis": False, "result": False}
    b = engine.process(data, tgt="en")
    assert b["cache"] == {"analysis": True, "result": True}
    # New glossary -> translation recomputed, OCR reused.
    c = engine.process(data, tgt="en", glossary={"서진": "Seojin"})
    assert c["cache"] == {"analysis": True, "result": False}
    assert any("Seojin" in r["translated_text"] for r in c["regions"]), [r["translated_text"] for r in c["regions"]]
    # SFX mode is part of the key as well.
    d = engine.process(data, tgt="en", sfx_mode="original")
    assert d["cache"] == {"analysis": True, "result": False}
    # Unsupported target -> explicit error, never a silent fallback.
    from dalbit.translate.base import TranslationUnavailable

    with pytest.raises(TranslationUnavailable):
        engine.process(data, tgt="xx")


def test_cancel_before_start(engine, fixtures):
    import threading

    from dalbit.pipeline import Cancelled

    ev = threading.Event()
    ev.set()
    engine.cache.clear()
    with pytest.raises(Cancelled):
        engine.process((fixtures / "chapter_03.png").read_bytes(), cancel=ev)


def test_rejects_non_images(engine):
    from dalbit.imageio import ImageRejected

    with pytest.raises(ImageRejected):
        engine.process(b"<html>not an image</html>")


@pytest.mark.parametrize("name", [f"chapter_{i:02d}" for i in range(1, 7)])
def test_chapter_pages_have_no_artwork_false_positives(engine, fixtures, name):
    gt = load_gt(fixtures, name)
    res = _run(engine, fixtures, name)
    assert len(res["regions"]) == len(gt["blocks"]), [(r["source_text"], r["kind"]) for r in res["regions"]]
    for d in res.get("discarded", []):
        assert d["reason"] == "likely-artwork"
    if res.get("discarded"):
        assert any("not shown" in w for w in res["warnings"]), "discarded detections must be reported"
