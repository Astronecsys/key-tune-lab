export const LAYOUT_SCHEMA_VERSION = 3;
export const LAYOUT_STORAGE_KEY = "music-lab-grid-layout-v1";
export const LEGACY_LAYOUT_STORAGE_KEY = "music-lab-free-layout-v4";

const GAP_PX = 10;
const ROW_HEIGHT_PX = 24;

const cloneLayout = (layout) => Object.fromEntries(
  Object.entries(layout).map(([id, item]) => [id, { ...item }]),
);

const cloneViewSettings = (settings = {}) => ({ ...settings });

export function layoutItemsOverlap(first, second) {
  return first.column < second.column + second.columns
    && first.column + first.columns > second.column
    && first.row < second.row + second.rows
    && first.row + first.rows > second.row;
}

export function overlappingPairs(layout) {
  const entries = Object.entries(layout);
  const pairs = [];
  for (let firstIndex = 0; firstIndex < entries.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < entries.length; secondIndex += 1) {
      if (layoutItemsOverlap(entries[firstIndex][1], entries[secondIndex][1])) {
        pairs.push([entries[firstIndex][0], entries[secondIndex][0]]);
      }
    }
  }
  return pairs;
}

function constrainItem(item, panel, columnCount) {
  const columns = Math.max(
    panel.minColumns,
    Math.min(columnCount, Math.round(Number(item.columns) || panel.minColumns)),
  );
  return {
    column: Math.max(0, Math.min(columnCount - columns, Math.round(Number(item.column) || 0))),
    row: Math.max(0, Math.round(Number(item.row) || 0)),
    columns,
    rows: Math.max(panel.minRows, Math.round(Number(item.rows) || panel.minRows)),
  };
}

function placeWithoutCollision(item, placedItems) {
  const candidate = { ...item };
  let guard = 0;
  while (guard < 1000) {
    const collisions = placedItems.filter((placed) => layoutItemsOverlap(candidate, placed));
    if (!collisions.length) return candidate;
    candidate.row = Math.max(...collisions.map((placed) => placed.row + placed.rows));
    guard += 1;
  }
  throw new Error("unable to resolve panel layout collision");
}

export function repairLayout(layout, panels, columnCount) {
  const panelMap = new Map(panels.map((panel) => [panel.id, panel]));
  const ordered = panels
    .map((panel) => ({
      panel,
      item: constrainItem(layout[panel.id] || panel.defaults, panel, columnCount),
    }))
    .sort((first, second) => first.item.row - second.item.row || first.item.column - second.item.column);
  const repaired = {};
  const placed = [];
  ordered.forEach(({ panel, item }) => {
    const resolved = placeWithoutCollision(item, placed);
    repaired[panel.id] = resolved;
    placed.push(resolved);
  });
  panels.forEach((panel) => {
    if (!repaired[panel.id] && panelMap.has(panel.id)) {
      repaired[panel.id] = constrainItem(panel.defaults, panel, columnCount);
    }
  });
  return repaired;
}

export function resolveLayoutWithAnchor(baseLayout, panels, anchorId, candidate, columnCount) {
  const panelMap = new Map(panels.map((panel) => [panel.id, panel]));
  const anchorPanel = panelMap.get(anchorId);
  if (!anchorPanel) throw new Error(`unknown panel ${anchorId}`);
  const resolved = {
    [anchorId]: constrainItem(candidate, anchorPanel, columnCount),
  };
  const placed = [resolved[anchorId]];
  panels
    .filter((panel) => panel.id !== anchorId)
    .map((panel) => ({
      panel,
      item: constrainItem(baseLayout[panel.id] || panel.defaults, panel, columnCount),
    }))
    .sort((first, second) => first.item.row - second.item.row || first.item.column - second.item.column)
    .forEach(({ panel, item }) => {
      const next = placeWithoutCollision(item, placed);
      resolved[panel.id] = next;
      placed.push(next);
    });
  return resolved;
}

export function compactLayout(layout, panels, columnCount) {
  const constrained = panels
    .map((panel) => ({
      panel,
      item: constrainItem(layout[panel.id] || panel.defaults, panel, columnCount),
    }))
    .sort((first, second) => first.item.row - second.item.row || first.item.column - second.item.column);
  const compacted = {};
  const placed = [];
  constrained.forEach(({ panel, item }) => {
    let candidate = { ...item, row: 0 };
    while (placed.some((other) => layoutItemsOverlap(candidate, other))) candidate.row += 1;
    compacted[panel.id] = candidate;
    placed.push(candidate);
  });
  return compacted;
}

export function fitLayout(layout, panels, columnCount) {
  const fitted = Object.fromEntries(panels.map((panel) => {
    const item = layout[panel.id] || panel.defaults;
    return [panel.id, {
      ...item,
      rows:panel.defaults.rows,
    }];
  }));
  return compactLayout(fitted, panels, columnCount);
}

export function convertLegacyLayout(legacy, panels, columnCount, workspaceWidth) {
  const columnStride = (workspaceWidth + GAP_PX) / columnCount;
  const rowStride = ROW_HEIGHT_PX + GAP_PX;
  const converted = {};
  panels.forEach((panel) => {
    const old = legacy?.[panel.legacyId || panel.id];
    if (!old) return;
    converted[panel.id] = {
      column: Math.round(Number(old.x || 0) / columnStride),
      row: Math.round(Number(old.y || 0) / rowStride),
      columns: Math.round((Number(old.w || 0) + GAP_PX) / columnStride),
      rows: Math.round((Number(old.h || 0) + GAP_PX) / rowStride),
    };
  });
  return repairLayout(converted, panels, columnCount);
}

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
}) {
  let unlocked = false;
  let currentMode = workspace.clientWidth >= 1600 ? "wide" : "compact";
  let currentColumns = currentMode === "wide" ? 24 : 12;
  const manifestsForMode = (mode) => panels.map((panel) => ({
    ...panel,
    defaults: panel.layouts[mode],
  }));
  const defaultsForMode = (mode) => Object.fromEntries(
    manifestsForMode(mode).map((panel) => [panel.id, { ...panel.defaults }]),
  );
  const savedDocument = readJson(storage, LAYOUT_STORAGE_KEY);
  const supportedSavedDocument = [1, 2, LAYOUT_SCHEMA_VERSION].includes(
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
        savedModes[mode] = fitLayout(
          savedModes[mode],
          manifestsForMode(mode),
          columnCount,
        );
      }
      if (userDefaults[mode]) {
        userDefaults[mode] = fitLayout(
          userDefaults[mode],
          manifestsForMode(mode),
          columnCount,
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
      );
    }
  }

  let currentLayout = repairLayout(
    savedModes[currentMode] || userDefaults[currentMode] || defaultsForMode(currentMode),
    manifestsForMode(currentMode),
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
    panels.forEach((panel) => {
      const item = currentLayout[panel.id];
      panel.element.style.left = "";
      panel.element.style.top = "";
      panel.element.style.width = "";
      panel.element.style.height = "";
      panel.element.style.gridColumn = `${item.column + 1} / span ${item.columns}`;
      panel.element.style.gridRow = `${item.row + 1} / span ${item.rows}`;
    });
    const rows = Math.max(...Object.values(currentLayout).map((item) => item.row + item.rows));
    workspace.style.setProperty("--layout-rows", rows);
    onLayoutChange(panels.map((panel) => panel.id));
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
    onVisibilityChange([...hiddenPanelIds]);
  };

  const setFocusedPanel = (panelId) => {
    focusedPanelId = panelId && panels.some((panel) => panel.id === panelId)
      ? panelId
      : null;
    workspace.classList.toggle("panel-focus-mode", Boolean(focusedPanelId));
    panels.forEach((panel) => {
      panel.element.classList.toggle("panel-focused", panel.id === focusedPanelId);
      const button = panel.element.querySelector("[data-panel-focus]");
      if (button) {
        button.textContent = panel.id === focusedPanelId ? "退出全屏" : "全屏";
        button.setAttribute?.("aria-label", panel.id === focusedPanelId ? "退出面板全屏" : "面板全屏");
      }
    });
    onFocusChange(focusedPanelId);
  };

  const saveAsDefault = () => {
    userDefaults[currentMode] = cloneLayout(currentLayout);
    captureViewSettings();
    userDefaultViewSettings[currentMode] = cloneViewSettings(
      savedViewSettings[currentMode],
    );
    userDefaultHiddenPanels[currentMode] = [...hiddenPanelIds];
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
          manifestsForMode(currentMode),
          panel.id,
          candidate,
          currentColumns,
        );
        apply(resolved);
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
          apply(compactLayout(currentLayout, manifestsForMode(currentMode), currentColumns));
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
    apply(fitLayout(currentLayout, manifestsForMode(currentMode), currentColumns));
    persist();
  });
  saveDefaultButton.addEventListener("click", saveAsDefault);
  resetButton.addEventListener("click", () => {
    currentLayout = userDefaults[currentMode] || defaultsForMode(currentMode);
    applyViewSettings(settingsForMode(currentMode, true));
    applyHiddenPanels(userDefaultHiddenPanels[currentMode] || []);
    apply(repairLayout(currentLayout, manifestsForMode(currentMode), currentColumns));
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
    currentLayout = repairLayout(
      savedModes[currentMode] || userDefaults[currentMode] || defaultsForMode(currentMode),
      manifestsForMode(currentMode),
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
      };
    },
    setLayout: (layout, { persist: shouldPersist = true } = {}) => {
      currentLayout = repairLayout(layout, manifestsForMode(currentMode), currentColumns);
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
      currentLayout = repairLayout(snapshot?.layout || currentLayout, manifestsForMode(currentMode), currentColumns);
      applyViewSettings({ ...builtInViewSettings, ...(snapshot?.viewSettings || {}) });
      applyHiddenPanels(snapshot?.hiddenPanels || []);
      apply();
      if (shouldPersist) persist();
    },
    focusPanel: setFocusedPanel,
    refresh: () => apply(),
    saveAsDefault,
    saveViewSettings: persist,
    isPanelVisible: (panelId) => !hiddenPanelIds.has(panelId),
    setPanelVisible: (panelId, visible) => {
      if (visible) hiddenPanelIds.delete(panelId);
      else hiddenPanelIds.add(panelId);
      const panel = panels.find((candidate) => candidate.id === panelId);
      panel?.element.classList.toggle("collapsed", !visible);
      onVisibilityChange([...hiddenPanelIds]);
      persist();
      if (visible) onLayoutChange([panelId]);
    },
  };
}
