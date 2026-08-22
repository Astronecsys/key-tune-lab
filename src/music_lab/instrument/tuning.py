from __future__ import annotations

import math
from dataclasses import asdict, dataclass, replace
from fractions import Fraction
from functools import lru_cache

from .tuning_space import (
    TuningSpace,
    equal_division_space,
    explicit_degree_space,
    parse_pitch_expression,
)


TRADITIONAL_NOTE_NAMES = (
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"
)


def key_label(midi_note: int) -> str:
    """Return a neutral hardware-key label with no pitch-name semantics."""
    return f"K{midi_note}"


def pitch_coordinate_label(equave: int, degree: int, divisions: int) -> str:
    """Describe a pitch relative to R0 without assuming a historical notation."""
    return f"R0[{equave}:{degree}]_{divisions}"


def traditional_pitch_alias(midi_pitch: int) -> str:
    """Return a C/D/E alias for the explicitly traditional 12-EDO view."""
    return (
        f"{TRADITIONAL_NOTE_NAMES[midi_pitch % 12]}"
        f"{midi_pitch // 12 - 1}"
    )


def _pow_fraction(base: int, exponent: int) -> Fraction:
    if exponent >= 0:
        return Fraction(base**exponent, 1)
    return Fraction(1, base ** (-exponent))


RELATION_PRIMES = (2, 3, 5, 7, 11)


def format_prime_vector(vector: dict[str, int]) -> str:
    terms = []
    for prime in map(str, RELATION_PRIMES):
        exponent = vector.get(prime, 0)
        if exponent:
            terms.append(f"{prime}^{exponent}")
    return " · ".join(terms) if terms else "1"


def ratio_from_prime_vector(vector: dict[str, int]) -> Fraction:
    ratio = Fraction(1, 1)
    for prime in RELATION_PRIMES:
        ratio *= _pow_fraction(prime, vector.get(str(prime), 0))
    return ratio


def _factor_limit(value: Fraction) -> dict[str, int] | None:
    numerator = value.numerator
    denominator = value.denominator
    vector = {str(prime): 0 for prime in RELATION_PRIMES}
    for prime in RELATION_PRIMES:
        while numerator % prime == 0:
            numerator //= prime
            vector[str(prime)] += 1
        while denominator % prime == 0:
            denominator //= prime
            vector[str(prime)] -= 1
    return vector if numerator == 1 and denominator == 1 else None


@lru_cache(maxsize=1)
def _relation_candidates() -> tuple[tuple[Fraction, dict[str, int]], ...]:
    candidates: dict[Fraction, dict[str, int]] = {}
    for exponent_3 in range(-6, 7):
        for exponent_5 in range(-4, 5):
            for exponent_7 in range(-3, 4):
                for exponent_11 in range(-2, 3):
                    ratio = (
                        _pow_fraction(3, exponent_3)
                        * _pow_fraction(5, exponent_5)
                        * _pow_fraction(7, exponent_7)
                        * _pow_fraction(11, exponent_11)
                    )
                    exponent_2 = 0
                    while ratio < 1:
                        ratio *= 2
                        exponent_2 += 1
                    while ratio >= 2:
                        ratio /= 2
                        exponent_2 -= 1
                    if ratio.numerator > 512 or ratio.denominator > 512:
                        continue
                    candidates[ratio] = {
                        "2": exponent_2,
                        "3": exponent_3,
                        "5": exponent_5,
                        "7": exponent_7,
                        "11": exponent_11,
                    }
    return tuple(candidates.items())


@lru_cache(maxsize=256)
def nearest_harmonic_ratio(target_ratio: float) -> tuple[Fraction, dict[str, int], float]:
    """Return the closest octave-normalized 11-limit relation and cents error."""
    if target_ratio <= 0:
        raise ValueError("target_ratio must be positive")
    while target_ratio < 1:
        target_ratio *= 2
    while target_ratio >= 2:
        target_ratio /= 2

    best: tuple[float, Fraction, dict[str, int]] | None = None
    for ratio, vector in _relation_candidates():
        error = 1200 * math.log2(target_ratio / float(ratio))
        candidate = (abs(error), ratio, vector)
        if best is None or candidate[0] < best[0]:
            best = candidate
    if best is None:
        raise RuntimeError("no 5-limit approximation found")
    return best[1], best[2], 1200 * math.log2(target_ratio / float(best[1]))


@dataclass(frozen=True)
class KeyPitch:
    midi_note: int
    key_label: str
    pitch_label: str
    traditional_alias: str | None
    degree: int
    equave: int
    frequency_hz: float
    ratio_from_reference: float
    ratio_label: str
    relationship_kind: str
    prime_vector: dict[str, int]
    prime_vector_label: str
    approximation_error_cents: float
    tuning_id: str
    tuning_name: str

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Tuning:
    id: str
    name: str
    description: str
    reference_midi: int
    reference_frequency_hz: float
    divisions: int
    ratios: tuple[Fraction, ...] | None = None
    equave_ratio: float = 2.0
    algebraic_basis: str | None = None
    space: TuningSpace | None = None
    reference_degree: int = 0
    traditional_alias_system: str | None = None
    definition: dict | None = None

    def __post_init__(self) -> None:
        if self.space is not None:
            if self.divisions != self.space.divisions:
                raise ValueError("tuning divisions must match its tuning space")
            return
        if self.ratios is not None:
            space = explicit_degree_space(
                id=self.id,
                name=self.name,
                description=self.description,
                degree_expressions=[
                    f"{ratio.numerator}/{ratio.denominator}"
                    for ratio in self.ratios
                ],
                equave_expression=f"{self.equave_ratio:g}",
                construction_kind="ratio_set",
            )
        else:
            equave_expression = self.algebraic_basis or f"{self.equave_ratio:g}"
            space = equal_division_space(
                id=self.id,
                name=self.name,
                description=self.description,
                divisions=self.divisions,
                equave_expression=equave_expression,
            )
        object.__setattr__(self, "space", space)

    def map_key(self, midi_note: int) -> KeyPitch:
        return self.map_relative(midi_note, midi_note - self.reference_midi)

    def with_reference(
        self,
        *,
        frequency_hz: float,
        midi_note: int | None = None,
        degree: int | None = None,
    ) -> Tuning:
        if frequency_hz <= 0:
            raise ValueError("reference frequency must be positive")
        reference_degree = self.reference_degree if degree is None else degree
        if not 0 <= reference_degree < self.divisions:
            raise ValueError("reference degree is outside the tuning space")
        return replace(
            self,
            reference_frequency_hz=frequency_hz,
            reference_midi=(self.reference_midi if midi_note is None else midi_note),
            reference_degree=reference_degree,
        )

    @property
    def uses_traditional_notation(self) -> bool:
        return self.traditional_alias_system == "western_12edo"

    def map_relative(self, physical_midi_note: int, relative: int) -> KeyPitch:
        assert self.space is not None
        absolute_step = self.reference_degree + relative
        equave, degree = divmod(absolute_step, self.divisions)
        degree_definition = self.space.degrees[degree]
        reference_definition = self.space.degrees[self.reference_degree]
        degree_ratio = degree_definition.ratio
        ratio_from_reference = (
            (self.equave_ratio**equave)
            * degree_ratio
            / reference_definition.ratio
        )
        frequency_hz = self.reference_frequency_hz * ratio_from_reference
        exact_ratio = _relative_exact_fraction(
            degree_definition.exact_fraction,
            reference_definition.exact_fraction,
            equave,
            self.space.equave_expression,
        )

        if exact_ratio is not None:
            ratio_label = f"{exact_ratio.numerator}/{exact_ratio.denominator}"
            vector = _factor_limit(exact_ratio) or {}
            error_cents = 0.0
            relationship_kind = "exact harmonic ratio"
        elif self.algebraic_basis:
            ratio_label = f"{self.algebraic_basis}^({relative}/{self.divisions})"
            vector = {}
            error_cents = 0.0
            relationship_kind = "exact algebraic relation"
        elif self.space.construction["kind"] == "generator_chain":
            generator_expression = self.space.construction[
                "generator_expression"
            ]
            generator_ratio, _ = parse_pitch_expression(generator_expression)
            coordinate_delta = (
                degree_definition.generator_coordinate
                - reference_definition.generator_coordinate
            )
            generator_component = generator_ratio**coordinate_delta
            equave_power = round(
                math.log(
                    ratio_from_reference / generator_component,
                    self.equave_ratio,
                )
            )
            components = []
            if coordinate_delta:
                components.append(
                    f"({generator_expression})^{coordinate_delta}"
                )
            if equave_power:
                components.append(
                    f"({self.space.equave_expression})^{equave_power}"
                )
            ratio_label = " · ".join(components) or "1/1"
            vector = {}
            error_cents = 0.0
            relationship_kind = "generated relation"
        else:
            approximation, vector, error_cents = nearest_harmonic_ratio(
                ratio_from_reference
            )
            ratio_label = f"≈ {approximation.numerator}/{approximation.denominator}"
            relationship_kind = "nearest 11-limit relation"

        return KeyPitch(
            midi_note=physical_midi_note,
            key_label=key_label(physical_midi_note),
            pitch_label=pitch_coordinate_label(equave, degree, self.divisions),
            traditional_alias=(
                traditional_pitch_alias(self.reference_midi + relative)
                if self.uses_traditional_notation
                else None
            ),
            degree=degree,
            equave=equave,
            frequency_hz=frequency_hz,
            ratio_from_reference=ratio_from_reference,
            ratio_label=ratio_label,
            relationship_kind=relationship_kind,
            prime_vector=vector,
            prime_vector_label=(ratio_label if self.algebraic_basis else format_prime_vector(vector)),
            approximation_error_cents=error_cents,
            tuning_id=self.id,
            tuning_name=self.name,
        )

    def map_ratio(
        self,
        physical_midi_note: int,
        ratio_from_reference: float,
        *,
        pitch_label: str,
        exact_ratio: Fraction | None = None,
    ) -> KeyPitch:
        assert self.space is not None
        if ratio_from_reference <= 0:
            raise ValueError("pitch ratio must be positive")
        frequency_hz = self.reference_frequency_hz * ratio_from_reference
        equave = math.floor(math.log(ratio_from_reference, self.equave_ratio))
        normalized = ratio_from_reference / (self.equave_ratio**equave)
        degree = min(
            range(self.divisions),
            key=lambda index: abs(
                math.log(self.space.degrees[index].ratio / normalized)
            ),
        )
        if exact_ratio is not None:
            vector = _factor_limit(exact_ratio) or {}
            ratio_label = f"{exact_ratio.numerator}/{exact_ratio.denominator}"
            relationship_kind = "exact harmonic lattice relation"
            error_cents = 0.0
        else:
            approximation, vector, error_cents = nearest_harmonic_ratio(
                ratio_from_reference
            )
            ratio_label = f"≈ {approximation.numerator}/{approximation.denominator}"
            relationship_kind = "generated lattice relation"
        return KeyPitch(
            midi_note=physical_midi_note,
            key_label=key_label(physical_midi_note),
            pitch_label=pitch_label,
            traditional_alias=None,
            degree=degree,
            equave=equave,
            frequency_hz=frequency_hz,
            ratio_from_reference=ratio_from_reference,
            ratio_label=ratio_label,
            relationship_kind=relationship_kind,
            prime_vector=vector,
            prime_vector_label=format_prime_vector(vector),
            approximation_error_cents=error_cents,
            tuning_id=self.id,
            tuning_name=self.name,
        )

    def summary(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "divisions": self.divisions,
            "reference_midi": self.reference_midi,
            "reference_frequency_hz": self.reference_frequency_hz,
            "equave_ratio": self.equave_ratio,
            "algebraic_basis": self.algebraic_basis,
            "uses_traditional_notation": self.uses_traditional_notation,
            "reference_degree": self.reference_degree,
            "space": self.space.to_dict(),
            "definition": self.definition,
        }


def _relative_exact_fraction(
    degree: Fraction | None,
    reference: Fraction | None,
    equave: int,
    equave_expression: str,
) -> Fraction | None:
    if degree is None or reference is None:
        return None
    try:
        equave_fraction = Fraction(equave_expression)
    except ValueError:
        return None
    return (equave_fraction**equave) * degree / reference


def get_tuning(tuning_id: str) -> Tuning:
    from .tuning_library import tuning_library

    return tuning_library().get(tuning_id)


def available_tunings() -> list[dict]:
    from .tuning_library import tuning_library

    return tuning_library().summaries()
