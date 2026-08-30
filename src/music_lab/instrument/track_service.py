from __future__ import annotations

from .target import PitchBendEvent, ScoreNote
from .tuning_compiler import KEY_POSITION, validate_compile_mode


class TrackService:
    """保存额外乐谱轴；target 与 performance 仍是运行时的两个特殊系统轴。"""

    def __init__(self) -> None:
        self.items: dict[str, dict] = {}
        self._counter = 0

    def upsert(
        self,
        *,
        filename: str,
        notes: list[ScoreNote],
        pitch_bends: list[PitchBendEvent],
        source_timing: dict,
        track_id: str | None = None,
    ) -> str:
        if track_id and track_id in self.items:
            resolved_id = track_id
            compile_mode = self.items[track_id].get("compile_mode", KEY_POSITION)
        else:
            return self.create(
                filename=filename,
                notes=notes,
                pitch_bends=pitch_bends,
                source_timing=source_timing,
            )
        self.items[resolved_id] = {
            "name": filename,
            "kind": "score",
            "notes": notes,
            "pitch_bends": pitch_bends,
            "source_timing": source_timing,
            "compile_mode": compile_mode,
        }
        return resolved_id

    def create(
        self,
        *,
        filename: str,
        notes: list[ScoreNote],
        pitch_bends: list[PitchBendEvent],
        source_timing: dict | None,
        kind: str = "score",
        compile_mode: str = KEY_POSITION,
    ) -> str:
        self._counter += 1
        track_id = f"track-{self._counter}"
        self.items[track_id] = {
            "name": filename,
            "kind": kind,
            "notes": notes,
            "pitch_bends": pitch_bends,
            "source_timing": source_timing,
            "compile_mode": validate_compile_mode(compile_mode),
        }
        return track_id

    def clear(self, track_id: str) -> None:
        track = self.require(track_id)
        track["notes"] = []
        track["pitch_bends"] = []
        track["source_timing"] = None

    def delete(self, track_id: str) -> None:
        if self.items.pop(track_id, None) is None:
            raise ValueError("找不到轨道")

    def set_compile_mode(self, track_id: str, mode: str) -> str:
        validated = validate_compile_mode(mode)
        self.require(track_id)["compile_mode"] = validated
        return validated

    def require(self, track_id: str) -> dict:
        try:
            return self.items[track_id]
        except KeyError as error:
            raise ValueError("找不到轨道") from error
