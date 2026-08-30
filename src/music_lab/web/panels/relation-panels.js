import {
  RELATION_PRIMES,
  pitchIdentityLabel,
  relationshipColumns,
  tonesHighToLow,
} from "../chord-view.js";

export function resolveChordBasis(chord) {
  if (chord.basis) return chord.basis;
  return chord.root ? {
    ...chord.root,
    mode:"lowest",
    origin:"lowest",
    sounding:true,
    ratio_from_reference:chord.root.frequency_hz / chord.reference.frequency_hz,
  } : null;
}

/** 05/06 两张关系表共享同一个只读关系 ViewModel。 */
export function createRelationPanelRenderer({
  state,
  byId,
  escapeHtml,
  panelRegistry,
  applyChordBasis,
  setField,
  palette,
  rootToneColor,
  relationColors,
}) {
  const toneColor = (toneIndex) => toneIndex === 0
    ? rootToneColor
    : relationColors[(toneIndex - 1) % relationColors.length];

  function relationVectorMarkup(relation) {
    const {primeExponents, algebraicRelation} = relationshipColumns(relation);
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

  function renderRows(container, tones, cellsForTone, {markBasis = false} = {}) {
    const distanceFromBottom = Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop);
    container.innerHTML = "";
    if (!tones.length) {
      container.innerHTML = '<span class="subtle">等待输入</span>';
    } else {
      const soundingLowToHigh = tones
        .filter((tone) => !tone.is_analysis_basis)
        .sort((first, second) => first.frequency_hz - second.frequency_hz);
      tonesHighToLow(tones).forEach((tone) => {
        const toneIndex = tone.is_analysis_basis ? 0 : soundingLowToHigh.indexOf(tone);
        const row = document.createElement("div");
        row.className = "relation-tone";
        row.classList.toggle("relation-basis", markBasis && tone.is_basis);
        row.classList.toggle("analysis-basis", Boolean(tone.is_analysis_basis));
        if (markBasis && tone.is_basis) {
          row.setAttribute("aria-label", `${pitchIdentityLabel(tone)}，和弦基准 B`);
        }
        row.classList.toggle("selected", tone.midi_note !== null && state.selectedNote === tone.midi_note);
        row.dataset.frequencyHz = tone.frequency_hz.toFixed(6);
        if (tone.midi_note !== null && tone.midi_note !== undefined) row.dataset.midiNote = String(tone.midi_note);
        row.style.setProperty("--tone-color", tone.is_analysis_basis ? palette.mauve : toneColor(toneIndex));
        row.innerHTML = cellsForTone(tone, toneIndex);
        if (tone.basis_selectable) {
          const basisButton = document.createElement("button");
          basisButton.className = "basis-row-action";
          basisButton.type = "button";
          basisButton.textContent = "设 B";
          basisButton.setAttribute("aria-label", `设 ${pitchIdentityLabel(tone)} 为和弦基准 B`);
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
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight - distanceFromBottom);
  }

  function renderPitchIdentity() {
    if (!state.snapshot) return;
    const chord = state.snapshot.chord;
    byId("tuningToneCount").textContent = `${chord.size} 音`;
    const reference = chord.reference;
    byId("tuningReference").textContent = reference
      ? `律制参考 T = ${pitchIdentityLabel(reference)} · ${reference.frequency_hz.toFixed(3)} Hz`
      : "律制参考 T —";
    renderRows(byId("tuningTones"), chord.tones, (tone) => {
      const relation = tone.tuning_relation;
      const referenceRelation = `×${relation.ratio.toFixed(8)} · ${relation.ratio_label}`;
      return `${pitchCellMarkup(tone)}
        <div class="relation-cell" title="${escapeHtml(referenceRelation)}">${escapeHtml(referenceRelation)}</div>
        ${relationVectorMarkup(relation)}`;
    });
  }

  function renderChord() {
    if (!state.snapshot) return;
    const chord = state.snapshot.chord;
    const renderSignature = JSON.stringify([state.selectedNote, chord]);
    if (renderSignature === state.chordRenderSignature) return;
    state.chordRenderSignature = renderSignature;
    const basis = resolveChordBasis(chord);
    const basisMode = chord.basis_mode || basis?.mode || "lowest";
    byId("chordPanel").classList.toggle("basis-selection-mode", basisMode === "selected");
    byId("chordName").textContent = chord.name;
    byId("chordCount").textContent = `${chord.size} 音`;
    byId("chordBasisMode").value = basisMode;
    byId("virtualBasisControls").hidden = basisMode !== "virtual";
    if (basisMode === "virtual" && basis) setField("virtualBasisRatio", Number(basis.ratio_from_reference.toPrecision(9)));
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
    byId("chordBasisHint").textContent = basisMode === "selected"
      ? "点击任意发声音高行设为 B"
      : basisMode === "virtual"
        ? "仅用于分析，不送入合成器"
        : ["auto_simple", "auto_fundamental", "auto_composite"].includes(basisMode)
          ? basis?.auto
            ? `${autoModelLabel} · 覆盖 ${basis.auto.coverage}/${basis.auto.tone_count} · 评分 ${basis.auto.score.toFixed(2)}`
            : "等待发声音以推断 B"
          : "自动取最低实音";
    byId("chordBasis").textContent = basis
      ? `和弦基准 B = ${pitchIdentityLabel(basis)} · ${basis.frequency_hz.toFixed(3)} Hz · ${originLabel}`
      : "和弦基准 B —";
    const tones = chord.tones.map((tone, toneIndex) => ({
      ...tone,
      basis_selectable:basisMode === "selected",
      is_basis:tone.is_basis ?? (basisMode === "lowest" && toneIndex === 0),
    }));
    if (basis && !basis.sounding) {
      tones.push({
        ...basis,
        velocity:0,
        is_basis:true,
        is_analysis_basis:true,
        chord_relation:basis.identity_relation || {
          reference:"B", ratio:1, ratio_label:"1/1", relationship_kind:"exact harmonic ratio",
          prime_vector:{"2":0,"3":0,"5":0,"7":0,"11":0}, prime_vector_label:"1",
        },
      });
    }
    renderRows(byId("chordTones"), tones, (tone) => {
      const relation = tone.chord_relation;
      const ratio = relation ? `×${relation.ratio.toFixed(8)} · ${relation.ratio_label}` : "等待选择 B";
      return `${pitchCellMarkup(tone)}
        <div class="relation-cell" title="${escapeHtml(ratio)}">${escapeHtml(ratio)}</div>
        ${relation ? relationVectorMarkup(relation) : '<div class="prime-vector">—</div>'}`;
    }, {markBasis:true});
  }

  return {renderPitchIdentity, renderChord};
}

