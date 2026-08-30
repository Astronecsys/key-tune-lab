import {
  INSTRUMENT_SCHEMA_VERSION,
} from "./instrument-state.js";
import { FastApiInstrumentClient } from "./instrument-client.js";
import { selectKeyboardView, selectTuningSpace } from "./instrument-selectors.js";
import { InstrumentStore } from "./instrument-store.js";
import {
  LAYOUT_STORAGE_KEY,
  createGridLayoutManager,
} from "./layout-manager.js";
import { DESKTOP_MANIFEST, PANEL_MANIFEST } from "./panel-manifest.js";
import { createKeyboardPanelRenderer } from "./panels/keyboard-panel.js";
import { createRelationPanelRenderer, resolveChordBasis } from "./panels/relation-panels.js";
import { createSignalPanelRenderer } from "./panels/signal-panels.js";
import { createTimbrePanel } from "./panels/timbre-panel.js";
import { createTracksPanelRenderer } from "./panels/tracks-panel.js";
import { createPresentationController } from "./presentation-controller.js";
import { PRESENTATION_STORAGE_KEY } from "./presentation-layout.js";
import {
  TIMBRE_STORAGE_KEY,
  createProjectStorage,
} from "./project-document.js";
import { PanelRegistry } from "./render-scheduler.js";
import {
  activeTuningPoints,
  drawTuningSpaceCanvas,
  tuningPointDescription,
  tuningPointFromCoordinates,
} from "./tuning-space-view.js";
import { TelemetryScheduler } from "./telemetry-scheduler.js";

const projectStorage = createProjectStorage(window.localStorage, {
  layout:LAYOUT_STORAGE_KEY,
  presentation:PRESENTATION_STORAGE_KEY,
  timbres:TIMBRE_STORAGE_KEY,
});

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
  spectrumMemory:null,
  presentation:{document:null, timer:null, playing:false, actionEpoch:0, actions:null},
  telemetry:null,
};
const instrumentClient = new FastApiInstrumentClient();
const instrumentStore = new InstrumentStore(state);

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
  return selectKeyboardView(state.snapshot);
}

function tuningSpaceView() {
  return selectTuningSpace(state.snapshot);
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

const presentationController = createPresentationController({
  state,
  byId:$,
  escapeHtml,
  projectStorage,
  layoutProvider:() => state.freeLayout,
  instrument:instrumentClient,
  refreshState,
  getInstrumentSnapshot:() => state.snapshot,
  getViewSettings:readPanelViewSettings,
  resetSpectrumHistory:resetSpectrumMemory,
  invalidatePanel:(panelId) => panelRegistry.invalidate(panelId),
  showMessage:showToast,
  switchDesktop:switchActiveDesktop,
});

function initializePresentationLayouts() {
  presentationController.initialize();
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

async function applyChordBasis(payload) {
  try {
    await instrumentClient.setChordBasis(payload);
    await refreshState();
  } catch (error) { showToast(error.message); }
}

async function refreshState() {
  if (state.refreshPending) return;
  state.refreshPending = true;
  try {
    instrumentStore.replaceSnapshot(await instrumentClient.state());
    renderAll();
  } catch (error) {
    showToast(`无法读取状态：${error.message}`);
  } finally {
    state.refreshPending = false;
  }
}

async function refreshAnalysis() {
  try {
    instrumentStore.replaceAnalysis(await instrumentClient.analysis());
    panelRegistry.invalidate(["spectrumPanel", "lissajousPanel"]);
  } catch (_) {}
}

async function refreshPhase() {
  if (state.phaseRefreshPending) return;
  state.phaseRefreshPending = true;
  try {
    const payload = await instrumentClient.phase(4096, {
      minimumSchemaVersion:INSTRUMENT_SCHEMA_VERSION - 1,
      maximumSchemaVersion:INSTRUMENT_SCHEMA_VERSION,
    });
    instrumentStore.replacePhase({
      samples:Array.from(payload.samples),
      sampleRateHz:payload.sampleRateHz,
    });
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

const keyboardPanelRenderer = createKeyboardPanelRenderer({
  state,
  canvas:$("keyboardCanvas"),
  resizeCanvas,
  getKeyboard:keyboardView,
  getChordBasis:() => chordBasis(state.snapshot.chord),
  palette:CATPPUCCIN,
  colorWithAlpha,
});

function drawKeyboard() {
  keyboardPanelRenderer.draw();
}

function keyFromPointer(event) {
  return keyboardPanelRenderer.keyFromPointer(event);
}

function chordBasis(chord) {
  return resolveChordBasis(chord);
}

const relationPanelRenderer = createRelationPanelRenderer({
  state,
  byId:$,
  escapeHtml,
  panelRegistry,
  applyChordBasis,
  setField,
  palette:CATPPUCCIN,
  rootToneColor:ROOT_TONE_COLOR,
  relationColors:PITCH_RELATION_COLORS,
});

function renderPitchIdentityPanel() {
  relationPanelRenderer.renderPitchIdentity();
}

function renderChordPanel() {
  relationPanelRenderer.renderChord();
}

async function refreshLiveState() {
  if (state.refreshPending || state.liveRefreshPending || !state.snapshot) return;
  state.liveRefreshPending = true;
  try {
    instrumentStore.mergeLive(await instrumentClient.live());
    renderLiveState();
  } catch (error) {
    showToast(`无法读取实时状态：${error.message}`);
  } finally {
    state.liveRefreshPending = false;
  }
}

const timbrePanel = createTimbrePanel({
  state,
  byId:$,
  projectStorage,
  storageKey:TIMBRE_STORAGE_KEY,
  instrument:instrumentClient,
  refreshState,
  showMessage:showToast,
  setField,
});

function renderPartialEditor(force = false) {
  timbrePanel.renderEditor(force);
}

function renderTimbreChoices() {
  timbrePanel.renderChoices();
}

const tracksPanelRenderer = createTracksPanelRenderer({
  state,
  canvasHost:() => $("tracksContainer"),
  resizeCanvas,
  palette:CATPPUCCIN,
});

function renderTracks() {
  tracksPanelRenderer.render();
}

function colorWithAlpha(hex, alpha) {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha))})`;
}

const signalPanelRenderer = createSignalPanelRenderer({
  state,
  byId:$,
  resizeCanvas,
  resolveBasis:chordBasis,
  palette:CATPPUCCIN,
  rootToneColor:ROOT_TONE_COLOR,
  relationColors:PITCH_RELATION_COLORS,
  colorWithAlpha,
});

function resetSpectrumMemory() {
  signalPanelRenderer.resetMemory();
}

function drawSignalAnalysis(requestedPanel = null) {
  signalPanelRenderer.draw(requestedPanel);
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
  const activeSummary = active.length
    ? `${active.length} 个触发音 · ${active.map((item) => item.frequency_hz.toFixed(1)).join(" / ")} Hz`
    : "等待琴键输入";
  // 摘要会随演奏快速变化；title 保留被界面截断后的完整频率列表。
  $("activeSummary").textContent = activeSummary;
  $("activeSummary").title = activeSummary;
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
  const mappingPresets = (state.snapshot.mapping_presets || []).filter(
    (preset) => preset.surface_kinds?.includes(keyboard.surface.kind),
  );
  const presetSelect = $("mappingPresetSelect");
  const previousPreset = presetSelect.value;
  presetSelect.innerHTML = '<option value="">手动参数</option>' + mappingPresets
    .map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`)
    .join("");
  if (mappingPresets.some((preset) => preset.id === previousPreset)) {
    presetSelect.value = previousPreset;
  }
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
    storage:projectStorage,
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
  const fullRefreshEvents = new Set([
    "ready", "configuration", "target_loaded", "tracks",
    "performance_cleared", "recording",
  ]);
  instrumentClient.openEventStream({
    onEvent:(event) => {
      if (document.hidden) return;
      if (fullRefreshEvents.has(event.type)) refreshState();
      else state.telemetry?.requestLive();
    },
    onError:() => {},
    onClose:() => setTimeout(connectWebSocket, 1200),
  });
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
      await instrumentClient.setTuning(event.target.value);
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  timbrePanel.bind();
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
      await instrumentClient.setVolume(Number(event.target.value) / 100);
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $("recordButton").addEventListener("click", async () => {
    if (state.snapshot.recording) await instrumentClient.stopRecording();
    else await instrumentClient.startRecording();
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
      await instrumentClient.setCustomTuning(payload);
      state.tuningDraftDirty = false;
      state.tuningEditorSourceSignature = null;
      await refreshState();
    } catch (error) { showToast(error.message); }
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
      await instrumentClient.saveTuning(payload);
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
      await instrumentClient.reloadTuningLibrary();
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
      await instrumentClient.setInputSurface(event.target.value);
      state.selectedInputId = null;
      state.hoveredInputId = null;
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $("mappingPresetSelect").addEventListener("change", (event) => {
    const preset = (state.snapshot.mapping_presets || []).find(
      (candidate) => candidate.id === event.target.value,
    );
    if (!preset) return;
    const mapping = preset.mapping || {};
    Object.entries({
      mappingMode:mapping.mode,
      mappingStep:mapping.degree_step,
      mappingSubset:Array.isArray(mapping.subset_degrees) ? mapping.subset_degrees.join(",") : mapping.subset_degrees,
      mappingQStep:mapping.q_step,
      mappingRStep:mapping.r_step,
      mappingQRatio:mapping.q_ratio_expression,
      mappingRRatio:mapping.r_ratio_expression,
    }).forEach(([id, value]) => {
      if (value !== undefined) setField(id, value);
    });
    updateMappingStrategyVisibility(mapping.mode || $("mappingMode").value);
    $("mappingSummary").textContent = `${preset.name} · ${preset.description || "预设参数已载入，点击“编译映射”应用"}`;
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
      await instrumentClient.setMapping(payload);
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $("addTrackButton").addEventListener("click", () => { state.pendingTrackId = null; $("midiFile").click(); });
  $("midiFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const result = await instrumentClient.uploadTrackMidi(await file.arrayBuffer(), {
        filename:file.name,
        trackId:state.pendingTrackId,
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
        if (playback.playing) await instrumentClient.stopPlayback();
        else await instrumentClient.startPlayback(trackId);
      } else if (button.dataset.action === "clear") {
        await instrumentClient.clearTrack(trackId);
      } else if (button.dataset.action === "delete") {
        await instrumentClient.deleteTrack(trackId);
      }
      await refreshState();
    } catch (error) { showToast(error.message); }
  });
  $("tracksContainer").addEventListener("change", async (event) => {
    const select = event.target.closest("select[data-track-compile]");
    if (!select) return;
    try {
      await instrumentClient.setTrackCompileMode(select.dataset.track, select.value);
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
      await instrumentClient.noteOff(nodeId);
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
      await instrumentClient.noteOn(key.nodeId, 96);
      if (epoch !== state.virtualInputEpoch || state.soundingVirtualInputId !== key.nodeId) {
        await instrumentClient.noteOff(key.nodeId);
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
  state.telemetry = new TelemetryScheduler({
    isLiveActive:() => Boolean(
      state.snapshot?.recording
      || state.snapshot?.playback?.playing
      || state.snapshot?.keyboard?.active?.length
    ),
    isPanelVisible:panelVisible,
    refreshLive:refreshLiveState,
    refreshAnalysis,
    refreshPhase,
    invalidatePanel:(panelId) => panelRegistry.invalidate(panelId),
  });
  state.telemetry.start();
  connectWebSocket();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshState();
  });
}

boot();
