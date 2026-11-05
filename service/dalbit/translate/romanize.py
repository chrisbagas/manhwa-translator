"""Hangul -> Revised Romanization (syllable by syllable, no assimilation rules).

Used for sound effects that are not in the lexicon: "광!" -> "GWANG!". This
shows the reader the sound that was read without inventing a meaning.
"""

from __future__ import annotations

INITIALS = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"]
VOWELS = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"]
FINALS = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"]
JAMO = {"ㄱ": "g", "ㄲ": "kk", "ㄴ": "n", "ㄷ": "d", "ㄹ": "r", "ㅁ": "m", "ㅂ": "b", "ㅅ": "s", "ㅆ": "ss", "ㅇ": "", "ㅈ": "j",
        "ㅊ": "ch", "ㅋ": "k", "ㅌ": "t", "ㅍ": "p", "ㅎ": "h", "ㅏ": "a", "ㅓ": "eo", "ㅗ": "o", "ㅜ": "u", "ㅡ": "eu", "ㅣ": "i"}


def romanize(text: str) -> str:
    out = []
    for ch in text:
        code = ord(ch) - 0xAC00
        if 0 <= code < 11172:
            i, rest = divmod(code, 588)
            v, f = divmod(rest, 28)
            out.append(INITIALS[i] + VOWELS[v] + FINALS[f])
        elif ch in JAMO:
            out.append(JAMO[ch])
        else:
            out.append(ch)
    return "".join(out)
