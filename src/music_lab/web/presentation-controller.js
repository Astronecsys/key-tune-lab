import {DESKTOP_MANIFEST, PANEL_MANIFEST} from "./panel-manifest.js";
import {
  loadPresentationDocument,
  moveScene,
  nextSceneId,
  savePresentationDocument,
} from "./presentation-layout.js";
import {createInstrumentActionRegistry} from "./presentation-actions.js";

// 布局放映是独立控制器：切换视图与执行动作都不会重建乐器状态。
export function createPresentationController({
  state,
  byId,
  escapeHtml,
  projectStorage,
  layoutProvider,
  instrument,
  refreshState,
  getInstrumentSnapshot,
  getViewSettings,
  resetSpectrumHistory,
  invalidatePanel,
  showMessage,
  switchDesktop,
}) {
  const $ = byId;

  function presentationSnapshot() {
    return layoutProvider()?.getSnapshot() || {
      layout:{},
      viewSettings:getViewSettings(),
      hiddenPanels:[],
      activeDesktop:DESKTOP_MANIFEST[0].id,
      panelDesktops:Object.fromEntries(PANEL_MANIFEST.map((panel) => [panel.id, panel.desktop])),
    };
  }
  
  function persistPresentation() {
    if (state.presentation.document) {
      state.presentation.document = savePresentationDocument(
        projectStorage,
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
  
  async function runSceneActions(scene, epoch) {
    if (!state.presentation.actions) {
      state.presentation.actions = createInstrumentActionRegistry({
        layout:() => layoutProvider(),
        instrument:instrument,
        refreshState,
        getSnapshot:getInstrumentSnapshot,
        resetSpectrumHistory:resetSpectrumHistory,
        invalidatePanel:(panelId) => invalidatePanel(panelId),
        showMessage:showMessage,
      });
    }
    await state.presentation.actions.run(scene.actions || [], {
      isCancelled:() => epoch !== state.presentation.actionEpoch,
      onError:(error) => showMessage(`场景动作失败：${error.message}`),
    });
  }
  
  function selectPresentationScene(sceneId, { startTimer = state.presentation.playing } = {}) {
    const documentData = state.presentation.document;
    const scene = documentData?.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene || !layoutProvider()) return;
    state.presentation.document.selectedId = scene.id;
    state.presentation.actionEpoch += 1;
    const actionEpoch = state.presentation.actionEpoch;
    layoutProvider().focusPanel(null);
    layoutProvider().applySnapshot(scene, {persist:false});
    persistPresentation();
    renderPresentationControls();
    if (startTimer) schedulePresentationAdvance();
    invalidatePanel(Object.keys(scene.layout));
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
    state.presentation.document = loadPresentationDocument(projectStorage, fallback);
    renderPresentationControls();
    $("layoutSceneSelect").addEventListener("change", (event) => selectPresentationScene(event.target.value));
    $("layoutSceneList").addEventListener("click", (event) => {
      const row = event.target.closest("[data-scene-id]");
      if (row) selectPresentationScene(row.dataset.sceneId);
    });
    $("layoutSceneSave").addEventListener("click", () => {
      let actions;
      try { actions = parseSceneActions(); } catch (error) { showMessage(error.message); return; }
      const name = $("layoutSceneName").value.trim() || `布局 ${state.presentation.document.scenes.length + 1}`;
      const snapshot = presentationSnapshot();
      const scene = {id:`layout-${Date.now().toString(36)}`, name, durationSeconds:Number($("layoutSceneDuration").value), actions, ...snapshot};
      state.presentation.document.scenes.push(scene);
      state.presentation.document.selectedId = scene.id;
      persistPresentation();
      renderPresentationControls();
      showMessage(`已保存布局：${name}`);
    });
    $("layoutSceneUpdate").addEventListener("click", () => {
      const scene = selectedPresentationScene();
      if (!scene) return;
      let actions;
      try { actions = parseSceneActions(); } catch (error) { showMessage(error.message); return; }
      Object.assign(scene, presentationSnapshot(), {
        name:$("layoutSceneName").value.trim() || scene.name,
        durationSeconds:Number($("layoutSceneDuration").value) || 12,
        actions,
      });
      persistPresentation();
      renderPresentationControls();
      showMessage(`已更新布局：${scene.name}`);
    });
    $("layoutSceneDelete").addEventListener("click", () => {
      if (state.presentation.document.scenes.length <= 1) {
        showMessage("至少保留一个布局");
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
      active:() => layoutProvider()?.getActiveDesktop() || null,
      switch:(desktopId) => switchDesktop(desktopId, {announce:false}),
      assignments:() => layoutProvider()?.getPanelDesktops() || {},
      movePanel:(panelId, desktopId) => layoutProvider()?.setPanelDesktop(panelId, desktopId) || false,
    };
    window.KEY_TUNE_PROJECT = {
      getDocument:() => projectStorage.getDocument(),
      exportJson:() => JSON.stringify(projectStorage.getDocument(), null, 2),
      importJson:(source) => {
        const documentData = typeof source === "string" ? JSON.parse(source) : source;
        const imported = projectStorage.replaceDocument(documentData);
        // 布局控制器持有内存态；刷新可以让所有 section 在同一个时刻完成切换。
        window.location.reload();
        return imported;
      },
    };
    selectPresentationScene(state.presentation.document.selectedId, {startTimer:false});
  }
  

  return {
    initialize:initializePresentationLayouts,
    render:renderPresentationControls,
    select:selectPresentationScene,
  };
}
