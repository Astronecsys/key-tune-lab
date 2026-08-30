import { requestFloat32, requestJson } from "./api-client.js";

const jsonBody = (payload) => ({
  headers:{"Content-Type":"application/json"},
  body:JSON.stringify(payload),
});

/**
 * 浏览器与乐器运行时之间唯一的传输边界。
 *
 * 面板不应知道 URL 或 FastAPI 的存在。未来若增加浏览器内运行时，只需实现
 * 相同方法，而不必修改任何面板渲染与交互代码。
 */
export class FastApiInstrumentClient {
  constructor({
    requestJsonImpl = requestJson,
    requestFloat32Impl = requestFloat32,
    locationRef = globalThis.location,
    WebSocketImpl = globalThis.WebSocket,
  } = {}) {
    this.requestJson = requestJsonImpl;
    this.requestFloat32 = requestFloat32Impl;
    this.location = locationRef;
    this.WebSocket = WebSocketImpl;
  }

  state() { return this.requestJson("/api/state"); }
  live() { return this.requestJson("/api/live"); }
  analysis() { return this.requestJson("/api/analysis"); }

  phase(frameCount, {minimumSchemaVersion, maximumSchemaVersion}) {
    return this.requestFloat32(`/api/phase?frame_count=${encodeURIComponent(frameCount)}`, {
      minimumSchemaVersion,
      maximumSchemaVersion,
    });
  }

  setTuning(id) { return this.#postJson("/api/tuning", {id}); }
  setCustomTuning(payload) { return this.#postJson("/api/tuning/custom", payload); }
  saveTuning(payload) { return this.#postJson("/api/tuning/library", payload); }
  reloadTuningLibrary() { return this.#post("/api/tuning/library/reload"); }
  setTimbre(id) { return this.#postJson("/api/timbre", {id}); }
  setCustomTimbre(partials) { return this.#postJson("/api/timbre/custom", {partials}); }
  setMapping(payload) { return this.#postJson("/api/mapping", payload); }
  setVolume(value) { return this.#postJson("/api/audio/volume", {value}); }
  setInputSurface(id) { return this.#postJson("/api/input-surface", {id}); }
  setChordBasis(payload) { return this.#postJson("/api/chord/basis", payload); }

  noteOn(nodeId, velocity = 96) {
    return this.#postJson(`/api/input/${encodeURIComponent(nodeId)}/on`, {velocity});
  }

  noteOff(nodeId) {
    return this.#post(`/api/input/${encodeURIComponent(nodeId)}/off`);
  }

  startRecording() { return this.#post("/api/recording/start"); }
  stopRecording() { return this.#post("/api/recording/stop"); }
  startPlayback(trackId) {
    return this.#post(`/api/playback/${encodeURIComponent(trackId)}/start`);
  }
  stopPlayback() { return this.#post("/api/playback/stop"); }
  clearTrack(trackId) { return this.#post(`/api/tracks/${encodeURIComponent(trackId)}/clear`); }
  deleteTrack(trackId) {
    return this.requestJson(`/api/tracks/${encodeURIComponent(trackId)}`, {method:"DELETE"});
  }
  setTrackCompileMode(trackId, mode) {
    return this.#postJson(`/api/tracks/${encodeURIComponent(trackId)}/compile`, {mode});
  }

  uploadTrackMidi(bytes, {filename, trackId = null} = {}) {
    const trackQuery = trackId ? `&track_id=${encodeURIComponent(trackId)}` : "";
    return this.requestJson(
      `/api/tracks/midi?filename=${encodeURIComponent(filename || "track.mid")}${trackQuery}`,
      {method:"POST", headers:{"Content-Type":"application/octet-stream"}, body:bytes},
    );
  }

  openEventStream({onEvent, onClose, onError} = {}) {
    if (!this.WebSocket || !this.location) throw new Error("当前环境不支持实时事件连接");
    const scheme = this.location.protocol === "https:" ? "wss" : "ws";
    const socket = new this.WebSocket(`${scheme}://${this.location.host}/ws`);
    socket.onmessage = (message) => {
      try { onEvent?.(JSON.parse(message.data)); }
      catch (error) { onError?.(error); }
    };
    socket.onerror = (error) => onError?.(error);
    socket.onclose = () => onClose?.();
    return socket;
  }

  #post(path) { return this.requestJson(path, {method:"POST"}); }
  #postJson(path, payload) {
    return this.requestJson(path, {method:"POST", ...jsonBody(payload)});
  }
}

