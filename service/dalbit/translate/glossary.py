"""User glossary (names, terms) applied around a sentence-level NMT model.

Bergamot has no terminology-constraint API and no document context. What it
does reliably is copy Latin-script tokens through, so glossary terms are
substituted with their English form *before* translation ("민준은" ->
"Minjun은"), which keeps character names consistent across bubbles. This is a
best-effort technique, not a guarantee; outputs are flagged when a glossary
term was applied so the reader can check them.
"""

from __future__ import annotations

import hashlib
import json
import re


def normalize_glossary(raw: object, *, max_entries: int = 500, max_len: int = 64) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in list(raw.items())[:max_entries]:
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        k, v = k.strip(), v.strip()
        if 0 < len(k) <= max_len and 0 < len(v) <= max_len:
            out[k] = v
    return out


def glossary_hash(glossary: dict[str, str]) -> str:
    if not glossary:
        return "none"
    return hashlib.sha256(json.dumps(sorted(glossary.items()), ensure_ascii=False).encode()).hexdigest()[:12]


def apply(text: str, glossary: dict[str, str]) -> tuple[str, list[str]]:
    used = []
    # Longest terms first so "김민준" wins over "민준".
    for src in sorted(glossary, key=len, reverse=True):
        if src in text:
            text = re.sub(re.escape(src), glossary[src], text)
            used.append(src)
    return text, used
