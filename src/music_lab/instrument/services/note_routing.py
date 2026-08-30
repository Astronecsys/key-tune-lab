from __future__ import annotations

import threading
from collections import deque

from ..recording import PerformanceNote
from ..target import PitchBendEvent, ScoreNote
from ..tuning import KeyPitch
from ..tuning_compiler import compile_midi_pitch
from .runtime_proxy import RuntimeServiceProxy

_MAX_PLAYBACK_VOICES = 128


class NoteRoutingService(RuntimeServiceProxy):
    """Route physical, virtual and playback notes through one voice lifecycle."""

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
                    self._map_physical_key(event["note"]) or self.tuning.map_key(event["note"])
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
        self._publish({"type": "note_off", "source": "virtual", "pitch": payload or {}})

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
                self.input_surface.node(input_node_id) if input_node_id is not None else None
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
                "input_midi_note": (input_node.midi_note if input_node is not None else None),
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
                retained = deque(voice_id for voice_id in queue if voice_id in active_voice_ids)
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
        return max(0.0, self._monotonic() - self.recording_started_monotonic)

    def _play_notes(
        self,
        notes: list[ScoreNote],
        pitch_bends: list[PitchBendEvent],
        channel_base: int,
        kind: str,
        compile_mode: str,
        stop_event: threading.Event,
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
        started = self._monotonic()
        started_voice_ids: dict[int, int] = {}
        try:
            for event_time, _, event_index, event_type, event_payload in events:
                delay = max(0.0, started + event_time - self._monotonic())
                if stop_event.wait(delay):
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
            self.synth.notes_off_for_channels({channel_base + channel for channel in range(16)})
