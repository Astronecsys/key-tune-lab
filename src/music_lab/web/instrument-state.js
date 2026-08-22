export const INSTRUMENT_SCHEMA_VERSION = 9;
const MINIMUM_COMPATIBLE_SCHEMA_VERSION = 8;

function requireCompatiblePayload(payload, label) {
  if (!payload || typeof payload !== "object") {
    throw new Error(`${label} 不是有效对象`);
  }
  if (
    payload.schema_version < MINIMUM_COMPATIBLE_SCHEMA_VERSION
    || payload.schema_version > INSTRUMENT_SCHEMA_VERSION
  ) {
    throw new Error(
      `${label} 数据版本不兼容：需要 ${MINIMUM_COMPATIBLE_SCHEMA_VERSION}–${INSTRUMENT_SCHEMA_VERSION}，收到 ${payload.schema_version ?? "未知"}`,
    );
  }
  return payload;
}

export function replaceSnapshot(uiState, payload) {
  uiState.snapshot = requireCompatiblePayload(payload, "完整状态");
  return uiState.snapshot;
}

export function mergeLiveSnapshot(uiState, payload) {
  const live = requireCompatiblePayload(payload, "实时状态");
  const snapshot = uiState.snapshot;
  if (!snapshot) throw new Error("尚未载入完整状态");
  snapshot.midi = live.midi;
  snapshot.audio = live.audio;
  snapshot.keyboard.active = live.keyboard_active;
  snapshot.recording = live.recording;
  snapshot.record_elapsed_seconds = live.record_elapsed_seconds;
  snapshot.performance = live.performance;
  snapshot.last_control_change = live.last_control_change;
  snapshot.playback = live.playback;
  snapshot.chord = live.chord;
  const performanceTrack = snapshot.tracks.find((track) => track.id === "performance");
  if (performanceTrack) {
    performanceTrack.name = live.performance_name;
    performanceTrack.notes = live.performance;
  }
  return snapshot;
}

export function replaceAnalysis(uiState, payload) {
  uiState.analysis = requireCompatiblePayload(payload, "分析状态");
  return uiState.analysis;
}
