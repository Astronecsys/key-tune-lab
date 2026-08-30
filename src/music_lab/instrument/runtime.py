from __future__ import annotations

import asyncio
import threading
import time
from collections import defaultdict, deque
from collections.abc import Callable

from .contracts import InstrumentSnapshot, LiveSnapshot
from .events import InstrumentEventBus
from .input_surface import (
    InputNode,
    get_input_surface,
)
from .mapping import (
    MappingDefinition,
)
from .midi_io import MidiInput
from .playback import PlaybackService
from .ports import ClockPort, MidiInputPort, SynthPort
from .recording import PerformanceNote
from .services.chord_analysis import ChordAnalysisService
from .services.configuration import ConfigurationService
from .services.note_routing import NoteRoutingService
from .services.read_models import InstrumentReadModelService
from .services.recording_tracks import RecordingTrackService
from .synth import PolySynth
from .target import PitchBendEvent, ScoreNote, demo_score
from .track_service import TrackService
from .tuning import (
    KeyPitch,
    Tuning,
    get_tuning,
)
from .tuning_compiler import (
    KEY_POSITION,
)

# Playback uses synth-only channels outside the MIDI 0-15 range so stopping an
# axis can never release a physical keyboard note that happens to share a MIDI
# channel and note number.
_PLAYBACK_CHANNEL_BASES = {
    "target": 128,
    "performance": 144,
    "extra": 160,
}


def _playback_channels() -> set[int]:
    return {
        base + midi_channel
        for base in _PLAYBACK_CHANNEL_BASES.values()
        for midi_channel in range(16)
    }


class InstrumentRuntime:
    def __init__(
        self,
        midi_port_hint: str,
        audio_enabled: bool = True,
        *,
        monotonic: ClockPort | None = None,
        synth: SynthPort | None = None,
        midi_factory: Callable[..., MidiInputPort] = MidiInput,
    ) -> None:
        self._lock = threading.RLock()
        # 使用间接调用保留测试可控性，也让录音/播放时钟成为可替换端口。
        self._monotonic = monotonic or (lambda: time.monotonic())
        self.events = InstrumentEventBus()
        self.tuning = get_tuning("12edo")
        self.synth = synth or PolySynth(enabled=audio_enabled)
        self.midi = midi_factory(
            midi_port_hint,
            self._handle_midi_event,
            status_handler=self._handle_midi_status,
        )
        self.recording = False
        self.recording_started_monotonic = self._monotonic()
        self.recording_stopped_elapsed = 0.0
        self.performance_notes: list[PerformanceNote] = []
        self._open_performance_notes: dict[tuple[int, int], deque[PerformanceNote]] = defaultdict(
            deque
        )
        self.performance_pitch_bends: list[PitchBendEvent] = []
        # Every note currently sent to the synth is registered here, regardless
        # of whether it came from physical MIDI or timeline playback. The source
        # stays in each voice payload so analysis sees one unified state without
        # conflating otherwise identical notes from different producers.
        self.active_notes: dict[int, dict] = {}
        self._active_note_queues: dict[tuple[str, int, int], deque[int]] = defaultdict(deque)
        self.target_notes: list[ScoreNote] = demo_score()
        self.target_pitch_bends: list[PitchBendEvent] = []
        self.target_source_timing: dict | None = None
        self.target_compile_mode = KEY_POSITION
        self.target_name = "示例：上行音阶"
        self.target_visible = True
        self.performance_name = "你的演奏"
        self.performance_visible = True
        self.performance_source_timing: dict | None = None
        self.performance_compile_mode = KEY_POSITION
        self._recording_take_counter = 0
        self.last_control_change: dict | None = None
        self.input_surface = get_input_surface("piano_61")
        self.mapping_definition = MappingDefinition(
            surface_id=self.input_surface.id,
            mode="continuous",
            anchor_node_id=self.input_surface.default_anchor_id,
            reference_frequency_hz=440.0,
        )
        self.keyboard_low = 36
        self.keyboard_high = 96
        self.mapping_mode = "continuous"
        self.mapping_degree_step = 1
        self.mapping_anchor: int | None = 69
        self.chord_basis_mode = "lowest"
        self.chord_basis_midi_note: int | None = None
        self.chord_virtual_ratio_from_reference = 1.0
        self._auto_basis_current: dict | None = None
        self._auto_basis_pending: dict | None = None
        self._auto_basis_pending_since = 0.0
        self._auto_basis_candidate_signature: tuple | None = None
        self._auto_basis_candidate_cache: dict | None = None
        self.track_service = TrackService()
        # 兼容现有扩展代码；真实所有权已经移入 TrackService。
        self.extra_tracks = self.track_service.items
        self._static_render_cache: dict | None = None
        self.playback = PlaybackService(
            lock=self._lock,
            publish=self._publish,
            force_cleanup=self._force_playback_cleanup,
        )
        self.chord_analysis = ChordAnalysisService(self)
        self.configuration = ConfigurationService(self)
        self.note_routing = NoteRoutingService(self)
        self.read_models = InstrumentReadModelService(self)
        self.recording_tracks = RecordingTrackService(self)

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self.events.set_loop(loop)

    def start(self) -> None:
        self.synth.start()
        self.midi.start()
        self._publish({"type": "status"})

    def stop(self) -> None:
        self.stop_playback()
        self.midi.stop()
        self.synth.stop()

    def _handle_midi_status(self, status: dict) -> None:
        self._publish({"type": "status", "midi": status})

    def subscribe(self) -> asyncio.Queue:
        return self.events.subscribe()

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.events.unsubscribe(queue)

    # Public facade kept stable for FastAPI and third-party scripts.
    def set_tuning(self, tuning_id: str) -> None:
        self.configuration.set_tuning(tuning_id)

    def set_timbre(self, timbre_id: str) -> None:
        self.configuration.set_timbre(timbre_id)

    def set_custom_timbre(self, partials: list[tuple[float, float]]) -> None:
        self.configuration.set_custom_timbre(partials)

    def set_custom_tuning(
        self,
        divisions: int,
        equave_ratio: float,
        reference_midi: int,
        reference_frequency_hz: float,
    ) -> None:
        self.configuration.set_custom_tuning(
            divisions,
            equave_ratio,
            reference_midi,
            reference_frequency_hz,
        )

    def set_custom_tuning_space(self, payload: dict) -> None:
        self.configuration.set_custom_tuning_space(payload)

    def save_current_tuning(self, payload: dict) -> Tuning:
        return self.configuration.save_current_tuning(payload)

    def reload_tuning_presets(self) -> None:
        self.configuration.reload_tuning_presets()

    def set_mapping(self, payload: dict) -> None:
        self.configuration.set_mapping(payload)

    def set_input_surface(self, surface_id: str) -> None:
        self.configuration.set_input_surface(surface_id)

    def set_volume(self, value: float) -> None:
        self.configuration.set_volume(value)

    def set_chord_basis(self, payload: dict) -> None:
        self.configuration.set_chord_basis(payload)

    @property
    def playback_kind(self) -> str | None:
        """兼容旧调用方；播放会话状态由 PlaybackService 单独管理。"""
        return self.playback.kind

    def start_playback(self, kind: str) -> None:
        if kind == "target":
            notes = list(self.target_notes)
            pitch_bends = list(self.target_pitch_bends)
            channel_base = _PLAYBACK_CHANNEL_BASES["target"]
            compile_mode = self.target_compile_mode
        elif kind == "performance":
            notes = [
                ScoreNote(
                    midi_note=note.midi_note,
                    start_seconds=note.start_seconds,
                    duration_seconds=note.duration_seconds or 0.1,
                    velocity=note.velocity,
                    channel=note.channel,
                    start_ticks=note.start_ticks,
                    duration_ticks=note.duration_ticks,
                )
                for note in self.performance_notes
            ]
            pitch_bends = list(self.performance_pitch_bends)
            channel_base = _PLAYBACK_CHANNEL_BASES["performance"]
            compile_mode = self.performance_compile_mode
        elif kind in self.extra_tracks:
            notes = list(self.extra_tracks[kind]["notes"])
            pitch_bends = list(self.extra_tracks[kind].get("pitch_bends", []))
            channel_base = _PLAYBACK_CHANNEL_BASES["extra"]
            compile_mode = self.extra_tracks[kind].get("compile_mode", KEY_POSITION)
        else:
            raise ValueError("找不到要播放的轨道")
        if not notes:
            raise ValueError("没有可播放的音符")
        self.playback.start(
            kind,
            lambda stop_event: self._play_notes(
                notes,
                pitch_bends,
                channel_base,
                kind,
                compile_mode,
                stop_event,
            ),
        )

    def stop_playback(self) -> None:
        self.playback.stop()

    def _force_playback_cleanup(self, kind: str | None) -> None:
        self._release_sounding_source("playback", kind)
        self.synth.notes_off_for_channels(_playback_channels())

    def start_recording(self) -> None:
        self.recording_tracks.start_recording()

    def _archive_performance_take(self) -> str | None:
        return self.recording_tracks._archive_performance_take()

    def stop_recording(self) -> None:
        self.recording_tracks.stop_recording()

    def clear_performance(self) -> None:
        self.recording_tracks.clear_performance()

    def restore_performance(self, notes: list[dict]) -> None:
        self.recording_tracks.restore_performance(notes)

    def load_target_midi(self, payload: bytes, filename: str) -> int:
        return self.recording_tracks.load_target_midi(payload, filename)

    def load_track_midi(
        self,
        payload: bytes,
        filename: str,
        track_id: str | None = None,
    ) -> tuple[str, int]:
        return self.recording_tracks.load_track_midi(payload, filename, track_id)

    def clear_track(self, track_id: str) -> None:
        self.recording_tracks.clear_track(track_id)

    def delete_track(self, track_id: str) -> None:
        self.recording_tracks.delete_track(track_id)

    def set_track_compile_mode(self, track_id: str, mode: str) -> None:
        self.recording_tracks.set_track_compile_mode(track_id, mode)

    def load_demo_target(self) -> None:
        self.recording_tracks.load_demo_target()

    def snapshot(self) -> InstrumentSnapshot:
        return self.read_models.snapshot()

    def live_snapshot(self) -> LiveSnapshot:
        return self.read_models.live_snapshot()

    def _playback_payload(self) -> dict:
        return self.read_models._playback_payload()

    def _handle_midi_event(self, event: dict) -> None:
        self.note_routing._handle_midi_event(event)

    def _note_on(self, event: dict) -> None:
        self.note_routing._note_on(event)

    def _note_off(self, event: dict) -> None:
        self.note_routing._note_off(event)

    def input_node_on(self, node_id: str, velocity: int = 96) -> None:
        self.note_routing.input_node_on(node_id, velocity)

    def input_node_off(self, node_id: str) -> None:
        self.note_routing.input_node_off(node_id)

    def _activate_sounding_note(
        self,
        *,
        source: str,
        source_id: str,
        channel: int,
        midi_note: int,
        velocity: int,
        pitch: KeyPitch,
        display_channel: int | None = None,
        input_node_id: str | None = None,
    ) -> dict:
        return self.note_routing._activate_sounding_note(
            source=source,
            source_id=source_id,
            channel=channel,
            midi_note=midi_note,
            velocity=velocity,
            pitch=pitch,
            display_channel=display_channel,
            input_node_id=input_node_id,
        )

    def _release_sounding_note(
        self,
        *,
        source: str,
        channel: int,
        midi_note: int,
        voice_id: int | None = None,
    ) -> dict | None:
        return self.note_routing._release_sounding_note(
            source=source,
            channel=channel,
            midi_note=midi_note,
            voice_id=voice_id,
        )

    def _release_sounding_source(
        self,
        source: str,
        source_id: str | None = None,
    ) -> list[dict]:
        return self.note_routing._release_sounding_source(source, source_id)

    def _refresh_active_pitch_bend(
        self,
        source: str,
        synth_channel: int,
        source_id: str | None = None,
    ) -> None:
        self.note_routing._refresh_active_pitch_bend(
            source,
            synth_channel,
            source_id,
        )

    def _record_time(self) -> float:
        return self.note_routing._record_time()

    def _play_notes(
        self,
        notes: list[ScoreNote],
        pitch_bends: list[PitchBendEvent],
        channel_base: int,
        kind: str,
        compile_mode: str,
        stop_event: threading.Event,
    ) -> None:
        self.note_routing._play_notes(
            notes,
            pitch_bends,
            channel_base,
            kind,
            compile_mode,
            stop_event,
        )

    def _chord_payload(self) -> dict:
        return self.chord_analysis._chord_payload()

    def _reset_auto_chord_basis(self) -> None:
        self.chord_analysis._reset_auto_chord_basis()

    def _score_note_payload(
        self,
        note: ScoreNote,
        compile_mode: str = KEY_POSITION,
    ) -> dict:
        return self.read_models._score_note_payload(note, compile_mode)

    def _performance_note_payload(
        self,
        note: PerformanceNote,
        now: float,
        compile_mode: str = KEY_POSITION,
    ) -> dict:
        return self.read_models._performance_note_payload(note, now, compile_mode)

    def _map_physical_key(self, midi_note: int):
        return self.read_models._map_physical_key(midi_note)

    def _map_input_node(self, node_id: str):
        return self.read_models._map_input_node(node_id)

    def _keyboard_key_payload(self, node: InputNode) -> dict:
        return self.read_models._keyboard_key_payload(node)

    def _available_tunings(self) -> list[dict]:
        return self.read_models._available_tunings()

    def _available_timbres(self) -> list[dict]:
        return self.read_models._available_timbres()

    def _available_input_surfaces(self) -> list[dict]:
        return self.read_models._available_input_surfaces()

    def _static_render_payload(self) -> dict:
        return self.read_models._static_render_payload()

    def _publish(self, event: dict) -> None:
        event_type = event.get("type")
        invalidates_static_render = (
            event_type in {"target_loaded", "tracks"}
            or (
                event_type == "configuration"
                and event.get("field") in {"tuning", "mapping", "surface"}
            )
            or (event_type == "recording" and event.get("archived_track_id") is not None)
        )
        if invalidates_static_render:
            with self._lock:
                self._static_render_cache = None

        self.events.publish(event)
