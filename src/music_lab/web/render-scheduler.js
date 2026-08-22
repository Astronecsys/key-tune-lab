export class PanelRegistry {
  constructor({ onError } = {}) {
    this.entries = new Map();
    this.pending = new Set();
    this.frame = null;
    this.onError = onError || ((error) => console.error(error));
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
        entries.forEach((entry) => {
          const panelId = entry.target.dataset.registeredPanelId;
          if (panelId) this.invalidate(panelId);
        });
      });
  }

  register({ id, element = null, render, observeResize = true }) {
    if (!id || typeof render !== "function") {
      throw new Error("panel registration requires an id and render function");
    }
    if (this.entries.has(id)) throw new Error(`panel ${id} is already registered`);
    this.entries.set(id, { id, element, render });
    if (element && observeResize && this.resizeObserver) {
      element.dataset.registeredPanelId = id;
      this.resizeObserver.observe(element);
    }
    return this;
  }

  invalidate(ids = "all") {
    const requested = ids === "all"
      ? [...this.entries.keys()]
      : Array.isArray(ids) ? ids : [ids];
    requested.forEach((id) => {
      if (this.entries.has(id)) this.pending.add(id);
    });
    if (this.frame === null && this.pending.size) {
      this.frame = requestAnimationFrame(() => this.flush());
    }
  }

  flush() {
    this.frame = null;
    const pending = [...this.pending];
    this.pending.clear();
    const rendered = new Set();
    pending.forEach((id) => {
      const entry = this.entries.get(id);
      if (!entry) return;
      if (entry.element?.classList.contains("collapsed")) return;
      if (rendered.has(entry.render)) return;
      try {
        entry.render();
        rendered.add(entry.render);
      } catch (error) {
        this.onError(error, id);
      }
    });
  }

  disconnect() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.entries.clear();
    this.pending.clear();
  }
}
