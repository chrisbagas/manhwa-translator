"""Small on-disk JSON cache with a size cap (oldest entries evicted first)."""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path


class DiskCache:
    def __init__(self, root: Path, *, max_bytes: int = 512 * 1024 * 1024):
        self.root = root
        self.max_bytes = max_bytes
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._writes = 0

    @staticmethod
    def make_key(*parts: str) -> str:
        return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()

    def _path(self, ns: str, key: str) -> Path:
        return self.root / ns / key[:2] / f"{key}.json"

    def get(self, ns: str, key: str) -> dict | None:
        p = self._path(ns, key)
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            os.utime(p, None)  # LRU-ish: reading refreshes mtime
            return data
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def put(self, ns: str, key: str, value: dict) -> None:
        p = self._path(ns, key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, p)
        with self._lock:
            self._writes += 1
            if self._writes % 25 == 0:
                self.prune()

    def prune(self) -> int:
        files = [(f.stat().st_mtime, f.stat().st_size, f) for f in self.root.rglob("*.json")]
        total = sum(s for _, s, _ in files)
        removed = 0
        for _, size, f in sorted(files):
            if total <= self.max_bytes:
                break
            try:
                f.unlink()
                total -= size
                removed += 1
            except FileNotFoundError:
                pass
        return removed

    def clear(self) -> None:
        for f in self.root.rglob("*.json"):
            f.unlink(missing_ok=True)

    def stats(self) -> dict:
        files = list(self.root.rglob("*.json"))
        return {"entries": len(files), "bytes": sum(f.stat().st_size for f in files), "maxBytes": self.max_bytes, "at": time.time()}
