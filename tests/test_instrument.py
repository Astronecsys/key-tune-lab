from __future__ import annotations

import io
import math
import time

import mido
import numpy as np
import pytest

from music_lab.instrument.midi_io import MidiInput, decode_midi_message
from music_lab.instrument.runtime import InstrumentRuntime
from music_lab.instrument.synth import PolySynth
from music_lab.instrument.target import (
    PitchBendEvent,
    ScoreNote,
    parse_midi_sequence,
)
from music_lab.instrument.tuning import get_tuning
from music_lab.instrument.tuning_compiler import (
    EQUAVE_PROPORTIONAL,
    KEY_POSITION,
    NEAREST_FREQUENCY,
    compile_midi_pitch,
)


def test_edo_maps_physical_keys_to_tuning_steps() -> None:
    tuning = get_tuning("19edo")
    assert tuning.map_key(69).frequency_hz == 440.0
    assert math.isclose(tuning.map_key(88).frequency_hz, 880.0)
    assert tuning.map_key(70).degree == 1
    assert tuning.map_key(70).key_label == "K70"
    assert tuning.map_key(70).pitch_label == "R0[0:1]_19"
    assert tuning.map_key(70).traditional_alias is None


def test_traditional_alias_is_only_exposed_by_12edo() -> None:
    traditional = get_tuning("12edo").map_key(60)
    assert traditional.key_label == "K60"
    assert traditional.pitch_label == "R0[-1:3]_12"
    assert traditional.traditional_alias == "C4"
    assert get_tuning("ji5_12").map_key(60).traditional_alias is None
    assert get_tuning("sqrt2_12").map_key(60).traditional_alias is None


def test_just_intonation_exposes_exact_prime_relation() -> None:
    pitch = get_tuning("ji5_12").map_key(64)
    assert pitch.ratio_label == "5/4"
    assert pitch.prime_vector == {"2": -2, "3": 0, "5": 1, "7": 0, "11": 0}
    assert pitch.approximation_error_cents == 0.0


def test_sqrt2_equave_repeats_after_twelve_physical_keys() -> None:
    tuning = get_tuning("sqrt2_12")
    assert math.isclose(
        tuning.map_key(81).frequency_hz,
        440.0 * math.sqrt(2),
    )
    assert tuning.map_key(70).ratio_label == "√2^(1/12)"


def test_seven_and_eleven_limit_relations_are_exposed() -> None:
    assert get_tuning("ji7_12").map_key(70).ratio_label == "7/4"
    assert get_tuning("ji11_12").map_key(66).ratio_label == "11/8"


def test_tuning_compiler_separates_key_frequency_and_equave_intents() -> None:
    tuning = get_tuning("sqrt2_12")
    key_position = compile_midi_pitch(tuning, 81, KEY_POSITION)
    nearest = compile_midi_pitch(tuning, 81, NEAREST_FREQUENCY)
    proportional = compile_midi_pitch(tuning, 81, EQUAVE_PROPORTIONAL)

    assert key_position.pitch.frequency_hz == pytest.approx(440 * math.sqrt(2))
    assert nearest.pitch.frequency_hz == pytest.approx(880.0)
    assert proportional.pitch.frequency_hz == pytest.approx(440 * math.sqrt(2))
    assert key_position.pitch_intent["kind"] == "physical_key"
    assert nearest.pitch_intent["kind"] == "nominal_frequency"
    assert proportional.pitch_intent["kind"] == "equave_position"


def test_key_position_compiler_uses_the_physical_mapping_callback() -> None:
    tuning = get_tuning("19edo")
    compiled = compile_midi_pitch(
        tuning,
        70,
        KEY_POSITION,
        key_position_mapper=lambda midi_note: tuning.map_relative(midi_note, 3),
    )

    assert compiled.pitch.degree == 3


def test_decode_note_on_and_velocity_zero_note_off() -> None:
    assert decode_midi_message([0x90, 60, 100]) == {
        "type": "note_on", "channel": 0, "note": 60, "velocity": 100
    }
    assert decode_midi_message([0x90, 60, 0]) == {
        "type": "note_off", "channel": 0, "note": 60, "velocity": 0
    }
    assert decode_midi_message([0x80, 60, 64]) == {
        "type": "note_off", "channel": 0, "note": 60, "velocity": 64
    }
    assert decode_midi_message([0xE2, 0x00, 0x60]) == {
        "type": "pitch_bend", "channel": 2, "value": 4096
    }


def test_midi_input_connects_after_a_device_is_hot_plugged() -> None:
    class FakeMidiIn:
        ports: list[str] = []

        def __init__(self) -> None:
            self.opened_port: int | None = None
            self.callback = None

        def get_ports(self) -> list[str]:
            return list(self.ports)

        def open_port(self, index: int) -> None:
            self.opened_port = index

        def ignore_types(self, **kwargs) -> None:  # noqa: ANN003
            del kwargs

        def set_callback(self, callback) -> None:  # noqa: ANN001
            self.callback = callback

        def cancel_callback(self) -> None:
            self.callback = None

        def close_port(self) -> None:
            self.opened_port = None

    statuses: list[dict] = []
    midi = MidiInput(
        "Digital Keyboard",
        lambda event: None,
        midi_in_factory=FakeMidiIn,
        poll_interval_seconds=0.01,
        status_handler=statuses.append,
    )
    midi.start()
    try:
        assert midi.status()["connected"] is False
        FakeMidiIn.ports = ["Digital Keyboard 0"]
        deadline = time.monotonic() + 0.5
        while not midi.status()["connected"] and time.monotonic() < deadline:
            time.sleep(0.01)
        assert midi.status() == {
            "connected": True,
            "selected_port": "Digital Keyboard 0",
            "available_ports": ["Digital Keyboard 0"],
            "error": None,
        }
        assert statuses[-1]["selected_port"] == "Digital Keyboard 0"

        FakeMidiIn.ports = []
        deadline = time.monotonic() + 0.5
        while midi.status()["connected"] and time.monotonic() < deadline:
            time.sleep(0.01)
        assert midi.status()["connected"] is False
        assert "Digital Keyboard" in midi.status()["error"]
        assert statuses[-1]["connected"] is False
    finally:
        midi.stop()


def test_parse_target_midi_timeline() -> None:
    midi = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.Message("note_on", note=60, velocity=100, time=0))
    track.append(mido.Message("note_off", note=60, velocity=0, time=480))
    stream = io.BytesIO()
    midi.save(file=stream)

    sequence = parse_midi_sequence(stream.getvalue())
    notes = list(sequence.notes)
    assert len(notes) == 1
    assert notes[0].midi_note == 60
    assert notes[0].start_seconds == 0.0
    assert math.isclose(notes[0].duration_seconds, 0.5)
    assert notes[0].start_ticks == 0
    assert notes[0].duration_ticks == 480
    assert sequence.ticks_per_beat == 480
    assert sequence.tempo_events[0].microseconds_per_beat == 500_000


def test_midi_parser_preserves_tempo_map_and_time_signature() -> None:
    midi = mido.MidiFile(type=0, ticks_per_beat=960)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=600_000, time=0))
    track.append(
        mido.MetaMessage(
            "time_signature", numerator=7, denominator=8, time=0
        )
    )
    track.append(mido.Message("note_on", note=60, velocity=90, time=0))
    track.append(mido.Message("note_off", note=60, velocity=0, time=960))
    stream = io.BytesIO()
    midi.save(file=stream)

    sequence = parse_midi_sequence(stream.getvalue())

    assert sequence.notes[0].duration_seconds == pytest.approx(0.6)
    assert sequence.notes[0].duration_ticks == 960
    assert sequence.tempo_events[0].microseconds_per_beat == 600_000
    assert sequence.time_signatures[0].numerator == 7
    assert sequence.time_signatures[0].denominator == 8


def test_midi_parser_preserves_overlapping_retriggers_of_the_same_pitch() -> None:
    midi = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.Message("note_on", note=60, velocity=90, time=0))
    track.append(mido.Message("note_on", note=60, velocity=100, time=120))
    track.append(mido.Message("note_off", note=60, velocity=0, time=120))
    track.append(mido.Message("note_off", note=60, velocity=0, time=120))
    stream = io.BytesIO()
    midi.save(file=stream)

    notes = parse_midi_sequence(stream.getvalue()).notes
    assert len(notes) == 2
    assert [note.start_seconds for note in notes] == pytest.approx([0.0, 0.125])
    assert [note.duration_seconds for note in notes] == pytest.approx([0.25, 0.25])


def test_midi_parser_extends_notes_until_sustain_pedal_is_released() -> None:
    midi = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.Message("control_change", control=64, value=127, time=0))
    track.append(mido.Message("note_on", note=60, velocity=90, time=0))
    track.append(mido.Message("note_off", note=60, velocity=0, time=240))
    track.append(mido.Message("control_change", control=64, value=0, time=240))
    track.append(mido.Message("pitchwheel", channel=0, pitch=4096, time=0))
    stream = io.BytesIO()
    midi.save(file=stream)

    sequence = parse_midi_sequence(stream.getvalue())
    assert sequence.notes[0].duration_seconds == pytest.approx(0.5)
    assert sequence.pitch_bends == (
        PitchBendEvent(
            time_seconds=0.5,
            channel=0,
            value=4096,
            time_ticks=480,
        ),
    )


def test_midi_parser_ignores_severely_unbalanced_sustain_streams() -> None:
    midi = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    for note in (60, 62, 64, 65):
        track.append(mido.Message("control_change", control=64, value=127, time=0))
        track.append(mido.Message("note_on", note=note, velocity=90, time=0))
        track.append(mido.Message("note_off", note=note, velocity=0, time=240))
        track.append(mido.MetaMessage("marker", text="pedal boundary", time=240))
    stream = io.BytesIO()
    midi.save(file=stream)

    sequence = parse_midi_sequence(stream.getvalue())

    assert [note.duration_seconds for note in sequence.notes] == pytest.approx(
        [0.25, 0.25, 0.25, 0.25]
    )
    assert sequence.repairs == ("ignored_malformed_sustain:channel_0",)
    assert sequence.timing_dict()["repairs"] == [
        "ignored_malformed_sustain:channel_0"
    ]


def test_reset_all_controllers_releases_sustained_notes() -> None:
    midi = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.Message("control_change", control=64, value=127, time=0))
    track.append(mido.Message("note_on", note=60, velocity=90, time=0))
    track.append(mido.Message("note_off", note=60, velocity=0, time=240))
    track.append(mido.Message("control_change", control=121, value=0, time=240))
    track.append(mido.Message("note_on", note=62, velocity=90, time=480))
    track.append(mido.Message("note_off", note=62, velocity=0, time=480))
    stream = io.BytesIO()
    midi.save(file=stream)

    notes = parse_midi_sequence(stream.getvalue()).notes
    assert notes[0].duration_seconds == pytest.approx(0.5)
    assert notes[1].duration_seconds == pytest.approx(0.5)


def test_synth_retrigger_voices_have_independent_release_tails() -> None:
    synth = PolySynth(enabled=False)
    first = synth.note_on(0, 60, 261.6256, 100)
    second = synth.note_on(0, 60, 261.6256, 100)

    synth.note_off(first)

    assert first != second
    assert synth._voices[first].released is True
    assert synth._voices[second].released is False


def test_synth_filters_inaudible_partials_and_reports_output_underruns() -> None:
    synth = PolySynth(enabled=False)
    synth.set_custom_timbre([(30.0, 1.0)])
    synth.note_on(0, 60, 1000.0, 127)
    outdata = np.empty((64, 2), dtype=np.float32)

    class UnderflowStatus:
        output_underflow = True

        def __bool__(self) -> bool:
            return True

        def __str__(self) -> str:
            return "output underflow"

    synth._callback(outdata, 64, None, UnderflowStatus())

    assert np.count_nonzero(outdata) == 0
    assert synth.status()["underrun_count"] == 1
    assert synth.status()["last_callback_status"] == "output underflow"


def test_synth_applies_polyphony_headroom_before_soft_clipping() -> None:
    synth = PolySynth(enabled=False)
    for note in range(60, 76):
        synth.note_on(0, note, 440 * 2 ** ((note - 69) / 12), 127)
    outdata = np.empty((64, 2), dtype=np.float32)
    for _ in range(4):
        synth._callback(outdata, 64, None, None)

    assert synth.status()["polyphony_gain"] <= 0.26
    assert np.max(np.abs(outdata)) < 1.0


def test_same_pitch_retrigger_inherits_phase_for_a_smooth_transition() -> None:
    synth = PolySynth(enabled=False)
    synth.set_timbre("sine")
    first = synth.note_on(0, 60, 261.6256, 100)
    outdata = np.empty((128, 2), dtype=np.float32)
    synth._callback(outdata, 128, None, None)
    inherited_phase = synth._voices[first].phases.copy()
    synth.note_off(first)

    second = synth.note_on(0, 60, 261.6256, 100)

    assert np.array_equal(synth._voices[second].phases, inherited_phase)
    assert synth._voices[first].release_samples_total == synth.attack_samples
    assert synth.block_size == 960
    assert synth.status()["callback_frames"] == 128


def test_low_level_mix_is_linear_without_unconditional_saturation() -> None:
    synth = PolySynth(enabled=False)
    synth.set_timbre("sine")
    synth.set_master_volume(0.1)
    voice_id = synth.note_on(0, 60, 261.6256, 127)
    outdata = np.empty((480, 2), dtype=np.float32)
    synth._callback(outdata, 480, None, None)
    start_phase = synth._voices[voice_id].phases[0]

    synth._callback(outdata, 480, None, None)

    sample_indices = np.arange(480)
    angular_step = 2 * np.pi * 261.6256 / synth.sample_rate_hz
    pan = ((60 * 7) % 17) / 16
    expected_left = (
        0.1
        * np.sin(start_phase + angular_step * sample_indices)
        * np.cos(pan * np.pi / 2)
    )
    assert outdata[:, 0] == pytest.approx(expected_left, abs=1e-6)
    assert synth.status()["limited_sample_count"] == 0


def test_diagnostic_capture_copies_exact_callback_output() -> None:
    synth = PolySynth(enabled=False, sample_rate_hz=1000)
    synth.set_timbre("sine")
    synth.note_on(0, 60, 100.0, 100)
    assert synth.start_diagnostic_capture(0.1) == 100
    first = np.empty((60, 2), dtype=np.float32)
    second = np.empty((60, 2), dtype=np.float32)

    synth._callback(first, 60, None, None)
    synth._callback(second, 60, None, None)
    captured, complete = synth.diagnostic_capture()

    assert complete is True
    assert captured.shape == (100, 2)
    assert captured[:60] == pytest.approx(first)
    assert captured[60:] == pytest.approx(second[:40])


def test_blocking_audio_writer_renders_fixed_blocks_without_callback_backend() -> None:
    synth = PolySynth(enabled=False, block_size=32)

    class FakeStream:
        def __init__(self) -> None:
            self.blocks: list[np.ndarray] = []

        def write(self, block: np.ndarray) -> bool:
            self.blocks.append(block.copy())
            if len(self.blocks) == 3:
                synth._writer_stop.set()
            return False

    stream = FakeStream()
    synth._stream = stream
    synth._writer_stop.clear()

    synth._writer_loop()

    assert len(stream.blocks) == 3
    assert all(block.shape == (32, 2) for block in stream.blocks)
    assert synth.status()["callback_frames"] == 32


def test_wasapi_writer_uses_soundcard_player() -> None:
    synth = PolySynth(enabled=False, block_size=32)

    class FakePlayer:
        def __init__(self) -> None:
            self.blocks: list[np.ndarray] = []

        def play(self, block: np.ndarray) -> None:
            self.blocks.append(block.copy())
            synth._writer_stop.set()

    player = FakePlayer()
    synth._stream = player
    synth._backend = "wasapi_soundcard"
    synth._writer_stop.clear()

    synth._writer_loop()

    assert len(player.blocks) == 1
    assert player.blocks[0].shape == (32, 2)


def test_recording_builds_performance_timeline() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.start_recording()
    runtime._handle_midi_event(
        {"type": "note_on", "channel": 0, "note": 65, "velocity": 91}
    )
    assert runtime.snapshot()["keyboard"]["active"][0]["frequency_hz"] > 0
    runtime._handle_midi_event(
        {"type": "note_off", "channel": 0, "note": 65, "velocity": 0}
    )
    runtime.stop_recording()

    performance = runtime.snapshot()["performance"]
    assert len(performance) == 1
    assert performance[0]["midi_note"] == 65
    assert performance[0]["duration_seconds"] >= 0.01


def test_live_snapshot_excludes_static_score_payloads() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime._handle_midi_event(
        {"type": "note_on", "channel": 0, "note": 65, "velocity": 91}
    )

    live = runtime.live_snapshot()

    assert live["schema_version"] == 9
    assert "tracks" not in live
    assert "tunings" not in live
    assert live["keyboard_active"][0]["midi_note"] == 65
    assert live["chord"]["size"] == 1


def test_static_score_rendering_is_cached_until_tuning_changes(monkeypatch) -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    original = runtime._score_note_payload
    call_count = 0

    def counted_score_note_payload(note, compile_mode=KEY_POSITION):  # noqa: ANN001
        nonlocal call_count
        call_count += 1
        return original(note, compile_mode)

    monkeypatch.setattr(runtime, "_score_note_payload", counted_score_note_payload)

    first_snapshot = runtime.snapshot()
    assert first_snapshot["schema_version"] == 9
    initial_call_count = call_count
    runtime.snapshot()

    assert initial_call_count > 0
    assert call_count == initial_call_count

    runtime.set_tuning("19edo")
    runtime.snapshot()

    assert call_count > initial_call_count


def test_each_recording_take_is_preserved_as_a_separate_axis() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)

    runtime.start_recording()
    runtime._handle_midi_event(
        {"type": "note_on", "channel": 0, "note": 60, "velocity": 90}
    )
    runtime._handle_midi_event(
        {"type": "note_off", "channel": 0, "note": 60, "velocity": 0}
    )
    runtime.stop_recording()

    runtime.start_recording()
    runtime._handle_midi_event(
        {"type": "note_on", "channel": 0, "note": 64, "velocity": 92}
    )
    runtime._handle_midi_event(
        {"type": "note_off", "channel": 0, "note": 64, "velocity": 0}
    )
    runtime.stop_recording()

    performance_tracks = [
        track for track in runtime.snapshot()["tracks"]
        if track["kind"] == "performance"
    ]
    assert [track["name"] for track in performance_tracks] == ["演奏 1", "演奏 2"]
    assert [track["notes"][0]["midi_note"] for track in performance_tracks] == [60, 64]
    assert all(track["deletable"] for track in performance_tracks)


def test_target_and_current_performance_axes_can_be_deleted() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    assert {track["id"] for track in runtime.snapshot()["tracks"]} == {
        "target",
        "performance",
    }

    runtime.delete_track("target")
    runtime.delete_track("performance")
    assert runtime.snapshot()["tracks"] == []

    runtime.start_recording()
    try:
        assert [track["id"] for track in runtime.snapshot()["tracks"]] == [
            "performance"
        ]
        with pytest.raises(ValueError, match="正在录制"):
            runtime.delete_track("performance")
    finally:
        runtime.stop_recording()


def test_active_notes_are_analyzed_as_a_chord() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    for note in (60, 64, 67):
        runtime._handle_midi_event(
            {"type": "note_on", "channel": 0, "note": note, "velocity": 90}
        )
    chord = runtime.snapshot()["chord"]
    assert chord["size"] == 3
    assert chord["name"] == "C4 大三和弦"
    assert chord["basis_mode"] == "lowest"
    assert chord["basis"]["midi_note"] == 60
    assert chord["basis"]["sounding"] is True
    assert [tone["is_basis"] for tone in chord["tones"]] == [True, False, False]
    assert [tone["chord_relation"]["ratio"] for tone in chord["tones"]] == pytest.approx(
        [1.0, 2 ** (4 / 12), 2 ** (7 / 12)]
    )
    assert chord["reference"] == {
        "midi_note": 69,
        "key_label": "K69",
        "pitch_label": "R0[0:0]_12",
        "traditional_alias": "A4",
        "frequency_hz": 440.0,
    }
    assert [tone["key_label"] for tone in chord["tones"]] == ["K60", "K64", "K67"]
    assert [tone["pitch_label"] for tone in chord["tones"]] == [
        "R0[-1:3]_12",
        "R0[-1:7]_12",
        "R0[-1:10]_12",
    ]
    assert [tone["traditional_alias"] for tone in chord["tones"]] == ["C4", "E4", "G4"]
    assert all(
        {
            "frequency_hz",
            "tuning_relation",
            "chord_relation",
        }
        <= tone.keys()
        for tone in chord["tones"]
    )
    assert all(
        tone["tuning_relation"]["reference"] == "T"
        and tone["chord_relation"]["reference"] == "B"
        for tone in chord["tones"]
    )
    assert chord["tones"][0]["tuning_relation"]["ratio_label"] == "≈ 72/121"
    assert chord["tones"][0]["chord_relation"]["prime_vector_label"] == "1"
    assert chord["tones"][2]["chord_relation"]["ratio_label"] == "≈ 3/2"
    assert chord["tones"][2]["chord_relation"]["prime_vector"] == {
        "2": -1,
        "3": 1,
        "5": 0,
        "7": 0,
        "11": 0,
    }
    assert all(
        "ratio_from_reference" not in tone
        and "cents_from_root" not in tone
        and "relation" not in tone
        for tone in chord["tones"]
    )


def test_selected_chord_basis_can_be_above_sounding_tones_and_persist() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    for note in (60, 64, 67):
        runtime._handle_midi_event(
            {"type": "note_on", "channel": 0, "note": note, "velocity": 90}
        )

    runtime.set_chord_basis({"mode": "selected", "midi_note": 64})
    chord = runtime.snapshot()["chord"]

    assert chord["basis_mode"] == "selected"
    assert chord["basis"]["midi_note"] == 64
    assert chord["basis"]["sounding"] is True
    assert [tone["is_basis"] for tone in chord["tones"]] == [False, True, False]
    assert chord["tones"][0]["chord_relation"]["ratio"] < 1
    assert chord["tones"][0]["chord_relation"]["ratio_label"] == "≈ 50/63"
    assert chord["tones"][0]["chord_relation"]["prime_vector"] == {
        "2": 1,
        "3": -2,
        "5": 2,
        "7": -1,
        "11": 0,
    }

    runtime._handle_midi_event({"type": "note_off", "channel": 0, "note": 64})
    released = runtime.snapshot()["chord"]

    assert released["basis"]["midi_note"] == 64
    assert released["basis"]["sounding"] is False
    assert all(not tone["is_basis"] for tone in released["tones"])


def test_virtual_chord_basis_is_analytical_and_not_a_sounding_tone() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime._handle_midi_event(
        {"type": "note_on", "channel": 0, "note": 69, "velocity": 90}
    )
    runtime.set_chord_basis(
        {"mode": "virtual", "ratio_from_reference": 0.25}
    )

    chord = runtime.snapshot()["chord"]

    assert chord["size"] == 1
    assert chord["basis"] == {
        "mode": "virtual",
        "origin": "virtual",
        "sounding": False,
        "input_node_id": None,
        "midi_note": None,
        "key_label": None,
        "pitch_label": "V[T×0.25]",
        "traditional_alias": None,
        "frequency_hz": 110.0,
        "ratio_from_reference": 0.25,
        "identity_relation": {
            "reference": "B",
            "ratio": 1.0,
            "ratio_label": "1/1",
            "relationship_kind": "exact harmonic ratio",
            "prime_vector": {"2": 0, "3": 0, "5": 0, "7": 0, "11": 0},
            "prime_vector_label": "1",
        },
    }
    assert chord["tones"][0]["chord_relation"]["ratio"] == pytest.approx(4.0)
    assert chord["tones"][0]["chord_relation"]["ratio_label"] == "4/1"
    assert runtime.synth.status()["active_voice_count"] == 1


def test_auto_simple_basis_selects_the_simplest_sounding_relation_origin() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    for note in (60, 64, 67):
        runtime._handle_midi_event(
            {"type": "note_on", "channel": 0, "note": note, "velocity": 90}
        )

    runtime.set_chord_basis({"mode": "auto_simple"})
    chord = runtime.snapshot()["chord"]

    assert chord["basis_mode"] == "auto_simple"
    assert chord["basis"]["midi_note"] == 60
    assert chord["basis"]["sounding"] is True
    assert chord["basis"]["auto"]["strategy"] == "simple"
    assert chord["basis"]["auto"]["score"] >= 0
    assert chord["basis"]["auto"]["coverage"] == 3
    assert chord["basis"]["auto"]["tone_count"] == 3
    assert chord["basis"]["auto"]["model"] == "tuning_relation"
    assert [tone["is_basis"] for tone in chord["tones"]] == [True, False, False]


def test_auto_common_fundamental_can_infer_an_unsounded_4_5_6_origin() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    for note in (60, 64, 67):
        runtime._handle_midi_event(
            {"type": "note_on", "channel": 0, "note": note, "velocity": 90}
        )

    runtime.set_chord_basis({"mode": "auto_fundamental"})
    chord = runtime.snapshot()["chord"]

    assert chord["basis_mode"] == "auto_fundamental"
    assert chord["basis"]["midi_note"] is None
    assert chord["basis"]["sounding"] is False
    assert chord["basis"]["frequency_hz"] == pytest.approx(65.5543, rel=1e-5)
    assert chord["basis"]["auto"]["coverage"] == 3
    assert chord["basis"]["auto"]["model"] == "integer_partials"
    assert [tone["chord_relation"]["ratio_label"] for tone in chord["tones"]] == [
        "≈ 4/1",
        "≈ 5/1",
        "≈ 6/1",
    ]
    assert runtime.synth.status()["active_voice_count"] == 3


def test_auto_common_fundamental_uses_non_integer_timbre_partials() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.set_tuning("sqrt2_12")
    runtime.set_timbre("sqrt2")
    for note in (60, 72):
        runtime._handle_midi_event(
            {"type": "note_on", "channel": 0, "note": note, "velocity": 90}
        )

    runtime.set_chord_basis({"mode": "auto_fundamental"})
    chord = runtime.snapshot()["chord"]

    assert chord["basis"]["midi_note"] == 60
    assert chord["basis"]["auto"]["model"] == "timbre_partials"
    assert chord["basis"]["auto"]["coverage"] == 2
    assert chord["tones"][1]["chord_relation"]["ratio_label"] == "P×1.4142136"
    assert (
        chord["tones"][1]["chord_relation"]["relationship_kind"]
        == "exact timbre-partial relation"
    )


def test_auto_composite_can_choose_a_constrained_virtual_relation() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    for note in (60, 64, 67):
        runtime._handle_midi_event(
            {"type": "note_on", "channel": 0, "note": note, "velocity": 90}
        )

    runtime.set_chord_basis({"mode": "auto_composite"})
    chord = runtime.snapshot()["chord"]

    assert chord["basis_mode"] == "auto_composite"
    assert chord["basis"]["sounding"] is False
    assert chord["basis"]["frequency_hz"] == pytest.approx(65.5543, rel=1e-5)
    assert chord["basis"]["auto"]["strategy"] == "composite"
    assert chord["basis"]["auto"]["model"] == "composite_integer_partials"
    assert [tone["chord_relation"]["ratio_label"] for tone in chord["tones"]] == [
        "≈ 4/1",
        "≈ 5/1",
        "≈ 6/1",
    ]
    assert runtime.synth.status()["active_voice_count"] == 3


def test_auto_composite_penalizes_deep_high_partial_virtual_roots() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    for note in (60, 61, 62):
        runtime._handle_midi_event(
            {"type": "note_on", "channel": 0, "note": note, "velocity": 90}
        )

    runtime.set_chord_basis({"mode": "auto_composite"})
    basis = runtime.snapshot()["chord"]["basis"]

    assert basis["sounding"] is True
    assert basis["midi_note"] in {60, 61, 62}
    assert basis["auto"]["model"] == "composite_sounding_relation"


def test_auto_basis_waits_for_a_stable_candidate_before_switching(
    monkeypatch,
) -> None:
    clock = [100.0]
    monkeypatch.setattr(
        "music_lab.instrument.runtime.time.monotonic",
        lambda: clock[0],
    )
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    for note in (60, 64, 67):
        runtime._handle_midi_event(
            {"type": "note_on", "channel": 0, "note": note, "velocity": 90}
        )
    runtime.set_chord_basis({"mode": "auto_simple"})
    assert runtime.snapshot()["chord"]["basis"]["midi_note"] == 60

    runtime._handle_midi_event({"type": "note_off", "channel": 0, "note": 60})
    pending = runtime.snapshot()["chord"]["basis"]
    assert pending["midi_note"] == 60
    assert pending["sounding"] is False

    clock[0] += 0.13
    settled = runtime.snapshot()["chord"]["basis"]
    assert settled["midi_note"] in {64, 67}
    assert settled["sounding"] is True


def test_algebraic_tuning_and_chord_relations_keep_separate_references() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.set_tuning("sqrt2_12")
    for note in (60, 64):
        runtime._handle_midi_event(
            {"type": "note_on", "channel": 0, "note": note, "velocity": 90}
        )

    chord = runtime.snapshot()["chord"]
    upper = chord["tones"][1]

    assert upper["tuning_relation"]["reference"] == "T"
    assert upper["tuning_relation"]["ratio_label"] == "√2^(-5/12)"
    assert upper["chord_relation"]["reference"] == "B"
    assert upper["chord_relation"]["ratio_label"] == "√2^(4/12)"
    assert upper["chord_relation"]["relationship_kind"] == "exact algebraic relation"
    assert "cents" not in upper["chord_relation"]
    assert "error_cents" not in upper["chord_relation"]

    runtime.set_chord_basis({"mode": "selected", "midi_note": 64})
    lower = runtime.snapshot()["chord"]["tones"][0]
    assert lower["chord_relation"]["ratio"] < 1
    assert lower["chord_relation"]["ratio_label"] == "√2^(-4/12)"


def test_tuning_relation_uses_the_full_custom_equave_ratio() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.set_custom_tuning(1, 3.0, 60, 300.0)
    runtime._handle_midi_event(
        {"type": "note_on", "channel": 0, "note": 61, "velocity": 90}
    )

    relation = runtime.snapshot()["chord"]["tones"][0]["tuning_relation"]

    assert relation["ratio"] == pytest.approx(3.0)
    assert relation["ratio_label"] == "3/1"
    assert relation["prime_vector"] == {
        "2": 0,
        "3": 1,
        "5": 0,
        "7": 0,
        "11": 0,
    }
    assert "error_cents" not in relation


def test_non_12edo_chord_has_no_traditional_pitch_names() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.set_tuning("19edo")
    for note in (60, 64, 67):
        runtime._handle_midi_event(
            {"type": "note_on", "channel": 0, "note": note, "velocity": 90}
        )
    chord = runtime.snapshot()["chord"]
    assert chord["name"] == "3 音频率集合 · 19 平均律"
    assert chord["reference"]["key_label"] == "K69"
    assert chord["reference"]["traditional_alias"] is None
    assert all(tone["traditional_alias"] is None for tone in chord["tones"])
    assert all(tone["pitch_label"].startswith("R0[") for tone in chord["tones"])


def test_target_playback_can_start_and_stop() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.start_playback("target")
    assert runtime.playback_kind == "target"
    runtime.stop_playback()
    assert runtime.playback_kind is None


def test_track_compiler_changes_timeline_and_playback_together() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.set_tuning("sqrt2_12")
    runtime.target_notes = [ScoreNote(81, 0.0, 0.3, 100)]

    direct = runtime.snapshot()["tracks"][0]["notes"][0]
    runtime.set_track_compile_mode("target", NEAREST_FREQUENCY)
    compiled_track = runtime.snapshot()["tracks"][0]
    compiled = compiled_track["notes"][0]

    assert direct["pitch"]["frequency_hz"] == pytest.approx(
        440 * math.sqrt(2)
    )
    assert compiled["pitch"]["frequency_hz"] == pytest.approx(880.0)
    assert compiled["compiled_pitch"] == compiled["pitch"]
    assert compiled["source_pitch"] == {
        "protocol": "midi1",
        "key": 81,
        "key_label": "K81",
        "nominal_tuning": "12edo_a4_440",
        "nominal_frequency_hz": 880.0,
        "channel": 0,
    }
    assert compiled["pitch_intent"]["kind"] == "nominal_frequency"
    assert compiled_track["compile_mode"] == NEAREST_FREQUENCY

    runtime.start_playback("target")
    try:
        deadline = time.monotonic() + 0.5
        active = runtime.snapshot()["keyboard"]["active"]
        while not active and time.monotonic() < deadline:
            time.sleep(0.005)
            active = runtime.snapshot()["keyboard"]["active"]
        assert active[0]["frequency_hz"] == pytest.approx(880.0)
    finally:
        runtime.stop_playback()


def test_track_compiler_rejects_unknown_or_missing_tracks() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    with pytest.raises(ValueError, match="unknown tuning compile mode"):
        runtime.set_track_compile_mode("target", "old_notation")
    with pytest.raises(ValueError, match="找不到轨道"):
        runtime.set_track_compile_mode("missing", KEY_POSITION)


def test_timeline_playback_updates_chord_and_visualization_note_state() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.target_notes = [
        ScoreNote(midi_note=note, start_seconds=0.0, duration_seconds=1.0, velocity=96)
        for note in (60, 64, 67)
    ]

    runtime.start_playback("target")
    try:
        deadline = time.monotonic() + 0.5
        snapshot = runtime.snapshot()
        while snapshot["chord"]["size"] < 3 and time.monotonic() < deadline:
            time.sleep(0.005)
            snapshot = runtime.snapshot()

        assert snapshot["chord"]["size"] == 3
        assert snapshot["chord"]["name"] == "C4 大三和弦"
        assert {note["source"] for note in snapshot["keyboard"]["active"]} == {"playback"}
        assert {note["source_id"] for note in snapshot["keyboard"]["active"]} == {"target"}
    finally:
        runtime.stop_playback()

    assert runtime.snapshot()["keyboard"]["active"] == []
    assert runtime.snapshot()["chord"]["size"] == 0


def test_stopping_timeline_releases_playback_without_releasing_physical_input() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime._handle_midi_event(
        {"type": "note_on", "channel": 0, "note": 72, "velocity": 88}
    )
    runtime.extra_tracks["track-test"] = {
        "name": "test",
        "notes": [
            ScoreNote(
                midi_note=60,
                start_seconds=0.0,
                duration_seconds=1.0,
                velocity=90,
            )
        ],
    }

    runtime.start_playback("track-test")
    deadline = time.monotonic() + 0.5
    snapshot = runtime.snapshot()
    while len(snapshot["keyboard"]["active"]) < 2 and time.monotonic() < deadline:
        time.sleep(0.005)
        snapshot = runtime.snapshot()
    assert {note["source"] for note in snapshot["keyboard"]["active"]} == {
        "midi",
        "playback",
    }

    runtime.stop_playback()
    active = runtime.snapshot()["keyboard"]["active"]
    assert len(active) == 1
    assert active[0]["source"] == "midi"
    assert active[0]["midi_note"] == 72
    physical_voices = [
        voice
        for voice in runtime.synth._voices.values()
        if voice.channel == 0 and voice.midi_note == 72
    ]
    assert len(physical_voices) == 1
    assert physical_voices[0].released is False
    assert all(
        voice.released
        for voice in runtime.synth._voices.values()
        if voice.channel > 15
    )
    runtime._handle_midi_event(
        {"type": "note_off", "channel": 0, "note": 72, "velocity": 0}
    )


def test_playback_preserves_original_midi_channels_for_overlapping_notes() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.target_notes = [
        ScoreNote(60, 0.0, 0.5, 90, channel=0),
        ScoreNote(60, 0.0, 0.5, 90, channel=1),
    ]

    runtime.start_playback("target")
    try:
        deadline = time.monotonic() + 0.5
        active = runtime.snapshot()["keyboard"]["active"]
        while len(active) < 2 and time.monotonic() < deadline:
            time.sleep(0.005)
            active = runtime.snapshot()["keyboard"]["active"]
        assert {note["channel"] for note in active} == {0, 1}
        assert {note["synth_channel"] for note in active} == {128, 129}
    finally:
        runtime.stop_playback()


def test_playback_pitch_bend_updates_synth_and_chord_frequency() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.target_notes = [ScoreNote(69, 0.0, 0.3, 100, channel=3)]
    runtime.target_pitch_bends = [PitchBendEvent(0.02, 3, 8191)]

    runtime.start_playback("target")
    try:
        deadline = time.monotonic() + 0.2
        active = runtime.snapshot()["keyboard"]["active"]
        while (
            (not active or active[0]["frequency_hz"] < 490)
            and time.monotonic() < deadline
        ):
            time.sleep(0.005)
            active = runtime.snapshot()["keyboard"]["active"]
        assert active[0]["frequency_hz"] == pytest.approx(
            440 * 2 ** ((2 * 8191 / 8192) / 12),
        )
        assert active[0]["synth_channel"] == 131
    finally:
        runtime.stop_playback()


def test_same_time_note_off_does_not_release_the_retriggered_voice() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.target_notes = [
        ScoreNote(60, 0.0, 0.05, 100),
        ScoreNote(60, 0.05, 0.3, 100),
    ]

    runtime.start_playback("target")
    try:
        time.sleep(0.09)
        active = runtime.snapshot()["keyboard"]["active"]
        assert len(active) == 1
        assert active[0]["midi_note"] == 60
        assert runtime.synth._voices[active[0]["voice_id"]].released is False
    finally:
        runtime.stop_playback()


def test_playback_voice_count_is_capped_for_malformed_or_extreme_midi() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.target_notes = [
        ScoreNote(60, 0.0, 0.5, 100)
        for _ in range(200)
    ]

    runtime.start_playback("target")
    try:
        deadline = time.monotonic() + 0.5
        while runtime.synth.status()["active_voice_count"] < 128 and time.monotonic() < deadline:
            time.sleep(0.005)
        assert len(runtime.snapshot()["keyboard"]["active"]) == 128
        assert runtime.synth.status()["active_voice_count"] == 128
    finally:
        runtime.stop_playback()


def test_custom_tuning_and_white_only_mapping() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.set_custom_tuning(17, 3.0, 60, 300.0)
    runtime.set_mapping({"mode": "white_only", "low": 60, "high": 72, "degree_step": 2})
    snapshot = runtime.snapshot()
    assert snapshot["tuning"]["divisions"] == 17
    black_key = next(key for key in snapshot["keyboard"]["keys"] if key["midi_note"] == 61)
    assert black_key["mapped"] is False
    assert runtime._map_physical_key(62).degree == 2


def test_frequency_analysis_has_low_frequency_resolution() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    analysis = runtime.synth.analysis_snapshot()
    assert analysis["schema_version"] == 9
    spectrum = analysis["spectrum"]
    low_frequencies = [point["frequency_hz"] for point in spectrum if point["frequency_hz"] < 100]
    assert low_frequencies[1] - low_frequencies[0] < 3.0
    assert "lissajous" not in analysis


def test_phase_snapshot_preserves_full_rate_final_output_samples() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.synth._monitor[-4:] = [
        [1.0, 3.0],
        [2.0, 4.0],
        [3.0, 5.0],
        [4.0, 6.0],
    ]
    runtime.synth._monitor_position = 0

    phase = runtime.synth.phase_snapshot(4)

    assert phase.dtype.name == "float32"
    assert phase.tolist() == [2.0, 3.0, 4.0, 5.0]
    assert runtime.synth.sample_rate_hz == 48000


def test_performance_can_be_restored_across_runtime_restart() -> None:
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    runtime.restore_performance(
        [
            {
                "midi_note": 55,
                "channel": 0,
                "velocity": 39,
                "start_seconds": 1.36,
                "duration_seconds": 0.67,
            }
        ]
    )
    assert runtime.snapshot()["performance"][0]["midi_note"] == 55


def test_additional_midi_tracks_are_not_limited_to_two_axes() -> None:
    midi = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.Message("note_on", note=48, velocity=80, time=0))
    track.append(mido.Message("note_off", note=48, velocity=0, time=240))
    stream = io.BytesIO()
    midi.save(file=stream)
    runtime = InstrumentRuntime("unused", audio_enabled=False)
    first_id, _ = runtime.load_track_midi(stream.getvalue(), "bass.mid")
    second_id, _ = runtime.load_track_midi(stream.getvalue(), "counterpoint.mid")
    assert first_id != second_id
    snapshot = runtime.snapshot()
    assert len(snapshot["tracks"]) == 4
    first_track = next(
        track for track in snapshot["tracks"] if track["id"] == first_id
    )
    assert first_track["compile_mode"] == KEY_POSITION
    assert first_track["source_timing"]["ticks_per_beat"] == 480
    assert first_track["notes"][0]["duration_ticks"] == 240
    runtime.delete_track(first_id)
    assert len(runtime.snapshot()["tracks"]) == 3
