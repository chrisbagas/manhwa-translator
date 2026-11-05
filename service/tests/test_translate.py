"""Translation helpers + the real Bergamot model (when installed)."""

from __future__ import annotations

import re

from dalbit.pipeline import split_sentences
from dalbit.translate import glossary, sfx
from dalbit.translate.romanize import romanize
from tests.conftest import MODELS, needs_models


def test_sfx_lexicon_handles_repeats_and_punctuation():
    assert sfx.lookup("쾅!") == "BOOM!"
    assert sfx.lookup("쿵쿵쿵") == "THUD THUD THUD"
    assert sfx.lookup("두근두근") == "BA-DUM BA-DUM"
    assert sfx.lookup("쾅앙~") == "BOOM"
    assert sfx.lookup("안녕하세요") is None


def test_romanization_of_unknown_effects():
    assert romanize("광!") == "gwang!"
    assert romanize("쿠궁") == "kugung"
    assert romanize("ㅋㅋ") == "kk"


def test_glossary_longest_term_first():
    g = {"민준": "Minjun", "김민준": "Kim Minjun"}
    text, used = glossary.apply("김민준은 민준이라고 불린다", g)
    assert text == "Kim Minjun은 Minjun이라고 불린다"
    assert set(used) == {"민준", "김민준"}
    assert glossary.glossary_hash(g) == glossary.glossary_hash(dict(reversed(list(g.items()))))


def test_sentence_split_keeps_ellipses_and_quotes():
    assert split_sentences("기다려! 나도 같이 갈래!") == ["기다려!", "나도 같이 갈래!"]
    assert split_sentences("살았다...") == ["살았다..."]
    assert split_sentences('"가자!" 그가 말했다.') == ['"가자!"', "그가 말했다."]


@needs_models
def test_bergamot_korean_dialogue_real_model():
    from dalbit.translate.bergamot import BergamotTranslator

    t = BergamotTranslator(MODELS / "bergamot")
    try:
        out = t.translate(["괜찮아.", "내가 지켜 줄게.", "형, 빨리 도망쳐요!"], "ko", "en")
        assert len(out) == 3
        for o in out:
            assert o and not re.search(r"[가-힣]", o), o
        assert "okay" in out[0].lower() or "fine" in out[0].lower() or "all right" in out[0].lower()
        assert "protect" in out[1].lower()
        # Glossary pre-substitution keeps names consistent.
        named = t.translate([glossary.apply("민준은 오늘 학교에 가지 않았다.", {"민준": "Minjun"})[0]], "ko", "en")[0]
        assert "Minjun" in named
        assert t.version("ko", "en").startswith("bergamot[koen:")
    finally:
        t.close()
