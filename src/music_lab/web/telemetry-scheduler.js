export class TelemetryScheduler {
  constructor({
    documentRef = globalThis.document,
    timerApi = globalThis,
    liveIntervalMs = 120,
    visualIntervalMs = 100,
    isLiveActive,
    isPanelVisible,
    refreshLive,
    refreshAnalysis,
    refreshPhase,
    invalidatePanel,
  }) {
    this.document = documentRef;
    this.timerApi = timerApi;
    this.liveIntervalMs = liveIntervalMs;
    this.visualIntervalMs = visualIntervalMs;
    this.isLiveActive = isLiveActive;
    this.isPanelVisible = isPanelVisible;
    this.refreshLive = refreshLive;
    this.refreshAnalysis = refreshAnalysis;
    this.refreshPhase = refreshPhase;
    this.invalidatePanel = invalidatePanel;
    this.timers = [];
    this.inFlight = new Set();
  }

  _runOnce(channel, operation) {
    if (this.inFlight.has(channel)) return;
    this.inFlight.add(channel);
    Promise.resolve(operation()).finally(() => this.inFlight.delete(channel));
  }

  tickLive() {
    if (this.document.hidden || !this.isLiveActive()) return;
    this.requestLive();
  }

  requestLive() {
    if (this.document.hidden) return;
    this._runOnce("live", this.refreshLive);
  }

  tickVisuals() {
    if (this.document.hidden) return;
    // 只有可见面板才拉取高频数据；第二桌面不会暗中消耗 FFT 与序列化时间。
    if (this.isPanelVisible("spectrumPanel")) {
      this._runOnce("analysis", this.refreshAnalysis);
    }
    if (this.isPanelVisible("lissajousPanel")) {
      this.invalidatePanel("lissajousPanel");
    }
    if (this.isPanelVisible("outputPhasePanel")) {
      this._runOnce("phase", this.refreshPhase);
    }
  }

  start() {
    if (this.timers.length) return;
    this.timers = [
      this.timerApi.setInterval(() => this.tickLive(), this.liveIntervalMs),
      this.timerApi.setInterval(() => this.tickVisuals(), this.visualIntervalMs),
    ];
  }

  stop() {
    this.timers.forEach((timer) => this.timerApi.clearInterval(timer));
    this.timers = [];
    this.inFlight.clear();
  }
}
