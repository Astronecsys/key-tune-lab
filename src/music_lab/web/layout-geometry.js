const GAP_PX = 10;
const ROW_HEIGHT_PX = 24;

const cloneLayout = (layout) => Object.fromEntries(
  Object.entries(layout).map(([id, item]) => [id, {...item}]),
);

export function normalizePanelDesktops(panels, assignments = {}, desktopIds = ["desktop1"]) {
  const fallbackDesktop = desktopIds[0];
  return Object.fromEntries(panels.map((panel) => {
    const requested = assignments[panel.id] || panel.desktop || fallbackDesktop;
    return [panel.id, desktopIds.includes(requested) ? requested : fallbackDesktop];
  }));
}

export function panelsOnDesktop(panels, assignments, desktopId) {
  return panels.filter((panel) => assignments[panel.id] === desktopId);
}

export function repairDesktopLayouts(layout, panels, assignments, desktopIds, columnCount) {
  const repaired = {};
  desktopIds.forEach((desktopId) => {
    Object.assign(
      repaired,
      repairLayout(layout, panelsOnDesktop(panels, assignments, desktopId), columnCount),
    );
  });
  return repaired;
}

export function normalizeDesktopOrigins(layout, panels, assignments, desktopIds) {
  const normalized = cloneLayout(layout);
  desktopIds.forEach((desktopId) => {
    const panelIds = panelsOnDesktop(panels, assignments, desktopId)
      .map((panel) => panel.id)
      .filter((panelId) => normalized[panelId]);
    if (!panelIds.length) return;
    const firstRow = Math.min(...panelIds.map((panelId) => normalized[panelId].row));
    if (firstRow <= 0) return;
    panelIds.forEach((panelId) => { normalized[panelId].row -= firstRow; });
  });
  return normalized;
}

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
    column:Math.max(0, Math.min(columnCount - columns, Math.round(Number(item.column) || 0))),
    row:Math.max(0, Math.round(Number(item.row) || 0)),
    columns,
    rows:Math.max(panel.minRows, Math.round(Number(item.rows) || panel.minRows)),
  };
}

function placeWithoutCollision(item, placedItems) {
  const candidate = {...item};
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
      item:constrainItem(layout[panel.id] || panel.defaults, panel, columnCount),
    }))
    .sort((first, second) => first.item.row - second.item.row || first.item.column - second.item.column);
  const repaired = {};
  const placed = [];
  ordered.forEach(({panel, item}) => {
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
  const resolved = {[anchorId]:constrainItem(candidate, anchorPanel, columnCount)};
  const placed = [resolved[anchorId]];
  panels
    .filter((panel) => panel.id !== anchorId)
    .map((panel) => ({
      panel,
      item:constrainItem(baseLayout[panel.id] || panel.defaults, panel, columnCount),
    }))
    .sort((first, second) => first.item.row - second.item.row || first.item.column - second.item.column)
    .forEach(({panel, item}) => {
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
      item:constrainItem(layout[panel.id] || panel.defaults, panel, columnCount),
    }))
    .sort((first, second) => first.item.row - second.item.row || first.item.column - second.item.column);
  const compacted = {};
  const placed = [];
  constrained.forEach(({panel, item}) => {
    const candidate = {...item, row:0};
    while (placed.some((other) => layoutItemsOverlap(candidate, other))) candidate.row += 1;
    compacted[panel.id] = candidate;
    placed.push(candidate);
  });
  return compacted;
}

export function fitLayout(layout, panels, columnCount) {
  const fitted = Object.fromEntries(panels.map((panel) => {
    const item = layout[panel.id] || panel.defaults;
    return [panel.id, {...item, rows:panel.defaults.rows}];
  }));
  return compactLayout(fitted, panels, columnCount);
}

export function convertLegacyLayout(
  legacy,
  panels,
  columnCount,
  workspaceWidth,
  panelDesktops = null,
  desktopIds = [],
) {
  const columnStride = (workspaceWidth + GAP_PX) / columnCount;
  const rowStride = ROW_HEIGHT_PX + GAP_PX;
  const converted = {};
  panels.forEach((panel) => {
    const old = legacy?.[panel.legacyId || panel.id];
    if (!old) return;
    converted[panel.id] = {
      column:Math.round(Number(old.x || 0) / columnStride),
      row:Math.round(Number(old.y || 0) / rowStride),
      columns:Math.round((Number(old.w || 0) + GAP_PX) / columnStride),
      rows:Math.round((Number(old.h || 0) + GAP_PX) / rowStride),
    };
  });
  return panelDesktops && desktopIds.length
    ? repairDesktopLayouts(converted, panels, panelDesktops, desktopIds, columnCount)
    : repairLayout(converted, panels, columnCount);
}
