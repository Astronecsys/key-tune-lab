export const valueAtPath = (root, path) => String(path || "").split(".").filter(Boolean).reduce(
  (value, key) => value == null ? undefined : value[key],
  root,
);

export class PresentationActionRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register(type, handler) {
    if (!type || typeof handler !== "function") {
      throw new Error("放映动作需要名称和处理函数");
    }
    this.handlers.set(type, handler);
    return this;
  }

  async run(actions, {isCancelled = () => false, onError = () => {}} = {}) {
    for (const action of actions || []) {
      if (isCancelled()) return {cancelled:true};
      const type = String(action?.type || "");
      const handler = this.handlers.get(type);
      if (!handler) {
        if (!type) continue;
        const error = new Error(`未知场景动作：${type}`);
        onError(error, action);
        return {cancelled:false, error};
      }
      try {
        await handler(action, {isCancelled});
      } catch (error) {
        onError(error, action);
        return {cancelled:false, error};
      }
    }
    return {cancelled:isCancelled()};
  }
}

export function createInstrumentActionRegistry({
  layout,
  request,
  refreshState,
  getSnapshot,
  resetSpectrumHistory,
  invalidatePanel,
  showMessage,
  delay = (seconds) => new Promise((resolve) => {
    globalThis.setTimeout(resolve, Math.max(0, Math.min(3600, Number(seconds) || 0)) * 1000);
  }),
}) {
  const registry = new PresentationActionRegistry();
  registry
    .register("wait", async (action) => delay(action.seconds))
    .register("focus_panel", async (action) => layout().focusPanel(action.panel_id || null))
    .register("switch_desktop", async (action) => {
      if (!layout().switchDesktop(action.desktop_id)) {
        throw new Error(`未知桌面：${action.desktop_id}`);
      }
    })
    .register("set_panel_visibility", async (action) => {
      layout().setHiddenPanels(action.hidden_panels || [], {persist:false});
    })
    .register("set_view", async (action) => {
      layout().setViewSettings(action.settings || {}, {persist:false});
    })
    .register("clear_spectrum_history", async () => {
      resetSpectrumHistory();
      invalidatePanel("spectrumPanel");
    })
    .register("playback_start", async (action) => {
      if (!action.track_id) throw new Error("playback_start 缺少 track_id");
      await request(`/api/playback/${encodeURIComponent(action.track_id)}/start`, {method:"POST"});
      await refreshState();
    })
    .register("playback_stop", async () => {
      await request("/api/playback/stop", {method:"POST"});
      await refreshState();
    })
    .register("recording_start", async () => {
      await request("/api/recording/start", {method:"POST"});
      await refreshState();
    })
    .register("recording_stop", async () => {
      await request("/api/recording/stop", {method:"POST"});
      await refreshState();
    })
    .register("chord_basis", async (action) => {
      await request("/api/chord/basis", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(action.payload || action),
      });
      await refreshState();
    })
    .register("assert_state", async (action) => {
      const actual = valueAtPath(getSnapshot(), action.path);
      const expected = Object.prototype.hasOwnProperty.call(action, "equals")
        ? action.equals
        : true;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`断言失败：${action.path} = ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`);
      }
    })
    .register("toast", async (action) => showMessage(String(action.message || "")));
  return registry;
}
