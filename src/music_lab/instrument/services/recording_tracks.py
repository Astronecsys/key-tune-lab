from __future__ import annotations

from ..recording import PerformanceNote
from ..target import ScoreNote, demo_score, parse_midi_sequence
from ..tuning_compiler import KEY_POSITION, validate_compile_mode
from .runtime_proxy import RuntimeServiceProxy


class RecordingTrackService(RuntimeServiceProxy):
    """Own recording takes, MIDI import and per-axis lifecycle commands."""

    def start_recording(self) -> None:
        with self._lock:
            archived_track_id = self._archive_performance_take()
            self._recording_take_counter += 1
            self.performance_name = f"演奏 {self._recording_take_counter}"
            self.performance_visible = True
            self.recording = True
            self.recording_started_monotonic = self._monotonic()
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
            return self.track_service.create(
                filename=self.performance_name,
                kind="performance",
                notes=notes,
                pitch_bends=list(self.performance_pitch_bends),
                source_timing=self.performance_source_timing,
                compile_mode=self.performance_compile_mode,
            )

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
            self.recording_started_monotonic = self._monotonic()
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
                start_ticks=(None if note.get("start_ticks") is None else int(note["start_ticks"])),
                duration_ticks=(
                    None if note.get("duration_ticks") is None else int(note["duration_ticks"])
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
            else:
                resolved_id = self.track_service.upsert(
                    filename=filename,
                    notes=notes,
                    pitch_bends=pitch_bends,
                    source_timing=source_timing,
                    track_id=track_id,
                )
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
                self.track_service.clear(track_id)
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
            else:
                self.track_service.delete(track_id)
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
                self.track_service.set_compile_mode(track_id, mode)
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
