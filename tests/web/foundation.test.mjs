import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compactLayout,
  convertLegacyLayout,
  createGridLayoutManager,
  fitLayout,
  LAYOUT_SCHEMA_VERSION,
  LAYOUT_STORAGE_KEY,
  overlappingPairs,
  repairLayout,
  resolveLayoutWithAnchor,
} from "../../src/music_lab/web/layout-manager.js";
import {
  mergeLiveSnapshot,
  replaceAnalysis,
  replaceSnapshot,
} from "../../src/music_lab/web/instrument-state.js";
import {
  lissajousTraceWindow,
  compactPitchIdentityLabel,
  pitchIdentityLabel,
  relationshipColumns,
  tonesHighToLow,
} from "../../src/music_lab/web/chord-view.js";
import { PANEL_MANIFEST } from "../../src/music_lab/web/panel-manifest.js";
import {
  loadPresentationDocument,
  moveScene,
  nextSceneId,
  savePresentationDocument,
} from "../../src/music_lab/web/presentation-layout.js";
import { delayedPhasePoints } from "../../src/music_lab/web/signal-view.js";
import {
  createSpectrumMemory,
  spectrumAfterglowBrightness,
  spectrumAfterglowColumns,
  updateSpectrumMemoryFrame,
} from "../../src/music_lab/web/spectrum-memory.js";

const panels = [
  {id:"a", legacyId:"old-a", minColumns:2, minRows:2, defaults:{column:0,row:0,columns:4,rows:4}},
  {id:"b", minColumns:2, minRows:2, defaults:{column:4,row:0,columns:4,rows:4}},
  {id:"c", minColumns:2, minRows:2, defaults:{column:0,row:4,columns:4,rows:4}},
];

test("compact and wide panel manifests are collision-free and respect minimums", () => {
  for (const [mode, columnCount] of [["compact", 12], ["wide", 24]]) {
    const layout = Object.fromEntries(
      PANEL_MANIFEST.map((panel) => [panel.id, panel.layouts[mode]]),
    );
    assert.deepEqual(overlappingPairs(layout), [], `${mode} layout overlaps`);
    PANEL_MANIFEST.forEach((panel) => {
      const item = layout[panel.id];
      assert.ok(item.columns >= panel.minColumns);
      assert.ok(item.rows >= panel.minRows);
      assert.ok(item.column + item.columns <= columnCount);
    });
  }
});

test("mapping compiler has room for independent reference and strategy controls", () => {
  const mappingPanel = PANEL_MANIFEST.find((panel) => panel.id === "mappingPanel");
  assert.equal(mappingPanel.minRows, 9);
  assert.equal(mappingPanel.layouts.compact.rows, 10);
  assert.equal(mappingPanel.layouts.wide.rows, 10);
});

test("fitLayout restores recommended heights while preserving panel widths", () => {
  const fitted = fitLayout(
    {a:{column:0,row:10,columns:5,rows:12}, b:{column:5,row:3,columns:3,rows:9}},
    [
      {...panels[0], defaults:{column:0,row:0,columns:4,rows:3}},
      {...panels[1], defaults:{column:4,row:0,columns:4,rows:4}},
    ],
    12,
  );
  assert.equal(fitted.a.columns, 5);
  assert.equal(fitted.a.rows, 3);
  assert.equal(fitted.b.columns, 3);
  assert.equal(fitted.b.rows, 4);
  assert.deepEqual(overlappingPairs(fitted), []);
});

test("saved defaults include panel view controls and reset restores them", () => {
  const makeTarget = () => {
    const listeners = new Map();
    const classes = new Set();
    return {
      style:{setProperty(name, value) { this[name] = value; }},
      classList:{
        add:(name) => classes.add(name),
        remove:(name) => classes.delete(name),
        toggle:(name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      },
      append() {},
      addEventListener(type, listener) {
        const current = listeners.get(type) || [];
        current.push(listener);
        listeners.set(type, current);
      },
      dispatch(type) {
        (listeners.get(type) || []).forEach((listener) => listener({}));
      },
      textContent:"",
    };
  };
  const values = new Map();
  const storage = {
    getItem:(key) => values.get(key) ?? null,
    setItem:(key, value) => values.set(key, value),
  };
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = {createElement:makeTarget};
  globalThis.window = {addEventListener() {}, removeEventListener() {}};
  try {
    const resetButton = makeTarget();
    const workspace = {...makeTarget(), clientWidth:1800};
    const panel = {
      id:"a",
      minColumns:2,
      minRows:2,
      layouts:{
        compact:{column:0,row:0,columns:4,rows:4},
        wide:{column:0,row:0,columns:8,rows:4},
      },
      element:makeTarget(),
    };
    let viewSettings = {trailExponent:0, drift:0.25, autoClose:true};
    const manager = createGridLayoutManager({
      workspace,
      panels:[panel],
      lockButton:makeTarget(),
      alignButton:makeTarget(),
      saveDefaultButton:makeTarget(),
      resetButton,
      storage,
      getViewSettings:() => viewSettings,
      applyViewSettings:(settings) => { viewSettings = {...settings}; },
    });

    viewSettings = {trailExponent:1.25, drift:-2.5, autoClose:false};
    manager.saveViewSettings();
    manager.setPanelVisible("a", false);
    manager.saveAsDefault();
    viewSettings = {trailExponent:-1, drift:3.5, autoClose:true};
    manager.saveViewSettings();
    manager.setPanelVisible("a", true);
    resetButton.dispatch("click");

    assert.deepEqual(
      viewSettings,
      {trailExponent:1.25, drift:-2.5, autoClose:false},
    );
    const saved = JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY));
    assert.equal(saved.version, LAYOUT_SCHEMA_VERSION);
    assert.deepEqual(saved.view_settings.wide, viewSettings);
    assert.deepEqual(saved.user_default_view_settings.wide, viewSettings);
    assert.deepEqual(saved.user_default_hidden_panels.wide, ["a"]);
    assert.equal(manager.isPanelVisible("a"), false);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test("presentation layouts preserve snapshots and ordered playback", () => {
  const values = new Map();
  const storage = {
    getItem:(key) => values.get(key) ?? null,
    setItem:(key, value) => values.set(key, value),
  };
  const fallback = {
    name:"工作台",
    layout:{spectrumPanel:{column:0,row:0,columns:4,rows:4}},
    viewSettings:{spectrumHistory:true},
    hiddenPanels:["chordPanel"],
    actions:[{type:"toast", message:"ready"}],
  };
  const documentData = loadPresentationDocument(storage, fallback);
  documentData.scenes.push({
    id:"second", name:"放映页", durationSeconds:8,
    layout:{keyboardPanel:{column:0,row:0,columns:8,rows:5}},
    viewSettings:{spectrumHistory:false}, hiddenPanels:[],
  });
  documentData.selectedId = "second";
  savePresentationDocument(storage, documentData);
  const restored = loadPresentationDocument(storage, fallback);
  assert.equal(restored.scenes.length, 2);
  assert.equal(restored.selectedId, "second");
  assert.deepEqual(restored.scenes[0].actions, [{type:"toast", message:"ready"}]);
  assert.equal(nextSceneId(restored.scenes, "second", 1), restored.scenes[0].id);
  assert.deepEqual(moveScene(restored.scenes, "second", -1).map((scene) => scene.id), ["second", restored.scenes[0].id]);
});

test("layout presentation and panel focus controls are available", () => {
  const html = readFileSync(
    new URL("../../src/music_lab/web/index.html", import.meta.url),
    "utf8",
  );
  const appSource = readFileSync(
    new URL("../../src/music_lab/web/app.js", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="layoutSceneSelect"/);
  assert.match(html, /id="layoutPresentationToggle"/);
  assert.match(appSource, /initializePresentationLayouts/);
  assert.match(appSource, /applySnapshot/);
});

test("every registered panel has a visibility toggle", () => {
  const html = readFileSync(
    new URL("../../src/music_lab/web/index.html", import.meta.url),
    "utf8",
  );
  const toggleIds = [...html.matchAll(/class="view-toggle active" data-panel="([^"]+)"/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(toggleIds, PANEL_MANIFEST.map((panel) => panel.id).sort());
});

test("global actions live in the panels they control", () => {
  const html = readFileSync(
    new URL("../../src/music_lab/web/index.html", import.meta.url),
    "utf8",
  );
  const mappingPanel = html.slice(
    html.indexOf('<section id="mappingPanel"'),
    html.indexOf('<main class="dashboard">'),
  );
  const tracksPanel = html.slice(
    html.indexOf('<section id="tracksPanel"'),
    html.indexOf('<aside id="chordPanel"'),
  );
  assert.match(mappingPanel, /id="volumeSlider"/);
  assert.match(tracksPanel, /id="recordButton"/);
  assert.match(tracksPanel, /id="addTrackButton"/);
  assert.match(tracksPanel, /id="midiFile"/);
  assert.match(html, /id="layoutSaveDefaultButton"/);
});

test("tuning and chord relations use separate, explicit references", () => {
  const html = readFileSync(
    new URL("../../src/music_lab/web/index.html", import.meta.url),
    "utf8",
  );
  const pitchIdentityPanel = html.slice(
    html.indexOf('<aside id="pitchIdentityPanel"'),
    html.indexOf('<aside id="chordPanel"'),
  );
  const chordPanel = html.slice(
    html.indexOf('<aside id="chordPanel"'),
    html.indexOf('<section id="spectrumPanel"'),
  );
  assert.match(pitchIdentityPanel, /05 \/ PITCH IDENTITY/);
  assert.match(pitchIdentityPanel, /律制参考 T/);
  assert.match(pitchIdentityPanel, /相对 T · 律制关系/);
  assert.match(pitchIdentityPanel, /相对律制参考 T 的关系分解/);
  assert.doesNotMatch(pitchIdentityPanel, /<span>实际频率<\/span>/);
  assert.match(chordPanel, /06 \/ CHORD RELATION/);
  assert.match(chordPanel, /和弦基准 B/);
  assert.match(chordPanel, /id="chordBasisMode"/);
  assert.match(chordPanel, /最低实音/);
  assert.match(chordPanel, /选定音高/);
  assert.match(chordPanel, /虚拟 f\/T/);
  assert.match(chordPanel, /自动 · 最简关系/);
  assert.match(chordPanel, /自动 · 共同基频/);
  assert.match(chordPanel, /自动 · 复合策略/);
  assert.match(chordPanel, /id="virtualBasisRatio"/);
  assert.match(chordPanel, /相对 B · 和弦关系/);
  assert.match(chordPanel, /相对和弦基准 B 的关系分解/);
  assert.doesNotMatch(chordPanel, /相对 B 音分|关系误差/);
  assert.doesNotMatch(pitchIdentityPanel, /律制误差/);
  assert.doesNotMatch(chordPanel, /相对参考音/);
  for (const panel of [pitchIdentityPanel, chordPanel]) {
    assert.match(panel, /音高身份 · Hz/);
    assert.doesNotMatch(panel, /物理按键 · MIDI · 力度/);
    assert.match(panel, /class="prime-vector prime-vector-header"/);
    assert.match(panel, /<i>2<\/i><i>3<\/i><i>5<\/i><i>7<\/i><i>11<\/i><i>ALG<\/i>/);
  }
  assert.doesNotMatch(chordPanel, /id="frequencyValue"/);
});

test("selected chord bases use a stable visible row action", () => {
  const appSource = readFileSync(
    new URL("../../src/music_lab/web/app.js", import.meta.url),
    "utf8",
  );
  const styles = readFileSync(
    new URL("../../src/music_lab/web/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(appSource, /basisButton\.textContent = "设 B"/);
  assert.match(
    appSource,
    /applyChordBasis\(\{mode:"selected", midi_note:tone\.midi_note\}\)/,
  );
  assert.match(styles, /\.basis-row-action \{/);
  assert.doesNotMatch(
    styles,
    /\.basis-row-action \{[^}]*background:\s*transparent/s,
  );
  assert.doesNotMatch(appSource, /pitchCellMarkup\(tone, tone\.is_basis/);
});

test("panels use compact English title bars without redundant Chinese headings", () => {
  const html = readFileSync(
    new URL("../../src/music_lab/web/index.html", import.meta.url),
    "utf8",
  );
  const panel = html.slice(
    html.indexOf('<section id="lissajousPanel"'),
    html.indexOf('<section id="keyboardPanel"'),
  );
  assert.match(panel, /08 \/ CHORD LISSAJOUS/);
  assert.match(panel, /分析基准 B × 发声音/);
  assert.doesNotMatch(panel, /<h2>|id="lissajousLegend"/);
  assert.doesNotMatch(html, /<h2>/);
  assert.match(html, /id="timbreLibraryPopover"/);
  assert.doesNotMatch(html, /id="savedTimbreSelect"/);
});

test("open Lissajous traces drift while exactly closed traces stay fixed", () => {
  const closedAtStart = lissajousTraceWindow(3 / 2, 0);
  const closedLater = lissajousTraceWindow(3 / 2, 5);
  assert.equal(closedAtStart.closed, true);
  assert.equal(closedAtStart.rootCycles, 2);
  assert.equal(closedAtStart.phaseOffset, 0);
  assert.equal(closedLater.phaseOffset, 0);

  const openAtStart = lissajousTraceWindow(Math.SQRT2, 0);
  const openLater = lissajousTraceWindow(Math.SQRT2, 5);
  assert.equal(openAtStart.closed, false);
  assert.ok(Math.abs(openAtStart.rootCycles - 16 / Math.sqrt(3)) < 1e-9);
  assert.equal(openAtStart.phaseOffset, 0);
  assert.ok(openLater.phaseOffset > openAtStart.phaseOffset);

  const adjusted = lissajousTraceWindow(Math.SQRT2, 2, {
    trailScale:2,
    driftCyclesPerSecond:-1,
  });
  assert.ok(Math.abs(adjusted.rootCycles - 32 / Math.sqrt(3)) < 1e-9);
  assert.equal(adjusted.phaseOffset, -4 * Math.PI);
  const forcedOpen = lissajousTraceWindow(3 / 2, 1, {autoClose:false});
  assert.equal(forcedOpen.closed, false);
  assert.notEqual(forcedOpen.rootCycles, 2);
});

test("delayed phase points use full-rate mono output and requested delay", () => {
  assert.deepEqual(
    delayedPhasePoints([0, 1, 2, 3], 1000, 1),
    [{x:1, y:0}, {x:2, y:1}, {x:3, y:2}],
  );
});

test("spectrum afterglow uses a perceptual half-life and preserves short hits", () => {
  const memory = createSpectrumMemory();
  const sounding = [{frequency_hz:440, level:1}];
  const silent = [{frequency_hz:440, level:0}];
  updateSpectrumMemoryFrame(memory, sounding, {
    nowMs:0,
    halfLifeSeconds:5,
    rms:0.2,
    peak:0.5,
  });
  const initialExposure = memory.exposure[0];
  const initialPeak = memory.peaks[0];
  assert.ok(initialExposure > 0.25, "a single analysis frame must leave a visible trace");
  updateSpectrumMemoryFrame(memory, silent, {
    nowMs:5000,
    halfLifeSeconds:5,
  });
  assert.ok(Math.abs(memory.exposure[0] / initialExposure - 0.5) < 1e-9);
  assert.equal(memory.peaks[0], initialPeak, "background history keeps its recorded peak shape");
  assert.ok(spectrumAfterglowBrightness(memory.exposure[0]) > memory.exposure[0]);
});

test("repeated spectrum hits accumulate exposure without exceeding one", () => {
  const memory = createSpectrumMemory();
  const sounding = [{frequency_hz:220, level:0.4}];
  updateSpectrumMemoryFrame(memory, sounding, {nowMs:0, rms:0.1, peak:0.2});
  const firstExposure = memory.exposure[0];
  updateSpectrumMemoryFrame(memory, sounding, {nowMs:100, rms:0.1, peak:0.2});
  assert.ok(memory.exposure[0] > firstExposure);
  assert.ok(memory.exposure[0] <= 1);
});

test("spectrum burn gain controls how quickly history accumulates", () => {
  const point = [{frequency_hz:440, level:0.5}];
  const slow = createSpectrumMemory();
  const fast = createSpectrumMemory();
  updateSpectrumMemoryFrame(slow, point, {
    nowMs:0, rms:0.1, peak:0.2, burnGain:0.25,
  });
  updateSpectrumMemoryFrame(fast, point, {
    nowMs:0, rms:0.1, peak:0.2, burnGain:4,
  });
  assert.ok(fast.exposure[0] > slow.exposure[0] * 5);
});

test("spectrum history becomes background frequency columns instead of a line", () => {
  const memory = createSpectrumMemory();
  memory.frequencies = [100, 1000];
  memory.peaks = [0.8, 0.2];
  memory.exposure = [0.9, 0.1];
  const points = [
    {frequency_hz:100, level:0},
    {frequency_hz:1000, level:0},
  ];
  const columns = spectrumAfterglowColumns(memory, points, {
    columnCount:2,
    minimumFrequency:100,
    maximumFrequency:1000,
  });
  assert.ok(columns[0].brightness > columns[1].brightness);

  const appSource = readFileSync(
    new URL("../../src/music_lab/web/app.js", import.meta.url),
    "utf8",
  );
  const memoryRenderer = appSource.slice(
    appSource.indexOf("function drawSpectrumMemory"),
    appSource.indexOf("function drawPartialRelations"),
  );
  assert.match(memoryRenderer, /createLinearGradient/);
  assert.match(memoryRenderer, /fillRect/);
  assert.match(memoryRenderer, /historyDepth/);
  assert.doesNotMatch(memoryRenderer, /lineTo|stroke\(/);

  const html = readFileSync(
    new URL("../../src/music_lab/web/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="historyBurnGain"/);
  assert.match(html, /id="historyDepth"/);
  assert.match(appSource, /spectrumBurnGain/);
  assert.match(appSource, /spectrumHistoryDepth/);
});

test("the final-output delayed phase view is an independent panel", () => {
  const html = readFileSync(
    new URL("../../src/music_lab/web/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="lissajousTrailLength"/);
  assert.match(html, /id="lissajousDriftSpeed"/);
  assert.match(html, /id="lissajousAutoClose"/);
  assert.match(html, /id="outputPhasePanel"/);
  assert.match(html, /09 \/ OUTPUT PHASE/);
  assert.match(html, /S\(t\) × S\(t−τ\)/);
  assert.match(html, /10 \/ INPUT SURFACE/);
});

test("the keyboard keeps B visible and separates hover from selection", () => {
  const appSource = readFileSync(
    new URL("../../src/music_lab/web/app.js", import.meta.url),
    "utf8",
  );
  assert.match(appSource, /function drawChordBasisMarker/);
  assert.doesNotMatch(appSource, /function drawUnsoundedBasisMarker/);
  assert.match(appSource, /ctx\.setLineDash\(basis\.sounding \? \[\] : \[5, 4\]\)/);
  assert.match(appSource, /selectedNote: null/);
  assert.match(appSource, /hoveredInputId: null/);
  assert.match(appSource, /addEventListener\("mouseleave"/);
  assert.match(appSource, /addEventListener\("pointerleave"/);
  assert.match(appSource, /clearKeyboardHover/);
  assert.match(appSource, /addEventListener\("click"/);
  const mouseMoveHandler = appSource.slice(
    appSource.indexOf('keyboardCanvas.addEventListener("mousemove"'),
    appSource.indexOf('keyboardCanvas.addEventListener("mouseleave"'),
  );
  assert.doesNotMatch(mouseMoveHandler, /selectedNote\s*=/);
  assert.match(mouseMoveHandler, /hoveredInputId\s*=/);
});

test("chord rows run high-to-low with explicit aligned prime exponents", () => {
  assert.deepEqual(
    tonesHighToLow([
      {frequency_hz:220},
      {frequency_hz:440},
      {frequency_hz:330},
    ]).map((tone) => tone.frequency_hz),
    [440, 330, 220],
  );
  assert.deepEqual(
    relationshipColumns({
      relationship_kind:"exact harmonic ratio",
      prime_vector:{"2":-2, "5":1},
      prime_vector_label:"2^-2 · 5^1",
    }),
    {primeExponents:["-2", "0", "1", "0", "0"], algebraicRelation:"—"},
  );
  assert.deepEqual(
    relationshipColumns({
      relationship_kind:"exact algebraic relation",
      prime_vector:{},
      prime_vector_label:"√2^(3/12)",
    }),
    {primeExponents:["—", "—", "—", "—", "—"], algebraicRelation:"√2^(3/12)"},
  );
  assert.deepEqual(
    relationshipColumns({
      relationship_kind:"exact timbre-partial relation",
      prime_vector:{},
      prime_vector_label:"P×1.4142136",
    }),
    {primeExponents:["—", "—", "—", "—", "—"], algebraicRelation:"P×1.4142136"},
  );
});

test("pitch identity only includes a traditional alias when one is provided", () => {
  assert.equal(
    pitchIdentityLabel({pitch_label:"R0[-1:3]_12", traditional_alias:"C4"}),
    "C4 · R0[-1:3]_12",
  );
  assert.equal(
    pitchIdentityLabel({pitch_label:"R0[-1:10]_19", traditional_alias:null}),
    "R0[-1:10]_19",
  );
  assert.equal(
    compactPitchIdentityLabel({
      pitch_label:"R0[-1:3]_12",
      traditional_alias:"C4",
      equave:-1,
      degree:3,
    }, 12),
    "C4",
  );
  assert.equal(
    compactPitchIdentityLabel({
      pitch_label:"R0[-1:10]_19",
      traditional_alias:null,
      equave:-1,
      degree:10,
    }, 19),
    "[-1:10]_19",
  );
});

test("chord relationship multiplier does not repeat the equave coordinate", () => {
  const appSource = readFileSync(
    new URL("../../src/music_lab/web/app.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(appSource, /ratio_label\} · E\$\{tone\.equave\}/);
});

test("repairLayout removes overlap without changing panel sizes", () => {
  const repaired = repairLayout({
    a:{column:0,row:0,columns:4,rows:4},
    b:{column:2,row:0,columns:4,rows:4},
    c:{column:0,row:2,columns:4,rows:4},
  }, panels, 12);
  assert.deepEqual(overlappingPairs(repaired), []);
  assert.deepEqual(repaired.a, {column:0,row:0,columns:4,rows:4});
  assert.equal(repaired.b.rows, 4);
  assert.equal(repaired.c.columns, 4);
});

test("moving a panel pushes only colliding panels downward deterministically", () => {
  const base = Object.fromEntries(panels.map((panel) => [panel.id, panel.defaults]));
  const moved = resolveLayoutWithAnchor(
    base,
    panels,
    "a",
    {column:4,row:0,columns:4,rows:4},
    12,
  );
  assert.deepEqual(overlappingPairs(moved), []);
  assert.deepEqual(moved.a, {column:4,row:0,columns:4,rows:4});
  assert.equal(moved.b.row, 4);
  assert.deepEqual(moved.c, base.c);
});

test("compactLayout packs upward while preserving columns and preventing overlap", () => {
  const compacted = compactLayout({
    a:{column:0,row:8,columns:4,rows:4},
    b:{column:4,row:12,columns:4,rows:4},
    c:{column:0,row:20,columns:4,rows:4},
  }, panels, 12);
  assert.deepEqual(overlappingPairs(compacted), []);
  assert.equal(compacted.a.row, 0);
  assert.equal(compacted.b.row, 0);
  assert.equal(compacted.c.row, 4);
});

test("legacy pixel layouts migrate to bounded grid coordinates", () => {
  const converted = convertLegacyLayout({
    "old-a":{x:0,y:0,w:390,h:300},
    b:{x:400,y:0,w:390,h:300},
    c:{x:0,y:310,w:390,h:300},
  }, panels, 12, 1200);
  assert.deepEqual(overlappingPairs(converted), []);
  Object.values(converted).forEach((item) => {
    assert.ok(item.column >= 0);
    assert.ok(item.column + item.columns <= 12);
    assert.ok(item.rows >= 2);
  });
});

test("instrument state rejects incompatible payloads and merges live data", () => {
  const uiState = {snapshot:null, analysis:null};
  assert.throws(
    () => replaceSnapshot(uiState, {schema_version:10}),
    /数据版本不兼容/,
  );
  assert.throws(
    () => replaceSnapshot(uiState, {schema_version:7}),
    /数据版本不兼容/,
  );
  replaceSnapshot(uiState, {
    schema_version:8,
    midi:{}, audio:{}, keyboard:{active:[]}, tracks:[{id:"performance",name:"old",notes:[]}],
  });
  mergeLiveSnapshot(uiState, {
    schema_version:8,
    midi:{connected:true}, audio:{running:true}, keyboard_active:[{midi_note:60}],
    recording:true, record_elapsed_seconds:1, performance:[{midi_note:60}],
    performance_name:"演奏 1", last_control_change:null,
    playback:{playing:false}, chord:{size:1},
  });
  replaceAnalysis(uiState, {schema_version:8, spectrum:[]});
  assert.equal(uiState.snapshot.keyboard.active[0].midi_note, 60);
  assert.equal(uiState.snapshot.tracks[0].name, "演奏 1");
  assert.equal(uiState.analysis.schema_version, 8);
});

test("tuning spaces, input surfaces, and mappings are separate UI contracts", () => {
  const html = readFileSync(
    new URL("../../src/music_lab/web/index.html", import.meta.url),
    "utf8",
  );
  const appSource = readFileSync(
    new URL("../../src/music_lab/web/app.js", import.meta.url),
    "utf8",
  );
  assert.match(html, /02 \/ TUNING SPACE/);
  assert.match(html, /id="tuningConstruction"/);
  assert.match(html, /value="generator_lattice"/);
  assert.match(html, /id="tuningEquaveExpression"/);
  assert.match(html, /03 \/ MAPPING COMPILER/);
  assert.match(html, /id="mappingAnchorNode"/);
  assert.match(html, /id="mappingReferenceDegree"/);
  assert.match(html, /id="inputSurfaceSelect"/);
  assert.match(appSource, /api\/input-surface/);
  assert.match(appSource, /api\/input\/\$\{encodeURIComponent\(key\.nodeId\)\}\/on/);
});

test("tuning definitions use an open library and interval-cycle editor contract", () => {
  const html = readFileSync(
    new URL("../../src/music_lab/web/index.html", import.meta.url),
    "utf8",
  );
  const appSource = readFileSync(
    new URL("../../src/music_lab/web/app.js", import.meta.url),
    "utf8",
  );
  const styles = readFileSync(
    new URL("../../src/music_lab/web/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(html, /value="interval_cycle"/);
  assert.match(html, /id="tuningIntervalExpressions"/);
  assert.match(html, /id="tuningLibraryButton"/);
  assert.match(html, /id="saveTuningButton"/);
  assert.match(html, /id="reloadTuningLibraryButton"/);
  assert.match(appSource, /\/api\/tuning\/library/);
  assert.match(appSource, /library-open/);
  assert.match(styles, /\.tuning-space-panel\.library-open/);
});

test("tuning-space visualization is circular, logarithmic, and keeps T as an overlay", () => {
  const html = readFileSync(
    new URL("../../src/music_lab/web/index.html", import.meta.url),
    "utf8",
  );
  const appSource = readFileSync(
    new URL("../../src/music_lab/web/app.js", import.meta.url),
    "utf8",
  );
  const viewSource = readFileSync(
    new URL("../../src/music_lab/web/tuning-space-view.js", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="tuningSpaceCanvas"/);
  assert.match(appSource, /function drawTuningSpace/);
  assert.match(viewSource, /normalizedPosition \* TAU/);
  assert.match(viewSource, /construction\.kind === "generator_chain"/);
  assert.match(viewSource, /space\.construction\.basis/);
  assert.match(viewSource, /referencePoint/);
  assert.match(viewSource, /rulerLeft/);
  assert.match(appSource, /"chrome", "tuningPanel", "keyboardPanel"/);
  assert.match(viewSource, /activeTuningPoints/);
  assert.match(viewSource, /dataset\.activePitchCount/);
  assert.match(appSource, /function tuningSpaceDescription/);
  assert.match(appSource, /键位与 Hz 由 03 编译/);
});

test("track controls expose per-axis tuning compilation", () => {
  const appSource = readFileSync(
    new URL("../../src/music_lab/web/app.js", import.meta.url),
    "utf8",
  );
  assert.match(appSource, /data-track-compile/);
  assert.match(appSource, /\/api\/tracks\/\$\{encodeURIComponent\(select\.dataset\.track\)\}\/compile/);
  assert.match(appSource, /track\.source_timing\?\.ticks_per_beat/);
});
