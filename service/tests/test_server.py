"""HTTP API security + behaviour (aiohttp test client, real engine)."""

from __future__ import annotations

import pytest

from dalbit.config import Config
from dalbit.server import make_app
from tests.conftest import MODELS, needs_models

EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"


@pytest.fixture
def cfg(tmp_path):
    c = Config(home=tmp_path)
    c.models_dir = MODELS
    return c


@pytest.fixture
async def client(aiohttp_client, cfg, engine):
    app = make_app(cfg, engine)
    cl = await aiohttp_client(app)
    cl.token = app["api"].token
    return cl


def H(cl, **extra):
    return {"Authorization": f"Bearer {cl.token}", "Origin": EXT, "Host": "127.0.0.1:47615", **extra}


async def test_health_without_token_reveals_little(client):
    r = await client.get("/v1/health", headers={"Host": "127.0.0.1:47615"})
    body = await r.json()
    assert r.status == 200 and body["authenticated"] is False and "models" not in body


async def test_requires_token(client):
    r = await client.post("/v1/translate", data=b"x", headers={"Origin": EXT, "Host": "127.0.0.1:47615"})
    assert r.status == 401
    r = await client.post("/v1/translate", data=b"x", headers={**H(client), "Authorization": "Bearer wrong"})
    assert r.status == 401


async def test_web_origins_are_refused_even_with_token(client):
    r = await client.post("/v1/translate", data=b"x", headers=H(client, Origin="https://evil.example"))
    assert r.status == 403


async def test_dns_rebinding_host_refused(client):
    r = await client.get("/v1/health", headers={"Host": "attacker.example:47615"})
    assert r.status == 403


async def test_bad_input_rejected(client):
    r = await client.post("/v1/translate", data=b"definitely not an image", headers=H(client))
    assert r.status == 422 and (await r.json())["code"] == "image-rejected"
    r = await client.post("/v1/translate?sfx=bogus", data=b"x", headers=H(client))
    assert r.status == 400
    r = await client.post("/v1/translate?src=../../etc", data=b"x", headers=H(client))
    assert r.status == 400


@needs_models
async def test_translate_roundtrip_and_cors(client, fixtures):
    data = (fixtures / "chapter_01.png").read_bytes()
    r = await client.post("/v1/translate?src=ko&tgt=en&requestId=t1", data=data, headers=H(client, **{"Content-Type": "image/png"}))
    assert r.status == 200, await r.text()
    assert r.headers["Access-Control-Allow-Origin"] == EXT
    body = await r.json()
    assert body["regions"] and body["regions"][0]["translated_text"]
    r = await client.post("/v1/translate-text", json={"texts": ["고마워."], "src": "ko", "tgt": "en"}, headers=H(client))
    assert r.status == 200 and "thank" in (await r.json())["translations"][0].lower()


@needs_models
async def test_unknown_target_language_is_explicit(client, fixtures):
    data = (fixtures / "chapter_01.png").read_bytes()
    r = await client.post("/v1/translate?tgt=xx", data=data, headers=H(client))
    assert r.status == 503 and (await r.json())["code"] == "translation-unavailable"


async def test_upload_size_limit(aiohttp_client, cfg, engine):
    cfg.max_upload_bytes = 1024
    app = make_app(cfg, engine)
    cl = await aiohttp_client(app)
    r = await cl.post("/v1/translate", data=b"0" * 4096, headers={"Authorization": f"Bearer {app['api'].token}", "Host": "127.0.0.1"})
    assert r.status == 413
