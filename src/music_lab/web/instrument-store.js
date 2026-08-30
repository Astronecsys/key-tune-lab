import {
  mergeLiveSnapshot,
  replaceAnalysis,
  replaceSnapshot,
} from "./instrument-state.js";

/**
 * 统一持有服务端读模型。当前仍复用旧 state 对象，确保布局和面板行为不变；
 * 后续无论数据来自 FastAPI 还是浏览器内运行时，面板都只观察这个 Store。
 */
export class InstrumentStore {
  constructor(target) {
    this.target = target;
    this.listeners = new Set();
  }

  get snapshot() { return this.target.snapshot; }
  get analysis() { return this.target.analysis; }
  get phase() { return this.target.phase; }

  replaceSnapshot(payload) {
    replaceSnapshot(this.target, payload);
    this.#notify("snapshot");
    return this.target.snapshot;
  }

  mergeLive(payload) {
    mergeLiveSnapshot(this.target, payload);
    this.#notify("live");
    return this.target.snapshot;
  }

  replaceAnalysis(payload) {
    replaceAnalysis(this.target, payload);
    this.#notify("analysis");
    return this.target.analysis;
  }

  replacePhase(payload) {
    this.target.phase = payload;
    this.#notify("phase");
    return payload;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #notify(kind) {
    for (const listener of this.listeners) listener(kind, this.target);
  }
}

