export const LAYOUT_SCHEMA_VERSION = 4;
export const LAYOUT_STORAGE_KEY = "music-lab-grid-layout-v1";
export const LEGACY_LAYOUT_STORAGE_KEY = "music-lab-free-layout-v4";

import {
  compactLayout,
  convertLegacyLayout,
  fitLayout,
  normalizeDesktopOrigins,
  normalizePanelDesktops,
  panelsOnDesktop,
  repairDesktopLayouts,
  resolveLayoutWithAnchor,
} from "./layout-geometry.js";

export {
  compactLayout,
  convertLegacyLayout,
  fitLayout,
  layoutItemsOverlap,
  normalizeDesktopOrigins,
  normalizePanelDesktops,
  overlappingPairs,
  repairDesktopLayouts,
  repairLayout,
  resolveLayoutWithAnchor,
} from "./layout-geometry.js";

const GAP_PX = 10;
const ROW_HEIGHT_PX = 24;

const cloneLayout = (layout) => Object.fromEntries(
  Object.entries(layout).map(([id, item]) => [id, { ...item }]),
);

const cloneViewSettings = (settings = {}) => ({ ...settings });

const cloneAssignments = (assignments = {}) => ({ ...assignments });

function readJson(storage, key) {
  try {
    return JSON.parse(storage.getItem(key) || "null");
  } catch (_) {
    return null;
  }
}

export function createGridLayoutManager({
  workspace,
  panels,
  desktops = [{id:"desktop1", label:"桌面 1"}],
  lockButton,
  alignButton,
  saveDefaultButton,
  resetButton,
  storage = window.localStorage,
  onLayoutChange = () => {},
  onDefaultSaved = () => {},
  onVisibilityChange = () => {},
  getViewSettings = () => ({}),
  applyViewSettings = () => {},
  onFocusChange = () => {},
  onDesktopChange = () => {},
}) {
  let unlocked = false;
  let currentMode = workspace.clientWidth >= 1600 ? "wide" : "compact";
  let currentColumns = currentMode === "wide" ? 24 : 12;
  const desktopIds = desktops.map((desktop) => desktop.id);
  const builtInPanelDesktops = normalizePanelDesktops(panels, {}, desktopIds);
  const manifestsForMode = (mode) => panels.map((panel) => ({
    ...panel,
    defaults: panel.layouts[mode],
  }));
  const manifestsForDesktopMode = (desktopId, mode = currentMode) => panelsOnDesktop(
    manifestsForMode(mode),
    panelDesktopIds,
    desktopId,
  );
  const defaultsForMode = (mode) => Object.fromEntries(
    manifestsForMode(mode).map((panel) => [panel.id, { ...panel.defaults }]),
  );
  const savedDocument = readJson(storage, LAYOUT_STORAGE_KEY);
  const supportedSavedDocument = [1, 2, 3, LAYOUT_SCHEMA_VERSION].includes(
    savedDocument?.version,
  );
  const savedModes = supportedSavedDocument
    ? { ...(savedDocument.modes || {}) }
    : {};
  const userDefaults = supportedSavedDocument
    ? { ...(savedDocument.user_defaults || {}) }
    : {};
  const savedViewSettings = supportedSavedDocument
    ? { ...(savedDocument.view_settings || {}) }
    : {};
  const userDefaultViewSettings = supportedSavedDocument
    ? { ...(savedDocument.user_default_view_settings || {}) }
    : {};
  const userDefaultHiddenPanels = supportedSavedDocument
    ? { ...(savedDocument.user_default_hidden_panels || {}) }
    : {};
  let panelDesktopIds = normalizePanelDesktops(
    panels,
    supportedSavedDocument && savedDocument.version >= 4
      ? savedDocument.panel_desktops
      : builtInPanelDesktops,
    desktopIds,
  );
  let userDefaultPanelDesktops = normalizePanelDesktops(
    panels,
    supportedSavedDocument && savedDocument.version >= 4
      ? savedDocument.user_default_panel_desktops || builtInPanelDesktops
      : builtInPanelDesktops,
    desktopIds,
  );
  let userDefaultActiveDesktop = desktopIds.includes(savedDocument?.user_default_active_desktop)
    ? savedDocument.user_default_active_desktop
    : desktopIds[0];
  let activeDesktopId = desktopIds.includes(savedDocument?.active_desktop)
    ? savedDocument.active_desktop
    : desktopIds[0];
  const builtInViewSettings = cloneViewSettings(getViewSettings());
  const hiddenPanelIds = new Set(
    supportedSavedDocument
      ? savedDocument.hidden_panels || []
      : [],
  );
  let focusedPanelId = null;

  if (savedDocument?.version === 1) {
    for (const [mode, columnCount] of [["compact", 12], ["wide", 24]]) {
      if (savedModes[mode]) {
        const fitted = {};
        desktopIds.forEach((desktopId) => Object.assign(
          fitted,
          fitLayout(savedModes[mode], manifestsForDesktopMode(desktopId, mode), columnCount),
        ));
        savedModes[mode] = fitted;
      }
      if (userDefaults[mode]) {
        const fitted = {};
        desktopIds.forEach((desktopId) => Object.assign(
          fitted,
          fitLayout(userDefaults[mode], manifestsForDesktopMode(desktopId, mode), columnCount),
        ));
        userDefaults[mode] = fitted;
      }
    }
  }

  if (supportedSavedDocument && savedDocument.version < 4) {
    for (const mode of ["compact", "wide"]) {
      const columnCount = mode === "wide" ? 24 : 12;
      if (savedModes[mode]) {
        savedModes[mode] = normalizeDesktopOrigins(
          repairDesktopLayouts(savedModes[mode], manifestsForMode(mode), panelDesktopIds, desktopIds, columnCount),
          manifestsForMode(mode),
          panelDesktopIds,
          desktopIds,
        );
      }
      if (userDefaults[mode]) {
        userDefaults[mode] = normalizeDesktopOrigins(
          repairDesktopLayouts(userDefaults[mode], manifestsForMode(mode), panelDesktopIds, desktopIds, columnCount),
          manifestsForMode(mode),
          panelDesktopIds,
          desktopIds,
        );
      }
    }
  }

  if (!savedModes[currentMode]) {
    const legacy = readJson(storage, LEGACY_LAYOUT_STORAGE_KEY);
    if (legacy) {
      savedModes[currentMode] = convertLegacyLayout(
        legacy,
        manifestsForMode(currentMode),
        currentColumns,
        workspace.clientWidth,
        panelDesktopIds,
        desktopIds,
      );
    }
  }

  let currentLayout = repairDesktopLayouts(
    savedModes[currentMode] || userDefaults[currentMode] || defaultsForMode(currentMode),
    manifestsForMode(currentMode),
    panelDesktopIds,
    desktopIds,
    currentColumns,
  );

  const settingsForMode = (mode, defaultsOnly = false) => ({
    ...builtInViewSettings,
    ...(
      defaultsOnly
        ? userDefaultViewSettings[mode]
        : savedViewSettings[mode] || userDefaultViewSettings[mode]
    ),
  });

  const captureViewSettings = () => {
    savedViewSettings[currentMode] = cloneViewSettings(getViewSettings());
  };

  const persist = () => {
    savedModes[currentMode] = cloneLayout(currentLayout);
    captureViewSettings();
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      version: LAYOUT_SCHEMA_VERSION,
      active_desktop: activeDesktopId,
      user_default_active_desktop: userDefaultActiveDesktop,
      panel_desktops: cloneAssignments(panelDesktopIds),
      user_default_panel_desktops: cloneAssignments(userDefaultPanelDesktops),
      modes: savedModes,
      user_defaults: userDefaults,
      view_settings: savedViewSettings,
      user_default_view_settings: userDefaultViewSettings,
      user_default_hidden_panels: userDefaultHiddenPanels,
      hidden_panels: [...hiddenPanelIds],
    }));
  };

  const apply = (layout = currentLayout) => {
    currentLayout = cloneLayout(layout);
    workspace.style.setProperty("--layout-columns", currentColumns);
    workspace.style.setProperty("--layout-row-height", `${ROW_HEIGHT_PX}px`);
    workspace.dataset ||= {};
    workspace.dataset.activeDesktop = activeDesktopId;
    panels.forEach((panel) => {
      const item = currentLayout[panel.id];
      if (!item) return;
      panel.element.style.left = "";
      panel.element.style.top = "";
      panel.element.style.width = "";
      panel.element.style.height = "";
      panel.element.style.gridColumn = `${item.column + 1} / span ${item.columns}`;
      panel.element.style.gridRow = `${item.row + 1} / span ${item.rows}`;
      panel.element.dataset ||= {};
      panel.element.dataset.desktop = panelDesktopIds[panel.id];
      panel.element.classList.toggle(
        "desktop-inactive",
        panelDesktopIds[panel.id] !== activeDesktopId,
      );
    });
    const activePanelIds = panelsOnDesktop(panels, panelDesktopIds, activeDesktopId)
      .map((panel) => panel.id);
    const rows = Math.max(
      1,
      ...activePanelIds
        .map((panelId) => currentLayout[panelId])
        .filter(Boolean)
        .map((item) => item.row + item.rows),
    );
    workspace.style.setProperty("--layout-rows", rows);
    onDesktopChange(
      activeDesktopId,
      cloneAssignments(panelDesktopIds),
      [...hiddenPanelIds],
    );
    onLayoutChange(activePanelIds);
  };

  const setUnlocked = (value) => {
    unlocked = Boolean(value);
    workspace.classList.toggle("layout-unlocked", unlocked);
    lockButton.textContent = unlocked ? "锁定布局" : "解锁布局";
  };

  const applyHiddenPanels = (panelIds) => {
    hiddenPanelIds.clear();
    panelIds.forEach((panelId) => hiddenPanelIds.add(panelId));
    panels.forEach((panel) => {
      panel.element.classList.toggle("collapsed", hiddenPanelIds.has(panel.id));
    });
    onVisibilityChange(
      [...hiddenPanelIds],
      cloneAssignments(panelDesktopIds),
      activeDesktopId,
    );
  };

  const setFocusedPanel = (panelId) => {
    focusedPanelId = panelId
      && panels.some((panel) => panel.id === panelId)
      && panelDesktopIds[panelId] === activeDesktopId
      ? panelId
      : null;
    workspace.classList.toggle("panel-focus-mode", Boolean(focusedPanelId));
    panels.forEach((panel) => {
      panel.element.classList.toggle("panel-focused", panel.id === focusedPanelId);
      const button = panel.element.querySelector?.("[data-panel-focus]");
      if (button) {
        button.textContent = panel.id === focusedPanelId ? "退出全屏" : "全屏";
        button.setAttribute?.("aria-label", panel.id === focusedPanelId ? "退出面板全屏" : "面板全屏");
      }
    });
    onFocusChange(focusedPanelId);
  };

  const switchDesktop = (desktopId, { persist: shouldPersist = true } = {}) => {
    if (!desktopIds.includes(desktopId)) return false;
    if (desktopId === activeDesktopId) {
      onDesktopChange(
        activeDesktopId,
        cloneAssignments(panelDesktopIds),
        [...hiddenPanelIds],
      );
      return true;
    }
    setFocusedPanel(null);
    activeDesktopId = desktopId;
    apply();
    if (shouldPersist) persist();
    return true;
  };

  const focusPanel = (panelId) => {
    if (panelId && panelDesktopIds[panelId] !== activeDesktopId) {
      switchDesktop(panelDesktopIds[panelId], {persist:false});
    }
    setFocusedPanel(panelId);
  };

  const saveAsDefault = () => {
    userDefaults[currentMode] = cloneLayout(currentLayout);
    captureViewSettings();
    userDefaultViewSettings[currentMode] = cloneViewSettings(
      savedViewSettings[currentMode],
    );
    userDefaultHiddenPanels[currentMode] = [...hiddenPanelIds];
    userDefaultPanelDesktops = cloneAssignments(panelDesktopIds);
    userDefaultActiveDesktop = activeDesktopId;
    persist();
    onDefaultSaved(currentMode);
  };

  panels.forEach((panel) => {
    const focusButton = document.createElement("button");
    focusButton.type = "button";
    focusButton.className = "panel-focus-button";
    focusButton.dataset ||= {};
    focusButton.dataset.panelFocus = panel.id;
    focusButton.textContent = "全屏";
    focusButton.title = "暂时隐藏其他面板并放大当前面板";
    focusButton.addEventListener("click", () => {
      setFocusedPanel(focusedPanelId === panel.id ? null : panel.id);
    });
    const dragHandle = document.createElement("div");
    dragHandle.className = "panel-drag-handle";
    dragHandle.title = "拖动面板（吸附网格）";
    dragHandle.textContent = "⠿";
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "panel-resize-handle";
    resizeHandle.title = "调整面板大小（吸附网格）";
    panel.element.append(focusButton, dragHandle, resizeHandle);

    const begin = (event, mode) => {
      if (!unlocked) return;
      event.preventDefault();
      const baseLayout = cloneLayout(currentLayout);
      const baseItem = { ...baseLayout[panel.id] };
      const startX = event.clientX;
      const startY = event.clientY;
      const columnStride = (workspace.clientWidth + GAP_PX) / currentColumns;
      const rowStride = ROW_HEIGHT_PX + GAP_PX;
      workspace.classList.add("layout-interacting");
      panel.element.classList.add("layout-active-panel");

      const move = (moveEvent) => {
        const columnDelta = Math.round((moveEvent.clientX - startX) / columnStride);
        const rowDelta = Math.round((moveEvent.clientY - startY) / rowStride);
        const candidate = mode === "move"
          ? { ...baseItem, column: baseItem.column + columnDelta, row: baseItem.row + rowDelta }
          : { ...baseItem, columns: baseItem.columns + columnDelta, rows: baseItem.rows + rowDelta };
        const resolved = resolveLayoutWithAnchor(
          baseLayout,
          manifestsForDesktopMode(activeDesktopId),
          panel.id,
          candidate,
          currentColumns,
        );
        apply({...baseLayout, ...resolved});
      };

      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        workspace.classList.remove("layout-interacting");
        panel.element.classList.remove("layout-active-panel");
        const finalItem = currentLayout[panel.id];
        if (
          mode === "resize"
          && (finalItem.columns < baseItem.columns || finalItem.rows < baseItem.rows)
        ) {
          apply({
            ...currentLayout,
            ...compactLayout(
              currentLayout,
              manifestsForDesktopMode(activeDesktopId),
              currentColumns,
            ),
          });
        }
        persist();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish, { once: true });
    };

    dragHandle.addEventListener("pointerdown", (event) => begin(event, "move"));
    resizeHandle.addEventListener("pointerdown", (event) => begin(event, "resize"));
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && focusedPanelId) {
      event.preventDefault();
      setFocusedPanel(null);
    }
  });

  lockButton.addEventListener("click", () => setUnlocked(!unlocked));
  alignButton.addEventListener("click", () => {
    apply({
      ...currentLayout,
      ...fitLayout(
        currentLayout,
        manifestsForDesktopMode(activeDesktopId),
        currentColumns,
      ),
    });
    persist();
  });
  saveDefaultButton.addEventListener("click", saveAsDefault);
  resetButton.addEventListener("click", () => {
    panelDesktopIds = normalizePanelDesktops(
      panels,
      userDefaultPanelDesktops || builtInPanelDesktops,
      desktopIds,
    );
    activeDesktopId = desktopIds.includes(userDefaultActiveDesktop)
      ? userDefaultActiveDesktop
      : desktopIds[0];
    currentLayout = repairDesktopLayouts(
      userDefaults[currentMode] || defaultsForMode(currentMode),
      manifestsForMode(currentMode),
      panelDesktopIds,
      desktopIds,
      currentColumns,
    );
    applyViewSettings(settingsForMode(currentMode, true));
    applyHiddenPanels(userDefaultHiddenPanels[currentMode] || []);
    setFocusedPanel(null);
    apply(currentLayout);
    persist();
  });
  window.addEventListener("resize", () => {
    const nextMode = workspace.clientWidth >= 1600 ? "wide" : "compact";
    if (nextMode === currentMode) {
      onLayoutChange(panels.map((panel) => panel.id));
      return;
    }
    savedModes[currentMode] = cloneLayout(currentLayout);
    captureViewSettings();
    currentMode = nextMode;
    currentColumns = currentMode === "wide" ? 24 : 12;
    currentLayout = repairDesktopLayouts(
      savedModes[currentMode] || userDefaults[currentMode] || defaultsForMode(currentMode),
      manifestsForMode(currentMode),
      panelDesktopIds,
      desktopIds,
      currentColumns,
    );
    applyViewSettings(settingsForMode(currentMode));
    apply();
    persist();
  });

  setUnlocked(false);
  applyHiddenPanels([...hiddenPanelIds]);
  applyViewSettings(settingsForMode(currentMode));
  apply();
  persist();
  return {
    getLayout: () => cloneLayout(currentLayout),
    getMode: () => currentMode,
    getHiddenPanels: () => [...hiddenPanelIds],
    getFocusedPanel: () => focusedPanelId,
    getSnapshot: () => {
      captureViewSettings();
      return {
        layout: cloneLayout(currentLayout),
        viewSettings: cloneViewSettings(getViewSettings()),
        hiddenPanels: [...hiddenPanelIds],
        activeDesktop: activeDesktopId,
        panelDesktops: cloneAssignments(panelDesktopIds),
      };
    },
    setLayout: (layout, { persist: shouldPersist = true } = {}) => {
      currentLayout = repairDesktopLayouts(
        layout,
        manifestsForMode(currentMode),
        panelDesktopIds,
        desktopIds,
        currentColumns,
      );
      apply();
      if (shouldPersist) persist();
    },
    setViewSettings: (settings, { persist: shouldPersist = true } = {}) => {
      applyViewSettings({ ...builtInViewSettings, ...settings });
      if (shouldPersist) persist();
    },
    setHiddenPanels: (panelIds, { persist: shouldPersist = true } = {}) => {
      applyHiddenPanels(panelIds);
      if (shouldPersist) persist();
    },
    applySnapshot: (snapshot, { persist: shouldPersist = true } = {}) => {
      if (snapshot?.panelDesktops) {
        panelDesktopIds = normalizePanelDesktops(
          panels,
          snapshot.panelDesktops,
          desktopIds,
        );
      }
      if (desktopIds.includes(snapshot?.activeDesktop)) {
        activeDesktopId = snapshot.activeDesktop;
      }
      currentLayout = repairDesktopLayouts(
        snapshot?.layout || currentLayout,
        manifestsForMode(currentMode),
        panelDesktopIds,
        desktopIds,
        currentColumns,
      );
      applyViewSettings({ ...builtInViewSettings, ...(snapshot?.viewSettings || {}) });
      applyHiddenPanels(snapshot?.hiddenPanels || []);
      setFocusedPanel(null);
      apply();
      if (shouldPersist) persist();
    },
    focusPanel,
    refresh: () => apply(),
    saveAsDefault,
    saveViewSettings: persist,
    getActiveDesktop: () => activeDesktopId,
    getPanelDesktop: (panelId) => panelDesktopIds[panelId] || null,
    getPanelDesktops: () => cloneAssignments(panelDesktopIds),
    switchDesktop,
    setPanelDesktop: (panelId, desktopId) => {
      if (!panelDesktopIds[panelId] || !desktopIds.includes(desktopId)) return false;
      if (panelDesktopIds[panelId] === desktopId) return true;
      if (focusedPanelId === panelId) setFocusedPanel(null);
      panelDesktopIds[panelId] = desktopId;
      currentLayout = repairDesktopLayouts(
        currentLayout,
        manifestsForMode(currentMode),
        panelDesktopIds,
        desktopIds,
        currentColumns,
      );
      apply();
      persist();
      return true;
    },
    isPanelVisible: (panelId) => !hiddenPanelIds.has(panelId),
    setPanelVisible: (panelId, visible) => {
      if (visible) hiddenPanelIds.delete(panelId);
      else hiddenPanelIds.add(panelId);
      const panel = panels.find((candidate) => candidate.id === panelId);
      panel?.element.classList.toggle("collapsed", !visible);
      onVisibilityChange(
        [...hiddenPanelIds],
        cloneAssignments(panelDesktopIds),
        activeDesktopId,
      );
      persist();
      if (visible) onLayoutChange([panelId]);
    },
  };
}
