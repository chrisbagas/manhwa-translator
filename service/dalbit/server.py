"""Loopback HTTP API used by the browser extension.

Security model (see docs/ARCHITECTURE.md):
* binds to 127.0.0.1 unless --allow-remote is given explicitly;
* every API call needs the pairing token (Authorization: Bearer ...);
* requests carrying a web Origin (http/https) are refused, so ordinary
  websites cannot drive the service even if they guess the port;
* the Host header must be a loopback name (blocks DNS-rebinding);
* uploads are size-limited, images are pixel-limited before decoding, and
  work runs on ONE worker thread behind a bounded queue.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import ipaddress
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from aiohttp import web

from . import __version__
from .config import Config
from .imageio import ImageRejected
from .pipeline import SFX_MODES, SUPPORTED_SOURCES, Cancelled, Engine
from .translate.base import TranslationUnavailable
from .translate.glossary import normalize_glossary

log = logging.getLogger("dalbit.server")

EXTENSION_SCHEMES = ("chrome-extension://", "moz-extension://", "safari-web-extension://")
LANG_RE = set("abcdefghijklmnopqrstuvwxyz-")


def _lang(v: str | None, default: str) -> str:
    v = (v or default).lower()
    if not (2 <= len(v) <= 8) or not set(v) <= LANG_RE:
        raise web.HTTPBadRequest(text=json.dumps({"error": "invalid language code"}), content_type="application/json")
    return v


def _json_error(status: int, message: str, **extra) -> web.Response:
    return web.json_response({"error": message, **extra}, status=status)


class Api:
    def __init__(self, cfg: Config, engine: Engine):
        self.cfg = cfg
        self.engine = engine
        self.token = cfg.load_or_create_token()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="dalbit-worker")
        self.pending = 0
        self.cancels: dict[str, threading.Event] = {}
        self.started = time.time()
        self.stats = {"processed": 0, "failed": 0, "cancelled": 0}

    # ---------------------------------------------------------------- guards
    def _allowed_host(self, host: str | None) -> bool:
        if self.cfg.allow_remote:
            return True
        if not host:
            return False
        name = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
        name = name.strip("[]").lower()
        if name == "localhost":
            return True
        try:
            return ipaddress.ip_address(name).is_loopback
        except ValueError:
            return False

    def _allowed_origin(self, origin: str | None) -> bool:
        if not origin or origin == "null":
            return True  # non-browser clients (CLI, tests); still need the token
        if self.cfg.allowed_origins:
            return origin in self.cfg.allowed_origins
        return origin.startswith(EXTENSION_SCHEMES)

    @web.middleware
    async def guard(self, request: web.Request, handler):
        if not self._allowed_host(request.headers.get("Host")):
            return _json_error(403, "host not allowed")
        origin = request.headers.get("Origin")
        if not self._allowed_origin(origin):
            return _json_error(403, "origin not allowed", hint="Only the Dalbit browser extension may call this service.")
        if request.method == "OPTIONS":
            resp = web.Response(status=204)
        elif request.path == "/v1/health":
            resp = await handler(request)
        else:
            auth = request.headers.get("Authorization", "")
            supplied = auth[7:] if auth.startswith("Bearer ") else ""
            if not supplied or not hmac.compare_digest(supplied.encode(), self.token.encode()):
                return _json_error(401, "missing or wrong pairing token", hint="Run `python -m dalbit token` and paste it into the extension settings.")
            resp = await handler(request)
        if origin and origin.startswith(EXTENSION_SCHEMES):
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Dalbit-Options"
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            resp.headers["Vary"] = "Origin"
        resp.headers["Cache-Control"] = "no-store"
        return resp

    # ---------------------------------------------------------------- handlers
    async def health(self, request: web.Request) -> web.Response:
        auth = request.headers.get("Authorization", "")
        authed = auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].encode(), self.token.encode())
        body = {"ok": True, "name": "dalbit", "version": __version__, "authenticated": authed}
        if authed:
            loop = asyncio.get_running_loop()
            try:
                models = await loop.run_in_executor(None, self.engine.models)
            except Exception as exc:  # noqa: BLE001
                models = {"error": str(exc)}
            body.update({
                "sources": list(SUPPORTED_SOURCES),
                "targets": {s: self.engine.translator.available_targets(s) for s in SUPPORTED_SOURCES},
                "sfxModes": list(SFX_MODES),
                "models": models,
                "queue": self.pending,
                "stats": self.stats,
                "uptimeS": round(time.time() - self.started),
            })
        return web.json_response(body)

    def _options(self, request: web.Request) -> dict:
        raw = request.headers.get("X-Dalbit-Options")
        if not raw:
            return {}
        if len(raw) > 64 * 1024:
            raise web.HTTPRequestEntityTooLarge(max_size=64 * 1024, actual_size=len(raw))
        try:
            return json.loads(base64.b64decode(raw).decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise web.HTTPBadRequest(text=json.dumps({"error": f"bad X-Dalbit-Options: {exc}"}), content_type="application/json")

    async def translate_image(self, request: web.Request) -> web.Response:
        q = request.query
        src = _lang(q.get("src"), "ko")
        tgt = _lang(q.get("tgt"), "en")
        sfx_mode = q.get("sfx", "annotate")
        if sfx_mode not in SFX_MODES:
            return _json_error(400, f"sfx must be one of {SFX_MODES}")
        request_id = (q.get("requestId") or "")[:64]
        opts = self._options(request)
        glossary = normalize_glossary(opts.get("glossary") or {})
        if self.pending >= self.cfg.max_queue:
            return _json_error(429, "queue full; try again shortly")
        data = await request.read()
        if not data:
            return _json_error(400, "empty body; send the image bytes")
        cancel = threading.Event()
        if request_id:
            self.cancels[request_id] = cancel
        self.pending += 1
        loop = asyncio.get_running_loop()
        try:
            fut = loop.run_in_executor(self.pool, lambda: self.engine.process(
                data, src=src, tgt=tgt, glossary=glossary, sfx_mode=sfx_mode, cancel=cancel))
            try:
                result = await fut
            except asyncio.CancelledError:
                cancel.set()  # client went away: stop at the next checkpoint
                raise
            self.stats["processed"] += 1
            return web.json_response(result, dumps=lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":")))
        except Cancelled:
            self.stats["cancelled"] += 1
            return _json_error(409, "cancelled")
        except ImageRejected as exc:
            self.stats["failed"] += 1
            return _json_error(422, str(exc), code="image-rejected")
        except TranslationUnavailable as exc:
            self.stats["failed"] += 1
            return _json_error(503, str(exc), code="translation-unavailable")
        except ValueError as exc:
            self.stats["failed"] += 1
            return _json_error(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            self.stats["failed"] += 1
            log.exception("pipeline failure")
            return _json_error(500, f"internal error: {type(exc).__name__}: {exc}")
        finally:
            self.pending -= 1
            if request_id:
                self.cancels.pop(request_id, None)

    async def translate_text(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return _json_error(400, "expected JSON")
        texts = body.get("texts")
        if not isinstance(texts, list) or not all(isinstance(t, str) and len(t) <= 2000 for t in texts) or len(texts) > 200:
            return _json_error(400, "texts must be a list of <=200 strings of <=2000 chars")
        src, tgt = _lang(body.get("src"), "ko"), _lang(body.get("tgt"), "en")
        glossary = normalize_glossary(body.get("glossary") or {})
        loop = asyncio.get_running_loop()
        try:
            out = await loop.run_in_executor(None, lambda: self.engine.translate_texts(texts, src, tgt, glossary))
        except TranslationUnavailable as exc:
            return _json_error(503, str(exc), code="translation-unavailable")
        return web.json_response({"translations": out}, dumps=lambda o: json.dumps(o, ensure_ascii=False))

    async def cancel(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return _json_error(400, "expected JSON")
        ids = body.get("requestIds") or ([body["requestId"]] if body.get("requestId") else [])
        n = 0
        for rid in ids[:500]:
            ev = self.cancels.get(str(rid))
            if ev is not None:
                ev.set()
                n += 1
        return web.json_response({"cancelled": n})

    async def cache_clear(self, request: web.Request) -> web.Response:
        await asyncio.get_running_loop().run_in_executor(None, self.engine.cache.clear)
        return web.json_response({"ok": True})


def make_app(cfg: Config, engine: Engine | None = None) -> web.Application:
    api = Api(cfg, engine or Engine(cfg))
    app = web.Application(middlewares=[api.guard], client_max_size=cfg.max_upload_bytes)
    app["api"] = api
    app.router.add_get("/v1/health", api.health)
    app.router.add_post("/v1/translate", api.translate_image)
    app.router.add_post("/v1/translate-text", api.translate_text)
    app.router.add_post("/v1/cancel", api.cancel)
    app.router.add_post("/v1/cache/clear", api.cache_clear)
    app.router.add_route("OPTIONS", "/{tail:.*}", lambda r: web.Response(status=204))
    return app


def run(cfg: Config, *, warm: bool = True) -> int:
    try:
        is_loopback = cfg.host == "localhost" or ipaddress.ip_address(cfg.host).is_loopback
    except ValueError:
        is_loopback = False
    if not is_loopback and not cfg.allow_remote:
        log.error("Refusing to bind to %s: only loopback is allowed without --allow-remote.", cfg.host)
        return 2
    if not is_loopback:
        log.warning("Binding to %s exposes the service to your network. Keep the token secret; never expose it to the internet.", cfg.host)
    engine = Engine(cfg)
    if warm:
        log.info("loading models ...")
        try:
            log.info("models ready (%s): %s", engine.warm_up(), engine.models())
        except Exception as exc:  # noqa: BLE001
            log.error("warm-up failed: %s -- run `python -m dalbit doctor`", exc)
    app = make_app(cfg, engine)
    token = app["api"].token
    log.info("Dalbit service on http://%s:%d  (token file: %s)", cfg.host, cfg.port, cfg.token_file)
    log.info("Pairing token: %s", token)
    web.run_app(app, host=cfg.host, port=cfg.port, print=None, access_log=None)
    return 0
