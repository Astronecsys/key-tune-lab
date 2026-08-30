// 泛音编辑器同时负责本地音色库；它通过 InstrumentClient 提交领域命令。
export function createTimbrePanel({
  state,
  byId,
  projectStorage,
  storageKey,
  instrument,
  refreshState,
  showMessage,
  setField,
}) {
  function savedTimbres() {
    try {
      return JSON.parse(projectStorage.getItem(storageKey) || "{}");
    } catch (_) {
      return {};
    }
  }

  function renderEditor(force = false) {
    const editor = byId("harmonicEditor");
    if (!state.partialDraft || state.partialSourceId !== state.snapshot.timbre.id) {
      state.partialDraft = state.snapshot.timbre.partials.map((partial) => ({
        multiple:partial.multiple,
        amplitude:partial.amplitude,
      }));
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

  function scheduleApply() {
    clearTimeout(state.partialApplyTimer);
    state.selectedSavedTimbreName = null;
    state.partialApplyTimer = setTimeout(async () => {
      try {
        await instrument.setCustomTimbre(
          state.partialDraft.map((partial) => [partial.multiple, partial.amplitude]),
        );
        state.partialSourceId = "custom";
        await refreshState();
      } catch (error) {
        showMessage(error.message);
      }
    }, 100);
  }

  function renderChoices() {
    const select = byId("timbreSelect");
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

  function bind() {
    byId("timbreSelect").addEventListener("change", async (event) => {
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
          await instrument.setCustomTimbre(
            state.partialDraft.map((partial) => [partial.multiple, partial.amplitude]),
          );
        } else {
          state.partialDraft = null;
          state.partialSourceId = null;
          state.selectedSavedTimbreName = null;
          await instrument.setTimbre(value.slice("builtin:".length));
        }
        await refreshState();
      } catch (error) {
        showMessage(error.message);
      }
    });

    const editor = byId("harmonicEditor");
    editor.addEventListener("click", (event) => {
      if (event.target.closest(".harmonic-partial")) return;
      if (state.partialDraft.length >= 32) return showMessage("最多 32 个部分音");
      const rect = event.currentTarget.getBoundingClientRect();
      const minMultiple = Number(event.currentTarget.dataset.minMultiple || 0.5);
      const maxMultiple = Number(event.currentTarget.dataset.maxMultiple || 12);
      const position = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const multiple = Math.round((2 ** (
        Math.log2(minMultiple) + position * Math.log2(maxMultiple / minMultiple)
      )) * 100) / 100;
      state.partialDraft.push({multiple, amplitude:0.5});
      state.partialDraft.sort((first, second) => first.multiple - second.multiple);
      renderEditor(true);
      scheduleApply();
    });
    editor.addEventListener("contextmenu", (event) => {
      const node = event.target.closest(".harmonic-partial");
      if (!node) return;
      event.preventDefault();
      if (state.partialDraft.length === 1) return showMessage("音色至少需要一个部分音");
      state.partialDraft.splice(Number(node.dataset.index), 1);
      renderEditor(true);
      scheduleApply();
    });
    editor.addEventListener("wheel", (event) => {
      const node = event.target.closest(".harmonic-partial");
      if (!node) return;
      event.preventDefault();
      const partial = state.partialDraft[Number(node.dataset.index)];
      partial.amplitude = Math.max(
        0,
        Math.min(1, partial.amplitude + (event.deltaY < 0 ? 0.03 : -0.03)),
      );
      renderEditor(true);
      scheduleApply();
    }, {passive:false});
    editor.addEventListener("change", (event) => {
      if (!event.target.matches(".harmonic-partial input")) return;
      const node = event.target.closest(".harmonic-partial");
      const value = Number(event.target.value);
      if (!Number.isFinite(value) || value <= 0) return renderEditor(true);
      state.partialDraft[Number(node.dataset.index)].multiple = Math.min(64, value);
      state.partialDraft.sort((first, second) => first.multiple - second.multiple);
      renderEditor(true);
      scheduleApply();
    });
    byId("saveTimbreButton").addEventListener("click", () => {
      const name = byId("savedTimbreName").value.trim();
      if (!name) return showMessage("请先输入音色名称");
      const library = savedTimbres();
      library[name] = state.partialDraft.map((partial) => ({
        multiple:partial.multiple,
        amplitude:partial.amplitude,
      }));
      projectStorage.setItem(storageKey, JSON.stringify(library));
      state.selectedSavedTimbreName = name;
      renderChoices();
      showMessage(`已保存音色：${name}`);
    });
    byId("deleteTimbreButton").addEventListener("click", () => {
      const selectedValue = byId("timbreSelect").value;
      const name = selectedValue.startsWith("saved:")
        ? selectedValue.slice("saved:".length)
        : state.selectedSavedTimbreName;
      if (!name) return showMessage("请先选择一个已保存音色");
      const library = savedTimbres();
      delete library[name];
      projectStorage.setItem(storageKey, JSON.stringify(library));
      state.selectedSavedTimbreName = null;
      setField("savedTimbreName", "");
      renderChoices();
      showMessage(`已删除音色：${name}`);
    });
  }

  return {bind, renderChoices, renderEditor};
}
