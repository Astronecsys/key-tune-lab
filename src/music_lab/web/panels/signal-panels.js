import {lissajousTraceWindow, pitchIdentityLabel} from "../chord-view.js";
import {delayedPhasePoints} from "../signal-view.js";
import {
  createSpectrumMemory,
  spectrumAfterglowColumns,
  updateSpectrumMemoryFrame,
} from "../spectrum-memory.js";

// 三个实时信号面板共享同一份分析快照，但拥有独立画布与显隐生命周期。
export function createSignalPanelRenderer({
  state,
  byId,
  resizeCanvas,
  resolveBasis,
  palette,
  rootToneColor,
  relationColors,
  colorWithAlpha,
}) {
  const chordBasis = resolveBasis;

  function resetSpectrumMemory() {
    state.spectrumMemory = createSpectrumMemory();
  }
  
  function updateSpectrumMemory(points) {
    return updateSpectrumMemoryFrame(state.spectrumMemory, points, {
      nowMs:performance.now(),
      halfLifeSeconds:Number(byId("historyDuration").value) || 5,
      burnGain:Number(byId("historyBurnGain").value) || 1,
      rms:state.analysis.rms,
      peak:state.analysis.peak,
    });
  }
  
  function buildPartialRelationModel() {
    const activeNotes = [...state.snapshot.keyboard.active]
      .sort((first, second) => first.frequency_hz - second.frequency_hz)
      .slice(0, 10);
    const noteColors = [palette.sky, palette.yellow, palette.green, palette.pink, palette.mauve, palette.peach];
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
    const depth = Number(byId("historyDepth").value) || 0.55;
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const haze = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
    haze.addColorStop(0, colorWithAlpha(palette.mauve, 0.35));
    haze.addColorStop(0.45, colorWithAlpha(palette.mauve, 1));
    haze.addColorStop(1, colorWithAlpha(palette.mauve, 0.28));
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
      ctx.strokeStyle = colorWithAlpha(palette.peach, 0.22 + relation.score * 0.62);
      ctx.lineWidth = 1 + relation.score * 1.8;
      ctx.shadowColor = colorWithAlpha(palette.red, 0.55);
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
      ctx.strokeStyle = colorWithAlpha(palette.text, 0.52 + Math.min(0.42, cluster.members.length * 0.08));
      ctx.lineWidth = 2 + Math.min(4, cluster.members.length * 0.8);
      ctx.shadowColor = palette.sky;
      ctx.shadowBlur = 10 + Math.min(12, cluster.members.length * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 2.5 + Math.min(3, cluster.members.length * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = palette.text;
      ctx.fill();
    });
    ctx.restore();
  
    const summary = byId("spectrumRelationSummary");
    if (model.activeNotes.length < 2) {
      summary.textContent = model.activeNotes.length ? `1 个音 · ${model.partials.length} 个部分音` : "等待多音输入";
    } else {
      summary.textContent = `融合 ${model.fusion.length} · 拍频邻近 ${model.roughness.length}`;
    }
  }
  
  function drawSignalAnalysis(requestedPanel = null) {
    if (!state.analysis) return;
    const spectrumCanvas = byId("spectrumCanvas");
    const requested = (panelId) => requestedPanel === null || requestedPanel === panelId;
    const spectrumVisible = requested("spectrumPanel")
      && !byId("spectrumPanel").classList.contains("collapsed");
    const lissajousVisible = requested("lissajousPanel")
      && !byId("lissajousPanel").classList.contains("collapsed");
    const outputPhaseVisible = requested("outputPhasePanel")
      && !byId("outputPhasePanel").classList.contains("collapsed");
    if (spectrumVisible && state.analysis) {
    const spectrumFrame = resizeCanvas(spectrumCanvas);
    const sctx = spectrumFrame.context;
    const sw = spectrumFrame.width;
    const sh = spectrumFrame.height;
    sctx.clearRect(0, 0, sw, sh);
    sctx.fillStyle = palette.crust; sctx.fillRect(0, 0, sw, sh);
    const xForSpectrum = (frequency) => 42 + (Math.log10(frequency / 20) / Math.log10(12000 / 20)) * (sw - 54);
    const yForSpectrum = (level) => 10 + (1 - Math.sqrt(Math.max(0, Math.min(1, level)))) * (sh - 34);
    sctx.strokeStyle = palette.surface0; sctx.lineWidth = 1;
    [100, 1000, 10000].forEach((frequency) => {
      const x = xForSpectrum(frequency);
      sctx.beginPath(); sctx.moveTo(x, 10); sctx.lineTo(x, sh - 22); sctx.stroke();
      sctx.fillStyle = palette.overlay0; sctx.font = "9px Consolas"; sctx.textAlign = "center";
      sctx.fillText(frequency >= 1000 ? `${frequency / 1000}k` : String(frequency), x, sh - 7);
    });
    if (byId("partialRelationsToggle").checked) {
      drawPartialRelations(sctx, sw, sh, xForSpectrum, yForSpectrum);
    } else {
      byId("spectrumRelationSummary").textContent = "部分音关系已关闭";
    }
    if (byId("spectrumHistoryToggle").checked) {
      drawSpectrumMemory(sctx, sw, sh, state.analysis.spectrum);
    }
    sctx.beginPath();
    state.analysis.spectrum.forEach((point, index) => {
      const x = xForSpectrum(point.frequency_hz);
      const y = yForSpectrum(point.level);
      if (index === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
    });
    sctx.strokeStyle = palette.sky; sctx.lineWidth = 1.6; sctx.stroke();
    }
  
    if (lissajousVisible) {
    const lissaCanvas = byId("lissajousCanvas");
    const lissaFrame = resizeCanvas(lissaCanvas);
    const lctx = lissaFrame.context;
    const lw = lissaFrame.width;
    const lh = lissaFrame.height;
    lctx.clearRect(0, 0, lw, lh);
    lctx.fillStyle = palette.crust; lctx.fillRect(0, 0, lw, lh);
    lctx.strokeStyle = palette.surface0; lctx.lineWidth = 1;
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
      lctx.fillStyle = palette.overlay0;
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
          trailScale:2 ** Number(byId("lissajousTrailLength").value),
          driftCyclesPerSecond:Number(byId("lissajousDriftSpeed").value),
          autoClose:byId("lissajousAutoClose").checked,
        });
        const {rational, rootCycles, phaseOffset} = traceWindow;
        const fastestCycles = Math.max(rootCycles, rootCycles * ratio);
        const pointCount = Math.min(16384, Math.max(4096, Math.ceil(fastestCycles * 256)));
        const toneIndex = [...state.snapshot.chord.tones]
          .filter((candidate) => !candidate.is_analysis_basis)
          .sort((first, second) => first.frequency_hz - second.frequency_hz)
          .findIndex((candidate) => candidate.midi_note === note.midi_note);
        const color = toneIndex === 0
          ? rootToneColor
          : relationColors[(Math.max(1, toneIndex) - 1) % relationColors.length];
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
      const phaseCanvas = byId("outputPhaseCanvas");
      const phaseFrame = resizeCanvas(phaseCanvas);
      const pctx = phaseFrame.context;
      const pw = phaseFrame.width;
      const ph = phaseFrame.height;
      pctx.clearRect(0, 0, pw, ph);
      pctx.fillStyle = palette.crust;
      pctx.fillRect(0, 0, pw, ph);
      pctx.strokeStyle = palette.surface0;
      pctx.lineWidth = 1;
      pctx.beginPath();
      pctx.moveTo(pw / 2, 8);
      pctx.lineTo(pw / 2, ph - 8);
      pctx.moveTo(8, ph / 2);
      pctx.lineTo(pw - 8, ph / 2);
      pctx.stroke();
      const delayMs = Number(byId("outputPhaseDelay").value);
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
        pctx.strokeStyle = palette.mauve;
        pctx.lineWidth = 1.15;
        pctx.lineJoin = "round";
        pctx.lineCap = "round";
        pctx.globalAlpha = 0.84;
        pctx.stroke();
        pctx.globalAlpha = 1;
        byId("outputPhaseSummary").textContent = `${points.length} 点 · τ ${delayMs.toFixed(1)} ms · 自动幅度`;
      } else {
        byId("outputPhaseSummary").textContent = "等待合成器输出";
      }
    }
    if (state.analysis) {
      byId("levelSummary").textContent = `RMS ${(state.analysis.rms * 100).toFixed(1)}% · PEAK ${(state.analysis.peak * 100).toFixed(1)}%`;
    }
  }
  
  if (!state.spectrumMemory) resetSpectrumMemory();

  return {
    draw:drawSignalAnalysis,
    resetMemory:resetSpectrumMemory,
  };
}
