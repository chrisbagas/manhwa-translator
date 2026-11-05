"""Service configuration (environment variables override defaults)."""

from __future__ import annotations

import os
import secrets
import stat
from dataclasses import dataclass, field
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PORT = 47615


def _home() -> Path:
    if os.environ.get("DALBIT_HOME"):
        return Path(os.environ["DALBIT_HOME"]).expanduser()
    base = os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config")
    if os.name == "nt" and os.environ.get("APPDATA"):
        base = os.environ["APPDATA"]
    return Path(base) / "dalbit"


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    home: Path = field(default_factory=_home)
    models_dir: Path = field(default_factory=lambda: Path(os.environ.get("DALBIT_MODELS", SERVICE_ROOT / "models")))
    recognizer: str = os.environ.get("DALBIT_RECOGNIZER", "auto")  # auto | easyocr | ppocr-korean
    threads: int = int(os.environ.get("DALBIT_THREADS", "0"))  # 0 = library default
    max_upload_bytes: int = 40 * 1024 * 1024
    max_pixels: int = 60_000_000  # e.g. 1200 x 50000
    max_side: int = 120_000
    max_queue: int = 64
    cache_max_bytes: int = 512 * 1024 * 1024
    # Exact extension origins allowed in addition to the scheme check, e.g.
    # "chrome-extension://abcdef...". Empty = any browser-extension origin.
    allowed_origins: tuple[str, ...] = ()
    allow_remote: bool = False

    @property
    def cache_dir(self) -> Path:
        return Path(os.environ.get("DALBIT_CACHE", self.home / "cache"))

    @property
    def token_file(self) -> Path:
        return self.home / "token"

    def load_or_create_token(self) -> str:
        if os.environ.get("DALBIT_TOKEN"):
            return os.environ["DALBIT_TOKEN"]
        self.home.mkdir(parents=True, exist_ok=True)
        if self.token_file.exists():
            tok = self.token_file.read_text().strip()
            if len(tok) >= 24:
                return tok
        tok = secrets.token_urlsafe(24)
        self.token_file.write_text(tok + "\n")
        try:
            self.token_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass
        return tok
