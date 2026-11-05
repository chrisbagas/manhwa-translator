"""Translation provider interface."""

from __future__ import annotations

from typing import Protocol


class Translator(Protocol):
    name: str

    def version(self, source: str, target: str) -> str:
        """Identifier that changes whenever outputs could change (used in cache keys)."""

    def supports(self, source: str, target: str) -> bool: ...

    def translate(self, texts: list[str], source: str, target: str) -> list[str]:
        """Translate independent segments (one bubble each). Order is preserved."""


class TranslationUnavailable(RuntimeError):
    pass
