from __future__ import annotations

from ..contracts import INSTRUMENT_SCHEMA_VERSION, InstrumentSnapshot, LiveSnapshot
from ..input_surface import InputNode, available_input_surfaces
from ..mapping import available_mapping_modes, compile_node_pitch
from ..mapping_preset import available_mapping_presets
from ..target import ScoreNote
from ..timbre_library import available_timbres
from ..tuning import available_tunings
from ..tuning_compiler import KEY_POSITION, available_compile_modes, compile_midi_pitch
from .runtime_proxy import RuntimeServiceProxy


class InstrumentReadModelService(RuntimeServiceProxy):
    """Create versioned HTTP/WebSocket snapshots without device side effects."""

    def snapshot(self) -> InstrumentSnapshot:
        with self._lock:
            record_now = self._runtime._record_time()
            static_render = self._runtime._static_render_payload()
            performance = [
                self._runtime._performance_note_payload(
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
                "tunings": self._runtime._available_tunings(),
                "tuning": self.tuning.summary(),
                "input_surfaces": self._runtime._available_input_surfaces(),
                "mapping_modes": available_mapping_modes(),
                "mapping_presets": available_mapping_presets(),
                "compile_modes": available_compile_modes(),
                "timbres": self._runtime._available_timbres(),
                "timbre": self.synth.timbre.summary(),
                "keyboard": {
                    "low": self.keyboard_low,
                    "high": self.keyboard_high,
                    "keys": static_render["keys"],
                    "active": list(self.active_notes.values()),
                    "surface": self.input_surface.to_dict(include_nodes=False),
                    "mapping": self.mapping_definition.to_dict() | {"anchor": self.mapping_anchor},
                },
                "recording": self.recording,
                "record_elapsed_seconds": record_now,
                "performance": performance,
                "target": {
                    "name": self.target_name,
                    "notes": static_render["target_notes"],
                },
                "last_control_change": self.last_control_change,
                "playback": self._runtime._playback_payload(),
                "chord": self._runtime._chord_payload(),
                "tracks": tracks,
            }

    def live_snapshot(self) -> LiveSnapshot:
        """Return only fast-changing state; static score data stays client-side."""
        with self._lock:
            record_now = self._runtime._record_time()
            performance = [
                self._runtime._performance_note_payload(
                    note, record_now, self.performance_compile_mode
                )
                for note in self.performance_notes
            ]
            return {
                "schema_version": INSTRUMENT_SCHEMA_VERSION,
                "midi": self.midi.status(),
                "audio": self.synth.status(),
                "keyboard_active": [dict(payload) for payload in self.active_notes.values()],
                "recording": self.recording,
                "record_elapsed_seconds": record_now,
                "performance": performance,
                "performance_name": self.performance_name,
                "last_control_change": self.last_control_change,
                "playback": self._runtime._playback_payload(),
                "chord": self._runtime._chord_payload(),
            }

    def _playback_payload(self) -> dict:
        return self.playback.payload()

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
        note,
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

        keys = [self._runtime._keyboard_key_payload(node) for node in self.input_surface.nodes]
        target_notes = [
            self._runtime._score_note_payload(note, self.target_compile_mode)
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
                    self._runtime._score_note_payload(note, track.get("compile_mode", KEY_POSITION))
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
