import {
  lissajousTraceWindow,
  RELATION_PRIMES,
  compactPitchIdentityLabel,
  pitchIdentityLabel,
  relationshipColumns,
  tonesHighToLow,
} from "./chord-view.js";
import {
  INSTRUMENT_SCHEMA_VERSION,
  mergeLiveSnapshot,
  replaceAnalysis,
  replaceSnapshot,
} from "./instrument-state.js";
import { createGridLayoutManager } from "./layout-manager.js";
import { DESKTOP_MANIFEST, PANEL_MANIFEST } from "./panel-manifest.js";
import {
  loadPresentationDocument,
  moveScene,
  nextSceneId,
  savePresentationDocument,
} from "./presentation-layout.js";
import { PanelRegistry } from "./render-scheduler.js";
import { delayedPhasePoints } from "./signal-view.js";
import {
  createSpectrumMemory,
  spectrumAfterglowColumns,
  updateSpectrumMemoryFrame,
} from "./spectrum-memory.js";
import {
  activeTuningPoints,
  drawTuningSpaceCanvas,
  tuningPointDescription,
  tuningPointFromCoordinates,
} from "./tuning-space-view.js";

const state = {
  snapshot: null,
  selectedNote: null,
  hoveredNote: null,
  selectedInputId: null,
  hoveredInputId: null,
  soundingVirtualInputId: null,
  virtualInputEpoch: 0,
  keyRects: [],
  tuningVisualPoints: [],
  selectedTuningPointId: null,
  hoveredTuningPointId: null,
  tuningEditorSourceSignature: null,
  tuningDraftDirty: false,
  refreshPending: false,
  liveRefreshPending: false,
  phaseRefreshPending: false,
  toastTimer: null,
  analysis: null,
  phase: null,
  pendingTrackId: null,
  partialDraft: null,
  partialSourceId: null,
  partialApplyTimer: null,
  selectedSavedTimbreName: null,
  chordRenderSignature: null,
  spectrumMemory:createSpectrumMemory(),
  presentation:{document:null, timer:null, playing:false, actionEpoch:0},
};

const panelRegistry = new PanelRegistry({
  onError: (error) => showToast(`面板绘制失败：${error.message}`),
});

const CATPPUCCIN = Object.freeze({
  crust: "#11111b",
  mantle: "#181825",
  base: "#1e1e2e",
  surface0: "#313244",
  surface1: "#45475a",
  surface2: "#585b70",
  overlay0: "#6c7086",
  subtext1: "#bac2de",
  text: "#cdd6f4",
  lavender: "#b4befe",
  sky: "#89dceb",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  peach: "#fab387",
  red: "#f38ba8",
  mauve: "#cba6f7",
  pink: "#f5c2e7",
});
const ROOT_TONE_COLOR = CATPPUCCIN.lavender;
const PITCH_RELATION_COLORS = Object.freeze([
  CATPPUCCIN.yellow,
  CATPPUCCIN.sky,
  CATPPUCCIN.pink,
  CATPPUCCIN.green,
  CATPPUCCIN.mauve,
  CATPPUCCIN.peach,
]);

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]);

function keyboardView() {
  const keyboard = state.snapshot.keyboard;
  const keys = keyboard.keys.map((key, index) => {
    const midiNote = key.input_midi_note ?? key.midi_note ?? null;
    return {
      ...key,
      input_node_id:key.input_node_id || (midiNote === null ? `node:${index}` : `midi:${midiNote}`),
      input_index:key.input_index ?? index,
      input_label:key.input_label || key.key_label || (midiNote === null ? `N${index}` : `K${midiNote}`),
      input_role:key.input_role || (midiNote !== null && isBlack(midiNote) ? "black" : "white"),
      input_midi_note:midiNote,
      coordinate:key.coordinate || [index],
    };
  });
  const legacyAnchor = keyboard.mapping?.anchor ?? state.snapshot.tuning.reference_midi;
  const anchorKey = keys.find((key) => key.input_midi_note === legacyAnchor)
    || keys.find((key) => key.input_midi_note === state.snapshot.tuning.reference_midi)
    || keys[0];
  return {
    ...keyboard,
    keys,
    surface:keyboard.surface || {
      id:"legacy_piano",
      name:"当前钢琴键盘",
      description:"旧版会话中的 MIDI 钢琴表面",
      kind:"piano",
      node_count:keys.length,
    },
    mapping:{
      surface_id:keyboard.surface?.id || "legacy_piano",
      mode:"continuous",
      anchor_node_id:anchorKey?.input_node_id || "",
      reference_degree:state.snapshot.tuning.reference_degree ?? 0,
      reference_frequency_hz:state.snapshot.tuning.reference_frequency_hz,
      degree_step:1,
      subset_degrees:[],
      q_step:1,
      r_step:5,
      q_ratio_expression:"3/2",
      r_ratio_expression:"5/4",
      ...keyboard.mapping,
      anchor_node_id:keyboard.mapping?.anchor_node_id || anchorKey?.input_node_id || "",
    },
  };
}

function tuningSpaceView() {
  const tuning = state.snapshot.tuning;
  if (tuning.space) return tuning.space;
  const degreeCount = Math.max(1, Number(tuning.divisions) || 12);
  const equave = Number(tuning.equave_ratio) || 2;
  const degrees = Array.from({length:degreeCount}, (_, index) => ({
    id:`d${index}`,
    index,
    expression:`${equave}^(${index}/${degreeCount})`,
    ratio:equave ** (index / degreeCount),
    normalized_position:index / degreeCount,
  }));
  return {
    equave_expression:String(equave),
    equave_ratio:equave,
    degree_count:degreeCount,
    degrees,
    construction:{kind:"equal_division", degree_count:degreeCount},
  };
}

function readPanelViewSettings() {
  return {
    partialRelations:$('partialRelationsToggle').checked,
    spectrumHistory:$('spectrumHistoryToggle').checked,
    spectrumHistorySeconds:Number($('historyDuration').value),
    spectrumBurnGain:Number($('historyBurnGain').value),
    spectrumHistoryDepth:Number($('historyDepth').value),
    lissajousTrailExponent:Number($('lissajousTrailLength').value),
    lissajousDriftCyclesPerSecond:Number($('lissajousDriftSpeed').value),
    lissajousAutoClose:$('lissajousAutoClose').checked,
    outputPhaseDelayMs:Number($('outputPhaseDelay').value),
  };
}

function applyNumericControlValue(id, value) {
  if (!Number.isFinite(Number(value))) return;
  const control = $(id);
  const minimum = Number(control.min);
  const maximum = Number(control.max);
  control.value = String(Math.max(minimum, Math.min(maximum, Number(value))));
}

function applyPanelViewSettings(settings = {}) {
  if (typeof settings.partialRelations === 'boolean') {
    $('partialRelationsToggle').checked = settings.partialRelations;
  }
  if (typeof settings.spectrumHistory === 'boolean') {
    $('spectrumHistoryToggle').checked = settings.spectrumHistory;
  }
  if (typeof settings.lissajousAutoClose === 'boolean') {
    $('lissajousAutoClose').checked = settings.lissajousAutoClose;
  }
  applyNumericControlValue('historyDuration', settings.spectrumHistorySeconds);
  applyNumericControlValue('historyBurnGain', settings.spectrumBurnGain);
  applyNumericControlValue('historyDepth', settings.spectrumHistoryDepth);
  applyNumericControlValue('lissajousTrailLength', settings.lissajousTrailExponent);
  applyNumericControlValue('lissajousDriftSpeed', settings.lissajousDriftCyclesPerSecond);
  applyNumericControlValue('outputPhaseDelay', settings.outputPhaseDelayMs);

  const historyEnabled = $('spectrumHistoryToggle').checked;
  ['historyDuration', 'historyBurnGain', 'historyDepth', 'clearSpectrumHistory']
    .forEach((id) => { $(id).disabled = !historyEnabled; });
  $('historyDurationValue').textContent = `t½ ${Number($('historyDuration').value).toFixed(1)}s`;
  $('historyBurnGainValue').textContent = `${Number($('historyBurnGain').value).toFixed(2)}×`;
  $('historyDepthValue').textContent = `${Math.round(Number($('historyDepth').value) * 100)}%`;
  $('lissajousTrailLengthValue').textContent = `${(2 ** Number($('lissajousTrailLength').value)).toFixed(2)}×`;
  const drift = Number($('lissajousDriftSpeed').value);
  $('lissajousDriftSpeedValue').textContent = `${drift >= 0 ? '+' : ''}${drift.toFixed(2)} 周期/s`;
  $('outputPhaseDelayValue').textContent = `${Number($('outputPhaseDelay').value).toFixed(1)} ms`;
  resetSpectrumMemory();
  panelRegistry.invalidate(['spectrumPanel', 'lissajousPanel', 'outputPhasePanel']);
}

function savePanelViewSettings() {
  state.freeLayout?.saveViewSettings();
}

function presentationSnapshot() {
  return state.freeLayout?.getSnapshot() || {
    layout:{},
    viewSettings:readPanelViewSettings(),
    hiddenPanels:[],
    activeDesktop:DESKTOP_MANIFEST[0].id,
    panelDesktops:Object.fromEntries(PANEL_MANIFEST.map((panel) => [panel.id, panel.desktop])),
  };
}

function persistPresentation() {
  if (state.presentation.document) {
    state.presentation.document = savePresentationDocument(
      window.localStorage,
      state.presentation.document,
    );
  }
}

function selectedPresentationScene() {
  return state.presentation.document?.scenes.find(
    (scene) => scene.id === state.presentation.document.selectedId,
  ) || state.presentation.document?.scenes[0] || null;
}

function renderPresentationControls() {
  const documentData = state.presentation.document;
  if (!documentData) return;
  const select = $("layoutSceneSelect");
  const list = $("layoutSceneList");
  const selected = selectedPresentationScene();
  select.innerHTML = documentData.scenes
    .map((scene) => `<option value="${escapeHtml(scene.id)}">${escapeHtml(scene.name)}</option>`)
    .join("");
  select.value = selected?.id || "";
  $("layoutSceneName").value = selected?.name || "";
  $("layoutSceneDuration").value = String(selected?.durationSeconds || 12);
  $("layoutSceneDurationValue").textContent = `${selected?.durationSeconds || 12}s`;
  $("layoutSceneActions").value = JSON.stringify(selected?.actions || [], null, 2);
  $("layoutActionHint").textContent = `${selected?.actions?.length || 0} 个动作 · 进入布局时按顺序执行`;
  $("layoutPresentationToggle").textContent = state.presentation.playing ? "暂停放映" : "开始放映";
  $("layoutPresentationStatus").textContent = state.presentation.playing
    ? `放映中 · ${selected?.name || "布局"} · 音频保持运行`
    : `${documentData.scenes.length} 个布局 · 可编排放映顺序`;
  list.innerHTML = documentData.scenes.map((scene, index) => `
    <button type="button" class="layout-scene-row${scene.id === selected?.id ? " selected" : ""}" data-scene-id="${escapeHtml(scene.id)}">
      <span class="layout-scene-order">${index + 1}</span><span>${escapeHtml(scene.name)}</span><small>${scene.durationSeconds}s</small>
    </button>`).join("");
}

function parseSceneActions() {
  const source = $("layoutSceneActions").value.trim();
  if (!source) return [];
  let actions;
  try {
    actions = JSON.parse(source);
  } catch (error) {
    throw new Error(`场景动作 JSON 无法解析：${error.message}`);
  }
  if (!Array.isArray(actions) || actions.some((action) => !action || typeof action !== "object" || Array.isArray(action))) {
    throw new Error("场景动作必须是 JSON 对象数组");
  }
  return actions;
}

const presentationDelay = (seconds) => new Promise((resolve) => {
  window.setTimeout(resolve, Math.max(0, Math.min(3600, Number(seconds) || 0)) * 1000);
});

function valueAtPath(root, path) {
  return String(path || "").split(".").filter(Boolean).reduce(
    (value, key) => value == null ? undefined : value[key],
    root,
  );
}

async function runSceneActions(scene, epoch) {
  for (const action of scene.actions || []) {
    if (epoch !== state.presentation.actionEpoch) return;
    try {
      const type = String(action.type || "");
      if (type === "wait") {
        await presentationDelay(action.seconds);
      } else if (type === "focus_panel") {
        state.freeLayout.focusPanel(action.panel_id || null);
      } else if (type === "switch_desktop") {
        if (!state.freeLayout.switchDesktop(action.desktop_id)) {
          throw new Error(`未知桌面：${action.desktop_id}`);
        }
      } else if (type === "set_panel_visibility") {
        state.freeLayout.setHiddenPanels(action.hidden_panels || [], {persist:false});
      } else if (type === "set_view") {
        state.freeLayout.setViewSettings(action.settings || {}, {persist:false});
      } else if (type === "clear_spectrum_history") {
        resetSpectrumMemory();
        panelRegistry.invalidate("spectrumPanel");
      } else if (type === "playback_start") {
        if (!action.track_id) throw new Error("playback_start 缺少 track_id");
        await api(`/api/playback/${encodeURIComponent(action.track_id)}/start`, {method:"POST"});
        await refreshState();
      } else if (type === "playback_stop") {
        await api("/api/playback/stop", {method:"POST"});
        await refreshState();
      } else if (type === "recording_start") {
        await api("/api/recording/start", {method:"POST"});
        await refreshState();
      } else if (type === "recording_stop") {
        await api("/api/recording/stop", {method:"POST"});
        await refreshState();
      } else if (type === "chord_basis") {
        await api("/api/chord/basis", {
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify(action.payload || action),
        });
        await refreshState();
      } else if (type === "assert_state") {
        const actual = valueAtPath(state.snapshot, action.path);
        const expected = Object.prototype.hasOwnProperty.call(action, "equals")
          ? action.equals
          : true;
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`断言失败：${action.path} = ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`);
        }
      } else if (type === "toast") {
        showToast(String(action.message || ""));
      } else if (type) {
        throw new Error(`未知场景动作：${type}`);
      }
    } catch (error) {
      showToast(`场景动作失败：${error.message}`);
      return;
    }
  }
}

function selectPresentationScene(sceneId, { startTimer = state.presentation.playing } = {}) {
  const documentData = state.presentation.document;
  const scene = documentData?.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene || !state.freeLayout) return;
  state.presentation.document.selectedId = scene.id;
  state.presentation.actionEpoch += 1;
  const actionEpoch = state.presentation.actionEpoch;
  state.freeLayout.focusPanel(null);
  state.freeLayout.applySnapshot(scene, {persist:false});
  persistPresentation();
  renderPresentationControls();
  if (startTimer) schedulePresentationAdvance();
  panelRegistry.invalidate(Object.keys(scene.layout));
  void runSceneActions(scene, actionEpoch);
}

function schedulePresentationAdvance() {
  clearTimeout(state.presentation.timer);
  if (!state.presentation.playing) return;
  const scene = selectedPresentationScene();
  state.presentation.timer = setTimeout(() => {
    const next = nextSceneId(state.presentation.document.scenes, scene?.id, 1);
    if (next) selectPresentationScene(next);
  }, Math.max(2, Number(scene?.durationSeconds) || 12) * 1000);
}

function setPresentationPlaying(playing) {
  state.presentation.playing = Boolean(playing);
  document.body.classList.toggle("presentation-playing", state.presentation.playing);
  if (state.presentation.playing) schedulePresentationAdvance();
  else clearTimeout(state.presentation.timer);
  renderPresentationControls();
}

function initializePresentationLayouts() {
  const fallback = {name:"默认布局", ...presentationSnapshot()};
  state.presentation.document = loadPresentationDocument(window.localStorage, fallback);
  renderPresentationControls();
  $("layoutSceneSelect").addEventListener("change", (event) => selectPresentationScene(event.target.value));
  $("layoutSceneList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-scene-id]");
    if (row) selectPresentationScene(row.dataset.sceneId);
  });
  $("layoutSceneSave").addEventListener("click", () => {
    let actions;
    try { actions = parseSceneActions(); } catch (error) { showToast(error.message); return; }
    const name = $("layoutSceneName").value.trim() || `布局 ${state.presentation.document.scenes.length + 1}`;
    const snapshot = presentationSnapshot();
    const scene = {id:`layout-${Date.now().toString(36)}`, name, durationSeconds:Number($("layoutSceneDuration").value), actions, ...snapshot};
    state.presentation.document.scenes.push(scene);
    state.presentation.document.selectedId = scene.id;
    persistPresentation();
    renderPresentationControls();
    showToast(`已保存布局：${name}`);
  });
  $("layoutSceneUpdate").addEventListener("click", () => {
    const scene = selectedPresentationScene();
    if (!scene) return;
    let actions;
    try { actions = parseSceneActions(); } catch (error) { showToast(error.message); return; }
    Object.assign(scene, presentationSnapshot(), {
      name:$("layoutSceneName").value.trim() || scene.name,
      durationSeconds:Number($("layoutSceneDuration").value) || 12,
      actions,
    });
    persistPresentation();
    renderPresentationControls();
    showToast(`已更新布局：${scene.name}`);
  });
  $("layoutSceneDelete").addEventListener("click", () => {
    if (state.presentation.document.scenes.length <= 1) {
      showToast("至少保留一个布局");
      return;
    }
    const index = state.presentation.document.scenes.findIndex((scene) => scene.id === state.presentation.document.selectedId);
    state.presentation.document.scenes.splice(index, 1);
    state.presentation.document.selectedId = state.presentation.document.scenes[Math.max(0, index - 1)].id;
    selectPresentationScene(state.presentation.document.selectedId, {startTimer:false});
    persistPresentation();
    renderPresentationControls();
  });
  $("layoutSceneUp").addEventListener("click", () => {
    state.presentation.document.scenes = moveScene(state.presentation.document.scenes, state.presentation.document.selectedId, -1);
    persistPresentation(); renderPresentationControls();
  });
  $("layoutSceneDown").addEventListener("click", () => {
    state.presentation.document.scenes = moveScene(state.presentation.document.scenes, state.presentation.document.selectedId, 1);
    persistPresentation(); renderPresentationControls();
  });
  $("layoutPresentationPrev").addEventListener("click", () => {
    selectPresentationScene(nextSceneId(state.presentation.document.scenes, state.presentation.document.selectedId, -1));
  });
  $("layoutPresentationNext").addEventListener("click", () => {
    selectPresentationScene(nextSceneId(state.presentation.document.scenes, state.presentation.document.selectedId, 1));
  });
  $("layoutPresentationToggle").addEventListener("click", () => setPresentationPlaying(!state.presentation.playing));
  $("layoutSceneDuration").addEventListener("input", (event) => {
    $("layoutSceneDurationValue").textContent = `${event.target.value}s`;
  });
  $("layoutSceneDuration").addEventListener("change", () => {
    const scene = selectedPresentationScene();
    if (scene) scene.durationSeconds = Number($("layoutSceneDuration").value) || 12;
    persistPresentation();
    if (state.presentation.playing) schedulePresentationAdvance();
  });
  window.KEY_TUNE_PRESENTATION = {
    getDocument:() => JSON.parse(JSON.stringify(state.presentation.document)),
    select:(sceneId) => selectPresentationScene(sceneId),
    start:() => setPresentationPlaying(true),
    stop:() => setPresentationPlaying(false),
    setActions:(sceneId, actions) => {
      const scene = state.presentation.document?.scenes.find((candidate) => candidate.id === sceneId);
      if (!scene || !Array.isArray(actions)) throw new Error("未知布局或动作不是数组");
      scene.actions = actions.filter((action) => action && typeof action === "object");
      persistPresentation();
      renderPresentationControls();
    },
  };
  window.KEY_TUNE_DESKTOPS = {
    list:() => DESKTOP_MANIFEST.map((desktop) => ({...desktop})),
    active:() => state.freeLayout?.getActiveDesktop() || null,
    switch:(desktopId) => switchActiveDesktop(desktopId, {announce:false}),
    assignments:() => state.freeLayout?.getPanelDesktops() || {},
    movePanel:(panelId, desktopId) => state.freeLayout?.setPanelDesktop(panelId, desktopId) || false,
  };
  selectPresentationScene(state.presentation.document.selectedId, {startTimer:false});
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = response.statusText;
    try { message = (await response.json()).detail || message; } catch (_) {}
    throw new Error(message);
  }
  return response.json();
}

async function applyChordBasis(payload) {
  try {
    await api("/api/chord/basis", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload),
    });
    await refreshState();
  } catch (error) { showToast(error.message); }
}

async function refreshState() {
  if (state.refreshPending) return;
  state.refreshPending = true;
  try {
    replaceSnapshot(state, await api("/api/state"));
    renderAll();
  } catch (error) {
    showToast(`无法读取状态：${error.message}`);
  } finally {
    state.refreshPending = false;
  }
}

async function refreshAnalysis() {
  try {
    replaceAnalysis(state, await api("/api/analysis"));
    panelRegistry.invalidate(["spectrumPanel", "lissajousPanel"]);
  } catch (_) {}
}

async function refreshPhase() {
  if (state.phaseRefreshPending) return;
  state.phaseRefreshPending = true;
  try {
    const response = await fetch("/api/phase?frame_count=4096", {cache:"no-store"});
    if (!response.ok) throw new Error(response.statusText);
    const schemaVersion = Number(response.headers.get("X-Schema-Version"));
    if (
      !Number.isInteger(schemaVersion)
      || schemaVersion < INSTRUMENT_SCHEMA_VERSION - 1
      || schemaVersion > INSTRUMENT_SCHEMA_VERSION
    ) throw new Error("相图数据版本不兼容");
    const samples = Array.from(new Float32Array(await response.arrayBuffer()));
    state.phase = {
      samples,
      sampleRateHz:Number(response.headers.get("X-Sample-Rate-Hz")),
    };
    panelRegistry.invalidate("outputPhasePanel");
  } catch (_) {
  } finally {
    state.phaseRefreshPending = false;
  }
}

function resizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function drawTuningSpace(space, referenceDegree) {
  const canvas = $("tuningSpaceCanvas");
  const selectedVisualId = state.hoveredTuningPointId || state.selectedTuningPointId;
  const activePitches = activeTuningPoints(
    space,
    state.snapshot.chord.tones,
    referenceDegree,
    state.snapshot.chord.reference?.frequency_hz,
  );
  state.tuningVisualPoints = drawTuningSpaceCanvas({
    canvas,
    space,
    referenceDegree,
    activePitches,
    selectedVisualId,
    palette: CATPPUCCIN,
    relationColors: PITCH_RELATION_COLORS,
    fallbackName: state.snapshot.tuning.name,
  });
  const hovered = state.tuningVisualPoints.find(
    (point) => point.visual_id === state.hoveredTuningPointId,
  );
  canvas.title = hovered
    ? tuningPointDescription(hovered)
    : activePitches.length
      ? `正在发音：${activePitches.map((point) => point.id).join(" · ")}`
      : "黄色 d0 是空间原点 · 紫色 T 来自 03 映射 · 发音时彩色光环显示实时音高";
}

function tuningPointFromPointer(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  return tuningPointFromCoordinates(
    state.tuningVisualPoints,
    event.clientX - rect.left,
    event.clientY - rect.top,
  );
}

function isBlack(note) { return [1, 3, 6, 8, 10].includes(note % 12); }

function drawChordBasisMarker(ctx, width, height, keys) {
  const basis = chordBasis(state.snapshot.chord);
  if (!basis || !Number.isFinite(basis.frequency_hz)) return;
  const mapped = keys
    .filter((key) => key.mapped && Number.isFinite(key.frequency_hz))
    .map((key) => {
      const rect = state.keyRects.find((candidate) => (
        candidate.nodeId === key.input_node_id
        || candidate.note === key.midi_note
      ));
      return rect ? {
        key,
        rect,
        x:rect.x + rect.w / 2,
        frequency:key.frequency_hz,
      } : null;
    })
    .filter(Boolean)
    .sort((first, second) => first.x - second.x);
  if (!mapped.length) return;
  const exact = mapped.find((point) => (
    point.key.input_node_id === basis.input_node_id
    || point.key.midi_note === basis.midi_note
    || Math.abs(Math.log(point.frequency / basis.frequency_hz)) < 1e-7
  ));
  let markerX = exact?.x;
  let outside = false;
  if (!exact) {
    for (let index = 0; index < mapped.length - 1; index += 1) {
      const first = mapped[index];
      const second = mapped[index + 1];
      const firstDelta = Math.log(basis.frequency_hz / first.frequency);
      const secondDelta = Math.log(basis.frequency_hz / second.frequency);
      if (firstDelta * secondDelta > 0) continue;
      const span = Math.log(second.frequency / first.frequency);
      const position = span === 0 ? 0.5 : firstDelta / span;
      markerX = first.x + (second.x - first.x) * position;
      break;
    }
  }
  if (!Number.isFinite(markerX)) {
    outside = true;
    const closest = mapped.reduce((best, point) => (
      Math.abs(Math.log(point.frequency / basis.frequency_hz))
        < Math.abs(Math.log(best.frequency / basis.frequency_hz))
        ? point
        : best
    ));
    markerX = closest.x;
  }

  $("keyboardCanvas").title = `${basis.sounding ? "发声中" : "未发声"}和弦基准 B · ${basis.frequency_hz.toFixed(3)} Hz`;

  ctx.save();
  ctx.strokeStyle = CATPPUCCIN.mauve;
  ctx.fillStyle = CATPPUCCIN.mauve;
  ctx.lineWidth = 2;
  ctx.setLineDash(basis.sounding ? [] : [5, 4]);
  if (exact) {
    ctx.strokeRect(
      exact.rect.x + 2,
      2,
      Math.max(1, exact.rect.w - 4),
      Math.max(1, exact.rect.h - 4),
    );
  } else {
    ctx.beginPath();
    ctx.moveTo(markerX, 26);
    ctx.lineTo(markerX, height - 3);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(markerX, 22);
  ctx.lineTo(markerX + 5, 27);
  ctx.lineTo(markerX, 32);
  ctx.lineTo(markerX - 5, 27);
  ctx.closePath();
  ctx.fill();
  const edgeDirection = markerX < width / 2 ? "← " : "→ ";
  const label = `${outside ? edgeDirection : ""}${basis.sounding ? "● " : ""}B ${basis.frequency_hz.toFixed(2)} Hz`;
  ctx.font = "bold 10px Consolas";
  const labelWidth = ctx.measureText(label).width + 10;
  const labelX = Math.max(2, Math.min(width - labelWidth - 2, markerX - labelWidth / 2));
  ctx.fillStyle = CATPPUCCIN.mantle;
  ctx.fillRect(labelX, 3, labelWidth, 17);
  ctx.strokeStyle = CATPPUCCIN.mauve;
  ctx.strokeRect(labelX, 3, labelWidth, 17);
  ctx.fillStyle = CATPPUCCIN.mauve;
  ctx.textAlign = "left";
  ctx.fillText(label, labelX + 5, 15);
  ctx.restore();
}

function drawKeyboard() {
  const canvas = $("keyboardCanvas");
  canvas.title = "";
  const { context: ctx, width, height } = resizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const keyboard = keyboardView();
  const keys = keyboard.keys;
  const active = new Map(keyboard.active.map((item) => [
    item.input_node_id || `midi:${item.midi_note}`,
    item,
  ]));
  state.keyRects = [];
  if (keyboard.surface.kind === "hex") {
    drawHexSurface(ctx, width, height, keys, active);
  } else {
    drawPianoSurface(ctx, width, height, keys, active);
    drawChordBasisMarker(ctx, width, height, keys);
  }
  const hoveredKey = keys.find((key) => key.input_node_id === state.hoveredInputId);
  const selectedKey = keys.find((key) => key.input_node_id === state.selectedInputId);
  const pointerDescriptions = [];
  if (hoveredKey?.mapped) {
    pointerDescriptions.push(`悬停 ${hoveredKey.input_label} · ${hoveredKey.frequency_hz.toFixed(3)} Hz`);
  }
  if (selectedKey?.mapped) {
    pointerDescriptions.push(`已选择 ${selectedKey.input_label} · ${selectedKey.frequency_hz.toFixed(3)} Hz`);
  }
  canvas.title = [canvas.title, ...pointerDescriptions].filter(Boolean).join(" · ");
}

function drawPianoSurface(ctx, width, height, keys, active) {
  const whiteKeys = keys.filter((key) => key.input_role === "white");
  const whiteWidth = width / whiteKeys.length;
  const blackWidth = whiteWidth * 0.62;
  const blackHeight = height * 0.62;
  const whitePositions = new Map();

  whiteKeys.forEach((key, index) => {
    const x = index * whiteWidth;
    whitePositions.set(key.input_midi_note, x);
    const isActive = active.has(key.input_node_id) || active.has(`midi:${key.midi_note}`);
    const isSelected = state.selectedInputId === key.input_node_id;
    const isHovered = state.hoveredInputId === key.input_node_id;
    ctx.fillStyle = !key.mapped ? CATPPUCCIN.surface2 : isActive ? CATPPUCCIN.yellow : isHovered ? CATPPUCCIN.lavender : CATPPUCCIN.text;
    ctx.fillRect(x + 0.6, 0, whiteWidth - 1.2, height - 1);
    ctx.strokeStyle = CATPPUCCIN.surface0;
    ctx.strokeRect(x + 0.6, 0, whiteWidth - 1.2, height - 1);
    if (isSelected) {
      ctx.save();
      ctx.strokeStyle = CATPPUCCIN.green;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 2, 2, Math.max(1, whiteWidth - 4), Math.max(1, height - 5));
      ctx.restore();
    }
    ctx.fillStyle = CATPPUCCIN.surface0;
    ctx.font = "11px Consolas";
    ctx.textAlign = "center";
    ctx.fillText(key.input_label, x + whiteWidth / 2, height - 43);
    ctx.fillStyle = CATPPUCCIN.surface2;
    ctx.font = "9px Consolas";
    ctx.fillText(key.mapped ? compactPitchIdentityLabel(key, state.snapshot.tuning.divisions) : "OFF", x + whiteWidth / 2, height - 27);
    ctx.fillText(key.mapped ? `${key.frequency_hz.toFixed(1)}` : "—", x + whiteWidth / 2, height - 11);
    state.keyRects.push({ nodeId:key.input_node_id, note:key.input_midi_note, x, y:0, w:whiteWidth, h:height, black:false, role:"white" });
  });

  keys.filter((key) => key.input_role === "black").forEach((key) => {
    let previous = key.input_midi_note - 1;
    while (previous >= keys[0].input_midi_note && isBlack(previous)) previous -= 1;
    const previousX = whitePositions.get(previous);
    if (previousX === undefined) return;
    const x = previousX + whiteWidth - blackWidth / 2;
    const isActive = active.has(key.input_node_id) || active.has(`midi:${key.midi_note}`);
    const isSelected = state.selectedInputId === key.input_node_id;
    const isHovered = state.hoveredInputId === key.input_node_id;
    ctx.fillStyle = !key.mapped ? CATPPUCCIN.surface0 : isActive ? CATPPUCCIN.sky : isHovered ? CATPPUCCIN.surface1 : CATPPUCCIN.crust;
    ctx.fillRect(x, 0, blackWidth, blackHeight);
    ctx.strokeStyle = CATPPUCCIN.crust;
    ctx.strokeRect(x, 0, blackWidth, blackHeight);
    if (isSelected) {
      ctx.save();
      ctx.strokeStyle = CATPPUCCIN.green;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1.5, 1.5, Math.max(1, blackWidth - 3), Math.max(1, blackHeight - 3));
      ctx.restore();
    }
    ctx.fillStyle = isActive ? CATPPUCCIN.crust : CATPPUCCIN.subtext1;
    ctx.font = `${isActive ? "bold " : ""}8px Consolas`;
    ctx.textAlign = "center";
    ctx.fillText(key.input_label, x + blackWidth / 2, blackHeight - 35);
    ctx.fillText(key.mapped ? compactPitchIdentityLabel(key, state.snapshot.tuning.divisions) : "OFF", x + blackWidth / 2, blackHeight - 22);
    ctx.fillText(key.mapped ? `${key.frequency_hz.toFixed(0)}` : "—", x + blackWidth / 2, blackHeight - 9);
    state.keyRects.push({ nodeId:key.input_node_id, note:key.input_midi_note, x, y:0, w:blackWidth, h:blackHeight, black:true, role:"black" });
  });
}

function drawHexSurface(ctx, width, height, keys, active) {
  const raw = keys.map((key) => ({
    key,
    x:Math.sqrt(3) * (key.coordinate[0] + key.coordinate[1] / 2),
    y:1.5 * key.coordinate[1],
  }));
  const minX = Math.min(...raw.map((item) => item.x));
  const maxX = Math.max(...raw.map((item) => item.x));
  const minY = Math.min(...raw.map((item) => item.y));
  const maxY = Math.max(...raw.map((item) => item.y));
  const scale = Math.min(
    (width - 24) / Math.max(1, maxX - minX + Math.sqrt(3)),
    (height - 14) / Math.max(1, maxY - minY + 2),
  );
  const radius = Math.max(5, scale * 0.94);
  const offsetX = (width - (maxX - minX) * scale) / 2 - minX * scale;
  const offsetY = (height - (maxY - minY) * scale) / 2 - minY * scale;
  const degreeColors = [CATPPUCCIN.sky, CATPPUCCIN.green, CATPPUCCIN.yellow, CATPPUCCIN.peach, CATPPUCCIN.pink, CATPPUCCIN.mauve];
  raw.forEach(({key, x:rawX, y:rawY}) => {
    const x = offsetX + rawX * scale;
    const y = offsetY + rawY * scale;
    const isActive = active.has(key.input_node_id) || active.has(`midi:${key.midi_note}`);
    const isSelected = state.selectedInputId === key.input_node_id;
    const isHovered = state.hoveredInputId === key.input_node_id;
    const path = new Path2D();
    for (let corner = 0; corner < 6; corner += 1) {
      const angle = Math.PI / 180 * (60 * corner - 30);
      const px = x + radius * Math.cos(angle);
      const py = y + radius * Math.sin(angle);
      if (corner === 0) path.moveTo(px, py); else path.lineTo(px, py);
    }
    path.closePath();
    const mappedColor = degreeColors[(key.degree || 0) % degreeColors.length];
    ctx.fillStyle = !key.mapped ? CATPPUCCIN.surface0 : isActive ? CATPPUCCIN.yellow : colorWithAlpha(mappedColor, isHovered ? 0.78 : 0.34);
    ctx.fill(path);
    ctx.strokeStyle = isSelected ? CATPPUCCIN.green : isHovered ? CATPPUCCIN.lavender : CATPPUCCIN.surface2;
    ctx.lineWidth = isSelected ? 2.2 : 1;
    ctx.stroke(path);
    if (radius >= 13) {
      ctx.fillStyle = isActive ? CATPPUCCIN.crust : CATPPUCCIN.text;
      ctx.font = `${isActive ? "bold " : ""}${Math.max(7, Math.min(10, radius * 0.35))}px Consolas`;
      ctx.textAlign = "center";
      ctx.fillText(key.input_label, x, y - 3);
      ctx.fillStyle = CATPPUCCIN.subtext1;
      ctx.fillText(key.mapped ? compactPitchIdentityLabel(key, state.snapshot.tuning.divisions) : "OFF", x, y + 8);
    }
    state.keyRects.push({nodeId:key.input_node_id, note:key.input_midi_note, x:x-radius, y:y-radius, w:radius*2, h:radius*2, black:false, role:"hex", centerX:x, centerY:y, radius});
  });
}

function keyFromPointer(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const candidates = state.keyRects.filter((item) => x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h);
  const hex = candidates
    .filter((item) => item.role === "hex")
    .sort((first, second) => (
      Math.hypot(x - first.centerX, y - first.centerY)
      - Math.hypot(x - second.centerX, y - second.centerY)
    ))[0];
  if (hex && Math.hypot(x - hex.centerX, y - hex.centerY) <= hex.radius) return hex;
  const black = candidates.find((item) => item.black);
  return black || candidates[0] || null;
}

function toneColor(toneIndex) {
  return toneIndex === 0
    ? ROOT_TONE_COLOR
    : PITCH_RELATION_COLORS[(toneIndex - 1) % PITCH_RELATION_COLORS.length];
}

function relationVectorMarkup(relation) {
  const { primeExponents, algebraicRelation } = relationshipColumns(relation);
  return `<div class="prime-vector" aria-label="关系分解：${escapeHtml(relation.prime_vector_label)}">${primeExponents.map((exponent, index) => `<span data-prime="${RELATION_PRIMES[index]}">${escapeHtml(exponent)}</span>`).join("")}<span class="algebraic-relation" title="${escapeHtml(algebraicRelation)}">${escapeHtml(algebraicRelation)}</span></div>`;
}

function pitchCellMarkup(tone, prefix = "") {
  const keyIdentity = tone.input_label
    ? `${tone.input_label}${tone.input_midi_note === null ? "" : ` · M${tone.input_midi_note}`} · v${tone.velocity}`
    : tone.midi_note === null || tone.midi_note === undefined
    ? "分析基准 · 未发声"
    : `${tone.key_label} · M${tone.midi_note} · v${tone.velocity}`;
  const pitchIdentity = `${prefix}${pitchIdentityLabel(tone)}`;
  const frequency = `${tone.frequency_hz.toFixed(3)} Hz`;
  const secondary = tone.is_analysis_basis ? `未发声 · ${frequency}` : frequency;
  return `<div class="relation-cell relation-pitch-identity" title="${escapeHtml(`${pitchIdentity} · ${frequency} · ${keyIdentity}`)}"><span>${escapeHtml(pitchIdentity)}</span><small>${escapeHtml(secondary)}</small></div>`;
}

function chordBasis(chord) {
  if (chord.basis) return chord.basis;
  return chord.root ? {
    ...chord.root,
    mode:"lowest",
    origin:"lowest",
    sounding:true,
    ratio_from_reference:chord.root.frequency_hz / chord.reference.frequency_hz,
  } : null;
}

function renderRelationRows(
  container,
  tones,
  cellsForTone,
  { markBasis = false } = {},
) {
  const distanceFromBottom = Math.max(
    0,
    container.scrollHeight - container.clientHeight - container.scrollTop,
  );
  container.innerHTML = "";
  if (!tones.length) {
    container.innerHTML = '<span class="subtle">等待输入</span>';
  } else {
    const soundingLowToHigh = tones
      .filter((tone) => !tone.is_analysis_basis)
      .sort((first, second) => first.frequency_hz - second.frequency_hz);
    tonesHighToLow(tones).forEach((tone) => {
      const toneIndex = tone.is_analysis_basis
        ? 0
        : soundingLowToHigh.indexOf(tone);
      const row = document.createElement("div");
      row.className = "relation-tone";
      row.classList.toggle("relation-basis", markBasis && tone.is_basis);
      row.classList.toggle("analysis-basis", Boolean(tone.is_analysis_basis));
      if (markBasis && tone.is_basis) {
        row.setAttribute("aria-label", `${pitchIdentityLabel(tone)}，和弦基准 B`);
      }
      row.classList.toggle(
        "selected",
        tone.midi_note !== null && state.selectedNote === tone.midi_note,
      );
      row.dataset.frequencyHz = tone.frequency_hz.toFixed(6);
      if (tone.midi_note !== null && tone.midi_note !== undefined) {
        row.dataset.midiNote = String(tone.midi_note);
      }
      row.style.setProperty(
        "--tone-color",
        tone.is_analysis_basis ? CATPPUCCIN.mauve : toneColor(toneIndex),
      );
      row.innerHTML = cellsForTone(tone, toneIndex);
      if (tone.basis_selectable) {
        const basisButton = document.createElement("button");
        basisButton.className = "basis-row-action";
        basisButton.type = "button";
        basisButton.textContent = "设 B";
        basisButton.setAttribute(
          "aria-label",
          `设 ${pitchIdentityLabel(tone)} 为和弦基准 B`,
        );
        basisButton.addEventListener("click", (event) => {
          event.stopPropagation();
          state.selectedNote = tone.midi_note;
          panelRegistry.invalidate(["pitchIdentityPanel", "keyboardPanel"]);
          void applyChordBasis({mode:"selected", midi_note:tone.midi_note});
        });
        row.appendChild(basisButton);
      }
      row.addEventListener("click", () => {
        if (tone.midi_note === null || tone.midi_note === undefined) return;
        state.selectedNote = tone.midi_note;
        panelRegistry.invalidate(["pitchIdentityPanel", "chordPanel", "keyboardPanel"]);
      });
      container.appendChild(row);
    });
  }
  container.scrollTop = Math.max(
    0,
    container.scrollHeight - container.clientHeight - distanceFromBottom,
  );
}

function renderPitchIdentityPanel() {
  if (!state.snapshot) return;
  const chord = state.snapshot.chord;
  $("tuningToneCount").textContent = `${chord.size} 音`;
  const reference = chord.reference;
  $("tuningReference").textContent = reference
    ? `律制参考 T = ${pitchIdentityLabel(reference)} · ${reference.frequency_hz.toFixed(3)} Hz`
    : "律制参考 T —";
  renderRelationRows($("tuningTones"), chord.tones, (tone) => {
      const relation = tone.tuning_relation;
      const referenceRelation = `×${relation.ratio.toFixed(8)} · ${relation.ratio_label}`;
      return `${pitchCellMarkup(tone)}
        <div class="relation-cell" title="${escapeHtml(referenceRelation)}">${escapeHtml(referenceRelation)}</div>
        ${relationVectorMarkup(relation)}`;
    });
}

function renderChordPanel() {
  if (!state.snapshot) return;
  const chord = state.snapshot.chord;
  const renderSignature = JSON.stringify([state.selectedNote, chord]);
  if (renderSignature === state.chordRenderSignature) return;
  state.chordRenderSignature = renderSignature;
  const basis = chordBasis(chord);
  const basisMode = chord.basis_mode || basis?.mode || "lowest";
  $("chordPanel").classList.toggle("basis-selection-mode", basisMode === "selected");
  $("chordName").textContent = chord.name;
  $("chordCount").textContent = `${chord.size} 音`;
  $("chordBasisMode").value = basisMode;
  $("virtualBasisControls").hidden = basisMode !== "virtual";
  if (basisMode === "virtual" && basis) {
    setField("virtualBasisRatio", Number(basis.ratio_from_reference.toPrecision(9)));
  }
  const originLabel = {
    lowest:"最低实音",
    selected:basis?.sounding ? "选定实音" : "选定音高 · 未发声",
    virtual:"虚拟基准 · 未发声",
    auto_simple:basis?.sounding ? "自动最简 · 实音" : "自动最简 · 未发声",
    auto_fundamental:basis?.sounding ? "自动共同基频 · 实音" : "自动共同基频 · 未发声",
    auto_composite:basis?.sounding ? "自动复合 · 实音" : "自动复合 · 虚拟",
  }[basis?.origin || basisMode];
  const autoModelLabel = {
    tuning_relation:"律制关系",
    integer_partials:"整数部分音",
    timbre_partials:"当前音色部分音",
    composite_sounding_relation:"复合评分 · 实音关系",
    composite_integer_partials:"复合评分 · 整数部分音",
    composite_timbre_partials:"复合评分 · 当前部分音",
  }[basis?.auto?.model] || basis?.auto?.model;
  $("chordBasisHint").textContent = basisMode === "selected"
    ? "点击任意发声音高行设为 B"
    : basisMode === "virtual"
      ? "仅用于分析，不送入合成器"
      : ["auto_simple", "auto_fundamental", "auto_composite"].includes(basisMode)
        ? basis?.auto
          ? `${autoModelLabel} · 覆盖 ${basis.auto.coverage}/${basis.auto.tone_count} · 评分 ${basis.auto.score.toFixed(2)}`
          : "等待发声音以推断 B"
        : "自动取最低实音";
  $("chordBasis").textContent = basis
    ? `和弦基准 B = ${pitchIdentityLabel(basis)} · ${basis.frequency_hz.toFixed(3)} Hz · ${originLabel}`
    : "和弦基准 B —";
  const tones = chord.tones.map((tone, toneIndex) => ({
    ...tone,
    basis_selectable:basisMode === "selected",
    is_basis:tone.is_basis ?? (
      basisMode === "lowest" && toneIndex === 0
    ),
  }));
  if (basis && !basis.sounding) {
    tones.push({
      ...basis,
      velocity:0,
      is_basis:true,
      is_analysis_basis:true,
      chord_relation:basis.identity_relation || {
        reference:"B",
        ratio:1,
        ratio_label:"1/1",
        relationship_kind:"exact harmonic ratio",
        prime_vector:{"2":0,"3":0,"5":0,"7":0,"11":0},
        prime_vector_label:"1",
      },
    });
  }
  renderRelationRows($("chordTones"), tones, (tone) => {
      const relation = tone.chord_relation;
      const ratio = relation
        ? `×${relation.ratio.toFixed(8)} · ${relation.ratio_label}`
        : "等待选择 B";
      return `${pitchCellMarkup(tone)}
        <div class="relation-cell" title="${escapeHtml(ratio)}">${escapeHtml(ratio)}</div>
        ${relation ? relationVectorMarkup(relation) : '<div class="prime-vector">—</div>'}`;
    }, {markBasis:true});
}

async function refreshLiveState() {
  if (state.refreshPending || state.liveRefreshPending || !state.snapshot) return;
  state.liveRefreshPending = true;
  try {
    mergeLiveSnapshot(state, await api("/api/live"));
    renderLiveState();
  } catch (error) {
    showToast(`无法读取实时状态：${error.message}`);
  } finally {
    state.liveRefreshPending = false;
  }
}

function renderPartialEditor(force = false) {
  const editor = $("harmonicEditor");
  if (!state.partialDraft || state.partialSourceId !== state.snapshot.timbre.id) {
    state.partialDraft = state.snapshot.timbre.partials.map((partial) => ({multiple:partial.multiple, amplitude:partial.amplitude}));
    state.partialSourceId = state.snapshot.timbre.id;
    force = true;
  }
  if (!force && editor.children.length === state.partialDraft.length) return;
  editor.innerHTML = "";
  const smallest = Math.min(...state.partialDraft.map((partial) => partial.multiple));
  const largest = Math.max(...state.partialDraft.map((partial) => partial.multiple));
  const minMultiple = Math.min(0.5, 2 ** Math.floor(Math.log2(smallest)));
  const maxMultiple = Math.max(16, 2 ** Math.ceil(Math.log2(largest * 1.08)));
  const logMin = Math.log2(minMultiple);
  const logSpan = Math.log2(maxMultiple) - logMin;
  editor.dataset.minMultiple = minMultiple;
  editor.dataset.maxMultiple = maxMultiple;
  for (let tick = minMultiple; tick <= maxMultiple; tick *= 2) {
    const marker = document.createElement("div");
    marker.className = "harmonic-axis-tick";
    marker.style.left = `${2 + ((Math.log2(tick) - logMin) / logSpan) * 96}%`;
    marker.innerHTML = `<span>${Number(tick.toFixed(3))}×</span>`;
    editor.appendChild(marker);
  }
  state.partialDraft.forEach((partial, index) => {
    const node = document.createElement("div");
    node.className = "harmonic-partial";
    node.dataset.index = index;
    node.style.left = `${2 + ((Math.log2(partial.multiple) - logMin) / logSpan) * 96}%`;
    const bar = document.createElement("div");
    bar.className = "harmonic-bar";
    bar.style.setProperty("--amplitude", Math.max(0, Math.min(1, partial.amplitude)));
    bar.title = `${Number(partial.multiple.toFixed(4))}× · 振幅 ${Number(partial.amplitude.toFixed(3))}`;
    const amplitude = document.createElement("span");
    amplitude.className = "harmonic-amplitude";
    amplitude.textContent = partial.amplitude.toFixed(2);
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0.01";
    input.max = "64";
    input.step = "0.01";
    input.value = Number(partial.multiple.toFixed(4));
    input.title = "倍频";
    node.append(bar, amplitude, input);
    editor.appendChild(node);
  });
}

function schedulePartialApply() {
  clearTimeout(state.partialApplyTimer);
  state.selectedSavedTimbreName = null;
  state.partialApplyTimer = setTimeout(async () => {
    try {
      await api("/api/timbre/custom", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({partials:state.partialDraft.map((partial) => [partial.multiple, partial.amplitude])})});
      state.partialSourceId = "custom";
      await refreshState();
    } catch (error) { showToast(error.message); }
  }, 100);
}

function savedTimbres() {
  try { return JSON.parse(localStorage.getItem("music-lab-saved-timbres") || "{}"); }
  catch (_) { return {}; }
}

function renderTimbreChoices() {
  const select = $("timbreSelect");
  const library = savedTimbres();
  select.innerHTML = "";
  const builtInGroup = document.createElement("optgroup");
  builtInGroup.label = "内置音色";
  state.snapshot.timbres.forEach((timbre) => {
    const option = document.createElement("option");
    option.value = `builtin:${timbre.id}`;
    option.textContent = timbre.name;
    builtInGroup.appendChild(option);
  });
  select.appendChild(builtInGroup);
  const localGroup = document.createElement("optgroup");
  localGroup.label = "我的音色";
  Object.keys(library).sort((a, b) => a.localeCompare(b, "zh-CN")).forEach((name) => {
    const option = document.createElement("option");
    option.value = `saved:${name}`;
    option.textContent = name;
    localGroup.appendChild(option);
  });
  if (localGroup.children.length) select.appendChild(localGroup);
  const savedName = state.selectedSavedTimbreName;
  if (savedName && library[savedName]) {
    select.value = `saved:${savedName}`;
    setField("savedTimbreName", savedName);
    return;
  }
  state.selectedSavedTimbreName = null;
  const builtInValue = `builtin:${state.snapshot.timbre.id}`;
  if ([...select.options].some((option) => option.value === builtInValue)) {
    select.value = builtInValue;
    return;
  }
  const current = document.createElement("option");
  current.value = "current:custom";
  current.textContent = "当前编辑（未保存）";
  select.prepend(current);
  select.value = current.value;
}

function allTimelineNotes() {
  return state.snapshot.tracks.flatMap((track) => track.notes);
}

function timelineBounds() {
  const notes = allTimelineNotes();
  const frequencies = notes.map((note) => note.pitch.frequency_hz);
  const ends = notes.map((note) => note.start_seconds + note.duration_seconds);
  return {
    minFrequency: frequencies.length ? Math.min(...frequencies) / 1.04 : 200,
    maxFrequency: frequencies.length ? Math.max(...frequencies) * 1.04 : 800,
    duration: Math.max(6, ...ends, state.snapshot.record_elapsed_seconds + 0.5),
  };
}

function drawTimeline(canvas, notes, color, trackId) {
  const { context: ctx, width, height } = resizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = CATPPUCCIN.crust;
  ctx.fillRect(0, 0, width, height);
  const padding = { left: 48, right: 10, top: 10, bottom: 20 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const bounds = timelineBounds();
  const logMin = Math.log2(bounds.minFrequency);
  const logMax = Math.log2(bounds.maxFrequency);
  const xFor = (seconds) => padding.left + (seconds / bounds.duration) * innerWidth;
  const yFor = (frequency) => padding.top + (1 - (Math.log2(frequency) - logMin) / (logMax - logMin || 1)) * innerHeight;

  ctx.strokeStyle = CATPPUCCIN.surface0;
  ctx.lineWidth = 1;
  const secondsStep = bounds.duration > 20 ? 5 : bounds.duration > 10 ? 2 : 1;
  for (let second = 0; second <= bounds.duration; second += secondsStep) {
    const x = xFor(second);
    ctx.beginPath(); ctx.moveTo(x, padding.top); ctx.lineTo(x, height - padding.bottom); ctx.stroke();
    ctx.fillStyle = CATPPUCCIN.overlay0; ctx.font = "9px Consolas"; ctx.textAlign = "center";
    ctx.fillText(`${second}s`, x, height - 6);
  }
  [bounds.minFrequency, Math.sqrt(bounds.minFrequency * bounds.maxFrequency), bounds.maxFrequency].forEach((frequency) => {
    const y = yFor(frequency);
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
    ctx.fillStyle = CATPPUCCIN.overlay0; ctx.font = "8px Consolas"; ctx.textAlign = "right";
    ctx.fillText(`${frequency.toFixed(0)}`, padding.left - 5, y + 3);
  });

  notes.forEach((note) => {
    const x = xFor(note.start_seconds);
    const w = Math.max(3, (note.duration_seconds / bounds.duration) * innerWidth);
    const y = yFor(note.pitch.frequency_hz);
    ctx.fillStyle = color;
    ctx.globalAlpha = note.open ? 0.66 : 0.88;
    ctx.fillRect(x, y - 5, w, 10);
    ctx.globalAlpha = 1;
  });

  const playbackHere = state.snapshot.playback.playing && state.snapshot.playback.kind === trackId;
  const recordingHere = trackId === "performance" && state.snapshot.recording;
  if (playbackHere || recordingHere) {
    const elapsed = playbackHere ? state.snapshot.playback.elapsed_seconds : state.snapshot.record_elapsed_seconds;
    const x = xFor(elapsed);
    ctx.strokeStyle = CATPPUCCIN.red;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, padding.top); ctx.lineTo(x, height - padding.bottom); ctx.stroke();
  }
}

function renderTracks() {
  const container = $("tracksContainer");
  const palette = [CATPPUCCIN.sky, CATPPUCCIN.yellow, CATPPUCCIN.green, CATPPUCCIN.pink, CATPPUCCIN.mauve];
  const existingRows = new Map(
    [...container.querySelectorAll(":scope > .track-row")]
      .map((row) => [row.dataset.trackId, row]),
  );
  const liveTrackIds = new Set(state.snapshot.tracks.map((track) => track.id));
  existingRows.forEach((row, trackId) => {
    if (!liveTrackIds.has(trackId)) row.remove();
  });

  state.snapshot.tracks.forEach((track, index) => {
    let row = existingRows.get(track.id);
    if (!row) {
      row = document.createElement("div");
      row.className = "track-row";
      row.dataset.trackId = track.id;
      row.innerHTML = '<div class="track-controls"><strong data-track-name></strong><span data-track-meta></span><label class="track-compile-control"><span>律制编译</span><select data-track-compile aria-label="律制编译策略"></select></label><button data-action="play"></button><button data-action="load">加载</button><button data-action="clear">清空</button><button data-action="delete">删除轴</button></div><div class="canvas-wrap"><canvas></canvas></div>';
      existingRows.set(track.id, row);
    }
    if (container.children[index] !== row) {
      container.insertBefore(row, container.children[index] || null);
    }
    row.querySelector("[data-track-name]").textContent = track.name;
    const sourceClock = track.source_timing?.ticks_per_beat
      ? ` · ${track.source_timing.ticks_per_beat} PPQ`
      : "";
    const repairBadge = track.source_timing?.repairs?.length
      ? " · 已修复踏板数据"
      : "";
    row.querySelector("[data-track-meta]").textContent = `${track.notes.length} 音符 · ${track.kind}${sourceClock}${repairBadge}`;
    row.querySelectorAll("button[data-action]").forEach((button) => { button.dataset.track = track.id; });
    const playingHere = state.snapshot.playback.playing && state.snapshot.playback.kind === track.id;
    const protectedHere = playingHere || (state.snapshot.recording && track.id === "performance");
    const compileSelect = row.querySelector("[data-track-compile]");
    const compileModes = state.snapshot.compile_modes || [
      {id:"key_position", name:"键位直译", description:"需要重启后才能切换编译策略"},
    ];
    const compileSignature = compileModes.map((mode) => `${mode.id}:${mode.name}`).join("|");
    if (compileSelect.dataset.signature !== compileSignature) {
      compileSelect.replaceChildren(...compileModes.map((mode) => {
        const option = document.createElement("option");
        option.value = mode.id;
        option.textContent = mode.name;
        option.title = mode.description || "";
        return option;
      }));
      compileSelect.dataset.signature = compileSignature;
    }
    compileSelect.dataset.track = track.id;
    compileSelect.value = track.compile_mode || "key_position";
    compileSelect.disabled = protectedHere || !state.snapshot.compile_modes;
    compileSelect.title = compileModes.find((mode) => mode.id === compileSelect.value)?.description || "";
    const playButton = row.querySelector('button[data-action="play"]');
    playButton.textContent = playingHere ? "■ 停止" : "▶ 播放";
    playButton.disabled = (state.snapshot.playback.playing && !playingHere)
      || (state.snapshot.recording && track.id === "performance");
    playButton.classList.toggle("track-stop", playingHere);
    row.querySelector('button[data-action="load"]').disabled = protectedHere;
    row.querySelector('button[data-action="clear"]').disabled = protectedHere;
    const deleteButton = row.querySelector('button[data-action="delete"]');
    deleteButton.hidden = !track.deletable;
    deleteButton.disabled = protectedHere;
    const canvas = row.querySelector("canvas");
    canvas.setAttribute("aria-label", `${track.name} 时间轴`);
    drawTimeline(canvas, track.notes, palette[index % palette.length], track.id);
  });
}

function colorWithAlpha(hex, alpha) {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha))})`;
}

function resetSpectrumMemory() {
  state.spectrumMemory = createSpectrumMemory();
}

function updateSpectrumMemory(points) {
  return updateSpectrumMemoryFrame(state.spectrumMemory, points, {
    nowMs:performance.now(),
    halfLifeSeconds:Number($("historyDuration").value) || 5,
    burnGain:Number($("historyBurnGain").value) || 1,
    rms:state.analysis.rms,
    peak:state.analysis.peak,
  });
}

function buildPartialRelationModel() {
  const activeNotes = [...state.snapshot.keyboard.active]
    .sort((first, second) => first.frequency_hz - second.frequency_hz)
    .slice(0, 10);
  const noteColors = [CATPPUCCIN.sky, CATPPUCCIN.yellow, CATPPUCCIN.green, CATPPUCCIN.pink, CATPPUCCIN.mauve, CATPPUCCIN.peach];
  const partials = [];
  activeNotes.forEach((note, noteIndex) => {
    state.snapshot.timbre.partials.forEach((partial, partialIndex) => {
      const frequency = note.frequency_hz * partial.multiple;
      const strength = Math.min(1, (note.velocity / 127) * partial.amplitude);
      if (frequency < 20 || frequency > 12000 || strength < 0.005) return;
      partials.push({
        frequency,
        strength,
        noteIndex,
        partialIndex,
        color: noteColors[noteIndex % noteColors.length],
      });
    });
  });
  partials.sort((first, second) => first.frequency - second.frequency);

  const clusters = [];
  partials.forEach((partial) => {
    const cluster = clusters[clusters.length - 1];
    const distanceCents = cluster ? Math.abs(1200 * Math.log2(partial.frequency / cluster.frequency)) : Infinity;
    if (!cluster || distanceCents > 8) {
      clusters.push({frequency:partial.frequency, weight:partial.strength, members:[partial]});
      return;
    }
    const combinedWeight = cluster.weight + partial.strength;
    cluster.frequency = (cluster.frequency * cluster.weight + partial.frequency * partial.strength) / combinedWeight;
    cluster.weight = combinedWeight;
    cluster.members.push(partial);
  });
  const fusion = clusters.filter((cluster) => new Set(cluster.members.map((partial) => partial.noteIndex)).size > 1);

  const roughness = [];
  for (let firstIndex = 0; firstIndex < partials.length; firstIndex += 1) {
    const first = partials[firstIndex];
    for (let secondIndex = firstIndex + 1; secondIndex < partials.length; secondIndex += 1) {
      const second = partials[secondIndex];
      const deltaHz = second.frequency - first.frequency;
      const scale = 0.24 / (0.021 * first.frequency + 19);
      if (scale * deltaHz > 2.5) break;
      if (first.noteIndex === second.noteIndex) continue;
      const distanceCents = 1200 * Math.log2(second.frequency / first.frequency);
      if (distanceCents <= 8) continue;
      const sensoryRoughness = Math.exp(-3.5 * scale * deltaHz) - Math.exp(-5.75 * scale * deltaHz);
      const score = Math.min(1, (sensoryRoughness / 0.18) * Math.sqrt(first.strength * second.strength));
      if (score >= 0.055) roughness.push({first, second, score});
    }
  }
  roughness.sort((first, second) => second.score - first.score);
  return {activeNotes, partials, fusion, roughness};
}

function drawSpectrumMemory(ctx, width, height, points) {
  const memory = updateSpectrumMemory(points);
  const plotLeft = 42;
  const plotTop = 10;
  const plotRight = width - 12;
  const plotBottom = height - 22;
  const columnCount = Math.max(1, Math.ceil(plotRight - plotLeft));
  const columns = spectrumAfterglowColumns(memory, points, {columnCount});
  const depth = Number($("historyDepth").value) || 0.55;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const haze = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
  haze.addColorStop(0, colorWithAlpha(CATPPUCCIN.mauve, 0.35));
  haze.addColorStop(0.45, colorWithAlpha(CATPPUCCIN.mauve, 1));
  haze.addColorStop(1, colorWithAlpha(CATPPUCCIN.mauve, 0.28));
  ctx.fillStyle = haze;
  columns.forEach((column, index) => {
    if (column.brightness < 0.015) return;
    ctx.globalAlpha = Math.min(1, column.brightness * depth);
    ctx.fillRect(plotLeft + index, plotTop, 1.2, plotBottom - plotTop);
  });
  ctx.restore();
}

function drawPartialRelations(ctx, width, height, xFor, yFor) {
  const model = buildPartialRelationModel();
  const plotBottom = height - 22;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  model.partials.forEach((partial) => {
    const x = xFor(partial.frequency);
    const y = yFor(partial.strength);
    ctx.beginPath();
    ctx.moveTo(x, plotBottom);
    ctx.lineTo(x, y);
    ctx.strokeStyle = colorWithAlpha(partial.color, 0.12 + Math.sqrt(partial.strength) * 0.22);
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  model.roughness.slice(0, 64).forEach((relation) => {
    const firstX = xFor(relation.first.frequency);
    const secondX = xFor(relation.second.frequency);
    const centerX = (firstX + secondX) / 2;
    const y = yFor(Math.max(relation.first.strength, relation.second.strength));
    ctx.beginPath();
    ctx.moveTo(firstX, y + 4);
    ctx.quadraticCurveTo(centerX, y - 5 - relation.score * 13, secondX, y + 4);
    ctx.strokeStyle = colorWithAlpha(CATPPUCCIN.peach, 0.22 + relation.score * 0.62);
    ctx.lineWidth = 1 + relation.score * 1.8;
    ctx.shadowColor = colorWithAlpha(CATPPUCCIN.red, 0.55);
    ctx.shadowBlur = 4 + relation.score * 8;
    ctx.stroke();
  });

  model.fusion.forEach((cluster) => {
    const x = xFor(cluster.frequency);
    const level = Math.min(1, cluster.members.reduce((sum, partial) => sum + partial.strength, 0));
    const y = yFor(level);
    ctx.beginPath();
    ctx.moveTo(x, plotBottom);
    ctx.lineTo(x, y);
    ctx.strokeStyle = colorWithAlpha(CATPPUCCIN.text, 0.52 + Math.min(0.42, cluster.members.length * 0.08));
    ctx.lineWidth = 2 + Math.min(4, cluster.members.length * 0.8);
    ctx.shadowColor = CATPPUCCIN.sky;
    ctx.shadowBlur = 10 + Math.min(12, cluster.members.length * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2.5 + Math.min(3, cluster.members.length * 0.5), 0, Math.PI * 2);
    ctx.fillStyle = CATPPUCCIN.text;
    ctx.fill();
  });
  ctx.restore();

  const summary = $("spectrumRelationSummary");
  if (model.activeNotes.length < 2) {
    summary.textContent = model.activeNotes.length ? `1 个音 · ${model.partials.length} 个部分音` : "等待多音输入";
  } else {
    summary.textContent = `融合 ${model.fusion.length} · 拍频邻近 ${model.roughness.length}`;
  }
}

function drawSignalAnalysis(requestedPanel = null) {
  if (!state.analysis) return;
  const spectrumCanvas = $("spectrumCanvas");
  const requested = (panelId) => requestedPanel === null || requestedPanel === panelId;
  const spectrumVisible = requested("spectrumPanel")
    && !$("spectrumPanel").classList.contains("collapsed");
  const lissajousVisible = requested("lissajousPanel")
    && !$("lissajousPanel").classList.contains("collapsed");
  const outputPhaseVisible = requested("outputPhasePanel")
    && !$("outputPhasePanel").classList.contains("collapsed");
  if (spectrumVisible && state.analysis) {
  const spectrumFrame = resizeCanvas(spectrumCanvas);
  const sctx = spectrumFrame.context;
  const sw = spectrumFrame.width;
  const sh = spectrumFrame.height;
  sctx.clearRect(0, 0, sw, sh);
  sctx.fillStyle = CATPPUCCIN.crust; sctx.fillRect(0, 0, sw, sh);
  const xForSpectrum = (frequency) => 42 + (Math.log10(frequency / 20) / Math.log10(12000 / 20)) * (sw - 54);
  const yForSpectrum = (level) => 10 + (1 - Math.sqrt(Math.max(0, Math.min(1, level)))) * (sh - 34);
  sctx.strokeStyle = CATPPUCCIN.surface0; sctx.lineWidth = 1;
  [100, 1000, 10000].forEach((frequency) => {
    const x = xForSpectrum(frequency);
    sctx.beginPath(); sctx.moveTo(x, 10); sctx.lineTo(x, sh - 22); sctx.stroke();
    sctx.fillStyle = CATPPUCCIN.overlay0; sctx.font = "9px Consolas"; sctx.textAlign = "center";
    sctx.fillText(frequency >= 1000 ? `${frequency / 1000}k` : String(frequency), x, sh - 7);
  });
  if ($("partialRelationsToggle").checked) {
    drawPartialRelations(sctx, sw, sh, xForSpectrum, yForSpectrum);
  } else {
    $("spectrumRelationSummary").textContent = "部分音关系已关闭";
  }
  if ($("spectrumHistoryToggle").checked) {
    drawSpectrumMemory(sctx, sw, sh, state.analysis.spectrum);
  }
  sctx.beginPath();
  state.analysis.spectrum.forEach((point, index) => {
    const x = xForSpectrum(point.frequency_hz);
    const y = yForSpectrum(point.level);
    if (index === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
  });
  sctx.strokeStyle = CATPPUCCIN.sky; sctx.lineWidth = 1.6; sctx.stroke();
  }

  if (lissajousVisible) {
  const lissaCanvas = $("lissajousCanvas");
  const lissaFrame = resizeCanvas(lissaCanvas);
  const lctx = lissaFrame.context;
  const lw = lissaFrame.width;
  const lh = lissaFrame.height;
  lctx.clearRect(0, 0, lw, lh);
  lctx.fillStyle = CATPPUCCIN.crust; lctx.fillRect(0, 0, lw, lh);
  lctx.strokeStyle = CATPPUCCIN.surface0; lctx.lineWidth = 1;
  lctx.beginPath(); lctx.moveTo(lw / 2, 8); lctx.lineTo(lw / 2, lh - 8); lctx.moveTo(8, lh / 2); lctx.lineTo(lw - 8, lh / 2); lctx.stroke();
  const active = [...state.snapshot.keyboard.active].sort((a, b) => a.frequency_hz - b.frequency_hz);
  const basis = chordBasis(state.snapshot.chord);
  let comparisonNotes = basis?.sounding
    ? active.filter((note) => !(
        note.midi_note === basis.midi_note
        && Math.abs(note.frequency_hz - basis.frequency_hz) < 0.001
      ))
    : active;
  if (!comparisonNotes.length && active.length) comparisonNotes = active;
  comparisonNotes = comparisonNotes.slice(0, 7);
  if (!basis || !active.length) {
    const waiting = basis ? "等待发声音" : "等待分析基准 B";
    lissaCanvas.title = waiting;
    lctx.fillStyle = CATPPUCCIN.overlay0;
    lctx.font = "11px Consolas";
    lctx.textAlign = "center";
    lctx.fillText(waiting, lw / 2, lh / 2 + 4);
  } else {
    const chordTones = new Map(state.snapshot.chord.tones.map((tone) => [tone.midi_note, tone]));
    const traceTimeSeconds = performance.now() / 1000;
    const traceDescriptions = [];
    comparisonNotes.forEach((note) => {
      const ratio = note.frequency_hz / basis.frequency_hz;
      const tone = chordTones.get(note.midi_note);
      const traceWindow = lissajousTraceWindow(ratio, traceTimeSeconds, {
        trailScale:2 ** Number($("lissajousTrailLength").value),
        driftCyclesPerSecond:Number($("lissajousDriftSpeed").value),
        autoClose:$("lissajousAutoClose").checked,
      });
      const {rational, rootCycles, phaseOffset} = traceWindow;
      const fastestCycles = Math.max(rootCycles, rootCycles * ratio);
      const pointCount = Math.min(16384, Math.max(4096, Math.ceil(fastestCycles * 256)));
      const color = toneColor(active.indexOf(note));
      lctx.beginPath();
      for (let index = 0; index <= pointCount; index += 1) {
        const phase = phaseOffset
          + (index / pointCount) * Math.PI * 2 * rootCycles;
        const x = lw / 2 + Math.sin(phase) * lw * 0.43;
        const y = lh / 2 - Math.sin(phase * ratio) * lh * 0.43;
        if (index === 0) lctx.moveTo(x, y); else lctx.lineTo(x, y);
      }
      lctx.strokeStyle = color;
      lctx.lineWidth = 1.35;
      lctx.lineJoin = "round";
      lctx.lineCap = "round";
      lctx.globalAlpha = 0.86;
      lctx.stroke();
      lctx.globalAlpha = 1;
      const motionLabel = traceWindow.closed ? "" : " · 滑动窗";
      traceDescriptions.push(
        `B ${pitchIdentityLabel(basis)} × ${pitchIdentityLabel(note)} · ${tone?.chord_relation?.ratio_label || `≈ ${rational.numerator}/${rational.denominator}`}${motionLabel}`,
      );
    });
    lissaCanvas.title = traceDescriptions.join("\n");
  }
  }
  if (outputPhaseVisible) {
    const phaseCanvas = $("outputPhaseCanvas");
    const phaseFrame = resizeCanvas(phaseCanvas);
    const pctx = phaseFrame.context;
    const pw = phaseFrame.width;
    const ph = phaseFrame.height;
    pctx.clearRect(0, 0, pw, ph);
    pctx.fillStyle = CATPPUCCIN.crust;
    pctx.fillRect(0, 0, pw, ph);
    pctx.strokeStyle = CATPPUCCIN.surface0;
    pctx.lineWidth = 1;
    pctx.beginPath();
    pctx.moveTo(pw / 2, 8);
    pctx.lineTo(pw / 2, ph - 8);
    pctx.moveTo(8, ph / 2);
    pctx.lineTo(pw - 8, ph / 2);
    pctx.stroke();
    const delayMs = Number($("outputPhaseDelay").value);
    const points = delayedPhasePoints(
      state.phase?.samples,
      state.phase?.sampleRateHz,
      delayMs,
    );
    const peak = points.reduce(
      (maximum, point) => Math.max(maximum, Math.abs(point.x), Math.abs(point.y)),
      0,
    );
    if (points.length && peak > 1e-6) {
      const scale = Math.min(pw, ph) * 0.43 / peak;
      pctx.beginPath();
      points.forEach((point, index) => {
        const x = pw / 2 + point.x * scale;
        const y = ph / 2 - point.y * scale;
        if (index === 0) pctx.moveTo(x, y); else pctx.lineTo(x, y);
      });
      pctx.strokeStyle = CATPPUCCIN.mauve;
      pctx.lineWidth = 1.15;
      pctx.lineJoin = "round";
      pctx.lineCap = "round";
      pctx.globalAlpha = 0.84;
      pctx.stroke();
      pctx.globalAlpha = 1;
      $("outputPhaseSummary").textContent = `${points.length} 点 · τ ${delayMs.toFixed(1)} ms · 自动幅度`;
    } else {
      $("outputPhaseSummary").textContent = "等待合成器输出";
    }
  }
  if (state.analysis) {
    $("levelSummary").textContent = `RMS ${(state.analysis.rms * 100).toFixed(1)}% · PEAK ${(state.analysis.peak * 100).toFixed(1)}%`;
  }
}

function renderStatus() {
  const midi = state.snapshot.midi;
  const audio = state.snapshot.audio;
  const midiElement = $("midiStatus");
  midiElement.textContent = midi.connected ? `MIDI · ${midi.selected_port}` : `MIDI · ${midi.error || "未连接"}`;
  midiElement.className = `status-pill ${midi.connected ? "ok" : "error"}`;
  const audioElement = $("audioStatus");
  const underrunLabel = audio.underrun_count ? ` · XRUN ${audio.underrun_count}` : "";
  audioElement.textContent = audio.running
    ? `AUDIO · ${audio.output_latency_ms?.toFixed(1) || "?"} ms · ${audio.output_device_name || "默认输出"}${underrunLabel}`
    : `AUDIO · ${audio.error || (audio.enabled ? "不可用" : "已关闭")}`;
  audioElement.className = `status-pill ${audio.running || !audio.enabled ? "ok" : "error"}`;
  const playback = state.snapshot.playback;
  const playbackElement = $("playbackStatus");
  playbackElement.textContent = playback.playing
    ? `PLAYBACK · ${playback.kind || "轴"} · ${(playback.elapsed_seconds || 0).toFixed(1)} s`
    : "PLAYBACK · 空闲";
  playbackElement.className = `status-pill ${playback.playing ? "ok" : "waiting"}`;
  const active = state.snapshot.keyboard.active;
  $("activeSummary").textContent = active.length
    ? `${active.length} 个触发音 · ${active.map((item) => item.frequency_hz.toFixed(1)).join(" / ")} Hz`
    : "等待琴键输入";
}

function fillSelect(select, options, currentId) {
  const previous = select.value;
  select.innerHTML = "";
  options.forEach((option) => {
    const element = document.createElement("option");
    element.value = option.id;
    element.textContent = option.name;
    select.appendChild(element);
  });
  select.value = currentId || previous;
}

function setField(id, value) {
  const element = $(id);
  if (document.activeElement !== element) element.value = value ?? "";
}

function renderChrome() {
  if (!state.snapshot) return;
  renderStatus();
  const volumePercent = Math.round(state.snapshot.audio.master_volume * 100);
  $("volumeSlider").value = volumePercent;
  $("volumeValue").textContent = `${volumePercent}%`;
  $("recordButton").textContent = state.snapshot.recording ? "■ 停止记录" : "● 开始记录";
  $("recordButton").classList.toggle("recording", state.snapshot.recording);
}

function renderTuningPanel() {
  if (!state.snapshot) return;
  const space = tuningSpaceView();
  const construction = space.construction;
  const editorKind = [
    "equal_division",
    "generator_chain",
    "interval_cycle",
    "generator_lattice",
  ].includes(construction.kind) ? construction.kind : "explicit";
  const editorSourceSignature = JSON.stringify([
    space.id,
    space.equave_expression,
    construction,
  ]);
  if (state.tuningEditorSourceSignature !== editorSourceSignature) {
    fillSelect($("tuningSelect"), state.snapshot.tunings, state.snapshot.tuning.id);
    setField("tuningConstruction", editorKind);
    setField("tuningEquaveExpression", space.equave_expression);
    setField("tuningDivisions", space.degree_count);
    setField("tuningGenerator", construction.generator_expression || "3/2");
    setField("tuningDegreeCount", construction.degree_count || space.degree_count);
    setField("tuningChainStart", construction.chain_start ?? -5);
    setField(
      "tuningIntervalExpressions",
      (construction.interval_expressions || []).join(", "),
    );
    setField(
      "tuningDegreeExpressions",
      (construction.degree_expressions || space.degrees.map((degree) => degree.expression)).join(", "),
    );
    updateTuningConstructionVisibility(editorKind);
    state.tuningEditorSourceSignature = editorSourceSignature;
    state.tuningDraftDirty = false;
  }
  if (!state.tuningDraftDirty) {
    $("tuningDescription").textContent = tuningSpaceDescription(
      space,
      state.snapshot.tuning.description,
    );
  }
  const referenceDegree = keyboardView().mapping.reference_degree;
  const activeCount = state.snapshot.chord.tones.length;
  let statusText = activeCount
    ? `02 定义音高 · ${activeCount} 个实时音高`
    : "02 定义音高 · T 与按键由 03 编译";
  if (state.tuningDraftDirty) {
    statusText = `自定义草稿未应用${activeCount ? ` · ${activeCount} 个实时音高` : ""}`;
  }
  $("tuningSpaceStatus").textContent = statusText;
  const draftKind = $("tuningConstruction").value || editorKind;
  $("applyTuningButton").textContent = draftKind === "generator_lattice"
    ? "开放格由预设载入"
    : state.tuningDraftDirty ? "应用自定义草稿" : "从参数生成空间";
  $("applyTuningButton").classList.toggle("draft-dirty", state.tuningDraftDirty);
  drawTuningSpace(space, referenceDegree);
}

function tuningSpaceDescription(space, fallback) {
  const construction = space.construction;
  if (construction.kind === "equal_division") {
    return `将 ${space.equave_expression}:1 等价区间等分为 ${space.degree_count} 个音级；键位与 Hz 由 03 编译。`;
  }
  if (construction.kind === "generator_chain") {
    const start = construction.chain_start ?? 0;
    const end = start + space.degree_count - 1;
    return `生成器 ${construction.generator_expression} · k=${start}…${end} · 折回 ${space.equave_expression}:1。`;
  }
  if (construction.kind === "interval_cycle") {
    return `${space.equave_expression}:1 · ${space.degree_count} 个相邻步进首尾闭合；每一步都来自同一份可保存定义。`;
  }
  if (construction.kind === "generator_lattice") {
    const basis = construction.basis_expressions?.join(" × ") || "未定义生成基";
    return `开放生成格 ${basis} · 不预先截取有限音级。`;
  }
  if (["explicit", "ratio_set"].includes(construction.kind)) {
    return `${space.equave_expression}:1 中的 ${space.degree_count} 个显式音高身份。`;
  }
  return fallback;
}

function markTuningDraftDirty() {
  state.tuningDraftDirty = true;
  $("tuningDescription").textContent = "参数尚未影响声音；点击“应用自定义草稿”后才会重新编译映射。";
  panelRegistry.invalidate("tuningPanel");
}

function renderTimbrePanel() {
  if (!state.snapshot) return;
  renderTimbreChoices();
  renderPartialEditor();
}

function renderMappingPanel() {
  if (!state.snapshot) return;
  const keyboard = keyboardView();
  const mapping = keyboard.mapping;
  const mappingModes = state.snapshot.mapping_modes || [
    {id:"continuous", name:"连续音级"},
    {id:"reverse", name:"反向连续"},
    {id:"white_only", name:"仅白键"},
  ];
  fillSelect($("mappingMode"), mappingModes, mapping.mode);
  const anchorSelect = $("mappingAnchorNode");
  const anchorSignature = keyboard.keys.map((key) => key.input_node_id).join("|");
  if (anchorSelect.dataset.signature !== anchorSignature) {
    anchorSelect.replaceChildren(...keyboard.keys.map((key) => {
      const option = document.createElement("option");
      option.value = key.input_node_id;
      option.textContent = `${key.input_label} · ${key.coordinate.join(",")}`;
      return option;
    }));
    anchorSelect.dataset.signature = anchorSignature;
  }
  setField("mappingAnchorNode", mapping.anchor_node_id);
  setField("mappingMode", mapping.mode);
  setField("mappingStep", mapping.degree_step);
  setField("mappingReferenceDegree", mapping.reference_degree);
  $("mappingReferenceDegree").max = String(Math.max(0, state.snapshot.tuning.divisions - 1));
  setField("mappingReferenceHz", Number(mapping.reference_frequency_hz.toFixed(6)));
  setField("mappingSubset", (mapping.subset_degrees || []).join(","));
  setField("mappingQStep", mapping.q_step);
  setField("mappingRStep", mapping.r_step);
  setField("mappingQRatio", mapping.q_ratio_expression);
  setField("mappingRRatio", mapping.r_ratio_expression);
  updateMappingStrategyVisibility(mapping.mode);
  const mappedCount = keyboard.keys.filter((key) => key.mapped).length;
  const tNode = keyboard.keys.find((key) => key.input_node_id === mapping.anchor_node_id);
  $("mappingSummary").textContent = `${mappedCount}/${keyboard.keys.length} 节点已映射 · T = ${tNode?.input_label || "—"} → d${mapping.reference_degree} @ ${Number(mapping.reference_frequency_hz).toFixed(3)} Hz`;
}

function updateTuningConstructionVisibility(kind) {
  $("equalDivisionFields").hidden = kind !== "equal_division";
  $("generatorChainFields").hidden = kind !== "generator_chain";
  $("explicitDegreeFields").hidden = kind !== "explicit";
  $("intervalCycleFields").hidden = kind !== "interval_cycle";
  $("applyTuningButton").disabled = kind === "generator_lattice";
}

function updateMappingStrategyVisibility(mode) {
  $("linearMappingFields").hidden = !["continuous", "reverse", "white_only"].includes(mode);
  $("subsetMappingFields").hidden = mode !== "periodic_subset";
  $("gridMappingFields").hidden = mode !== "grid_linear";
  $("latticeMappingFields").hidden = mode !== "harmonic_lattice";
}

function renderAll() {
  panelRegistry.invalidate("all");
}

function renderLiveState() {
  panelRegistry.invalidate([
    "chrome", "tuningPanel", "keyboardPanel", "pitchIdentityPanel", "chordPanel", "tracksPanel",
    "spectrumPanel", "lissajousPanel", "outputPhasePanel",
  ]);
}

const panelVisible = (panelId) => !$(panelId).classList.contains("collapsed")
  && !$(panelId).classList.contains("desktop-inactive");

const renderTracksPanel = () => state.snapshot && renderTracks();
const renderSpectrumPanel = () => state.snapshot && drawSignalAnalysis("spectrumPanel");
const renderLissajousPanel = () => state.snapshot && drawSignalAnalysis("lissajousPanel");
const renderOutputPhasePanel = () => state.snapshot && drawSignalAnalysis("outputPhasePanel");
const renderKeyboardPanel = () => {
  if (!state.snapshot) return;
  const keyboard = keyboardView();
  const surfaces = state.snapshot.input_surfaces || [{
    id:keyboard.surface.id,
    name:keyboard.surface.name,
  }];
  fillSelect(
    $("inputSurfaceSelect"),
    surfaces,
    keyboard.surface.id,
  );
  $("inputSurfaceSelect").disabled = !state.snapshot.input_surfaces;
  $("surfaceDescription").textContent = keyboard.surface.description;
  drawKeyboard();
};

function renderDesktopControls(activeDesktopId, panelDesktops = {}) {
  const switcher = $("desktopSwitcher");
  if (switcher) {
    switcher.innerHTML = DESKTOP_MANIFEST.map((desktop) => `
      <button type="button" role="tab" class="${desktop.id === activeDesktopId ? "active" : ""}" data-desktop-switch="${escapeHtml(desktop.id)}" aria-selected="${desktop.id === activeDesktopId}" title="${escapeHtml(`${desktop.label} · ${desktop.shortcut}`)}">
        ${escapeHtml(desktop.shortLabel)}<kbd>${escapeHtml(desktop.shortcut)}</kbd>
      </button>
    `).join("");
  }
  const activeDesktop = DESKTOP_MANIFEST.find((desktop) => desktop.id === activeDesktopId);
  if ($("activeDesktopLabel")) {
    $("activeDesktopLabel").textContent = `${activeDesktop?.label || activeDesktopId} · 可恢复任意面板`;
  }
  const assignmentContainer = $("panelDesktopAssignments");
  if (assignmentContainer) {
    assignmentContainer.innerHTML = PANEL_MANIFEST.map((panel) => `
      <label class="panel-desktop-assignment">
        <span>${escapeHtml(panel.label || panel.id)}</span>
        <select data-panel-desktop="${escapeHtml(panel.id)}" aria-label="${escapeHtml(`${panel.label || panel.id}所在桌面`)}">
          ${DESKTOP_MANIFEST.map((desktop) => `<option value="${escapeHtml(desktop.id)}"${panelDesktops[panel.id] === desktop.id ? " selected" : ""}>${escapeHtml(desktop.shortLabel)}</option>`).join("")}
        </select>
      </label>
    `).join("");
  }
}

function renderPanelVisibilityControls(hiddenPanelIds = [], panelDesktops = {}, activeDesktopId = DESKTOP_MANIFEST[0].id) {
  const hidden = new Set(hiddenPanelIds);
  const markup = PANEL_MANIFEST.map((panel) => `
    <button type="button" class="view-toggle${hidden.has(panel.id) ? "" : " active"}${panelDesktops[panel.id] !== activeDesktopId ? " other-desktop" : ""}" data-panel="${escapeHtml(panel.id)}" aria-pressed="${!hidden.has(panel.id)}" title="${escapeHtml(panelDesktops[panel.id] !== activeDesktopId ? "位于另一桌面；从顶栏打开时会切换过去" : "切换面板显隐")}">
      <span>${escapeHtml(panel.label || panel.id)}</span><small class="panel-desktop-badge">${escapeHtml(DESKTOP_MANIFEST.find((desktop) => desktop.id === panelDesktops[panel.id])?.shortLabel || "D?")}</small>
    </button>
  `).join("");
  ["layoutPanelToggles", "externalPanelToggles"].forEach((id) => {
    const container = $(id);
    if (container) container.innerHTML = markup;
  });
  renderDesktopControls(activeDesktopId, panelDesktops);
}

function switchActiveDesktop(desktopId, {announce = true} = {}) {
  if (!state.freeLayout?.switchDesktop(desktopId)) return false;
  const desktop = DESKTOP_MANIFEST.find((candidate) => candidate.id === desktopId);
  if (announce) showToast(`已切换到${desktop?.label || desktopId}`);
  return true;
}

function initializePanelRegistry() {
  panelRegistry
    .register({id:"chrome", render:renderChrome, observeResize:false})
    .register({id:"layoutPanel", element:$("layoutPanel"), render:() => {}})
    .register({id:"timbrePanel", element:$("timbrePanel"), render:renderTimbrePanel})
    .register({id:"tuningPanel", element:$("tuningPanel"), render:renderTuningPanel})
    .register({id:"mappingPanel", element:$("mappingPanel"), render:renderMappingPanel})
    .register({id:"tracksPanel", element:$("tracksPanel"), render:renderTracksPanel})
    .register({id:"pitchIdentityPanel", element:$("pitchIdentityPanel"), render:renderPitchIdentityPanel})
    .register({id:"chordPanel", element:$("chordPanel"), render:renderChordPanel})
    .register({id:"spectrumPanel", element:$("spectrumPanel"), render:renderSpectrumPanel})
    .register({id:"lissajousPanel", element:$("lissajousPanel"), render:renderLissajousPanel})
    .register({id:"outputPhasePanel", element:$("outputPhasePanel"), render:renderOutputPhasePanel})
    .register({id:"keyboardPanel", element:$("keyboardPanel"), render:renderKeyboardPanel});
}

function initializeFreeLayout() {
  const core = document.querySelector(".core-grid");
  const dashboard = document.querySelector(".dashboard");
  const workspace = document.createElement("main");
  workspace.id = "freeWorkspace";
  workspace.className = "free-workspace";
  core.parentNode.insertBefore(workspace, core);
  const panels = PANEL_MANIFEST.map((manifest) => ({
    ...manifest,
    element:$(manifest.id),
  }));
  panels.forEach((panel) => workspace.appendChild(panel.element));
  core.remove();
  dashboard.remove();
  state.freeLayout = createGridLayoutManager({
    workspace,
    panels,
    desktops:DESKTOP_MANIFEST,
    lockButton:$("layoutLockButton"),
    alignButton:$("layoutAlignButton"),
    saveDefaultButton:$("layoutSaveDefaultButton"),
    resetButton:$("layoutResetButton"),
    onLayoutChange:(panelIds) => panelRegistry.invalidate(panelIds),
    onDefaultSaved:(mode) => showToast(`已保存${mode === "wide" ? "宽屏" : "紧凑屏"}默认布局`),
    onVisibilityChange:(hiddenPanelIds, panelDesktops, activeDesktopId) => {
      renderPanelVisibilityControls(hiddenPanelIds, panelDesktops, activeDesktopId);
    },
    onDesktopChange:(activeDesktopId, panelDesktops, hiddenPanelIds) => {
      renderPanelVisibilityControls(hiddenPanelIds, panelDesktops, activeDesktopId);
      panelRegistry.invalidate(
        PANEL_MANIFEST
          .filter((panel) => panelDesktops[panel.id] === activeDesktopId)
          .map((panel) => panel.id),
      );
    },
    getViewSettings:readPanelViewSettings,
    applyViewSettings:applyPanelViewSettings,
  });
}

function connectWebSocket() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/ws`);
  const fullRefreshEvents = new Set([
    "ready", "status", "configuration", "target_loaded", "tracks",
    "performance_cleared", "recording",
  ]);
  socket.onmessage = (message) => {
    if (document.hidden) return;
    let event;
    try { event = JSON.parse(message.data); } catch (_) { event = {type: "ready"}; }
    if (fullRefreshEvents.has(event.type)) refreshState();
    else refreshLiveState();
  };
  socket.onclose = () => setTimeout(connectWebSocket, 1200);
}

function bindControls() {
  const redrawSpectrum = () => {
    if (state.analysis) panelRegistry.invalidate("spectrumPanel");
  };
  $("partialRelationsToggle").addEventListener("change", () => {
    redrawSpectrum();
    savePanelViewSettings();
  });
  $("spectrumHistoryToggle").addEventListener("change", (event) => {
    resetSpectrumMemory();
    ["historyDuration", "historyBurnGain", "historyDepth", "clearSpectrumHistory"]
      .forEach((id) => { $(id).disabled = !event.target.checked; });
    redrawSpectrum();
    savePanelViewSettings();
  });
  $("historyDuration").addEventListener("input", (event) => {
    $("historyDurationValue").textContent = `t½ ${Number(event.target.value).toFixed(1)}s`;
  });
  $("historyDuration").addEventListener("change", savePanelViewSettings);
  $("historyBurnGain").addEventListener("input", (event) => {
    $("historyBurnGainValue").textContent = `${Number(event.target.value).toFixed(2)}×`;
  });
  $("historyBurnGain").addEventListener("change", savePanelViewSettings);
  $("historyDepth").addEventListener("input", (event) => {
    $("historyDepthValue").textContent = `${Math.round(Number(event.target.value) * 100)}%`;
    panelRegistry.invalidate("spectrumPanel");
  });
  $("historyDepth").addEventListener("change", savePanelViewSettings);
  $("clearSpectrumHistory").addEventListener("click", () => {
    resetSpectrumMemory();
    panelRegistry.invalidate("spectrumPanel");
  });
  $("lissajousTrailLength").addEventListener("input", (event) => {
    $("lissajousTrailLengthValue").textContent = `${(2 ** Number(event.target.value)).toFixed(2)}×`;
    panelRegistry.invalidate("lissajousPanel");
  });
  $("lissajousTrailLength").addEventListener("change", savePanelViewSettings);
  $("lissajousDriftSpeed").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    $("lissajousDriftSpeedValue").textContent = `${value >= 0 ? "+" : ""}${value.toFixed(2)} 周期/s`;
    panelRegistry.invalidate("lissajousPanel");
  });
  $("lissajousDriftSpeed").addEventListener("change", savePanelViewSettings);
  $("lissajousAutoClose").addEventListener("change", () => {
    panelRegistry.invalidate("lissajousPanel");
    savePanelViewSettings();
  });
  $("outputPhaseDelay").addEventListener("input", (event) => {
    $("outputPhaseDelayValue").textContent = `${Number(event.target.value).toFixed(1)} ms`;
    panelRegistry.invalidate("outputPhasePanel");
  });
  $("outputPhaseDelay").addEventListener("change", savePanelViewSettings);
  $("chordBasisMode").addEventListener("change", async (event) => {
    const mode = event.target.value;
    $("virtualBasisControls").hidden = mode !== "virtual";
    const payload = {mode};
    if (mode === "virtual") {
      payload.ratio_from_reference = Number($("virtualBasisRatio").value);
    }
    await applyChordBasis(payload);
  });
  $("applyVirtualBasis").addEventListener("click", async () => {
    await applyChordBasis({
      mode:"virtual",
      ratio_from_reference:Number($("virtualBasisRatio").value),
    });
  });
  const tuningCanvas = $("tuningSpaceCanvas");
  tuningCanvas.addEventListener("mousemove", (event) => {
    const point = tuningPointFromPointer(event);
    const visualId = point?.visual_id || null;
    if (visualId === state.hoveredTuningPointId) return;
    state.hoveredTuningPointId = visualId;
    tuningCanvas.style.cursor = point ? "pointer" : "crosshair";
    panelRegistry.invalidate("tuningPanel");
  });
  tuningCanvas.addEventListener("mouseleave", () => {
    if (state.hoveredTuningPointId === null) return;
    state.hoveredTuningPointId = null;
    tuningCanvas.style.cursor = "crosshair";
    panelRegistry.invalidate("tuningPanel");
  });
  tuningCanvas.addEventListener("click", (event) => {
    const point = tuningPointFromPointer(event);
    state.selectedTuningPointId = point?.visual_id || null;
    panelRegistry.invalidate("tuningPanel");
  });
  $("tuningSelect").addEventListener("change", async (event) => {
    try {
      state.tuningDraftDirty = false;
      state.tuningEditorSourceSignature = null;
      await api("/api/tuning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: event.target.value }) });
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $("timbreSelect").addEventListener("change", async (event) => {
    try {
      const value = event.target.value;
      if (value === "current:custom") return;
      if (value.startsWith("saved:")) {
        const name = value.slice("saved:".length);
        const partials = savedTimbres()[name];
        if (!partials) return;
        state.partialDraft = partials.map((partial) => ({
          multiple:Number(partial.multiple),
          amplitude:Number(partial.amplitude),
        }));
        state.partialSourceId = "custom";
        state.selectedSavedTimbreName = name;
        await api("/api/timbre/custom", {
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            partials:state.partialDraft.map((partial) => [
              partial.multiple,
              partial.amplitude,
            ]),
          }),
        });
      } else {
        state.partialDraft = null;
        state.partialSourceId = null;
        state.selectedSavedTimbreName = null;
        await api("/api/timbre", {
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({id:value.slice("builtin:".length)}),
        });
      }
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $("tuningConstruction").addEventListener("change", (event) => {
    updateTuningConstructionVisibility(event.target.value);
    markTuningDraftDirty();
  });
  [
    "tuningEquaveExpression", "tuningDivisions", "tuningGenerator",
    "tuningDegreeCount", "tuningChainStart", "tuningDegreeExpressions",
    "tuningIntervalExpressions",
  ].forEach((id) => $(id).addEventListener("input", markTuningDraftDirty));
  $("volumeSlider").addEventListener("input", (event) => {
    $("volumeValue").textContent = `${event.target.value}%`;
  });
  $("volumeSlider").addEventListener("change", async (event) => {
    try {
      await api("/api/audio/volume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: Number(event.target.value) / 100 }),
      });
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $("recordButton").addEventListener("click", async () => {
    await api(state.snapshot.recording ? "/api/recording/stop" : "/api/recording/start", { method: "POST" });
    await refreshState();
  });
  $("applyTuningButton").addEventListener("click", async () => {
    try {
      const kind = $("tuningConstruction").value;
      const payload = {
        kind,
        equave_expression:$("tuningEquaveExpression").value.trim(),
      };
      if (kind === "equal_division") {
        payload.divisions = Number($("tuningDivisions").value);
      } else if (kind === "generator_chain") {
        payload.generator_expression = $("tuningGenerator").value.trim();
        payload.degree_count = Number($("tuningDegreeCount").value);
        payload.chain_start = Number($("tuningChainStart").value);
      } else if (kind === "interval_cycle") {
        payload.interval_expressions = $("tuningIntervalExpressions").value;
      } else {
        payload.degree_expressions = $("tuningDegreeExpressions").value;
      }
      await api("/api/tuning/custom", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(payload),
      });
      state.tuningDraftDirty = false;
      state.tuningEditorSourceSignature = null;
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $("harmonicEditor").addEventListener("click", (event) => {
    if (event.target.closest(".harmonic-partial")) return;
    if (state.partialDraft.length >= 32) return showToast("最多 32 个部分音");
    const rect = event.currentTarget.getBoundingClientRect();
    const minMultiple = Number(event.currentTarget.dataset.minMultiple || 0.5);
    const maxMultiple = Number(event.currentTarget.dataset.maxMultiple || 12);
    const position = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const multiple = Math.round((2 ** (Math.log2(minMultiple) + position * Math.log2(maxMultiple / minMultiple))) * 100) / 100;
    state.partialDraft.push({multiple, amplitude:0.5});
    state.partialDraft.sort((a, b) => a.multiple - b.multiple);
    renderPartialEditor(true);
    schedulePartialApply();
  });
  $("harmonicEditor").addEventListener("contextmenu", (event) => {
    const node = event.target.closest(".harmonic-partial");
    if (!node) return;
    event.preventDefault();
    if (state.partialDraft.length === 1) return showToast("音色至少需要一个部分音");
    state.partialDraft.splice(Number(node.dataset.index), 1);
    renderPartialEditor(true);
    schedulePartialApply();
  });
  $("harmonicEditor").addEventListener("wheel", (event) => {
    const node = event.target.closest(".harmonic-partial");
    if (!node) return;
    event.preventDefault();
    const partial = state.partialDraft[Number(node.dataset.index)];
    partial.amplitude = Math.max(0, Math.min(1, partial.amplitude + (event.deltaY < 0 ? 0.03 : -0.03)));
    renderPartialEditor(true);
    schedulePartialApply();
  }, {passive:false});
  $("harmonicEditor").addEventListener("change", (event) => {
    if (!event.target.matches(".harmonic-partial input")) return;
    const node = event.target.closest(".harmonic-partial");
    const value = Number(event.target.value);
    if (!Number.isFinite(value) || value <= 0) return renderPartialEditor(true);
    state.partialDraft[Number(node.dataset.index)].multiple = Math.min(64, value);
    state.partialDraft.sort((a, b) => a.multiple - b.multiple);
    renderPartialEditor(true);
    schedulePartialApply();
  });
  $("saveTimbreButton").addEventListener("click", () => {
    const name = $("savedTimbreName").value.trim();
    if (!name) return showToast("请先输入音色名称");
    const library = savedTimbres();
    library[name] = state.partialDraft.map((partial) => ({multiple:partial.multiple, amplitude:partial.amplitude}));
    localStorage.setItem("music-lab-saved-timbres", JSON.stringify(library));
    state.selectedSavedTimbreName = name;
    renderTimbreChoices();
    showToast(`已保存音色：${name}`);
  });
  $("deleteTimbreButton").addEventListener("click", () => {
    const selectedValue = $("timbreSelect").value;
    const name = selectedValue.startsWith("saved:")
      ? selectedValue.slice("saved:".length)
      : state.selectedSavedTimbreName;
    if (!name) return showToast("请先选择一个已保存音色");
    const library = savedTimbres();
    delete library[name];
    localStorage.setItem("music-lab-saved-timbres", JSON.stringify(library));
    state.selectedSavedTimbreName = null;
    setField("savedTimbreName", "");
    renderTimbreChoices();
    showToast(`已删除音色：${name}`);
  });
  $("saveTuningButton").addEventListener("click", async () => {
    try {
      if (state.tuningDraftDirty) {
        throw new Error("请先应用当前草稿；库只保存已经过编译验证的律制定义");
      }
      const payload = {
        id:$("savedTuningId").value.trim(),
        name:$("savedTuningName").value.trim(),
        description:$("savedTuningDescription").value.trim(),
        overwrite:$("overwriteSavedTuning").checked,
      };
      await api("/api/tuning/library", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(payload),
      });
      state.tuningEditorSourceSignature = null;
      await refreshState();
      $("tuningLibraryPopover").hidden = true;
      $("tuningPanel").classList.remove("library-open");
      $("tuningLibraryButton").setAttribute("aria-expanded", "false");
      showToast(`已保存律制定义：${payload.name}`);
    } catch (error) { showToast(error.message); }
  });
  $("reloadTuningLibraryButton").addEventListener("click", async () => {
    try {
      await api("/api/tuning/library/reload", {method:"POST"});
      state.tuningEditorSourceSignature = null;
      await refreshState();
      showToast("已重载 configs/tunings 中的律制定义");
    } catch (error) { showToast(error.message); }
  });
  $("tuningLibraryButton").addEventListener("click", () => {
    const popover = $("tuningLibraryPopover");
    popover.hidden = !popover.hidden;
    $("tuningPanel").classList.toggle("library-open", !popover.hidden);
    $("tuningLibraryButton").setAttribute("aria-expanded", String(!popover.hidden));
    if (!popover.hidden) {
      const current = state.snapshot.tuning;
      const libraryEntry = state.snapshot.tunings.find((item) => item.id === current.id);
      const isUserDefinition = libraryEntry?.library_scope === "user";
      setField("savedTuningId", isUserDefinition ? current.id : current.id === "custom" ? "my-tuning" : `${current.id}-user`);
      setField("savedTuningName", current.name);
      setField("savedTuningDescription", current.description);
      $("overwriteSavedTuning").checked = false;
      $("savedTuningId").focus();
    }
  });
  $("timbreLibraryButton").addEventListener("click", () => {
    const popover = $("timbreLibraryPopover");
    popover.hidden = !popover.hidden;
    $("timbreLibraryButton").setAttribute("aria-expanded", String(!popover.hidden));
    if (!popover.hidden) $("savedTimbreName").focus();
  });
  document.addEventListener("pointerdown", (event) => {
    const timbreTop = $("timbreLibraryButton").closest(".timbre-top");
    if (!timbreTop.contains(event.target)) {
      $("timbreLibraryPopover").hidden = true;
      $("timbreLibraryButton").setAttribute("aria-expanded", "false");
    }
    const tuningTop = $("tuningLibraryButton").closest(".tuning-library-control");
    if (!tuningTop.contains(event.target)) {
      $("tuningLibraryPopover").hidden = true;
      $("tuningPanel").classList.remove("library-open");
      $("tuningLibraryButton").setAttribute("aria-expanded", "false");
    }
  });
  $("mappingMode").addEventListener("change", (event) => {
    updateMappingStrategyVisibility(event.target.value);
  });
  $("nearestSubsetButton").addEventListener("click", () => {
    const degreeCount = tuningSpaceView().degree_count;
    const subset = Array.from(
      new Set(Array.from({length:12}, (_, index) => Math.round(index * degreeCount / 12) % degreeCount)),
    ).sort((first, second) => first - second);
    setField("mappingSubset", subset.join(","));
  });
  $("inputSurfaceSelect").addEventListener("change", async (event) => {
    try {
      await api("/api/input-surface", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({id:event.target.value}),
      });
      state.selectedInputId = null;
      state.hoveredInputId = null;
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $("applyMappingButton").addEventListener("click", async () => {
    try {
      const payload = {
        surface_id:keyboardView().surface.id,
        mode:$("mappingMode").value,
        anchor_node_id:$("mappingAnchorNode").value,
        reference_degree:Number($("mappingReferenceDegree").value),
        reference_frequency_hz:Number($("mappingReferenceHz").value),
        degree_step:Number($("mappingStep").value),
        subset_degrees:$("mappingSubset").value,
        q_step:Number($("mappingQStep").value),
        r_step:Number($("mappingRStep").value),
        q_ratio_expression:$("mappingQRatio").value.trim(),
        r_ratio_expression:$("mappingRRatio").value.trim(),
      };
      await api("/api/mapping", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(payload),
      });
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $("addTrackButton").addEventListener("click", () => { state.pendingTrackId = null; $("midiFile").click(); });
  $("midiFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const trackQuery = state.pendingTrackId ? `&track_id=${encodeURIComponent(state.pendingTrackId)}` : "";
      const result = await api(`/api/tracks/midi?filename=${encodeURIComponent(file.name)}${trackQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: await file.arrayBuffer(),
      });
      showToast(`已向 ${result.track_id} 载入 ${result.notes} 个音符`);
      event.target.value = "";
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $("tracksContainer").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const trackId = button.dataset.track;
    try {
      if (button.dataset.action === "load") { state.pendingTrackId = trackId; $("midiFile").click(); return; }
      if (button.dataset.action === "play") {
        const playback = state.snapshot.playback;
        if (playback.playing && playback.kind !== trackId) return;
        const path = playback.playing
          ? "/api/playback/stop"
          : `/api/playback/${encodeURIComponent(trackId)}/start`;
        await api(path, {method:"POST"});
      } else if (button.dataset.action === "clear") {
        await api(`/api/tracks/${encodeURIComponent(trackId)}/clear`, {method:"POST"});
      } else if (button.dataset.action === "delete") {
        await api(`/api/tracks/${encodeURIComponent(trackId)}`, {method:"DELETE"});
      }
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $("tracksContainer").addEventListener("change", async (event) => {
    const select = event.target.closest("select[data-track-compile]");
    if (!select) return;
    try {
      await api(`/api/tracks/${encodeURIComponent(select.dataset.track)}/compile`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({mode:select.value}),
      });
      await refreshState();
    } catch (error) {
      showToast(error.message);
      await refreshState();
    }
  });
  document.addEventListener("click", (event) => {
    const desktopButton = event.target.closest("[data-desktop-switch]");
    if (desktopButton) {
      switchActiveDesktop(desktopButton.dataset.desktopSwitch);
      return;
    }
    const button = event.target.closest(".view-toggle");
    if (!button) return;
    const panel = $(button.dataset.panel);
    if (!panel || !state.freeLayout) return;
    const panelDesktop = state.freeLayout.getPanelDesktop(panel.id);
    if (button.closest("#externalPanelToggles") && panelDesktop !== state.freeLayout.getActiveDesktop()) {
      state.freeLayout.setPanelVisible(panel.id, true);
      switchActiveDesktop(panelDesktop);
      return;
    }
    state.freeLayout.setPanelVisible(panel.id, panel.classList.contains("collapsed"));
  });
  $("panelDesktopAssignments").addEventListener("change", (event) => {
    const select = event.target.closest("[data-panel-desktop]");
    if (!select || !state.freeLayout) return;
    const panel = PANEL_MANIFEST.find((candidate) => candidate.id === select.dataset.panelDesktop);
    if (!state.freeLayout.setPanelDesktop(select.dataset.panelDesktop, select.value)) return;
    const desktop = DESKTOP_MANIFEST.find((candidate) => candidate.id === select.value);
    showToast(`${panel?.label || select.dataset.panelDesktop}已移到${desktop?.label || select.value}`);
  });
  window.addEventListener("keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
    const index = event.code === "Digit1" ? 0 : event.code === "Digit2" ? 1 : -1;
    const desktop = DESKTOP_MANIFEST[index];
    if (!desktop) return;
    event.preventDefault();
    switchActiveDesktop(desktop.id);
  });
  const panelVisibilityButton = $("panelVisibilityButton");
  const panelVisibilityPopover = $("panelVisibilityPopover");
  panelVisibilityButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = panelVisibilityPopover.hidden;
    panelVisibilityPopover.hidden = !opening;
    panelVisibilityButton.setAttribute("aria-expanded", String(opening));
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest(".meta-panel-control")) return;
    panelVisibilityPopover.hidden = true;
    panelVisibilityButton.setAttribute("aria-expanded", "false");
  });
  const keyboardCanvas = $("keyboardCanvas");
  const clearKeyboardHover = () => {
    if (state.hoveredInputId === null) return;
    state.hoveredInputId = null;
    panelRegistry.invalidate("keyboardPanel");
  };
  keyboardCanvas.addEventListener("mousemove", (event) => {
    const key = keyFromPointer(event);
    const hoveredInputId = key?.nodeId ?? null;
    if (hoveredInputId !== state.hoveredInputId) {
      state.hoveredInputId = hoveredInputId;
      panelRegistry.invalidate("keyboardPanel");
    }
  });
  keyboardCanvas.addEventListener("mouseleave", clearKeyboardHover);
  keyboardCanvas.addEventListener("pointerleave", clearKeyboardHover);
  document.addEventListener("mousemove", (event) => {
    if (event.target !== keyboardCanvas) clearKeyboardHover();
  });
  window.addEventListener("blur", clearKeyboardHover);
  keyboardCanvas.addEventListener("click", (event) => {
    const key = keyFromPointer(event);
    if (!key || key.nodeId === state.selectedInputId) return;
    state.selectedInputId = key.nodeId;
    state.selectedNote = key.note;
    panelRegistry.invalidate(["keyboardPanel", "pitchIdentityPanel", "chordPanel"]);
  });
  const releaseVirtualInput = async () => {
    const nodeId = state.soundingVirtualInputId;
    if (!nodeId) return;
    state.virtualInputEpoch += 1;
    state.soundingVirtualInputId = null;
    try {
      await api(`/api/input/${encodeURIComponent(nodeId)}/off`, {method:"POST"});
    } catch (error) { showToast(error.message); }
  };
  keyboardCanvas.addEventListener("pointerdown", async (event) => {
    if (event.button !== 0 || state.snapshot.schema_version < 9) return;
    const key = keyFromPointer(event);
    if (!key?.nodeId) return;
    event.preventDefault();
    await releaseVirtualInput();
    state.soundingVirtualInputId = key.nodeId;
    const epoch = ++state.virtualInputEpoch;
    keyboardCanvas.setPointerCapture?.(event.pointerId);
    try {
      await api(`/api/input/${encodeURIComponent(key.nodeId)}/on`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({velocity:96}),
      });
      if (epoch !== state.virtualInputEpoch || state.soundingVirtualInputId !== key.nodeId) {
        await api(`/api/input/${encodeURIComponent(key.nodeId)}/off`, {method:"POST"});
      }
    } catch (error) {
      state.soundingVirtualInputId = null;
      showToast(error.message);
    }
  });
  keyboardCanvas.addEventListener("pointerup", () => { void releaseVirtualInput(); });
  keyboardCanvas.addEventListener("pointercancel", () => { void releaseVirtualInput(); });
  window.addEventListener("blur", () => { void releaseVirtualInput(); });
}

async function boot() {
  initializePanelRegistry();
  initializeFreeLayout();
  initializePresentationLayouts();
  bindControls();
  await refreshState();
  connectWebSocket();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshState();
  });
  setInterval(() => {
    if (document.hidden) return;
    if (
      state.snapshot?.recording
      || state.snapshot?.playback?.playing
      || state.snapshot?.keyboard?.active?.length
    ) refreshLiveState();
  }, 120);
  setInterval(() => {
    if (document.hidden) return;
    if (panelVisible("spectrumPanel")) refreshAnalysis();
    if (panelVisible("lissajousPanel")) panelRegistry.invalidate("lissajousPanel");
    if (panelVisible("outputPhasePanel")) refreshPhase();
  }, 100);
}

boot();
