export const RELATION_PRIMES = Object.freeze([2, 3, 5, 7, 11]);
const LISSAJOUS_NEAR_CLOSED_LOG_ERROR = 2e-4;
const LISSAJOUS_CLOSED_TURN_ERROR = 1e-7;
const LISSAJOUS_AUTO_CLOSE_MAX_CYCLES = 8;
const LISSAJOUS_NORMALIZED_PATH_LENGTH = 16;

export function tonesHighToLow(tones) {
  return [...tones].sort((first, second) => second.frequency_hz - first.frequency_hz);
}

export function pitchIdentityLabel(pitch) {
  if (!pitch?.pitch_label) return "—";
  return pitch.traditional_alias
    ? `${pitch.traditional_alias} · ${pitch.pitch_label}`
    : pitch.pitch_label;
}

export function compactPitchIdentityLabel(pitch, divisions) {
  if (!pitch?.pitch_label) return "—";
  return pitch.traditional_alias
    || `[${pitch.equave}:${pitch.degree}]_${divisions}`;
}

export function relationshipColumns(tone) {
  const isAlgebraic = tone.relationship_kind === "exact algebraic relation"
    || tone.relationship_kind?.includes("timbre-partial");
  return {
    primeExponents: RELATION_PRIMES.map((prime) => isAlgebraic
      ? "—"
      : String(tone.prime_vector?.[String(prime)] ?? 0)),
    algebraicRelation: isAlgebraic ? tone.prime_vector_label : "—",
  };
}

export function approximateFrequencyRatio(value, maxDenominator = 24) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("frequency ratio must be positive");
  }
  let best = {numerator:Math.round(value), denominator:1, error:Infinity};
  for (let denominator = 1; denominator <= maxDenominator; denominator += 1) {
    const numerator = Math.max(1, Math.round(value * denominator));
    const error = Math.abs(value - numerator / denominator);
    if (error < best.error) best = {numerator, denominator, error};
  }
  return best;
}

export function lissajousTraceWindow(
  ratio,
  timeSeconds,
  {trailScale = 1, driftCyclesPerSecond = 0.25, autoClose = true} = {},
) {
  const rational = approximateFrequencyRatio(ratio);
  const rationalValue = rational.numerator / rational.denominator;
  const nearClosed = Math.abs(Math.log(ratio / rationalValue))
    < LISSAJOUS_NEAR_CLOSED_LOG_ERROR;
  const resolvedScale = Number.isFinite(Number(trailScale))
    ? Math.max(0.25, Math.min(4, Number(trailScale)))
    : 1;
  const shouldAutoClose = Boolean(autoClose)
    && nearClosed
    && rational.denominator <= LISSAJOUS_AUTO_CLOSE_MAX_CYCLES;
  const rootCycles = shouldAutoClose
    ? rational.denominator
    : Math.max(
      0.25,
      LISSAJOUS_NORMALIZED_PATH_LENGTH
        * resolvedScale
        / Math.sqrt(1 + ratio * ratio),
    );
  const endpointTurnError = Math.abs(
    rootCycles * ratio - Math.round(rootCycles * ratio),
  );
  const closed = shouldAutoClose
    && endpointTurnError < LISSAJOUS_CLOSED_TURN_ERROR;
  const resolvedSpeed = Number(driftCyclesPerSecond);
  return {
    rational,
    rootCycles,
    closed,
    phaseOffset:closed
      ? 0
      : timeSeconds * Math.PI * 2 * (
        Number.isFinite(resolvedSpeed) ? resolvedSpeed : 0.25
      ),
  };
}
