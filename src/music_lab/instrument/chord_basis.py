from __future__ import annotations

import math
from collections.abc import Iterable

from .tuning import RELATION_PRIMES, nearest_harmonic_ratio, ratio_from_prime_vector

_RELATION_ERROR_WEIGHT = 4000.0
_FUNDAMENTAL_TOLERANCE = math.log(1.01)
_MAX_FUNDAMENTAL_PARTIAL = 16


def _unique_pitches(active: Iterable[dict]) -> list[dict]:
    unique: list[dict] = []
    for pitch in sorted(active, key=lambda item: item["frequency_hz"]):
        if unique and math.isclose(
            pitch["frequency_hz"],
            unique[-1]["frequency_hz"],
            rel_tol=1e-9,
        ):
            continue
        unique.append(pitch)
    return unique


def _relation_cost(ratio: float, tuning) -> tuple[float, float]:  # noqa: ANN001
    if tuning.algebraic_basis:
        lattice_steps = math.log(ratio, tuning.equave_ratio) * tuning.divisions
        nearest_step = round(lattice_steps)
        approximation = tuning.equave_ratio ** (nearest_step / tuning.divisions)
        return abs(math.log(ratio / approximation)), abs(nearest_step)

    normalized = ratio
    equaves = 0
    while normalized < 1:
        normalized *= 2
        equaves -= 1
    while normalized >= 2:
        normalized /= 2
        equaves += 1
    _, vector, _ = nearest_harmonic_ratio(normalized)
    vector = dict(vector)
    vector["2"] = vector.get("2", 0) + equaves
    approximation = float(ratio_from_prime_vector(vector))
    relation_error = abs(math.log(ratio / approximation))
    complexity = sum(
        abs(vector.get(str(prime), 0)) * math.log(prime)
        for prime in RELATION_PRIMES
    )
    return relation_error, complexity


def select_simplest_basis(active: Iterable[dict], tuning) -> dict | None:  # noqa: ANN001
    pitches = _unique_pitches(active)
    if not pitches:
        return None
    candidates: list[tuple[float, float, dict]] = []
    for basis in pitches:
        relation_error = 0.0
        complexity = 0.0
        for pitch in pitches:
            error, cost = _relation_cost(
                pitch["frequency_hz"] / basis["frequency_hz"],
                tuning,
            )
            relation_error += error
            complexity += cost
        score = complexity + relation_error * _RELATION_ERROR_WEIGHT
        candidates.append((score, basis["frequency_hz"], basis))
    score, _, basis = min(candidates, key=lambda item: (item[0], item[1]))
    return dict(basis) | {
        "origin": "auto_simple",
        "sounding": True,
        "_auto_key": ("simple", basis["midi_note"]),
        "auto": {
            "strategy": "simple",
            "score": score / len(pitches),
            "coverage": len(pitches),
            "tone_count": len(pitches),
            "model": "tuning_relation",
        },
    }


def _extended_timbre_multiples(partials: Iterable[tuple[float, float]]) -> tuple[float, ...]:
    multiples = sorted(
        {
            float(multiple)
            for multiple, amplitude in partials
            if amplitude > 0 and 1 <= multiple <= 32
        }
    )
    if len(multiples) >= 3:
        log_steps = [
            math.log(current / previous)
            for previous, current in zip(multiples, multiples[1:])
        ]
        if max(log_steps) - min(log_steps) < 1e-6:
            generator = math.exp(sum(log_steps) / len(log_steps))
            while multiples[-1] * generator <= 32:
                multiples.append(multiples[-1] * generator)
    return tuple(multiples or [1.0])


def _nearest_multiplier(value: float, multiples: tuple[float, ...]) -> float:
    return min(multiples, key=lambda multiple: (abs(math.log(value / multiple)), multiple))


def _fundamental_candidate(
    frequencies: tuple[float, ...],
    seed: float,
    multiples: tuple[float, ...],
    model: str,
) -> dict:
    basis = seed
    assignments: tuple[float, ...] = ()
    for _ in range(2):
        assignments = tuple(
            _nearest_multiplier(frequency / basis, multiples)
            for frequency in frequencies
        )
        basis = math.exp(
            sum(
                math.log(frequency / multiple)
                for frequency, multiple in zip(frequencies, assignments)
            )
            / len(frequencies)
        )
        basis = min(basis, frequencies[0])
    assignments = tuple(
        _nearest_multiplier(frequency / basis, multiples)
        for frequency in frequencies
    )
    errors = tuple(
        abs(math.log((frequency / basis) / multiple))
        for frequency, multiple in zip(frequencies, assignments)
    )
    coverage = sum(error <= _FUNDAMENTAL_TOLERANCE for error in errors)
    fit_cost = sum((error / _FUNDAMENTAL_TOLERANCE) ** 2 for error in errors)
    complexity = sum(math.log1p(multiple) for multiple in assignments) / len(assignments)
    score = fit_cost + (len(frequencies) - coverage) * 12 + complexity * 0.18
    return {
        "frequency_hz": basis,
        "score": score,
        "coverage": coverage,
        "assignments": assignments,
        "model": model,
    }


def infer_common_fundamental(
    active: Iterable[dict],
    reference_frequency_hz: float,
    timbre_partials: Iterable[tuple[float, float]],
) -> dict | None:
    pitches = _unique_pitches(active)
    if not pitches:
        return None
    frequencies = tuple(pitch["frequency_hz"] for pitch in pitches)
    harmonic = tuple(float(value) for value in range(1, _MAX_FUNDAMENTAL_PARTIAL + 1))
    timbre = _extended_timbre_multiples(timbre_partials)
    models = [("integer_partials", harmonic)]
    if timbre != harmonic[: len(timbre)]:
        models.insert(0, ("timbre_partials", timbre))

    candidates: list[dict] = []
    for model, multiples in models:
        seeds = {
            round(math.log(frequency / multiple), 10)
            for frequency in frequencies
            for multiple in multiples
            if frequencies[0] / 32 <= frequency / multiple <= frequencies[0] * 1.01
        }
        candidates.extend(
            _fundamental_candidate(
                frequencies,
                math.exp(seed),
                multiples,
                model,
            )
            for seed in seeds
        )
    best = min(
        candidates,
        key=lambda candidate: (
            candidate["score"],
            -candidate["frequency_hz"],
            candidate["model"],
        ),
    )
    sounding = next(
        (
            pitch
            for pitch in pitches
            if math.isclose(
                pitch["frequency_hz"],
                best["frequency_hz"],
                rel_tol=1e-7,
            )
        ),
        None,
    )
    auto = {
        "strategy": "fundamental",
        "score": best["score"] / len(pitches),
        "coverage": best["coverage"],
        "tone_count": len(pitches),
        "model": best["model"],
    }
    auto_key = (
        "fundamental",
        best["model"],
        tuple(round(value, 8) for value in best["assignments"]),
    )
    if sounding is not None:
        return dict(sounding) | {
            "origin": "auto_fundamental",
            "sounding": True,
            "_auto_key": auto_key,
            "_relation_frequencies": frequencies,
            "_relation_multipliers": best["assignments"],
            "auto": auto,
        }
    ratio = best["frequency_hz"] / reference_frequency_hz
    return {
        "midi_note": None,
        "key_label": None,
        "pitch_label": f"AF[T×{ratio:.8g}]",
        "traditional_alias": None,
        "degree": None,
        "equave": None,
        "frequency_hz": best["frequency_hz"],
        "origin": "auto_fundamental",
        "sounding": False,
        "_auto_key": auto_key,
        "_relation_frequencies": frequencies,
        "_relation_multipliers": best["assignments"],
        "auto": auto,
    }


def select_composite_basis(
    active: Iterable[dict],
    tuning,  # noqa: ANN001
    reference_frequency_hz: float,
    timbre_partials: Iterable[tuple[float, float]],
) -> dict | None:
    """Choose between a sounding simple relation and a constrained virtual root."""
    pitches = _unique_pitches(active)
    if not pitches:
        return None
    simple = select_simplest_basis(pitches, tuning)
    fundamental = infer_common_fundamental(
        pitches,
        reference_frequency_hz,
        timbre_partials,
    )
    candidates: list[tuple[float, int, dict, str]] = []
    if simple is not None:
        candidates.append(
            (
                float(simple["auto"]["score"]),
                0,
                simple,
                "sounding_relation",
            )
        )
    if fundamental is not None:
        auto = fundamental["auto"]
        missing = max(0, int(auto["tone_count"]) - int(auto["coverage"]))
        multipliers = tuple(fundamental.get("_relation_multipliers") or ())
        partial_complexity = (
            sum(math.log2(max(1.0, value)) for value in multipliers)
            / len(multipliers)
            if multipliers
            else 0.0
        )
        depth = max(
            0.0,
            math.log(pitches[0]["frequency_hz"] / fundamental["frequency_hz"]),
        )
        virtual_penalty = 0.45 if not fundamental["sounding"] else 0.0
        score = (
            float(auto["score"])
            + missing * 3.0
            + virtual_penalty
            + depth * 0.08
            + partial_complexity * 1.3
        )
        candidates.append(
            (
                score,
                1 if not fundamental["sounding"] else 0,
                fundamental,
                str(auto["model"]),
            )
        )
    score, _, selected, selected_model = min(
        candidates,
        key=lambda item: (item[0], item[1], -item[2]["frequency_hz"]),
    )
    selected_auto = selected["auto"]
    return dict(selected) | {
        "origin": "auto_composite",
        "_auto_key": ("composite", selected.get("_auto_key")),
        "auto": {
            "strategy": "composite",
            "score": score,
            "coverage": selected_auto["coverage"],
            "tone_count": selected_auto["tone_count"],
            "model": f"composite_{selected_model}",
            "candidate_count": len(candidates),
        },
    }
