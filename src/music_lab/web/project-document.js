export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_STORAGE_KEY = "key-tune-project-v1";
export const TIMBRE_STORAGE_KEY = "music-lab-saved-timbres";

const DEFAULT_SECTION_KEYS = Object.freeze({
  layout:"music-lab-grid-layout-v1",
  presentation:"music-lab-presentation-layouts-v1",
  timbres:TIMBRE_STORAGE_KEY,
});

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function readJson(storage, key) {
  try {
    return JSON.parse(storage.getItem(key) || "null");
  } catch (_) {
    return null;
  }
}

export function normalizeProjectDocument(candidate = {}) {
  const source = candidate && typeof candidate === "object" ? candidate : {};
  return {
    version:PROJECT_SCHEMA_VERSION,
    layout:source.layout && typeof source.layout === "object" ? clone(source.layout) : null,
    presentation:source.presentation && typeof source.presentation === "object"
      ? clone(source.presentation)
      : null,
    timbres:source.timbres && typeof source.timbres === "object" && !Array.isArray(source.timbres)
      ? clone(source.timbres)
      : {},
  };
}

export function loadProjectDocument(storage, sectionKeys = DEFAULT_SECTION_KEYS) {
  const current = readJson(storage, PROJECT_STORAGE_KEY);
  if (current?.version === PROJECT_SCHEMA_VERSION) return normalizeProjectDocument(current);

  // 第一次升级时只读取旧键，不删除它们；如果迁移失败，用户仍能回到旧版本恢复布局。
  return normalizeProjectDocument({
    layout:readJson(storage, sectionKeys.layout),
    presentation:readJson(storage, sectionKeys.presentation),
    timbres:readJson(storage, sectionKeys.timbres),
  });
}

export function saveProjectDocument(storage, document) {
  const normalized = normalizeProjectDocument(document);
  storage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function createProjectStorage(storage, sectionKeys = DEFAULT_SECTION_KEYS) {
  let document = saveProjectDocument(storage, loadProjectDocument(storage, sectionKeys));
  const sectionByKey = new Map(Object.entries(sectionKeys).map(([section, key]) => [key, section]));

  const persistSection = (key, rawValue) => {
    const section = sectionByKey.get(key);
    if (!section) return false;
    let value = null;
    try {
      value = JSON.parse(rawValue);
    } catch (_) {
      value = section === "timbres" ? {} : null;
    }
    document = saveProjectDocument(storage, {...document, [section]:value});
    return true;
  };

  return {
    getItem(key) {
      const section = sectionByKey.get(key);
      return section ? JSON.stringify(document[section]) : storage.getItem(key);
    },
    setItem(key, value) {
      if (!persistSection(key, value)) storage.setItem(key, value);
    },
    removeItem(key) {
      const section = sectionByKey.get(key);
      if (!section) return storage.removeItem(key);
      document = saveProjectDocument(storage, {
        ...document,
        [section]:section === "timbres" ? {} : null,
      });
    },
    getDocument() {
      return clone(document);
    },
    replaceDocument(nextDocument) {
      document = saveProjectDocument(storage, nextDocument);
      return clone(document);
    },
  };
}
