"""Mozilla Bergamot (Marian NMT) translator, run in a Node.js child process.

Models are the ones Firefox's built-in translation uses (MPL-2.0), loaded from
local files. ko->en is direct; other targets pivot through English when an
en->X model is installed (e.g. models/bergamot/enes).
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import shutil
import subprocess
import threading
from pathlib import Path

from .base import TranslationUnavailable

HOST_JS = Path(__file__).resolve().parents[2] / "bergamot_host" / "host.mjs"


class BergamotTranslator:
    name = "bergamot"

    def __init__(self, models_dir: Path, *, node: str | None = None, timeout_s: float = 120.0):
        self.models_dir = models_dir
        self.node = node or os.environ.get("DALBIT_NODE") or shutil.which("node")
        self.timeout_s = timeout_s
        self._proc: subprocess.Popen | None = None
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._lock = threading.Lock()
        self._next_id = 0
        self._versions: dict[str, str] = {}

    # ---------------------------------------------------------------- models
    def _pair_dir(self, s: str, t: str) -> Path:
        return self.models_dir / f"{s}{t}"

    def _route(self, source: str, target: str) -> list[tuple[str, str]]:
        if self._pair_dir(source, target).is_dir():
            return [(source, target)]
        if source != "en" and target != "en" and self._pair_dir(source, "en").is_dir() and self._pair_dir("en", target).is_dir():
            return [(source, "en"), ("en", target)]
        return []

    def supports(self, source: str, target: str) -> bool:
        return bool(self._route(source, target))

    def available_targets(self, source: str) -> list[str]:
        if not self.models_dir.is_dir():
            return []
        pairs = [p.name for p in self.models_dir.iterdir() if p.is_dir() and len(p.name) == 4]
        targets = {p[2:] for p in pairs if p[:2] == source}
        if "en" in targets:
            targets |= {p[2:] for p in pairs if p[:2] == "en"}
        return sorted(targets)

    def version(self, source: str, target: str) -> str:
        key = f"{source}{target}"
        if key not in self._versions:
            parts = []
            for s, t in self._route(source, target):
                d = self._pair_dir(s, t)
                meta = d / "metadata.json"
                if meta.exists():
                    parts.append(f"{s}{t}:{json.loads(meta.read_text()).get('hash', '')[:12]}")
                else:
                    model = next(d.glob("model.*.bin"))
                    parts.append(f"{s}{t}:{hashlib.sha256(model.read_bytes()).hexdigest()[:12]}")
            self._versions[key] = "bergamot[" + "+".join(parts) + "]"
        return self._versions[key]

    # ---------------------------------------------------------------- process
    def _start(self) -> None:
        if not self.node:
            raise TranslationUnavailable("Node.js not found; install Node 18+ or set DALBIT_NODE")
        if not (HOST_JS.parent / "node_modules" / "@browsermt" / "bergamot-translator").exists():
            raise TranslationUnavailable("bergamot_host dependencies missing; run `npm ci` in service/bergamot_host")
        self._proc = subprocess.Popen(
            [self.node, str(HOST_JS), str(self.models_dir)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._lines = queue.Queue()
        proc = self._proc

        def pump():
            assert proc.stdout is not None
            for line in proc.stdout:
                self._lines.put(line)
            self._lines.put(None)

        threading.Thread(target=pump, daemon=True).start()

    def _call(self, payload: dict) -> object:
        with self._lock:
            if self._proc is None or self._proc.poll() is not None:
                self._start()
            assert self._proc is not None and self._proc.stdin is not None
            self._next_id += 1
            payload = {**payload, "id": self._next_id}
            try:
                self._proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
                self._proc.stdin.flush()
                while True:
                    line = self._lines.get(timeout=self.timeout_s)
                    if line is None:
                        err = self._proc.stderr.read() if self._proc.stderr else ""
                        self._proc = None
                        raise TranslationUnavailable(f"translation engine exited: {err.strip()[-500:]}")
                    msg = json.loads(line)
                    if msg.get("id") == payload["id"]:
                        break
            except queue.Empty:
                self.close()
                raise TranslationUnavailable("translation engine timed out")
            if not msg.get("ok"):
                raise TranslationUnavailable(str(msg.get("error")))
            return msg["result"]

    def translate(self, texts: list[str], source: str, target: str) -> list[str]:
        route = self._route(source, target)
        if not route:
            raise TranslationUnavailable(f"no Bergamot model for {source}->{target} in {self.models_dir}")
        out = list(texts)
        for s, t in route:
            if not out:
                break
            out = list(self._call({"op": "translate", "from": s, "to": t, "texts": out}))  # type: ignore[arg-type]
        return out

    def close(self) -> None:
        if self._proc is not None:
            try:
                self._proc.kill()
            except Exception:  # noqa: BLE001
                pass
            self._proc = None
