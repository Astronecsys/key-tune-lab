import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECT_SCHEMA_VERSION,
  PROJECT_STORAGE_KEY,
  TIMBRE_STORAGE_KEY,
  createProjectStorage,
  loadProjectDocument,
} from "../../src/music_lab/web/project-document.js";

const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem:(key) => values.has(key) ? values.get(key) : null,
    setItem:(key, value) => values.set(key, String(value)),
    removeItem:(key) => values.delete(key),
  };
};

test("legacy layout, presentation, and timbres migrate into one project document", () => {
  const storage = memoryStorage({
    "music-lab-grid-layout-v1":JSON.stringify({version:4, active_desktop:"desktop2"}),
    "music-lab-presentation-layouts-v1":JSON.stringify({version:2, scenes:[{id:"demo"}]}),
    [TIMBRE_STORAGE_KEY]:JSON.stringify({glass:[{multiple:1, amplitude:1}]}),
  });

  const project = loadProjectDocument(storage);

  assert.equal(project.version, PROJECT_SCHEMA_VERSION);
  assert.equal(project.layout.active_desktop, "desktop2");
  assert.equal(project.presentation.scenes[0].id, "demo");
  assert.equal(project.timbres.glass[0].multiple, 1);
});

test("project storage gives legacy modules isolated section views", () => {
  const storage = memoryStorage();
  const projectStorage = createProjectStorage(storage);
  projectStorage.setItem("music-lab-grid-layout-v1", JSON.stringify({version:4}));
  projectStorage.setItem(TIMBRE_STORAGE_KEY, JSON.stringify({warm:[{multiple:1, amplitude:1}]}));

  const document = JSON.parse(storage.getItem(PROJECT_STORAGE_KEY));

  assert.equal(document.layout.version, 4);
  assert.equal(document.timbres.warm.length, 1);
  assert.equal(JSON.parse(projectStorage.getItem("music-lab-grid-layout-v1")).version, 4);
});

test("invalid imported sections normalize without destroying the other sections", () => {
  const storage = memoryStorage();
  const projectStorage = createProjectStorage(storage);
  projectStorage.replaceDocument({
    version:999,
    layout:{version:4},
    presentation:"broken",
    timbres:["broken"],
  });

  assert.deepEqual(projectStorage.getDocument(), {
    version:PROJECT_SCHEMA_VERSION,
    layout:{version:4},
    presentation:null,
    timbres:{},
  });
});
