from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .contracts import (
    INSTRUMENT_SCHEMA_VERSION,
    ChordBasisRequest,
    CustomTimbreRequest,
    CustomTuningRequest,
    IdRequest,
    InputNodeOnRequest,
    MappingRequest,
    RestorePerformanceRequest,
    TrackCompileRequest,
    TuningLibrarySaveRequest,
    VolumeRequest,
)
from .runtime import InstrumentRuntime

WEB_DIR = Path(__file__).resolve().parents[1] / "web"


def _json_response(payload: dict) -> Response:
    return Response(
        content=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        media_type="application/json",
    )


def create_app(
    midi_port_hint: str = "Digital Keyboard",
    audio_enabled: bool = True,
) -> FastAPI:
    runtime = InstrumentRuntime(
        midi_port_hint=midi_port_hint,
        audio_enabled=audio_enabled,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        del app
        runtime.set_loop(asyncio.get_running_loop())
        runtime.start()
        try:
            yield
        finally:
            runtime.stop()

    app = FastAPI(title="KEY//TUNE LAB Instrument", lifespan=lifespan)
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.state.runtime = runtime

    @app.middleware("http")
    async def disable_web_asset_cache(request, call_next):  # noqa: ANN001
        response = await call_next(request)
        if request.url.path == "/" or request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/api/health")
    async def health() -> dict:
        snapshot = runtime.snapshot()
        return {
            "ok": True,
            "midi_connected": snapshot["midi"]["connected"],
            "audio_running": snapshot["audio"]["running"],
        }

    @app.get("/api/state")
    async def state() -> Response:
        return _json_response(runtime.snapshot())

    @app.get("/api/live")
    async def live_state() -> Response:
        return _json_response(runtime.live_snapshot())

    @app.get("/api/analysis")
    async def analysis() -> Response:
        return _json_response(runtime.synth.analysis_snapshot())

    @app.get("/api/phase")
    async def phase(frame_count: int = Query(4096, ge=256, le=16384)) -> Response:
        samples = runtime.synth.phase_snapshot(frame_count)
        return Response(
            content=samples.tobytes(),
            media_type="application/octet-stream",
            headers={
                "Cache-Control": "no-store",
                "X-Sample-Rate-Hz": str(runtime.synth.sample_rate_hz),
                "X-Schema-Version": str(INSTRUMENT_SCHEMA_VERSION),
                "X-Frames": str(len(samples)),
                "X-Channels": "1",
                "X-Sample-Format": "float32-le",
            },
        )

    @app.post("/api/diagnostics/audio/start")
    async def start_audio_capture(
        duration_seconds: float = Query(10.0),
    ) -> dict:
        try:
            frames = runtime.synth.start_diagnostic_capture(duration_seconds)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"frames": frames, "sample_rate_hz": runtime.synth.sample_rate_hz}

    @app.get("/api/diagnostics/audio")
    async def get_audio_capture() -> Response:
        samples, complete = runtime.synth.diagnostic_capture()
        return Response(
            content=samples.tobytes(),
            media_type="application/octet-stream",
            headers={
                "X-Sample-Rate-Hz": str(runtime.synth.sample_rate_hz),
                "X-Frames": str(len(samples)),
                "X-Channels": "2",
                "X-Complete": "true" if complete else "false",
            },
        )

    @app.post("/api/tuning")
    async def set_tuning(payload: IdRequest) -> dict:
        try:
            runtime.set_tuning(payload.id)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return runtime.snapshot()

    @app.post("/api/tuning/custom")
    async def set_custom_tuning(payload: CustomTuningRequest) -> dict:
        definition = payload.to_payload()
        try:
            if "kind" in definition or "equave_expression" in definition:
                runtime.set_custom_tuning_space(definition)
            else:
                runtime.set_custom_tuning(
                    divisions=int(definition["divisions"]),
                    equave_ratio=float(definition["equave_ratio"]),
                    reference_midi=int(definition["reference_midi"]),
                    reference_frequency_hz=float(definition["reference_frequency_hz"]),
                )
        except (KeyError, TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return runtime.snapshot()

    @app.post("/api/timbre")
    async def set_timbre(payload: IdRequest) -> dict:
        try:
            runtime.set_timbre(payload.id)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return runtime.snapshot()

    @app.post("/api/timbre/custom")
    async def set_custom_timbre(payload: CustomTimbreRequest) -> dict:
        try:
            partials = [(float(item[0]), float(item[1])) for item in payload.partials]
            runtime.set_custom_timbre(partials)
        except (TypeError, ValueError, IndexError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return runtime.snapshot()

    @app.post("/api/mapping")
    async def set_mapping(payload: MappingRequest) -> dict:
        try:
            runtime.set_mapping(payload.to_payload())
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return runtime.snapshot()

    @app.post("/api/audio/volume")
    async def set_volume(payload: VolumeRequest) -> dict:
        try:
            runtime.set_volume(payload.value)
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return runtime.snapshot()

    @app.post("/api/tuning/library")
    async def save_tuning_to_library(payload: TuningLibrarySaveRequest) -> dict:
        try:
            saved = runtime.save_current_tuning(payload.to_payload())
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"saved": saved.summary(), "state": runtime.snapshot()}

    @app.post("/api/tuning/library/reload")
    async def reload_tuning_library() -> dict:
        try:
            runtime.reload_tuning_presets()
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return runtime.snapshot()

    @app.post("/api/input-surface")
    async def set_input_surface(payload: IdRequest) -> dict:
        try:
            runtime.set_input_surface(payload.id)
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return runtime.snapshot()

    @app.post("/api/input/{node_id}/on")
    async def input_node_on(
        node_id: str,
        payload: InputNodeOnRequest | None = None,
    ) -> dict:
        try:
            runtime.input_node_on(node_id, (payload or InputNodeOnRequest()).velocity)
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"node_id": node_id, "active": True}

    @app.post("/api/input/{node_id}/off")
    async def input_node_off(node_id: str) -> dict:
        try:
            runtime.input_node_off(node_id)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"node_id": node_id, "active": False}

    @app.post("/api/chord/basis")
    async def set_chord_basis(payload: ChordBasisRequest) -> dict:
        try:
            runtime.set_chord_basis(payload.to_payload())
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return runtime.snapshot()

    @app.post("/api/playback/{kind}/start")
    async def start_playback(kind: str) -> dict:
        try:
            runtime.start_playback(kind)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"playing": True, "kind": kind}

    @app.post("/api/playback/stop")
    async def stop_playback() -> dict:
        runtime.stop_playback()
        return {"playing": False}

    @app.post("/api/recording/start")
    async def start_recording() -> dict:
        runtime.start_recording()
        return {"recording": True}

    @app.post("/api/recording/stop")
    async def stop_recording() -> dict:
        runtime.stop_recording()
        return {"recording": False}

    @app.post("/api/recording/clear")
    async def clear_recording() -> dict:
        runtime.clear_performance()
        return {"cleared": True}

    @app.post("/api/recording/restore")
    async def restore_recording(payload: RestorePerformanceRequest) -> dict:
        try:
            runtime.restore_performance([note.to_payload() for note in payload.notes])
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"restored": len(runtime.performance_notes)}

    @app.post("/api/target/demo")
    async def load_demo() -> dict:
        runtime.load_demo_target()
        return {"loaded": runtime.target_name, "notes": len(runtime.target_notes)}

    @app.post("/api/target/midi")
    async def load_midi(
        payload: bytes = Body(..., media_type="application/octet-stream"),
        filename: str = Query("target.mid"),
    ) -> dict:
        try:
            note_count = runtime.load_target_midi(payload, filename)
        except (OSError, ValueError, EOFError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"loaded": filename, "notes": note_count}

    @app.post("/api/tracks/midi")
    async def load_track_midi(
        payload: bytes = Body(..., media_type="application/octet-stream"),
        filename: str = Query("track.mid"),
        track_id: str | None = Query(None),
    ) -> dict:
        try:
            resolved_id, note_count = runtime.load_track_midi(payload, filename, track_id)
        except (OSError, ValueError, EOFError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"track_id": resolved_id, "loaded": filename, "notes": note_count}

    @app.post("/api/tracks/{track_id}/clear")
    async def clear_track(track_id: str) -> dict:
        try:
            runtime.clear_track(track_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return {"track_id": track_id, "cleared": True}

    @app.post("/api/tracks/{track_id}/compile")
    async def set_track_compile_mode(
        track_id: str,
        payload: TrackCompileRequest,
    ) -> dict:
        try:
            mode = payload.mode
            runtime.set_track_compile_mode(track_id, mode)
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"track_id": track_id, "compile_mode": mode}

    @app.delete("/api/tracks/{track_id}")
    async def delete_track(track_id: str) -> dict:
        try:
            runtime.delete_track(track_id)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"track_id": track_id, "deleted": True}

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        await websocket.accept()
        queue = runtime.subscribe()
        try:
            await websocket.send_json({"type": "ready"})
            while True:
                event = await queue.get()
                await websocket.send_json(event)
        except WebSocketDisconnect:
            pass
        finally:
            runtime.unsubscribe(queue)

    return app


def run_instrument_app(
    host: str,
    port: int,
    midi_port_hint: str,
    audio_enabled: bool,
) -> None:
    import uvicorn

    uvicorn.run(
        create_app(
            midi_port_hint=midi_port_hint,
            audio_enabled=audio_enabled,
        ),
        host=host,
        port=port,
        log_level="info",
    )
