"""Korean onomatopoeia (sound effects / mimetic words) -> short English glosses.

General NMT models translate isolated sound effects poorly ("쾅" -> "bang" is
fine, "두근두근" often is not), so a small hand-written lexicon is tried first.
Entries are written for this project. Unknown effects fall back to the NMT
model and are flagged as uncertain rather than invented.
"""

from __future__ import annotations

import re

# Base syllable(s) -> English. Matching tolerates repetition (쿵쿵쿵), trailing
# punctuation and elongation marks (쾅!!, 쾅~).
LEXICON_KO: dict[str, str] = {
    "쾅": "BOOM", "쿵": "THUD", "쿠궁": "RUMBLE", "콰광": "KA-BOOM", "콰앙": "KA-BOOM", "펑": "POW",
    "퍽": "WHAM", "팍": "WHACK", "빡": "SMACK", "짝": "SLAP", "철썩": "SPLASH", "첨벙": "SPLASH",
    "탁": "TAP", "톡": "TAP", "똑": "KNOCK", "똑똑": "KNOCK KNOCK", "딸깍": "CLICK", "찰칵": "CLICK",
    "쨍그랑": "CRASH", "와장창": "CRASH", "우당탕": "CLATTER", "쿵쾅": "STOMP", "쾅쾅": "BANG BANG",
    "휙": "WHOOSH", "쉭": "SWISH", "슉": "SHOOP", "훅": "WHOOSH", "휘익": "WHOOSH", "샥": "SWISH",
    "두근": "BA-DUM", "두근두근": "BA-DUM BA-DUM", "콩닥": "THUMP-THUMP", "쿵쾅쿵쾅": "THUMP THUMP",
    "번쩍": "FLASH", "반짝": "SPARKLE", "빤짝": "SPARKLE", "스윽": "SHFF", "슥": "SHF",
    "부들": "TREMBLE", "덜덜": "SHIVER", "후들": "WOBBLE", "움찔": "FLINCH", "흠칫": "STARTLE",
    "털썩": "FLOP", "풀썩": "FLOP", "벌떡": "JOLT UP", "꿀꺽": "GULP", "꿀떡": "GULP", "냠": "NOM",
    "냠냠": "NOM NOM", "쩝": "SMACK", "후": "PHEW", "휴": "PHEW", "하아": "HAAH", "헉": "GASP",
    "흑": "SOB", "훌쩍": "SNIFF", "킥": "SNICKER", "킥킥": "HEHE", "크크": "HEH HEH", "ㅋㅋ": "LOL",
    "ㅋㅋㅋ": "LOL", "하하": "HAHA", "히히": "HEHE", "흐흐": "HEH HEH", "깔깔": "CACKLE",
    "으악": "AAARGH", "꺅": "EEK", "꺄악": "KYAAH", "아악": "AAAH", "윽": "UGH", "읏": "NGH",
    "쿨럭": "COUGH", "콜록": "COUGH", "에취": "ACHOO", "쯧": "TSK", "칫": "TCH", "흥": "HMPH",
    "부릉": "VROOM", "끼익": "SCREECH", "빵빵": "HONK HONK", "띵동": "DING-DONG", "따르릉": "RING RING",
    "지잉": "BZZT", "위잉": "WHIRR", "삐": "BEEP", "삐빅": "BEEP-BEEP", "째깍": "TICK", "똑딱": "TICK-TOCK",
    "주르륵": "TRICKLE", "뚝뚝": "DRIP DRIP", "뚝": "DRIP", "보글": "BUBBLE", "치익": "SIZZLE",
    "활활": "BLAZE", "화르륵": "WHOOSH", "우르릉": "RUMBLE", "쏴아": "SHHHH", "솨아": "SHHHH",
    "꽉": "SQUEEZE", "꾹": "PRESS", "덥석": "GRAB", "툭": "POKE", "쿡": "JAB", "찌릿": "ZAP",
    "빠직": "SNAP", "뚜둑": "CRACK", "우두둑": "CRUNCH", "바스락": "RUSTLE", "부스럭": "RUSTLE",
    "저벅": "STEP", "터벅": "TRUDGE", "뚜벅": "STEP", "타닥": "PATTER", "후다닥": "DASH", "쌩": "ZOOM",
    "슝": "ZOOM", "번뜩": "GLINT", "히죽": "SMIRK", "씨익": "GRIN", "방긋": "SMILE", "멍": "BLANK",
    "글썽": "TEARY", "끄덕": "NOD", "도리도리": "HEAD SHAKE", "빼꼼": "PEEK", "힐끔": "GLANCE",
    "쓱": "SHF", "꿈틀": "TWITCH", "부르르": "SHUDDER", "벌컥": "BURST OPEN", "철컥": "CLACK",
}

_PUNCT = re.compile(r"[\s!?.,~…\-ー·:;'\"“”‘’()\[\]]+")


def normalize(text: str) -> str:
    return _PUNCT.sub("", text)


def _collapse_repeats(s: str) -> tuple[str, int]:
    """'쿵쿵쿵' -> ('쿵', 3); '두근두근' -> ('두근', 2)."""
    for size in range(1, len(s) // 2 + 1):
        unit = s[:size]
        if len(s) % size == 0 and unit * (len(s) // size) == s:
            return unit, len(s) // size
    return s, 1


def lookup(text: str, lang: str = "ko") -> str | None:
    if lang != "ko":
        return None
    s = normalize(text)
    if not s:
        return None
    # Elongations: 쾅앙 / 쿠우웅 style vowel stretching is common; strip trailing
    # filler syllables 아/앙/으/응/우/웅/이/잉 once if the base form is known.
    candidates = [s]
    unit, reps = _collapse_repeats(s)
    if reps > 1:
        candidates.append(unit)
    stripped = re.sub(r"[아앙으응우웅이잉어엉]+$", "", s)
    if stripped and stripped != s:
        candidates.append(stripped)
    for c in candidates:
        if c in LEXICON_KO:
            gloss = LEXICON_KO[c]
            if c == unit and reps > 1 and c not in (s,):
                gloss = " ".join([gloss] * min(reps, 3))
            return gloss + ("!" if "!" in text else "")
    return None


def looks_like_sfx(text: str, lang: str = "ko") -> bool:
    s = normalize(text)
    if not s or len(s) > 6:
        return False
    if lookup(text, lang):
        return True
    unit, reps = _collapse_repeats(s)
    return reps > 1 and len(unit) <= 2
