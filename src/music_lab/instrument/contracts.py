from __future__ import annotations

from typing import Any, TypedDict

from pydantic import BaseModel, ConfigDict, Field

INSTRUMENT_SCHEMA_VERSION = 9


class InstrumentSnapshot(TypedDict, total=False):
    """后端交给网页的稳定顶层结构；细节对象由各领域模块负责生成。"""

    schema_version: int
    midi: dict[str, Any]
    audio: dict[str, Any]
    tuning: dict[str, Any]
    keyboard: dict[str, Any]
    recording: bool
    playback: dict[str, Any]
    chord: dict[str, Any]
    tracks: list[dict[str, Any]]


class LiveSnapshot(TypedDict, total=False):
    schema_version: int
    midi: dict[str, Any]
    audio: dict[str, Any]
    keyboard_active: list[dict[str, Any]]
    recording: bool
    playback: dict[str, Any]
    chord: dict[str, Any]


class StrictRequest(BaseModel):
    """简单命令拒绝拼错的字段，尽早把错误报告给调用方。"""

    model_config = ConfigDict(extra="forbid")


class ExtensibleRequest(BaseModel):
    """律制和映射是开放定义，保留当前版本尚不了解的扩展字段。"""

    model_config = ConfigDict(extra="allow")

    def to_payload(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


class IdRequest(StrictRequest):
    id: str = Field(min_length=1)


class CustomTuningRequest(ExtensibleRequest):
    kind: str | None = None
    divisions: int | None = None
    equave_ratio: float | None = None
    equave_expression: str | None = None
    reference_midi: int | None = None
    reference_frequency_hz: float | None = None


class CustomTimbreRequest(StrictRequest):
    partials: list[tuple[float, float]] = Field(min_length=1, max_length=32)


class MappingRequest(ExtensibleRequest):
    surface_id: str | None = None
    mode: str | None = None
    anchor_node_id: str | None = None
    reference_frequency_hz: float | None = None
    reference_degree: int | None = None


class VolumeRequest(StrictRequest):
    value: float = Field(ge=0, le=1)


class TuningLibrarySaveRequest(ExtensibleRequest):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str | None = None
    overwrite: bool = False


class InputNodeOnRequest(StrictRequest):
    velocity: int = Field(default=96, ge=1, le=127)


class ChordBasisRequest(ExtensibleRequest):
    mode: str
    midi_note: int | None = None
    ratio_from_reference: float | None = None


class PerformanceNoteRequest(ExtensibleRequest):
    midi_note: int
    velocity: int
    start_seconds: float
    duration_seconds: float
    channel: int = 0
    start_ticks: int | None = None
    duration_ticks: int | None = None


class RestorePerformanceRequest(StrictRequest):
    notes: list[PerformanceNoteRequest]


class TrackCompileRequest(StrictRequest):
    mode: str = Field(min_length=1)
