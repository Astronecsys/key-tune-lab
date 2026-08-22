from __future__ import annotations

import asyncio
import math
import threading
import time
from collections import defaultdict, deque
from copy import deepcopy
from dataclasses import asdict, dataclass, replace

from .chord_basis import (
    infer_common_fundamental,
    select_composite_basis,
    select_simplest_basis,
)
from .contracts import INSTRUMENT_SCHEMA_VERSION
from .midi_io import MidiInput
from .input_surface import (
    InputNode,
    available_input_surfaces,
    get_input_surface,
    piano_surface,
)
from .mapping import (
    MappingDefinition,
    available_mapping_modes,
    compile_node_pitch,
    nearest_subset,
    validate_mapping,
)
from .synth import PolySynth, available_timbres
from .target import PitchBendEvent, ScoreNote, demo_score, parse_midi_sequence
from .tuning import (
    KeyPitch,
    Tuning,
    available_tunings,
    format_prime_vector,
    get_tuning,
    key_label,
    nearest_harmonic_ratio,
    ratio_from_prime_vector,
)
from .tuning_compiler import (
    KEY_POSITION,
    available_compile_modes,
    compile_midi_pitch,
    validate_compile_mode,
)
from .tuning_library import (
    draft_definition,
    reload_tuning_library,
    save_user_tuning_definition,
    tuning_from_definition,
)


# Playback uses synth-only channels outside the MIDI 0-15 range so stopping an
# axis can never release a physical keyboard note that happens to share a MIDI
# channel and note number.
_PLAYBACK_CHANNEL_BASES = {
    "target": 128,
    "performance": 144,
    "extra": 160,
}
_MAX_PLAYBACK_VOICES = 128


def _playback_channels() -> set[int]:
    return {
        base + midi_channel
        for base in _PLAYBACK_CHANNEL_BASES.values()
        for midi_channel in range(16)
    }


@dataclass
class PerformanceNote:
    midi_note: int
    channel: int
    velocity: int
    start_seconds: float
    duration_seconds: float | None = None
    start_ticks: int | None = None
    duration_ticks: int | None = None

    def to_dict(self, now_seconds: float) -> dict:
        payload = asdict(self)
        if payload["duration_seconds"] is None:
            payload["duration_seconds"] = max(0.01, now_seconds - self.start_seconds)
            payload["open"] = True
        else:
            payload["open"] = False
        return payload


class InstrumentRuntime:
    def __init__(self, midi_port_hint: str, audio_enabled: bool = True) -> None:
        self._lock = threading.RLock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: set[asyncio.Queue] = set()
        self.tuning = get_tuning("12edo")
        self.synth = PolySynth(enabled=audio_enabled)
        self.midi = MidiInput(
            midi_port_hint,
            self._handle_midi_event,
            status_handler=self._handle_midi_status,
        )
        self.recording = False
        self.recording_started_monotonic = time.monotonic()
        self.recording_stopped_elapsed = 0.0
        self.performance_notes: list[PerformanceNote] = []
        self._open_performance_notes: dict[
            tuple[int, int], deque[PerformanceNote]
        ] = defaultdict(deque)
        self.performance_pitch_bends: list[PitchBendEvent] = []
        # Every note currently sent to the synth is registered here, regardless
        # of whether it came from physical MIDI or timeline playback. The source
        # stays in each voice payload so analysis sees one unified state without
        # conflating otherwise identical notes from different producers.
        self.active_notes: dict[int, dict] = {}
        self._active_note_queues: dict[
            tuple[str, int, int], deque[int]
        ] = defaultdict(deque)
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
        self.extra_tracks: dict[str, dict] = {}
        self._track_counter = 0
        self._playback_thread: threading.Thread | None = None
        self._playback_stop = threading.Event()
        self.playback_kind: str | None = None
        self.playback_started_monotonic = 0.0
        self._static_render_cache: dict | None = None

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

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
        queue: asyncio.Queue = asyncio.Queue(maxsize=32)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    def set_tuning(self, tuning_id: str) -> None:
        tuning = get_tuning(tuning_id)
        mapping = self._adapt_mapping_to_tuning(
            tuning,
            self.mapping_definition,
        )
        tuning = self._realize_tuning_reference(tuning, mapping)
        with self._lock:
            self.synth.all_notes_off()
            self.active_notes.clear()
            self._active_note_queues.clear()
            self._open_performance_notes.clear()
            self.tuning = tuning
            self.mapping_definition = mapping
            self._sync_legacy_mapping_fields()
            self._reset_auto_chord_basis()
        self._publish({"type": "configuration", "field": "tuning"})

    def _adapt_mapping_to_tuning(
        self,
        tuning: Tuning,
        mapping: MappingDefinition,
    ) -> MappingDefinition:
        """Keep an input mapping valid when its independent pitch space changes."""
        reference_degree = max(
            0,
            min(mapping.reference_degree, tuning.divisions - 1),
        )
        mapping = replace(mapping, reference_degree=reference_degree)
        if mapping.mode == "periodic_subset":
            if tuning.divisions >= 12:
                mapping = replace(
                    mapping,
                    subset_degrees=nearest_subset(tuning.divisions, 12),
                )
            else:
                mapping = replace(
                    mapping,
                    mode="continuous",
                    subset_degrees=(),
                )
        if (
            self.input_surface.kind == "hex"
            and tuning.space.construction["kind"] == "generator_lattice"
        ):
            mapping = replace(mapping, mode="harmonic_lattice")
        validate_mapping(mapping, self.input_surface, tuning)
        return mapping

    def _realize_tuning_reference(
        self,
        tuning: Tuning,
        mapping: MappingDefinition,
    ) -> Tuning:
        anchor = self.input_surface.node(mapping.anchor_node_id)
        assert anchor is not None
        return tuning.with_reference(
            frequency_hz=mapping.reference_frequency_hz,
            midi_note=(
                anchor.midi_note
                if anchor.midi_note is not None
                else tuning.reference_midi
            ),
            degree=mapping.reference_degree,
        )

    def set_timbre(self, timbre_id: str) -> None:
        with self._lock:
            self.synth.set_timbre(timbre_id)
            self.active_notes.clear()
            self._active_note_queues.clear()
            self._reset_auto_chord_basis()
        self._publish({"type": "configuration", "field": "timbre"})

    def set_custom_timbre(self, partials: list[tuple[float, float]]) -> None:
        with self._lock:
            self.synth.set_custom_timbre(partials)
            self.active_notes.clear()
            self._active_note_queues.clear()
            self._reset_auto_chord_basis()
        self._publish({"type": "configuration", "field": "timbre"})

    def set_custom_tuning(
        self,
        divisions: int,
        equave_ratio: float,
        reference_midi: int,
        reference_frequency_hz: float,
    ) -> None:
        if not 1 <= divisions <= 128:
            raise ValueError("divisions must be between 1 and 128")
        if not 1.01 <= equave_ratio <= 8:
            raise ValueError("equave ratio must be between 1.01 and 8")
        if not 0 <= reference_midi <= 127 or reference_frequency_hz <= 0:
            raise ValueError("invalid reference key or frequency")
        self.set_custom_tuning_space(
            {
                "kind": "equal_division",
                "divisions": divisions,
                "equave_expression": f"{equave_ratio:g}",
                "reference_frequency_hz": reference_frequency_hz,
                "reference_midi": reference_midi,
            }
        )

    def set_custom_tuning_space(self, payload: dict) -> None:
        current_anchor = self.input_surface.node(
            self.mapping_definition.anchor_node_id
        )
        definition = draft_definition(
            payload,
            default_frequency_hz=self.mapping_definition.reference_frequency_hz,
            default_midi_note=(
                current_anchor.midi_note
                if current_anchor is not None and current_anchor.midi_note is not None
                else self.tuning.reference_midi
            ),
            default_reference_degree=self.mapping_definition.reference_degree,
        )
        tuning = tuning_from_definition(definition)
        space = tuning.space
        assert space is not None
        reference_frequency_hz = tuning.reference_frequency_hz
        reference_degree = tuning.reference_degree
        requested_reference_midi = tuning.reference_midi
        requested_anchor = (
            self.input_surface.node_for_midi(int(requested_reference_midi))
            if requested_reference_midi is not None
            else None
        )
        mapping = replace(
            self.mapping_definition,
            reference_frequency_hz=reference_frequency_hz,
            reference_degree=reference_degree,
            anchor_node_id=(
                requested_anchor.id
                if requested_anchor is not None
                else self.mapping_definition.anchor_node_id
            ),
        )
        mapping = self._adapt_mapping_to_tuning(tuning, mapping)
        tuning = self._realize_tuning_reference(tuning, mapping)
        with self._lock:
            self.synth.all_notes_off()
            self.active_notes.clear()
            self._active_note_queues.clear()
            self.tuning = tuning
            self.mapping_definition = mapping
            self._sync_legacy_mapping_fields()
            self._open_performance_notes.clear()
            self._reset_auto_chord_basis()
        self._publish({"type": "configuration", "field": "tuning"})

    def save_current_tuning(self, payload: dict) -> Tuning:
        if self.tuning.definition is None:
            raise ValueError("the current tuning has no reusable definition")
        tuning_id = str(payload.get("id", "")).strip()
        name = str(payload.get("name", "")).strip()
        if not tuning_id or not name:
            raise ValueError("tuning id and name are required")
        anchor = self.input_surface.node(self.mapping_definition.anchor_node_id)
        definition = deepcopy(self.tuning.definition)
        definition.update(
            {
                "id": tuning_id,
                "name": name,
                "description": str(
                    payload.get("description", self.tuning.description)
                ).strip(),
                "reference": {
                    "midi_note": (
                        anchor.midi_note
                        if anchor is not None and anchor.midi_note is not None
                        else self.tuning.reference_midi
                    ),
                    "frequency_hz": self.mapping_definition.reference_frequency_hz,
                    "degree": self.mapping_definition.reference_degree,
                },
            }
        )
        tags = [
            tag
            for tag in definition.get("tags", [])
            if tag not in {"builtin", "user-draft"}
        ]
        if "user" not in tags:
            tags.append("user")
        definition["tags"] = tags
        saved = save_user_tuning_definition(
            definition,
            overwrite=bool(payload.get("overwrite", False)),
        )
        self.set_tuning(saved.id)
        return saved

    def reload_tuning_presets(self) -> None:
        reload_tuning_library()
        self._publish({"type": "configuration", "field": "tuning_library"})

    def set_mapping(self, payload: dict) -> None:
        surface = self.input_surface
        if payload.get("surface_id"):
            surface = get_input_surface(str(payload["surface_id"]))
        elif "low" in payload or "high" in payload:
            low = int(payload.get("low", self.keyboard_low))
            high = int(payload.get("high", self.keyboard_high))
            surface = piano_surface(
                id="piano_custom",
                name=f"自定义 {high - low + 1} 键",
                low_midi=low,
                key_count=high - low + 1,
            )

        mode = str(payload.get("mode", self.mapping_definition.mode))
        anchor_node_id = payload.get("anchor_node_id")
        if not anchor_node_id:
            anchor_value = payload.get("anchor")
            if anchor_value not in {None, ""}:
                anchor_node = surface.node_for_midi(int(anchor_value))
                if anchor_node is None:
                    raise ValueError("T anchor key is outside the selected surface")
                anchor_node_id = anchor_node.id
            elif surface.id != self.input_surface.id:
                previous_anchor = self.input_surface.node(
                    self.mapping_definition.anchor_node_id
                )
                carried_anchor = (
                    surface.node_for_midi(previous_anchor.midi_note)
                    if previous_anchor is not None
                    and previous_anchor.midi_note is not None
                    else None
                )
                anchor_node_id = (
                    carried_anchor.id
                    if carried_anchor is not None
                    else surface.default_anchor_id
                )
            else:
                anchor_node_id = self.mapping_definition.anchor_node_id
        subset_value = payload.get(
            "subset_degrees", self.mapping_definition.subset_degrees
        )
        if isinstance(subset_value, str):
            subset = tuple(
                int(value.strip())
                for value in subset_value.split(",")
                if value.strip()
            )
        else:
            subset = tuple(int(value) for value in subset_value)
        if mode == "periodic_subset" and not subset:
            subset = nearest_subset(self.tuning.divisions, min(12, self.tuning.divisions))
        mapping = MappingDefinition(
            surface_id=surface.id,
            mode=mode,
            anchor_node_id=str(anchor_node_id),
            reference_frequency_hz=float(
                payload.get(
                    "reference_frequency_hz",
                    self.mapping_definition.reference_frequency_hz,
                )
            ),
            reference_degree=int(
                payload.get(
                    "reference_degree",
                    self.mapping_definition.reference_degree,
                )
            ),
            degree_step=int(
                payload.get("degree_step", self.mapping_definition.degree_step)
            ),
            subset_degrees=subset,
            q_step=int(payload.get("q_step", self.mapping_definition.q_step)),
            r_step=int(payload.get("r_step", self.mapping_definition.r_step)),
            q_ratio_expression=str(
                payload.get(
                    "q_ratio_expression",
                    self.mapping_definition.q_ratio_expression,
                )
            ),
            r_ratio_expression=str(
                payload.get(
                    "r_ratio_expression",
                    self.mapping_definition.r_ratio_expression,
                )
            ),
        )
        validate_mapping(mapping, surface, self.tuning)
        anchor_node = surface.node(mapping.anchor_node_id)
        assert anchor_node is not None
        tuning = self.tuning.with_reference(
            frequency_hz=mapping.reference_frequency_hz,
            midi_note=(
                anchor_node.midi_note
                if anchor_node.midi_note is not None
                else self.tuning.reference_midi
            ),
            degree=mapping.reference_degree,
        )
        with self._lock:
            self.synth.all_notes_off()
            self.active_notes.clear()
            self._active_note_queues.clear()
            self.input_surface = surface
            self.mapping_definition = mapping
            self.tuning = tuning
            self._sync_legacy_mapping_fields()
        self._publish({"type": "configuration", "field": "mapping"})

    def set_input_surface(self, surface_id: str) -> None:
        surface = get_input_surface(surface_id)
        mapping = self.mapping_definition.with_surface(surface)
        if (
            mapping.mode == "grid_linear"
            and self.tuning.space.construction["kind"] == "generator_lattice"
        ):
            mapping = replace(mapping, mode="harmonic_lattice")
        self.set_mapping(mapping.to_dict())

    def _sync_legacy_mapping_fields(self) -> None:
        midi_notes = [
            node.midi_note
            for node in self.input_surface.nodes
            if node.midi_note is not None
        ]
        self.keyboard_low = min(midi_notes, default=0)
        self.keyboard_high = max(midi_notes, default=len(self.input_surface.nodes) - 1)
        self.mapping_mode = self.mapping_definition.mode
        self.mapping_degree_step = self.mapping_definition.degree_step
        anchor = self.input_surface.node(self.mapping_definition.anchor_node_id)
        self.mapping_anchor = anchor.midi_note if anchor is not None else None

    def set_volume(self, value: float) -> None:
        self.synth.set_master_volume(value)
        self._publish({"type": "configuration", "field": "volume"})

    def set_chord_basis(self, payload: dict) -> None:
        mode = str(payload.get("mode", self.chord_basis_mode))
        if mode not in {
            "lowest",
            "selected",
            "virtual",
            "auto_simple",
            "auto_fundamental",
            "auto_composite",
        }:
            raise ValueError("unknown chord basis mode")
        with self._lock:
            if mode != self.chord_basis_mode:
                self._reset_auto_chord_basis()
            if mode == "selected":
                midi_value = payload.get("midi_note")
                if midi_value not in {None, ""}:
                    midi_note = int(midi_value)
                    if not 0 <= midi_note <= 127:
                        raise ValueError("selected basis MIDI note must be between 0 and 127")
                    self.chord_basis_midi_note = midi_note
                elif self.chord_basis_midi_note is None and self.active_notes:
                    self.chord_basis_midi_note = min(
                        self.active_notes.values(),
                        key=lambda item: item["frequency_hz"],
                    )["midi_note"]
            elif mode == "virtual":
                ratio = float(
                    payload.get(
                        "ratio_from_reference",
                        self.chord_virtual_ratio_from_reference,
                    )
                )
                if not math.isfinite(ratio) or not 1e-6 <= ratio <= 1e6:
                    raise ValueError("virtual basis f/T ratio must be between 1e-6 and 1e6")
                self.chord_virtual_ratio_from_reference = ratio
            self.chord_basis_mode = mode
        self._publish({"type": "configuration", "field": "chord_basis"})

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
            compile_mode = self.extra_tracks[kind].get(
                "compile_mode", KEY_POSITION
            )
        else:
            raise ValueError("找不到要播放的轨道")
        if not notes:
            raise ValueError("没有可播放的音符")
        self.stop_playback()
        self._playback_stop.clear()
        self.playback_kind = kind
        self.playback_started_monotonic = time.monotonic()
        self._playback_thread = threading.Thread(
            target=self._play_notes,
            args=(notes, pitch_bends, channel_base, kind, compile_mode),
            name=f"music-lab-{kind}-playback",
            daemon=True,
        )
        self._playback_thread.start()
        self._publish({"type": "playback", "kind": kind, "playing": True})

    def stop_playback(self) -> None:
        self._playback_stop.set()
        thread = self._playback_thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=0.5)
        self._release_sounding_source("playback")
        self.synth.notes_off_for_channels(_playback_channels())
        with self._lock:
            self._playback_thread = None
            self.playback_kind = None
        self._publish({"type": "playback", "playing": False})

    def start_recording(self) -> None:
        with self._lock:
            archived_track_id = self._archive_performance_take()
            self._recording_take_counter += 1
            self.performance_name = f"演奏 {self._recording_take_counter}"
            self.performance_visible = True
            self.recording = True
            self.recording_started_monotonic = time.monotonic()
            self.recording_stopped_elapsed = 0.0
            self.performance_notes.clear()
            self.performance_pitch_bends.clear()
            self.performance_source_timing = None
            self.performance_compile_mode = KEY_POSITION
            self._open_performance_notes.clear()
        self._publish(
            {
                "type": "recording",
                "recording": True,
                "track_id": "performance",
                "archived_track_id": archived_track_id,
            }
        )

    def _archive_performance_take(self) -> str | None:
        with self._lock:
            if not self.performance_notes:
                return None
            self._track_counter += 1
            track_id = f"track-{self._track_counter}"
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
            self.extra_tracks[track_id] = {
                "name": self.performance_name,
                "kind": "performance",
                "notes": notes,
                "pitch_bends": list(self.performance_pitch_bends),
                "source_timing": self.performance_source_timing,
                "compile_mode": self.performance_compile_mode,
            }
            return track_id

    def stop_recording(self) -> None:
        with self._lock:
            now = self._record_time()
            for queue in self._open_performance_notes.values():
                for note in queue:
                    note.duration_seconds = max(0.01, now - note.start_seconds)
            self._open_performance_notes.clear()
            self.recording_stopped_elapsed = now
            self.recording = False
        self._publish({"type": "recording", "recording": False})

    def clear_performance(self) -> None:
        with self._lock:
            self.performance_notes.clear()
            self.performance_pitch_bends.clear()
            self.performance_source_timing = None
            self._open_performance_notes.clear()
            self.recording_started_monotonic = time.monotonic()
            self.recording_stopped_elapsed = 0.0
        self._publish({"type": "performance_cleared"})

    def restore_performance(self, notes: list[dict]) -> None:
        restored = [
            PerformanceNote(
                midi_note=int(note["midi_note"]),
                channel=int(note.get("channel", 0)),
                velocity=int(note["velocity"]),
                start_seconds=float(note["start_seconds"]),
                duration_seconds=float(note["duration_seconds"]),
                start_ticks=(
                    None
                    if note.get("start_ticks") is None
                    else int(note["start_ticks"])
                ),
                duration_ticks=(
                    None
                    if note.get("duration_ticks") is None
                    else int(note["duration_ticks"])
                ),
            )
            for note in notes
        ]
        with self._lock:
            self.performance_notes = restored
            self.performance_pitch_bends.clear()
            self.performance_source_timing = None
            self.performance_compile_mode = KEY_POSITION
            self.performance_name = "恢复的演奏"
            self.performance_visible = True
            self.recording_stopped_elapsed = max(
                (note.start_seconds + (note.duration_seconds or 0) for note in restored),
                default=0.0,
            )
        self._publish({"type": "tracks", "action": "restored", "track_id": "performance"})

    def load_target_midi(self, payload: bytes, filename: str) -> int:
        sequence = parse_midi_sequence(payload)
        notes = list(sequence.notes)
        if not notes:
            raise ValueError("MIDI 文件中没有可显示的音符")
        with self._lock:
            self.target_notes = notes
            self.target_pitch_bends = list(sequence.pitch_bends)
            self.target_source_timing = sequence.timing_dict()
            self.target_name = filename
            self.target_visible = True
        self._publish({"type": "target_loaded", "name": filename})
        return len(notes)

    def load_track_midi(
        self,
        payload: bytes,
        filename: str,
        track_id: str | None = None,
    ) -> tuple[str, int]:
        sequence = parse_midi_sequence(payload)
        notes = list(sequence.notes)
        pitch_bends = list(sequence.pitch_bends)
        source_timing = sequence.timing_dict()
        if not notes:
            raise ValueError("MIDI 文件中没有可显示的音符")
        with self._lock:
            if track_id == "target":
                self.target_notes = notes
                self.target_pitch_bends = pitch_bends
                self.target_source_timing = source_timing
                self.target_name = filename
                self.target_visible = True
                resolved_id = "target"
            elif track_id == "performance":
                self.performance_notes = [
                    PerformanceNote(
                        midi_note=note.midi_note,
                        channel=note.channel,
                        velocity=note.velocity,
                        start_seconds=note.start_seconds,
                        duration_seconds=note.duration_seconds,
                        start_ticks=note.start_ticks,
                        duration_ticks=note.duration_ticks,
                    )
                    for note in notes
                ]
                self.performance_pitch_bends = pitch_bends
                self.performance_source_timing = source_timing
                self.recording_stopped_elapsed = max(
                    note.start_seconds + note.duration_seconds for note in notes
                )
                self.performance_name = filename
                self.performance_visible = True
                resolved_id = "performance"
            elif track_id and track_id in self.extra_tracks:
                compile_mode = self.extra_tracks[track_id].get(
                    "compile_mode", KEY_POSITION
                )
                self.extra_tracks[track_id] = {
                    "name": filename,
                    "kind": "score",
                    "notes": notes,
                    "pitch_bends": pitch_bends,
                    "source_timing": source_timing,
                    "compile_mode": compile_mode,
                }
                resolved_id = track_id
            else:
                self._track_counter += 1
                resolved_id = f"track-{self._track_counter}"
                self.extra_tracks[resolved_id] = {
                    "name": filename,
                    "kind": "score",
                    "notes": notes,
                    "pitch_bends": pitch_bends,
                    "source_timing": source_timing,
                    "compile_mode": KEY_POSITION,
                }
        self._publish({"type": "tracks", "action": "loaded", "track_id": resolved_id})
        return resolved_id, len(notes)

    def clear_track(self, track_id: str) -> None:
        if track_id == "performance":
            self.clear_performance()
            return
        with self._lock:
            if track_id == "target":
                self.target_notes = []
                self.target_pitch_bends = []
                self.target_source_timing = None
                self.target_name = "空目标轨道"
            elif track_id in self.extra_tracks:
                self.extra_tracks[track_id]["notes"] = []
                self.extra_tracks[track_id]["pitch_bends"] = []
                self.extra_tracks[track_id]["source_timing"] = None
            else:
                raise ValueError("找不到轨道")
        self._publish({"type": "tracks", "action": "cleared", "track_id": track_id})

    def delete_track(self, track_id: str) -> None:
        if track_id == self.playback_kind:
            self.stop_playback()
        with self._lock:
            if track_id == "target":
                self.target_notes = []
                self.target_pitch_bends = []
                self.target_source_timing = None
                self.target_name = "目标轴"
                self.target_visible = False
            elif track_id == "performance":
                if self.recording:
                    raise ValueError("正在录制的演奏轴不能删除")
                self.performance_notes.clear()
                self.performance_pitch_bends.clear()
                self.performance_source_timing = None
                self._open_performance_notes.clear()
                self.performance_name = "你的演奏"
                self.performance_visible = False
                self.recording_stopped_elapsed = 0.0
            elif self.extra_tracks.pop(track_id, None) is None:
                raise ValueError("找不到轨道")
        self._publish({"type": "tracks", "action": "deleted", "track_id": track_id})

    def set_track_compile_mode(self, track_id: str, mode: str) -> None:
        mode = validate_compile_mode(mode)
        if track_id == self.playback_kind:
            raise ValueError("正在播放的轨道不能切换律制编译策略")
        with self._lock:
            if track_id == "target" and self.target_visible:
                self.target_compile_mode = mode
            elif track_id == "performance" and self.performance_visible:
                self.performance_compile_mode = mode
            elif track_id in self.extra_tracks:
                self.extra_tracks[track_id]["compile_mode"] = mode
            else:
                raise ValueError("找不到轨道")
        self._publish(
            {
                "type": "tracks",
                "action": "compile_mode",
                "track_id": track_id,
                "mode": mode,
            }
        )

    def load_demo_target(self) -> None:
        with self._lock:
            self.target_notes = demo_score()
            self.target_pitch_bends = []
            self.target_source_timing = None
            self.target_name = "示例：上行音阶"
            self.target_visible = True
        self._publish({"type": "target_loaded", "name": self.target_name})

    def snapshot(self) -> dict:
        with self._lock:
            record_now = self._record_time()
            static_render = self._static_render_payload()
            performance = [
                self._performance_note_payload(
                    note, record_now, self.performance_compile_mode
                )
                for note in self.performance_notes
            ]
            tracks = list(static_render["tracks"])
            if self.performance_visible:
                tracks.append(
                    {
                        "id": "performance",
                        "name": self.performance_name,
                        "kind": "performance",
                        "notes": performance,
                        "compile_mode": self.performance_compile_mode,
                        "source_timing": self.performance_source_timing,
                        "deletable": True,
                    }
                )
            return {
                "schema_version": INSTRUMENT_SCHEMA_VERSION,
                "midi": self.midi.status(),
                "audio": self.synth.status(),
                "tunings": self._available_tunings(),
                "tuning": self.tuning.summary(),
                "input_surfaces": self._available_input_surfaces(),
                "mapping_modes": available_mapping_modes(),
                "compile_modes": available_compile_modes(),
                "timbres": self._available_timbres(),
                "timbre": self.synth.timbre.summary(),
                "keyboard": {
                    "low": self.keyboard_low,
                    "high": self.keyboard_high,
                    "keys": static_render["keys"],
                    "active": list(self.active_notes.values()),
                    "surface": self.input_surface.to_dict(include_nodes=False),
                    "mapping": self.mapping_definition.to_dict()
                    | {"anchor": self.mapping_anchor},
                },
                "recording": self.recording,
                "record_elapsed_seconds": record_now,
                "performance": performance,
                "target": {
                    "name": self.target_name,
                    "notes": static_render["target_notes"],
                },
                "last_control_change": self.last_control_change,
                "playback": self._playback_payload(),
                "chord": self._chord_payload(),
                "tracks": tracks,
            }

    def live_snapshot(self) -> dict:
        """Return only fast-changing state; static score data stays client-side."""
        with self._lock:
            record_now = self._record_time()
            performance = [
                self._performance_note_payload(
                    note, record_now, self.performance_compile_mode
                )
                for note in self.performance_notes
            ]
            return {
                "schema_version": INSTRUMENT_SCHEMA_VERSION,
                "midi": self.midi.status(),
                "audio": self.synth.status(),
                "keyboard_active": [
                    dict(payload) for payload in self.active_notes.values()
                ],
                "recording": self.recording,
                "record_elapsed_seconds": record_now,
                "performance": performance,
                "performance_name": self.performance_name,
                "last_control_change": self.last_control_change,
                "playback": self._playback_payload(),
                "chord": self._chord_payload(),
            }

    def _playback_payload(self) -> dict:
        return {
            "kind": self.playback_kind,
            "playing": self.playback_kind is not None,
            "elapsed_seconds": (
                max(0.0, time.monotonic() - self.playback_started_monotonic)
                if self.playback_kind is not None
                else 0.0
            ),
        }

    def _handle_midi_event(self, event: dict) -> None:
        event_type = event["type"]
        if event_type == "note_on":
            self._note_on(event)
        elif event_type == "note_off":
            self._note_off(event)
        elif event_type == "pitch_bend":
            channel = event["channel"]
            self.synth.set_pitch_bend(channel, event["value"])
            self._refresh_active_pitch_bend("midi", channel)
            with self._lock:
                if self.recording:
                    self.performance_pitch_bends.append(
                        PitchBendEvent(
                            time_seconds=self._record_time(),
                            channel=channel,
                            value=event["value"],
                        )
                    )
            self._publish(event)
        elif event_type == "control_change":
            with self._lock:
                self.last_control_change = event
            self._publish(event)

    def _note_on(self, event: dict) -> None:
        record_key = (event["channel"], event["note"])
        with self._lock:
            input_node = self.input_surface.node_for_midi(event["note"])
            pitch = self._map_physical_key(event["note"])
            if pitch is None or input_node is None:
                return
            payload = self._activate_sounding_note(
                source="midi",
                source_id="physical",
                channel=event["channel"],
                midi_note=event["note"],
                velocity=event["velocity"],
                pitch=pitch,
                input_node_id=input_node.id,
            )
            if self.recording:
                note = PerformanceNote(
                    midi_note=event["note"],
                    channel=event["channel"],
                    velocity=event["velocity"],
                    start_seconds=self._record_time(),
                )
                self.performance_notes.append(note)
                self._open_performance_notes[record_key].append(note)
        self._publish({"type": "note_on", "pitch": payload})

    def _note_off(self, event: dict) -> None:
        record_key = (event["channel"], event["note"])
        with self._lock:
            pitch_payload = self._release_sounding_note(
                source="midi",
                channel=event["channel"],
                midi_note=event["note"],
            )
            if pitch_payload is None:
                pitch_payload = (
                    self._map_physical_key(event["note"])
                    or self.tuning.map_key(event["note"])
                ).to_dict()
            open_notes = self._open_performance_notes.get(record_key)
            open_note = open_notes.popleft() if open_notes else None
            if open_notes is not None and not open_notes:
                self._open_performance_notes.pop(record_key, None)
            if open_note is not None:
                open_note.duration_seconds = max(
                    0.01,
                    self._record_time() - open_note.start_seconds,
                )
        self._publish({"type": "note_off", "pitch": pitch_payload})

    def input_node_on(self, node_id: str, velocity: int = 96) -> None:
        if not 1 <= velocity <= 127:
            raise ValueError("velocity must be between 1 and 127")
        with self._lock:
            node = self.input_surface.node(node_id)
            pitch = self._map_input_node(node_id)
            if node is None or pitch is None:
                raise ValueError("input node is not mapped")
            synth_note = node.midi_note if node.midi_note is not None else node.index
            payload = self._activate_sounding_note(
                source="virtual",
                source_id=node.id,
                channel=240,
                midi_note=synth_note,
                velocity=velocity,
                pitch=pitch,
                display_channel=0,
                input_node_id=node.id,
            )
        self._publish({"type": "note_on", "source": "virtual", "pitch": payload})

    def input_node_off(self, node_id: str) -> None:
        with self._lock:
            node = self.input_surface.node(node_id)
            if node is None:
                raise ValueError("input node does not exist")
            synth_note = node.midi_note if node.midi_note is not None else node.index
            payload = self._release_sounding_note(
                source="virtual",
                channel=240,
                midi_note=synth_note,
            )
        self._publish(
            {"type": "note_off", "source": "virtual", "pitch": payload or {}}
        )

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
        with self._lock:
            if source == "playback":
                playback_voice_ids = [
                    active_voice_id
                    for active_voice_id, active_payload in self.active_notes.items()
                    if active_payload["source"] == "playback"
                ]
                if len(playback_voice_ids) >= _MAX_PLAYBACK_VOICES:
                    stolen_voice_id = min(playback_voice_ids)
                    stolen_payload = self.active_notes.pop(stolen_voice_id)
                    stolen_key = (
                        "playback",
                        stolen_payload["synth_channel"],
                        stolen_payload["midi_note"],
                    )
                    stolen_queue = self._active_note_queues.get(stolen_key)
                    if stolen_queue and stolen_voice_id in stolen_queue:
                        stolen_queue.remove(stolen_voice_id)
                        if not stolen_queue:
                            self._active_note_queues.pop(stolen_key, None)
                    self.synth.discard_voice(stolen_voice_id)
            voice_id = self.synth.note_on(
                channel,
                midi_note,
                pitch.frequency_hz,
                velocity,
            )
            bend_factor = self.synth.pitch_bend_factor(channel)
            input_node = (
                self.input_surface.node(input_node_id)
                if input_node_id is not None
                else None
            )
            payload = pitch.to_dict() | {
                "channel": channel if display_channel is None else display_channel,
                "synth_channel": channel,
                "velocity": velocity,
                "source": source,
                "source_id": source_id,
                "voice_id": voice_id,
                "base_frequency_hz": pitch.frequency_hz,
                "frequency_hz": pitch.frequency_hz * bend_factor,
                "input_node_id": input_node_id,
                "input_label": input_node.label if input_node is not None else None,
                "input_midi_note": (
                    input_node.midi_note if input_node is not None else None
                ),
                "input_coordinate": (
                    list(input_node.coordinate) if input_node is not None else None
                ),
            }
            self.active_notes[voice_id] = payload
            self._active_note_queues[(source, channel, midi_note)].append(voice_id)
        return payload

    def _release_sounding_note(
        self,
        *,
        source: str,
        channel: int,
        midi_note: int,
        voice_id: int | None = None,
    ) -> dict | None:
        key = (source, channel, midi_note)
        with self._lock:
            queue = self._active_note_queues.get(key)
            if voice_id is None:
                voice_id = queue.popleft() if queue else None
            elif queue and voice_id in queue:
                queue.remove(voice_id)
            if queue is not None and not queue:
                self._active_note_queues.pop(key, None)
            if voice_id is None:
                return None
            payload = self.active_notes.pop(voice_id, None)
            self.synth.note_off(voice_id)
        return payload

    def _release_sounding_source(
        self,
        source: str,
        source_id: str | None = None,
    ) -> list[dict]:
        released: list[dict] = []
        with self._lock:
            voice_ids = [
                voice_id
                for voice_id, payload in self.active_notes.items()
                if payload["source"] == source
                and (source_id is None or payload["source_id"] == source_id)
            ]
            for voice_id in voice_ids:
                released.append(self.active_notes.pop(voice_id))
                self.synth.note_off(voice_id)
            active_voice_ids = set(self.active_notes)
            for key, queue in list(self._active_note_queues.items()):
                retained = deque(
                    voice_id for voice_id in queue if voice_id in active_voice_ids
                )
                if retained:
                    self._active_note_queues[key] = retained
                else:
                    self._active_note_queues.pop(key, None)
        return released

    def _refresh_active_pitch_bend(
        self,
        source: str,
        synth_channel: int,
        source_id: str | None = None,
    ) -> None:
        factor = self.synth.pitch_bend_factor(synth_channel)
        with self._lock:
            for payload in self.active_notes.values():
                if (
                    payload["source"] == source
                    and payload["synth_channel"] == synth_channel
                    and (source_id is None or payload["source_id"] == source_id)
                ):
                    payload["frequency_hz"] = payload["base_frequency_hz"] * factor

    def _record_time(self) -> float:
        if not self.recording:
            return self.recording_stopped_elapsed
        return max(0.0, time.monotonic() - self.recording_started_monotonic)

    def _play_notes(
        self,
        notes: list[ScoreNote],
        pitch_bends: list[PitchBendEvent],
        channel_base: int,
        kind: str,
        compile_mode: str,
    ) -> None:
        events: list[tuple[float, int, int, str, object]] = []
        for note_index, note in enumerate(notes):
            events.append((note.start_seconds, 2, note_index, "note_on", note))
            events.append(
                (
                    note.start_seconds + note.duration_seconds,
                    1,
                    note_index,
                    "note_off",
                    note,
                )
            )
        for event_index, pitch_bend in enumerate(pitch_bends):
            events.append(
                (
                    pitch_bend.time_seconds,
                    0,
                    event_index,
                    "pitch_bend",
                    pitch_bend,
                )
            )
        events.sort(key=lambda event: (event[0], event[1], event[2]))
        started = time.monotonic()
        started_voice_ids: dict[int, int] = {}
        try:
            for event_time, _, event_index, event_type, event_payload in events:
                delay = max(0.0, started + event_time - time.monotonic())
                if self._playback_stop.wait(delay):
                    break
                if event_type == "pitch_bend":
                    pitch_bend = event_payload
                    assert isinstance(pitch_bend, PitchBendEvent)
                    synth_channel = channel_base + pitch_bend.channel
                    self.synth.set_pitch_bend(synth_channel, pitch_bend.value)
                    self._refresh_active_pitch_bend(
                        "playback",
                        synth_channel,
                        kind,
                    )
                    self._publish(
                        {
                            "type": "pitch_bend",
                            "source": "playback",
                            "kind": kind,
                            "channel": pitch_bend.channel,
                            "value": pitch_bend.value,
                        }
                    )
                    continue
                note = event_payload
                assert isinstance(note, ScoreNote)
                synth_channel = channel_base + note.channel
                is_on = event_type == "note_on"
                with self._lock:
                    pitch = compile_midi_pitch(
                        self.tuning,
                        note.midi_note,
                        compile_mode,
                        key_position_mapper=self._map_physical_key,
                    )
                    if is_on:
                        payload = self._activate_sounding_note(
                            source="playback",
                            source_id=kind,
                            channel=synth_channel,
                            midi_note=note.midi_note,
                            velocity=note.velocity,
                            pitch=pitch.pitch,
                            display_channel=note.channel,
                        )
                        started_voice_ids[event_index] = payload["voice_id"]
                    else:
                        voice_id = started_voice_ids.pop(event_index, None)
                        payload = (
                            self._release_sounding_note(
                                source="playback",
                                channel=synth_channel,
                                midi_note=note.midi_note,
                                voice_id=voice_id,
                            )
                            if voice_id is not None
                            else None
                        ) or pitch.pitch.to_dict()
                self._publish(
                    {
                        "type": "note_on" if is_on else "note_off",
                        "source": "playback",
                        "kind": kind,
                        "pitch": payload,
                    }
                )
        finally:
            self._release_sounding_source("playback", kind)
            self.synth.notes_off_for_channels(
                {channel_base + channel for channel in range(16)}
            )
        if not self._playback_stop.is_set():
            with self._lock:
                self.playback_kind = None
                self._playback_thread = None
            self._publish({"type": "playback", "kind": kind, "playing": False})

    def _chord_payload(self) -> dict:
        active = sorted(self.active_notes.values(), key=lambda item: item["frequency_hz"])
        reference_midi = (
            self.mapping_anchor
            if self.mapping_anchor is not None
            else self.tuning.reference_midi
        )
        reference_pitch = self.tuning.map_relative(reference_midi, 0)
        reference = {
            "midi_note": reference_midi,
            "key_label": reference_pitch.key_label,
            "pitch_label": reference_pitch.pitch_label,
            "traditional_alias": reference_pitch.traditional_alias,
            "frequency_hz": self.tuning.reference_frequency_hz,
        }
        basis = self._resolve_chord_basis(active)
        basis_payload = self._chord_basis_payload(basis)
        if not active:
            return {
                "size": 0,
                "name": "等待和弦输入",
                "basis_mode": self.chord_basis_mode,
                "basis": basis_payload,
                "reference": reference,
                "tones": [],
            }
        tones = []
        for pitch in active:
            tones.append(
                {
                    "midi_note": pitch["midi_note"],
                    "key_label": pitch["key_label"],
                    "pitch_label": pitch["pitch_label"],
                    "traditional_alias": pitch["traditional_alias"],
                    "degree": pitch["degree"],
                    "equave": pitch["equave"],
                    "frequency_hz": pitch["frequency_hz"],
                    "velocity": pitch["velocity"],
                    "source": pitch["source"],
                    "channel": pitch["channel"],
                    "is_basis": bool(
                        basis
                        and basis.get("voice_id") == pitch.get("voice_id")
                    ),
                    "tuning_relation": self._tuning_relation_payload(pitch),
                    "chord_relation": (
                        self._chord_relation_payload(
                            pitch,
                            basis,
                        )
                        if basis
                        else None
                    ),
                }
            )
        return {
            "size": len(active),
            "name": self._conventional_chord_name(active),
            "basis_mode": self.chord_basis_mode,
            "basis": basis_payload,
            "reference": reference,
            "tones": tones,
        }

    def _resolve_chord_basis(self, active: list[dict]) -> dict | None:
        if self.chord_basis_mode == "lowest":
            if not active:
                return None
            return dict(active[0]) | {
                "origin": "lowest",
                "sounding": True,
            }
        if self.chord_basis_mode == "selected":
            if self.chord_basis_midi_note is None:
                return None
            sounding = next(
                (
                    pitch
                    for pitch in active
                    if pitch["midi_note"] == self.chord_basis_midi_note
                ),
                None,
            )
            if sounding is not None:
                return dict(sounding) | {
                    "origin": "selected",
                    "sounding": True,
                }
            pitch = (
                self._map_physical_key(self.chord_basis_midi_note)
                or self.tuning.map_key(self.chord_basis_midi_note)
            )
            return pitch.to_dict() | {
                "origin": "selected",
                "sounding": False,
            }
        if self.chord_basis_mode in {
            "auto_simple",
            "auto_fundamental",
            "auto_composite",
        }:
            return self._resolve_auto_chord_basis(active)
        ratio = self.chord_virtual_ratio_from_reference
        return {
            "midi_note": None,
            "key_label": None,
            "pitch_label": f"V[T×{ratio:.8g}]",
            "traditional_alias": None,
            "degree": None,
            "equave": None,
            "frequency_hz": self.tuning.reference_frequency_hz * ratio,
            "origin": "virtual",
            "sounding": False,
        }

    def _reset_auto_chord_basis(self) -> None:
        self._auto_basis_current = None
        self._auto_basis_pending = None
        self._auto_basis_pending_since = 0.0
        self._auto_basis_candidate_signature = None
        self._auto_basis_candidate_cache = None

    def _resolve_auto_chord_basis(self, active: list[dict]) -> dict | None:
        signature = (
            self.chord_basis_mode,
            self.tuning.id,
            self.tuning.reference_frequency_hz,
            self.tuning.equave_ratio,
            self.tuning.divisions,
            self.synth.timbre.id,
            tuple(self.synth.timbre.partials),
            tuple(
                (pitch["midi_note"], round(pitch["frequency_hz"], 8))
                for pitch in active
            ),
        )
        if signature == self._auto_basis_candidate_signature:
            candidate = self._auto_basis_candidate_cache
        else:
            if self.chord_basis_mode == "auto_simple":
                candidate = select_simplest_basis(active, self.tuning)
            elif self.chord_basis_mode == "auto_fundamental":
                candidate = infer_common_fundamental(
                    active,
                    self.tuning.reference_frequency_hz,
                    self.synth.timbre.partials,
                )
            else:
                candidate = select_composite_basis(
                    active,
                    self.tuning,
                    self.tuning.reference_frequency_hz,
                    self.synth.timbre.partials,
                )
            self._auto_basis_candidate_signature = signature
            self._auto_basis_candidate_cache = candidate
        if candidate is None:
            return self._materialize_auto_basis(self._auto_basis_current, active)
        if self._auto_basis_current is None:
            self._auto_basis_current = candidate
            return candidate
        if (
            candidate.get("_auto_key")
            == self._auto_basis_current.get("_auto_key")
        ):
            self._auto_basis_current = candidate
            self._auto_basis_pending = None
            return candidate

        now = time.monotonic()
        if (
            self._auto_basis_pending is None
            or candidate.get("_auto_key")
            != self._auto_basis_pending.get("_auto_key")
        ):
            self._auto_basis_pending = candidate
            self._auto_basis_pending_since = now
        else:
            self._auto_basis_pending = candidate
            if now - self._auto_basis_pending_since >= 0.12:
                self._auto_basis_current = candidate
                self._auto_basis_pending = None
                return candidate
        return self._materialize_auto_basis(self._auto_basis_current, active)

    def _materialize_auto_basis(
        self,
        basis: dict | None,
        active: list[dict],
    ) -> dict | None:
        if basis is None:
            return None
        midi_note = basis.get("midi_note")
        if midi_note is not None:
            sounding = next(
                (
                    pitch
                    for pitch in active
                    if pitch["midi_note"] == midi_note
                ),
                None,
            )
            if sounding is not None:
                return dict(sounding) | {
                    "origin": basis["origin"],
                    "sounding": True,
                    "_auto_key": basis.get("_auto_key"),
                    "_relation_frequencies": basis.get("_relation_frequencies"),
                    "_relation_multipliers": basis.get("_relation_multipliers"),
                    "auto": basis.get("auto"),
                }
        return dict(basis) | {"sounding": False}

    def _chord_basis_payload(self, basis: dict | None) -> dict | None:
        if basis is None:
            return None
        payload = {
            "mode": self.chord_basis_mode,
            "origin": basis["origin"],
            "sounding": basis["sounding"],
            "midi_note": basis.get("midi_note"),
            "input_node_id": basis.get("input_node_id"),
            "key_label": basis.get("key_label"),
            "pitch_label": basis["pitch_label"],
            "traditional_alias": basis.get("traditional_alias"),
            "frequency_hz": basis["frequency_hz"],
            "ratio_from_reference": (
                basis["frequency_hz"] / self.tuning.reference_frequency_hz
            ),
            "identity_relation": self._identity_chord_relation(),
        }
        if basis.get("auto") is not None:
            payload["auto"] = basis["auto"]
        return payload

    def _identity_chord_relation(self) -> dict:
        if self.tuning.algebraic_basis:
            label = f"{self.tuning.algebraic_basis}^(0/{self.tuning.divisions})"
            return {
                "reference": "B",
                "ratio": 1.0,
                "ratio_label": label,
                "relationship_kind": "exact algebraic relation",
                "prime_vector": {},
                "prime_vector_label": label,
            }
        vector = {str(prime): 0 for prime in (2, 3, 5, 7, 11)}
        return {
            "reference": "B",
            "ratio": 1.0,
            "ratio_label": "1/1",
            "relationship_kind": "exact harmonic ratio",
            "prime_vector": vector,
            "prime_vector_label": "1",
        }

    def _tuning_relation_payload(self, pitch: dict) -> dict:
        ratio = pitch["frequency_hz"] / self.tuning.reference_frequency_hz
        is_algebraic = pitch["relationship_kind"] == "exact algebraic relation"
        if is_algebraic:
            vector: dict[str, int] = {}
            ratio_label = pitch["ratio_label"]
            relationship_kind = pitch["relationship_kind"]
        else:
            normalized = ratio
            octaves = 0
            while normalized < 1:
                normalized *= 2
                octaves -= 1
            while normalized >= 2:
                normalized /= 2
                octaves += 1
            _, vector, error = nearest_harmonic_ratio(normalized)
            vector = dict(vector)
            vector["2"] = vector.get("2", 0) + octaves
            approximation = ratio_from_prime_vector(vector)
            relationship_kind = (
                "exact harmonic ratio"
                if abs(error) < 1e-9
                else "nearest 11-limit relation"
            )
            prefix = "" if relationship_kind == "exact harmonic ratio" else "≈ "
            ratio_label = (
                f"{prefix}{approximation.numerator}/{approximation.denominator}"
            )
        return {
            "reference": "T",
            "ratio": ratio,
            "ratio_label": ratio_label,
            "relationship_kind": relationship_kind,
            "prime_vector": vector,
            "prime_vector_label": (
                pitch["prime_vector_label"]
                if is_algebraic
                else format_prime_vector(vector)
            ),
        }

    def _chord_relation_payload(
        self,
        pitch: dict,
        basis: dict,
    ) -> dict:
        fundamental_relation = self._fundamental_relation_payload(pitch, basis)
        if fundamental_relation is not None:
            return fundamental_relation
        basis_frequency = basis["frequency_hz"]
        ratio = pitch["frequency_hz"] / basis_frequency
        if self.tuning.algebraic_basis:
            exponent = math.log(ratio, self.tuning.equave_ratio)
            lattice_steps = exponent * self.tuning.divisions
            nearest_step = round(lattice_steps)
            exponent_label = (
                f"{nearest_step}/{self.tuning.divisions}"
                if math.isclose(lattice_steps, nearest_step, abs_tol=1e-9)
                else f"{exponent:.8g}"
            )
            label = f"{self.tuning.algebraic_basis}^({exponent_label})"
            return {
                "reference": "B",
                "ratio": ratio,
                "ratio_label": label,
                "relationship_kind": "exact algebraic relation",
                "prime_vector": {},
                "prime_vector_label": label,
            }

        normalized = ratio
        octaves = 0
        while normalized < 1:
            normalized *= 2
            octaves -= 1
        while normalized >= 2:
            normalized /= 2
            octaves += 1
        _, vector, error = nearest_harmonic_ratio(normalized)
        vector = dict(vector)
        vector["2"] = vector.get("2", 0) + octaves
        approximation = ratio_from_prime_vector(vector)
        relationship_kind = (
            "exact harmonic ratio" if abs(error) < 1e-9
            else "nearest 11-limit relation"
        )
        prefix = "" if relationship_kind == "exact harmonic ratio" else "≈ "
        return {
            "reference": "B",
            "ratio": ratio,
            "ratio_label": (
                f"{prefix}{approximation.numerator}/{approximation.denominator}"
            ),
            "relationship_kind": relationship_kind,
            "prime_vector": vector,
            "prime_vector_label": format_prime_vector(vector),
        }

    def _fundamental_relation_payload(
        self,
        pitch: dict,
        basis: dict,
    ) -> dict | None:
        auto = basis.get("auto")
        frequencies = basis.get("_relation_frequencies")
        multipliers = basis.get("_relation_multipliers")
        if (
            auto is None
            or not frequencies
            or not multipliers
        ):
            return None
        relation_index = min(
            range(len(frequencies)),
            key=lambda index: abs(
                math.log(pitch["frequency_hz"] / frequencies[index])
            ),
        )
        multiplier = multipliers[relation_index]
        ratio = pitch["frequency_hz"] / basis["frequency_hz"]
        exact = math.isclose(ratio, multiplier, rel_tol=1e-9)
        prefix = "" if exact else "≈ "
        if (
            str(auto["model"]).endswith("integer_partials")
            and float(multiplier).is_integer()
        ):
            partial = int(round(multiplier))
            remaining = partial
            vector = {str(prime): 0 for prime in (2, 3, 5, 7, 11)}
            for prime in (2, 3, 5, 7, 11):
                while remaining % prime == 0:
                    remaining //= prime
                    vector[str(prime)] += 1
            if remaining == 1:
                return {
                    "reference": "B",
                    "ratio": ratio,
                    "ratio_label": f"{prefix}{partial}/1",
                    "relationship_kind": (
                        "exact harmonic ratio" if exact
                        else "nearest harmonic-partial relation"
                    ),
                    "prime_vector": vector,
                    "prime_vector_label": format_prime_vector(vector),
                }
        label = f"{prefix}P×{multiplier:.8g}"
        return {
            "reference": "B",
            "ratio": ratio,
            "ratio_label": label,
            "relationship_kind": (
                "exact timbre-partial relation" if exact
                else "nearest timbre-partial relation"
            ),
            "prime_vector": {},
            "prime_vector_label": label,
        }

    def _conventional_chord_name(self, active: list[dict]) -> str:
        if len(active) == 1:
            pitch_name = active[0]["traditional_alias"] or active[0]["pitch_label"]
            return f"单音 · {pitch_name}"
        if self.tuning.id != "12edo":
            return f"{len(active)} 音频率集合 · {self.tuning.name}"
        root_step = active[0]["equave"] * 12 + active[0]["degree"]
        intervals = tuple(
            sorted(
                {
                    (note["equave"] * 12 + note["degree"] - root_step) % 12
                    for note in active
                }
            )
        )
        qualities = {
            (0, 4, 7): "大三和弦",
            (0, 3, 7): "小三和弦",
            (0, 3, 6): "减三和弦",
            (0, 4, 8): "增三和弦",
            (0, 5, 7): "挂四和弦",
            (0, 2, 7): "挂二和弦",
            (0, 4, 7, 10): "属七和弦",
            (0, 4, 7, 11): "大七和弦",
            (0, 3, 7, 10): "小七和弦",
        }
        quality = qualities.get(intervals)
        root_alias = active[0]["traditional_alias"]
        return f"{root_alias} {quality}" if quality else f"{len(active)} 音集合 · 间隔 {intervals}"

    def _score_note_payload(
        self,
        note: ScoreNote,
        compile_mode: str = KEY_POSITION,
    ) -> dict:
        compiled = compile_midi_pitch(
            self.tuning,
            note.midi_note,
            compile_mode,
            key_position_mapper=self._map_physical_key,
        )
        return note.to_dict() | compiled.payload(channel=note.channel)

    def _performance_note_payload(
        self,
        note: PerformanceNote,
        now: float,
        compile_mode: str = KEY_POSITION,
    ) -> dict:
        compiled = compile_midi_pitch(
            self.tuning,
            note.midi_note,
            compile_mode,
            key_position_mapper=self._map_physical_key,
        )
        return note.to_dict(now) | compiled.payload(channel=note.channel)

    def _map_physical_key(self, midi_note: int):
        node = self.input_surface.node_for_midi(midi_note)
        if node is None:
            return None
        return compile_node_pitch(
            self.mapping_definition,
            self.input_surface,
            self.tuning,
            node,
        )

    def _map_input_node(self, node_id: str):
        node = self.input_surface.node(node_id)
        if node is None:
            return None
        return compile_node_pitch(
            self.mapping_definition,
            self.input_surface,
            self.tuning,
            node,
        )

    def _keyboard_key_payload(self, node: InputNode) -> dict:
        pitch = self._map_input_node(node.id)
        node_payload = {
            "input_node_id": node.id,
            "input_index": node.index,
            "input_label": node.label,
            "input_role": node.role,
            "input_midi_note": node.midi_note,
            "coordinate": list(node.coordinate),
        }
        if pitch is not None:
            return pitch.to_dict() | node_payload | {"mapped": True}
        return node_payload | {
            "midi_note": node.midi_note if node.midi_note is not None else node.index,
            "key_label": node.label,
            "pitch_label": None,
            "traditional_alias": None,
            "mapped": False,
            "degree": None,
            "frequency_hz": None,
        }

    def _available_tunings(self) -> list[dict]:
        tunings = available_tunings()
        if self.tuning.id not in {tuning["id"] for tuning in tunings}:
            tunings.append(self.tuning.summary())
        return tunings

    def _available_timbres(self) -> list[dict]:
        timbres = available_timbres()
        if self.synth.timbre.id == "custom":
            timbres.append(self.synth.timbre.summary())
        return timbres

    def _available_input_surfaces(self) -> list[dict]:
        surfaces = available_input_surfaces()
        if self.input_surface.id not in {surface["id"] for surface in surfaces}:
            surfaces.append(self.input_surface.to_dict())
        return surfaces

    def _static_render_payload(self) -> dict:
        if self._static_render_cache is not None:
            return self._static_render_cache

        keys = [
            self._keyboard_key_payload(node) for node in self.input_surface.nodes
        ]
        target_notes = [
            self._score_note_payload(note, self.target_compile_mode)
            for note in self.target_notes
        ]
        tracks: list[dict] = []
        if self.target_visible:
            tracks.append(
                {
                    "id": "target",
                    "name": self.target_name,
                    "kind": "score",
                    "notes": target_notes,
                    "compile_mode": self.target_compile_mode,
                    "source_timing": self.target_source_timing,
                    "deletable": True,
                }
            )
        tracks.extend(
            {
                "id": track_id,
                "name": track["name"],
                "kind": track.get("kind", "score"),
                "notes": [
                    self._score_note_payload(
                        note, track.get("compile_mode", KEY_POSITION)
                    )
                    for note in track["notes"]
                ],
                "compile_mode": track.get("compile_mode", KEY_POSITION),
                "source_timing": track.get("source_timing"),
                "deletable": True,
            }
            for track_id, track in self.extra_tracks.items()
        )
        self._static_render_cache = {
            "keys": keys,
            "target_notes": target_notes,
            "tracks": tracks,
        }
        return self._static_render_cache

    def _publish(self, event: dict) -> None:
        event_type = event.get("type")
        invalidates_static_render = (
            event_type in {"target_loaded", "tracks"}
            or (
                event_type == "configuration"
                and event.get("field") in {"tuning", "mapping", "surface"}
            )
            or (
                event_type == "recording"
                and event.get("archived_track_id") is not None
            )
        )
        if invalidates_static_render:
            with self._lock:
                self._static_render_cache = None

        loop = self._loop
        if loop is None or not loop.is_running():
            return

        def deliver() -> None:
            for queue in tuple(self._subscribers):
                if queue.full():
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                queue.put_nowait(event)

        loop.call_soon_threadsafe(deliver)
