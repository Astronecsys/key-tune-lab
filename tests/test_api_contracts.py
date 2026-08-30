from __future__ import annotations

import httpx
import pytest

from music_lab.instrument.app import create_app
from music_lab.instrument.contracts import INSTRUMENT_SCHEMA_VERSION


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _client(app):  # noqa: ANN001
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    )


@pytest.mark.anyio
async def test_state_and_live_endpoints_share_the_instrument_schema() -> None:
    """完整快照与实时增量必须可以被同一个前端状态容器消费。"""
    app = create_app(audio_enabled=False)
    async with app.router.lifespan_context(app):
        async with await _client(app) as client:
            snapshot = await client.get("/api/state")
            live = await client.get("/api/live")

    assert snapshot.status_code == 200
    assert live.status_code == 200
    assert snapshot.json()["schema_version"] == INSTRUMENT_SCHEMA_VERSION
    assert live.json()["schema_version"] == INSTRUMENT_SCHEMA_VERSION
    assert {"midi", "audio", "keyboard", "tracks", "chord"} <= snapshot.json().keys()
    assert {"midi", "audio", "keyboard_active", "playback", "chord"} <= live.json().keys()


@pytest.mark.anyio
async def test_phase_endpoint_is_a_versioned_float32_stream() -> None:
    app = create_app(audio_enabled=False)
    async with app.router.lifespan_context(app):
        async with await _client(app) as client:
            response = await client.get("/api/phase", params={"frame_count": 512})

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["x-schema-version"] == str(INSTRUMENT_SCHEMA_VERSION)
    assert response.headers["x-frames"] == "512"
    assert response.headers["x-sample-format"] == "float32-le"
    assert len(response.content) == 512 * 4


@pytest.mark.anyio
async def test_api_rejects_an_incomplete_timbre_definition() -> None:
    app = create_app(audio_enabled=False)
    async with app.router.lifespan_context(app):
        async with await _client(app) as client:
            response = await client.post("/api/timbre/custom", json={"partials": [[1.0]]})

    assert response.status_code in {400, 422}
