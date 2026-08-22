export function delayedPhasePoints(samples, sampleRateHz, delayMs) {
  if (!Array.isArray(samples) || samples.length < 2) return [];
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return [];
  const mono = samples.map((sample) => (
    Array.isArray(sample)
      ? (Number(sample?.[0]) + Number(sample?.[1])) / 2
      : Number(sample)
  ));
  const requestedDelay = Math.round(Number(delayMs) * sampleRateHz / 1000);
  const delaySamples = Math.max(1, Math.min(mono.length - 1, requestedDelay));
  return mono.slice(delaySamples).map((value, index) => ({
    x:value,
    y:mono[index],
  }));
}
