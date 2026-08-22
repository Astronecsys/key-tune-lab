const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export const SPECTRUM_AFTERGLOW_NOISE_FLOOR = 0.025;

export function createSpectrumMemory() {
  return {
    frequencies:[],
    peaks:[],
    exposure:[],
    lastUpdateMs:null,
  };
}

export function updateSpectrumMemoryFrame(memory, points, {
  nowMs,
  halfLifeSeconds = 5,
  burnGain = 1,
  rms = 0,
  peak = 0,
} = {}) {
  const frequenciesChanged = memory.frequencies.length !== points.length
    || points.some((point, index) => (
      Math.abs(point.frequency_hz - memory.frequencies[index]) > 0.01
    ));
  if (frequenciesChanged) {
    memory.frequencies = points.map((point) => point.frequency_hz);
    memory.peaks = points.map(() => 0);
    memory.exposure = points.map(() => 0);
    memory.lastUpdateMs = null;
  }

  const timestamp = Number.isFinite(nowMs) ? nowMs : 0;
  const elapsedSeconds = memory.lastUpdateMs === null
    ? 0.07
    : Math.max(0.001, Math.min(60, (timestamp - memory.lastUpdateMs) / 1000));
  const sampledSeconds = Math.min(0.25, elapsedSeconds);
  const safeHalfLife = Math.max(0.25, Number(halfLifeSeconds) || 5);
  const safeBurnGain = Math.max(0.1, Math.min(8, Number(burnGain) || 1));
  const exposureDecay = 2 ** (-elapsedSeconds / safeHalfLife);
  const loudnessScale = Math.sqrt(Math.min(
    1,
    Math.max(clamp01(rms) * 8, clamp01(peak) * 2.5),
  ));
  memory.lastUpdateMs = timestamp;

  points.forEach((point, index) => {
    const perceivedLevel = clamp01(Math.sqrt(clamp01(point.level)) * loudnessScale);
    const current = perceivedLevel >= SPECTRUM_AFTERGLOW_NOISE_FLOOR
      ? perceivedLevel
      : 0;
    const fadedExposure = memory.exposure[index] * exposureDecay;
    memory.peaks[index] = fadedExposure < 0.005
      ? current
      : Math.max(current, memory.peaks[index]);

    const impulseStrength = current ** 0.7;
    const impulse = 1 - Math.exp(
      -impulseStrength * (0.18 + sampledSeconds * 2.2) * safeBurnGain,
    );
    memory.exposure[index] = 1 - (1 - fadedExposure) * (1 - impulse);
    if (memory.exposure[index] < 0.005 && current === 0) {
      memory.peaks[index] = 0;
    }
  });
  return memory;
}

export function spectrumAfterglowBrightness(exposure) {
  return clamp01(exposure) ** 0.55;
}

export function spectrumAfterglowColumns(memory, points, {
  columnCount,
  minimumFrequency = 20,
  maximumFrequency = 12000,
} = {}) {
  const count = Math.max(1, Math.floor(Number(columnCount) || 1));
  if (!points.length || memory.frequencies.length !== points.length) {
    return Array.from({length:count}, () => ({brightness:0, peak:0}));
  }
  const ratio = maximumFrequency / minimumFrequency;
  let pointIndex = 0;
  return Array.from({length:count}, (_, columnIndex) => {
    const position = count === 1 ? 0 : columnIndex / (count - 1);
    const targetFrequency = minimumFrequency * (ratio ** position);
    while (
      pointIndex < points.length - 1
      && Math.abs(Math.log(points[pointIndex + 1].frequency_hz / targetFrequency))
        <= Math.abs(Math.log(points[pointIndex].frequency_hz / targetFrequency))
    ) pointIndex += 1;
    const exposure = memory.exposure[pointIndex] || 0;
    const peak = memory.peaks[pointIndex] || 0;
    return {
      brightness:spectrumAfterglowBrightness(exposure)
        * (0.3 + 0.7 * Math.sqrt(clamp01(peak))),
      peak,
    };
  });
}
