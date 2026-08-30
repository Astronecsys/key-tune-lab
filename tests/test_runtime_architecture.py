from __future__ import annotations

from music_lab.instrument.runtime import InstrumentRuntime
from music_lab.instrument.services.chord_analysis import ChordAnalysisService
from music_lab.instrument.services.configuration import ConfigurationService
from music_lab.instrument.services.note_routing import NoteRoutingService
from music_lab.instrument.services.read_models import InstrumentReadModelService
from music_lab.instrument.services.recording_tracks import RecordingTrackService


def test_runtime_assembles_explicit_domain_services() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)

    assert isinstance(runtime.configuration, ConfigurationService)
    assert isinstance(runtime.recording_tracks, RecordingTrackService)
    assert isinstance(runtime.note_routing, NoteRoutingService)
    assert isinstance(runtime.chord_analysis, ChordAnalysisService)
    assert isinstance(runtime.read_models, InstrumentReadModelService)


def test_recording_uses_the_injected_clock_port() -> None:
    now = [10.0]
    runtime = InstrumentRuntime(
        "unused",
        audio_enabled=False,
        monotonic=lambda: now[0],
    )
    runtime.start_recording()
    runtime._handle_midi_event(
        {"type": "note_on", "channel": 0, "note": 60, "velocity": 90}
    )
    now[0] += 0.25
    runtime._handle_midi_event(
        {"type": "note_off", "channel": 0, "note": 60, "velocity": 0}
    )
    runtime.stop_recording()

    assert runtime.snapshot()["performance"][0]["duration_seconds"] == 0.25


def test_midi_factory_is_a_replaceable_device_port() -> None:
    captured: dict = {}

    class FakeMidi:
        started = False
        stopped = False

        def start(self) -> None:
            self.started = True

        def stop(self) -> None:
            self.stopped = True

        def status(self) -> dict:
            return {"connected": False, "port_hint": "fake"}

    def midi_factory(port_hint, handler, *, status_handler):  # noqa: ANN001
        captured.update(
            port_hint=port_hint,
            handler=handler,
            status_handler=status_handler,
        )
        return FakeMidi()

    runtime = InstrumentRuntime(
        "replaceable-midi",
        audio_enabled=False,
        midi_factory=midi_factory,
    )
    runtime.start()
    runtime.stop()

    assert captured["port_hint"] == "replaceable-midi"
    assert callable(captured["handler"])
    assert callable(captured["status_handler"])
    assert runtime.midi.started is True
    assert runtime.midi.stopped is True

