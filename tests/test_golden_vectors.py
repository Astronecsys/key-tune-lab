from __future__ import annotations

import json
import math
from pathlib import Path

from music_lab.instrument.chord_basis import select_simplest_basis
from music_lab.instrument.tuning import get_tuning
from music_lab.instrument.tuning_compiler import compile_midi_pitch
from music_lab.instrument.tuning_space import parse_pitch_expression

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "domain" / "golden-v1.json"


def _fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def test_pitch_expression_golden_vectors() -> None:
    fixture = _fixture()
    tolerance = fixture["relative_tolerance"]
    for vector in fixture["pitch_expressions"]:
        value, exact = parse_pitch_expression(vector["expression"])
        assert math.isclose(value, vector["value"], rel_tol=tolerance)
        if vector["exact_numerator"] is None:
            assert exact is None
        else:
            assert str(exact.numerator) == vector["exact_numerator"]
            assert str(exact.denominator) == vector["exact_denominator"]


def test_tuning_and_compilation_golden_vectors() -> None:
    fixture = _fixture()
    tolerance = fixture["relative_tolerance"]
    for vector in fixture["tuning_pitches"]:
        pitch = get_tuning(vector["tuning_id"]).map_key(vector["midi_note"])
        assert pitch.degree == vector["degree"]
        assert pitch.equave == vector["equave"]
        assert pitch.pitch_label == vector["pitch_label"]
        assert math.isclose(pitch.frequency_hz, vector["frequency_hz"], rel_tol=tolerance)
    for vector in fixture["compilation"]:
        compiled = compile_midi_pitch(
            get_tuning(vector["tuning_id"]),
            vector["midi_note"],
            vector["mode"],
        )
        assert compiled.pitch_intent["kind"] == vector["intent_kind"]
        assert math.isclose(
            compiled.pitch.frequency_hz,
            vector["frequency_hz"],
            rel_tol=tolerance,
        )


def test_chord_basis_golden_vector() -> None:
    vector = _fixture()["simplest_chord_basis"]
    basis = select_simplest_basis(vector["active"], get_tuning(vector["tuning_id"]))
    assert basis is not None
    assert basis["midi_note"] == vector["expected_midi_note"]
    assert basis["frequency_hz"] == vector["expected_frequency_hz"]
    assert basis["auto"]["coverage"] == vector["expected_coverage"]
