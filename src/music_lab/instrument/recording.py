from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass
class PerformanceNote:
    """A captured note whose duration may remain open during recording."""

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
