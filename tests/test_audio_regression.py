from __future__ import annotations

import numpy as np

from music_lab.instrument.synth import PolySynth


def _render(synth: PolySynth, frames: int = 256) -> np.ndarray:
    block = np.empty((frames, 2), dtype=np.float32)
    synth._callback(block, frames, None, None)
    return block


def _assert_boundary_is_continuous(previous: np.ndarray, current: np.ndarray) -> None:
    """块边界不应比相邻的正常波形步进突然大出一个数量级。"""
    boundary_jump = float(np.max(np.abs(current[0] - previous[-1])))
    local_steps = np.abs(np.diff(np.concatenate((previous[-32:], current[:32])), axis=0))
    normal_step = float(np.percentile(local_steps, 95))
    assert boundary_jump <= max(0.015, normal_step * 3.0)


def test_held_note_stays_continuous_when_a_second_note_enters_and_leaves() -> None:
    synth = PolySynth(enabled=False, sample_rate_hz=48_000, block_size=256)
    synth.set_timbre("sine")
    synth.set_master_volume(0.2)
    synth.note_on(0, 60, 261.6256, 105)
    previous = _render(synth)
    for _ in range(4):
        previous = _render(synth)

    second_voice = synth.note_on(0, 67, 391.9954, 100)
    entered = _render(synth)
    _assert_boundary_is_continuous(previous, entered)

    previous = _render(synth)
    synth.note_off(second_voice)
    released = _render(synth)
    _assert_boundary_is_continuous(previous, released)


def test_dense_polyphony_remains_finite_and_continuous() -> None:
    synth = PolySynth(enabled=False, sample_rate_hz=48_000, block_size=256)
    synth.set_master_volume(0.3)
    voices = []
    previous = _render(synth)

    for midi_note in (48, 52, 55, 60, 64, 67, 72, 76):
        frequency = 440.0 * 2 ** ((midi_note - 69) / 12)
        voices.append(synth.note_on(midi_note % 4, midi_note, frequency, 96))
        current = _render(synth)
        _assert_boundary_is_continuous(previous, current)
        previous = current

    for voice_id in reversed(voices):
        synth.note_off(voice_id)
        current = _render(synth)
        _assert_boundary_is_continuous(previous, current)
        previous = current

    assert np.isfinite(previous).all()
    assert float(np.max(np.abs(previous))) < 1.0


def test_spectrum_requests_share_a_short_lived_analysis_frame() -> None:
    synth = PolySynth(enabled=False)
    synth.note_on(0, 60, 261.6256, 100)
    _render(synth)

    first = synth.analysis_snapshot()
    second = synth.analysis_snapshot()

    assert second is first
