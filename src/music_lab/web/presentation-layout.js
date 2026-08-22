export const PRESENTATION_STORAGE_KEY = "music-lab-presentation-layouts-v1";
export const PRESENTATION_SCHEMA_VERSION = 1;

const clone = (value) => JSON.parse(JSON.stringify(value));

function sceneId() {
  return `layout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function normalizeScene(scene, fallback = {}) {
  const candidate = scene && typeof scene === "object" ? scene : {};
  return {
    id: String(candidate.id || sceneId()),
    name: String(candidate.name || fallback.name || "未命名布局"),
    durationSeconds: Math.max(2, Math.min(3600, Number(candidate.durationSeconds) || 12)),
    layout: clone(candidate.layout || fallback.layout || {}),
    viewSettings: clone(candidate.viewSettings || fallback.viewSettings || {}),
    hiddenPanels: Array.isArray(candidate.hiddenPanels)
      ? [...new Set(candidate.hiddenPanels.map(String))]
      : [...new Set(fallback.hiddenPanels || [])],
  };
}

export function loadPresentationDocument(storage, fallbackScene) {
  let raw = null;
  try {
    raw = JSON.parse(storage.getItem(PRESENTATION_STORAGE_KEY) || "null");
  } catch (_) {
    raw = null;
  }
  const scenes = Array.isArray(raw?.scenes) && raw.scenes.length
    ? raw.scenes.map((scene) => normalizeScene(scene, fallbackScene))
    : [normalizeScene(fallbackScene, { name: "默认布局" })];
  const selectedId = scenes.some((scene) => scene.id === raw?.selectedId)
    ? raw.selectedId
    : scenes[0].id;
  return { version: PRESENTATION_SCHEMA_VERSION, scenes, selectedId };
}

export function savePresentationDocument(storage, document) {
  const payload = {
    version: PRESENTATION_SCHEMA_VERSION,
    selectedId: document.selectedId,
    scenes: document.scenes.map((scene) => normalizeScene(scene)),
  };
  storage.setItem(PRESENTATION_STORAGE_KEY, JSON.stringify(payload));
  return payload;
}

export function moveScene(scenes, sceneIdToMove, direction) {
  const index = scenes.findIndex((scene) => scene.id === sceneIdToMove);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= scenes.length) return scenes;
  const next = [...scenes];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function nextSceneId(scenes, currentId, direction = 1) {
  if (!scenes.length) return null;
  const index = Math.max(0, scenes.findIndex((scene) => scene.id === currentId));
  return scenes[(index + direction + scenes.length) % scenes.length].id;
}
