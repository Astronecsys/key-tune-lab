from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

from .tuning import KeyPitch, Tuning, key_label

KEY_POSITION = "key_position"
NEAREST_FREQUENCY = "nearest_frequency"
EQUAVE_PROPORTIONAL = "equave_proportional"

COMPILE_MODES = (
    {
        "id": KEY_POSITION,
        "name": "键位直译",
        "description": "把 MIDI 键号当作实体键位，应用当前键盘映射。",
    },
    {
        "id": NEAREST_FREQUENCY,
        "name": "最近频率",
        "description": "把 MIDI 键号先解释为标准 MIDI 频率，再选择当前律制中最近的音高。",
    },
    {
        "id": EQUAVE_PROPORTIONAL,
        "name": "等价层比例",
        "description": "保留音在来源 2:1 等价层中的相对位置，并缩放到当前律制的分度。",
    },
)
COMPILE_MODE_IDS = frozenset(mode["id"] for mode in COMPILE_MODES)


def midi1_nominal_frequency(midi_note: int) -> float:
    return 440.0 * (2.0 ** ((midi_note - 69) / 12.0))


@dataclass(frozen=True)
class CompilationResult:
    mode: str
    pitch: KeyPitch
    source_pitch: dict
    pitch_intent: dict

    def payload(self, *, channel: int) -> dict:
        compiled_pitch = self.pitch.to_dict()
        return {
            # `pitch` remains the compatibility field consumed by all current
            # visualizers. The explicit field makes the score IR layers clear.
            "pitch": compiled_pitch,
            "compiled_pitch": compiled_pitch,
            "source_pitch": self.source_pitch | {"channel": channel},
            "pitch_intent": self.pitch_intent,
            "compile_mode": self.mode,
        }


def available_compile_modes() -> list[dict]:
    return [dict(mode) for mode in COMPILE_MODES]


def validate_compile_mode(mode: str) -> str:
    if mode not in COMPILE_MODE_IDS:
        raise ValueError(f"unknown tuning compile mode {mode!r}")
    return mode


def compile_midi_pitch(
    tuning: Tuning,
    midi_note: int,
    mode: str,
    *,
    key_position_mapper: Callable[[int], KeyPitch | None] | None = None,
) -> CompilationResult:
    mode = validate_compile_mode(mode)
    source_frequency = midi1_nominal_frequency(midi_note)
    source_pitch = {
        "protocol": "midi1",
        "key": midi_note,
        "key_label": key_label(midi_note),
        "nominal_tuning": "12edo_a4_440",
        "nominal_frequency_hz": source_frequency,
    }

    if mode == KEY_POSITION:
        pitch = (
            key_position_mapper(midi_note)
            if key_position_mapper is not None
            else None
        ) or tuning.map_key(midi_note)
        intent = {
            "kind": "physical_key",
            "key": midi_note,
            "target_relative_step": _relative_step(tuning, pitch),
        }
    elif mode == NEAREST_FREQUENCY:
        relative = _nearest_relative_step(tuning, source_frequency)
        pitch = tuning.map_relative(midi_note, relative)
        intent = {
            "kind": "nominal_frequency",
            "frequency_hz": source_frequency,
            "target_relative_step": relative,
            "compiled_to_source_ratio": pitch.frequency_hz / source_frequency,
        }
    else:
        source_relative_steps = midi_note - tuning.reference_midi
        relative = round(source_relative_steps * tuning.divisions / 12)
        pitch = tuning.map_relative(midi_note, relative)
        intent = {
            "kind": "equave_position",
            "source_equave_ratio": 2.0,
            "source_divisions": 12,
            "source_relative_step": source_relative_steps,
            "target_equave_ratio": tuning.equave_ratio,
            "target_relative_step": relative,
        }

    return CompilationResult(
        mode=mode,
        pitch=pitch,
        source_pitch=source_pitch,
        pitch_intent=intent,
    )


def _relative_step(tuning: Tuning, pitch: KeyPitch) -> int:
    return pitch.equave * tuning.divisions + pitch.degree


def _nearest_relative_step(tuning: Tuning, frequency_hz: float) -> int:
    estimate = (
        math.log(frequency_hz / tuning.reference_frequency_hz)
        / math.log(tuning.equave_ratio)
        * tuning.divisions
    )
    center = round(estimate)
    radius = max(8, tuning.divisions * 2)
    return min(
        range(center - radius, center + radius + 1),
        key=lambda relative: abs(
            math.log(tuning.map_relative(0, relative).frequency_hz / frequency_hz)
        ),
    )
