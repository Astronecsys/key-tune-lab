from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from fractions import Fraction


_POWER_PATTERN = re.compile(r"^(.+)\^\((-?\d+)/(\d+)\)$")
_SQRT_PATTERN = re.compile(r"^sqrt\((\d+(?:\.\d+)?)\)$")


def parse_pitch_expression(expression: str) -> tuple[float, Fraction | None]:
    """Parse the deliberately small exact-expression language used by the UI."""
    text = expression.strip().replace(" ", "")
    text = re.sub(r"√(\d+(?:\.\d+)?)", r"sqrt(\1)", text)
    if not text:
        raise ValueError("pitch expression cannot be empty")

    power_match = _POWER_PATTERN.fullmatch(text)
    if power_match:
        base, _ = parse_pitch_expression(power_match.group(1))
        numerator = int(power_match.group(2))
        denominator = int(power_match.group(3))
        if denominator == 0:
            raise ValueError("pitch exponent denominator cannot be zero")
        value = base ** (numerator / denominator)
        return value, None

    sqrt_match = _SQRT_PATTERN.fullmatch(text)
    if sqrt_match:
        return math.sqrt(float(sqrt_match.group(1))), None

    try:
        fraction = Fraction(text)
    except (ValueError, ZeroDivisionError) as error:
        raise ValueError(f"unsupported pitch expression {expression!r}") from error
    if fraction <= 0:
        raise ValueError("pitch expressions must be positive")
    return float(fraction), fraction


@dataclass(frozen=True)
class PitchDegree:
    id: str
    index: int
    ratio: float
    expression: str
    generator_coordinate: int | None = None
    exact_fraction: Fraction | None = None

    def to_dict(self, equave_ratio: float) -> dict:
        payload = asdict(self)
        payload.pop("exact_fraction")
        payload["normalized_position"] = math.log(
            self.ratio, equave_ratio
        )
        return payload


@dataclass(frozen=True)
class TuningSpace:
    id: str
    name: str
    description: str
    equave_ratio: float
    equave_expression: str
    degrees: tuple[PitchDegree, ...]
    construction: dict

    @property
    def divisions(self) -> int:
        return len(self.degrees)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "equave_ratio": self.equave_ratio,
            "equave_expression": self.equave_expression,
            "degree_count": self.divisions,
            "degrees": [
                degree.to_dict(self.equave_ratio) for degree in self.degrees
            ],
            "construction": dict(self.construction),
        }


def equal_division_space(
    *,
    id: str,
    name: str,
    description: str,
    divisions: int,
    equave_expression: str = "2",
) -> TuningSpace:
    if not 1 <= divisions <= 256:
        raise ValueError("divisions must be between 1 and 256")
    equave_ratio, _ = parse_pitch_expression(equave_expression)
    if not 1.000001 <= equave_ratio <= 16:
        raise ValueError("equave ratio must be between 1.000001 and 16")
    degrees = tuple(
        PitchDegree(
            id=f"d{index}",
            index=index,
            ratio=equave_ratio ** (index / divisions),
            expression=f"{equave_expression}^({index}/{divisions})",
            generator_coordinate=index,
        )
        for index in range(divisions)
    )
    return TuningSpace(
        id=id,
        name=name,
        description=description,
        equave_ratio=equave_ratio,
        equave_expression=equave_expression,
        degrees=degrees,
        construction={
            "kind": "equal_division",
            "divisions": divisions,
            "equave_expression": equave_expression,
        },
    )


def explicit_degree_space(
    *,
    id: str,
    name: str,
    description: str,
    degree_expressions: list[str] | tuple[str, ...],
    equave_expression: str = "2",
    construction_kind: str = "explicit",
) -> TuningSpace:
    equave_ratio, equave_exact = parse_pitch_expression(equave_expression)
    parsed: list[tuple[float, str, Fraction | None]] = []
    for expression in degree_expressions:
        ratio, exact = parse_pitch_expression(expression)
        normalized = _normalize_ratio(ratio, equave_ratio)
        normalized_exact = (
            _normalize_exact_fraction(exact, equave_exact)
            if exact is not None and equave_exact is not None
            else None
        )
        parsed.append((normalized, expression.strip(), normalized_exact))
    parsed.sort(key=lambda item: item[0])
    if not parsed or not math.isclose(parsed[0][0], 1.0, rel_tol=1e-9):
        parsed.insert(0, (1.0, "1/1", Fraction(1, 1)))
    _reject_duplicate_degrees(parsed)
    degrees = tuple(
        PitchDegree(
            id=f"d{index}",
            index=index,
            ratio=ratio,
            expression=expression,
            exact_fraction=exact,
        )
        for index, (ratio, expression, exact) in enumerate(parsed)
    )
    return TuningSpace(
        id=id,
        name=name,
        description=description,
        equave_ratio=equave_ratio,
        equave_expression=equave_expression,
        degrees=degrees,
        construction={
            "kind": construction_kind,
            "degree_expressions": [degree.expression for degree in degrees],
            "equave_expression": equave_expression,
        },
    )


def generator_chain_space(
    *,
    id: str,
    name: str,
    description: str,
    generator_expression: str,
    degree_count: int,
    chain_start: int,
    equave_expression: str = "2",
) -> TuningSpace:
    if not 1 <= degree_count <= 256:
        raise ValueError("degree count must be between 1 and 256")
    equave_ratio, equave_exact = parse_pitch_expression(equave_expression)
    generator_ratio, generator_exact = parse_pitch_expression(
        generator_expression
    )
    generated: list[tuple[float, str, int, Fraction | None]] = []
    for coordinate in range(chain_start, chain_start + degree_count):
        ratio = _normalize_ratio(generator_ratio**coordinate, equave_ratio)
        raw_exact = (
            generator_exact**coordinate
            if generator_exact is not None
            else None
        )
        exact = (
            _normalize_exact_fraction(raw_exact, equave_exact)
            if raw_exact is not None and equave_exact is not None
            else None
        )
        generated.append(
            (
                ratio,
                f"{generator_expression}^{coordinate} mod {equave_expression}",
                coordinate,
                exact,
            )
        )
    generated.sort(key=lambda item: item[0])
    _reject_duplicate_degrees(
        [(ratio, expression, exact) for ratio, expression, _, exact in generated]
    )
    degrees = tuple(
        PitchDegree(
            id=f"g{coordinate}",
            index=index,
            ratio=ratio,
            expression=expression,
            generator_coordinate=coordinate,
            exact_fraction=exact,
        )
        for index, (ratio, expression, coordinate, exact) in enumerate(generated)
    )
    return TuningSpace(
        id=id,
        name=name,
        description=description,
        equave_ratio=equave_ratio,
        equave_expression=equave_expression,
        degrees=degrees,
        construction={
            "kind": "generator_chain",
            "generator_expression": generator_expression,
            "degree_count": degree_count,
            "chain_start": chain_start,
            "equave_expression": equave_expression,
        },
    )


def interval_cycle_space(
    *,
    id: str,
    name: str,
    description: str,
    interval_expressions: list[str] | tuple[str, ...],
    equave_expression: str = "2",
) -> TuningSpace:
    """Build ordered scale degrees from one complete cycle of adjacent steps."""
    if not 1 <= len(interval_expressions) <= 256:
        raise ValueError("an interval cycle must contain between 1 and 256 steps")
    equave_ratio, equave_exact = parse_pitch_expression(equave_expression)
    cumulative = 1.0
    cumulative_exact: Fraction | None = Fraction(1, 1)
    degrees: list[PitchDegree] = []
    normalized_intervals: list[str] = []
    for index, raw_expression in enumerate(interval_expressions):
        expression = str(raw_expression).strip()
        interval_ratio, interval_exact = parse_pitch_expression(expression)
        if interval_ratio <= 1:
            raise ValueError("interval-cycle steps must be greater than one")
        if index:
            if cumulative >= equave_ratio or math.isclose(
                cumulative, equave_ratio, rel_tol=1e-9, abs_tol=1e-12
            ):
                raise ValueError("interval cycle reaches the equave before its final step")
        degrees.append(
            PitchDegree(
                id=f"d{index}",
                index=index,
                ratio=cumulative,
                expression=(
                    "1/1"
                    if index == 0
                    else f"product(intervals[0:{index}])"
                ),
                generator_coordinate=index,
                exact_fraction=cumulative_exact,
            )
        )
        cumulative *= interval_ratio
        cumulative_exact = (
            cumulative_exact * interval_exact
            if cumulative_exact is not None and interval_exact is not None
            else None
        )
        normalized_intervals.append(expression)
    if not math.isclose(cumulative, equave_ratio, rel_tol=1e-7, abs_tol=1e-10):
        raise ValueError(
            "interval cycle does not close at the equave: "
            f"product={cumulative:.12g}, equave={equave_ratio:.12g}"
        )
    if cumulative_exact is not None and equave_exact is not None:
        if cumulative_exact != equave_exact:
            raise ValueError("exact interval cycle does not equal the exact equave")
    return TuningSpace(
        id=id,
        name=name,
        description=description,
        equave_ratio=equave_ratio,
        equave_expression=equave_expression,
        degrees=tuple(degrees),
        construction={
            "kind": "interval_cycle",
            "interval_expressions": normalized_intervals,
            "equave_expression": equave_expression,
        },
    )


def lattice_space(
    *,
    id: str,
    name: str,
    description: str,
    basis_expressions: tuple[str, ...],
    equave_expression: str = "2",
) -> TuningSpace:
    equave_ratio, _ = parse_pitch_expression(equave_expression)
    basis = []
    for expression in basis_expressions:
        ratio, _ = parse_pitch_expression(expression)
        normalized = _normalize_ratio(ratio, equave_ratio)
        basis.append(
            {
                "expression": expression,
                "ratio": ratio,
                "normalized_ratio": normalized,
                "normalized_position": math.log(normalized, equave_ratio),
            }
        )
    return TuningSpace(
        id=id,
        name=name,
        description=description,
        equave_ratio=equave_ratio,
        equave_expression=equave_expression,
        degrees=(
            PitchDegree(
                id="origin",
                index=0,
                ratio=1.0,
                expression="1/1",
                exact_fraction=Fraction(1, 1),
            ),
        ),
        construction={
            "kind": "generator_lattice",
            "basis_expressions": list(basis_expressions),
            "basis": basis,
            "equave_expression": equave_expression,
        },
    )


def _normalize_ratio(ratio: float, equave_ratio: float) -> float:
    if not math.isfinite(ratio) or ratio <= 0:
        raise ValueError("pitch ratios must be finite and positive")
    exponent = math.floor(math.log(ratio, equave_ratio))
    normalized = ratio / (equave_ratio**exponent)
    if normalized >= equave_ratio and math.isclose(
        normalized, equave_ratio, rel_tol=1e-10
    ):
        return 1.0
    return normalized


def _normalize_exact_fraction(
    ratio: Fraction,
    equave: Fraction,
) -> Fraction:
    if equave <= 1:
        raise ValueError("equave ratio must be greater than one")
    while ratio < 1:
        ratio *= equave
    while ratio >= equave:
        ratio /= equave
    return ratio


def _reject_duplicate_degrees(
    parsed: list[tuple[float, str, Fraction | None]],
) -> None:
    for first, second in zip(parsed, parsed[1:]):
        if math.isclose(first[0], second[0], rel_tol=1e-9, abs_tol=1e-12):
            raise ValueError(
                f"duplicate pitch degrees {first[1]!r} and {second[1]!r}"
            )
