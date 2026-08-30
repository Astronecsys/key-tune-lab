// 轨道面板只关心时间轴读模型；播放、录音与 MIDI 上传由控制器处理。
export function createTracksPanelRenderer({state, canvasHost, resizeCanvas, palette}) {
  const timelineNotes = () => state.snapshot.tracks.flatMap((track) => track.notes);

  function timelineBounds() {
    const notes = timelineNotes();
    const frequencies = notes.map((note) => note.pitch.frequency_hz);
    const ends = notes.map((note) => note.start_seconds + note.duration_seconds);
    return {
      minFrequency:frequencies.length ? Math.min(...frequencies) / 1.04 : 200,
      maxFrequency:frequencies.length ? Math.max(...frequencies) * 1.04 : 800,
      duration:Math.max(6, ...ends, state.snapshot.record_elapsed_seconds + 0.5),
    };
  }

  function drawTimeline(canvas, notes, color, trackId) {
    const {context:ctx, width, height} = resizeCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = palette.crust;
    ctx.fillRect(0, 0, width, height);
    const padding = {left:48, right:10, top:10, bottom:20};
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const bounds = timelineBounds();
    const logMin = Math.log2(bounds.minFrequency);
    const logMax = Math.log2(bounds.maxFrequency);
    const xFor = (seconds) => padding.left + (seconds / bounds.duration) * innerWidth;
    const yFor = (frequency) => padding.top
      + (1 - (Math.log2(frequency) - logMin) / (logMax - logMin || 1)) * innerHeight;

    ctx.strokeStyle = palette.surface0;
    ctx.lineWidth = 1;
    const secondsStep = bounds.duration > 20 ? 5 : bounds.duration > 10 ? 2 : 1;
    for (let second = 0; second <= bounds.duration; second += secondsStep) {
      const x = xFor(second);
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, height - padding.bottom);
      ctx.stroke();
      ctx.fillStyle = palette.overlay0;
      ctx.font = "9px Consolas";
      ctx.textAlign = "center";
      ctx.fillText(`${second}s`, x, height - 6);
    }
    [bounds.minFrequency, Math.sqrt(bounds.minFrequency * bounds.maxFrequency), bounds.maxFrequency]
      .forEach((frequency) => {
        const y = yFor(frequency);
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
        ctx.fillStyle = palette.overlay0;
        ctx.font = "8px Consolas";
        ctx.textAlign = "right";
        ctx.fillText(`${frequency.toFixed(0)}`, padding.left - 5, y + 3);
      });

    notes.forEach((note) => {
      const x = xFor(note.start_seconds);
      const widthForNote = Math.max(3, (note.duration_seconds / bounds.duration) * innerWidth);
      const y = yFor(note.pitch.frequency_hz);
      ctx.fillStyle = color;
      ctx.globalAlpha = note.open ? 0.66 : 0.88;
      ctx.fillRect(x, y - 5, widthForNote, 10);
      ctx.globalAlpha = 1;
    });

    const playbackHere = state.snapshot.playback.playing && state.snapshot.playback.kind === trackId;
    const recordingHere = trackId === "performance" && state.snapshot.recording;
    if (playbackHere || recordingHere) {
      const elapsed = playbackHere
        ? state.snapshot.playback.elapsed_seconds
        : state.snapshot.record_elapsed_seconds;
      const x = xFor(elapsed);
      ctx.strokeStyle = palette.red;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, height - padding.bottom);
      ctx.stroke();
    }
  }

  function render() {
    const container = canvasHost();
    const colors = [palette.sky, palette.yellow, palette.green, palette.pink, palette.mauve];
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
      const repairBadge = track.source_timing?.repairs?.length ? " · 已修复踏板数据" : "";
      row.querySelector("[data-track-meta]").textContent = `${track.notes.length} 音符 · ${track.kind}${sourceClock}${repairBadge}`;
      row.querySelectorAll("button[data-action]").forEach((button) => {
        button.dataset.track = track.id;
      });
      const playingHere = state.snapshot.playback.playing
        && state.snapshot.playback.kind === track.id;
      const protectedHere = playingHere
        || (state.snapshot.recording && track.id === "performance");
      const compileSelect = row.querySelector("[data-track-compile]");
      const compileModes = state.snapshot.compile_modes || [
        {id:"key_position", name:"键位直译", description:"需要重启后才能切换编译策略"},
      ];
      const signature = compileModes.map((mode) => `${mode.id}:${mode.name}`).join("|");
      if (compileSelect.dataset.signature !== signature) {
        compileSelect.replaceChildren(...compileModes.map((mode) => {
          const option = document.createElement("option");
          option.value = mode.id;
          option.textContent = mode.name;
          option.title = mode.description || "";
          return option;
        }));
        compileSelect.dataset.signature = signature;
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
      drawTimeline(canvas, track.notes, colors[index % colors.length], track.id);
    });
  }

  return {render};
}
