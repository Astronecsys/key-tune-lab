import { compactPitchIdentityLabel } from "../chord-view.js";

const isBlack = (note) => [1, 3, 6, 8, 10].includes(note % 12);

/** 实体表面只读取 ViewModel，并把命中区域写回 UI 临时状态。 */
export function createKeyboardPanelRenderer({
  state,
  canvas,
  resizeCanvas,
  getKeyboard,
  getChordBasis,
  palette,
  colorWithAlpha,
}) {
  function drawChordBasisMarker(ctx, width, height, keys) {
    const basis = getChordBasis();
    if (!basis || !Number.isFinite(basis.frequency_hz)) return;
    const mapped = keys
      .filter((key) => key.mapped && Number.isFinite(key.frequency_hz))
      .map((key) => {
        const rect = state.keyRects.find((candidate) => (
          candidate.nodeId === key.input_node_id || candidate.note === key.midi_note
        ));
        return rect ? {key, rect, x:rect.x + rect.w / 2, frequency:key.frequency_hz} : null;
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
          < Math.abs(Math.log(best.frequency / basis.frequency_hz)) ? point : best
      ));
      markerX = closest.x;
    }

    canvas.title = `${basis.sounding ? "发声中" : "未发声"}和弦基准 B · ${basis.frequency_hz.toFixed(3)} Hz`;
    ctx.save();
    ctx.strokeStyle = palette.mauve;
    ctx.fillStyle = palette.mauve;
    ctx.lineWidth = 2;
    ctx.setLineDash(basis.sounding ? [] : [5, 4]);
    if (exact) {
      ctx.strokeRect(exact.rect.x + 2, 2, Math.max(1, exact.rect.w - 4), Math.max(1, exact.rect.h - 4));
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
    ctx.fillStyle = palette.mantle;
    ctx.fillRect(labelX, 3, labelWidth, 17);
    ctx.strokeStyle = palette.mauve;
    ctx.strokeRect(labelX, 3, labelWidth, 17);
    ctx.fillStyle = palette.mauve;
    ctx.textAlign = "left";
    ctx.fillText(label, labelX + 5, 15);
    ctx.restore();
  }

  function drawPiano(ctx, width, height, keys, active, tuningDivisions) {
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
      ctx.fillStyle = !key.mapped ? palette.surface2 : isActive ? palette.yellow : isHovered ? palette.lavender : palette.text;
      ctx.fillRect(x + 0.6, 0, whiteWidth - 1.2, height - 1);
      ctx.strokeStyle = palette.surface0;
      ctx.strokeRect(x + 0.6, 0, whiteWidth - 1.2, height - 1);
      if (isSelected) {
        ctx.save();
        ctx.strokeStyle = palette.green;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 2, 2, Math.max(1, whiteWidth - 4), Math.max(1, height - 5));
        ctx.restore();
      }
      ctx.fillStyle = palette.surface0;
      ctx.font = "11px Consolas";
      ctx.textAlign = "center";
      ctx.fillText(key.input_label, x + whiteWidth / 2, height - 43);
      ctx.fillStyle = palette.surface2;
      ctx.font = "9px Consolas";
      ctx.fillText(key.mapped ? compactPitchIdentityLabel(key, tuningDivisions) : "OFF", x + whiteWidth / 2, height - 27);
      ctx.fillText(key.mapped ? `${key.frequency_hz.toFixed(1)}` : "—", x + whiteWidth / 2, height - 11);
      state.keyRects.push({nodeId:key.input_node_id, note:key.input_midi_note, x, y:0, w:whiteWidth, h:height, black:false, role:"white"});
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
      ctx.fillStyle = !key.mapped ? palette.surface0 : isActive ? palette.sky : isHovered ? palette.surface1 : palette.crust;
      ctx.fillRect(x, 0, blackWidth, blackHeight);
      ctx.strokeStyle = palette.crust;
      ctx.strokeRect(x, 0, blackWidth, blackHeight);
      if (isSelected) {
        ctx.save();
        ctx.strokeStyle = palette.green;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1.5, 1.5, Math.max(1, blackWidth - 3), Math.max(1, blackHeight - 3));
        ctx.restore();
      }
      ctx.fillStyle = isActive ? palette.crust : palette.subtext1;
      ctx.font = `${isActive ? "bold " : ""}8px Consolas`;
      ctx.textAlign = "center";
      ctx.fillText(key.input_label, x + blackWidth / 2, blackHeight - 35);
      ctx.fillText(key.mapped ? compactPitchIdentityLabel(key, tuningDivisions) : "OFF", x + blackWidth / 2, blackHeight - 22);
      ctx.fillText(key.mapped ? `${key.frequency_hz.toFixed(0)}` : "—", x + blackWidth / 2, blackHeight - 9);
      state.keyRects.push({nodeId:key.input_node_id, note:key.input_midi_note, x, y:0, w:blackWidth, h:blackHeight, black:true, role:"black"});
    });
  }

  function drawHex(ctx, width, height, keys, active, tuningDivisions) {
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
    const degreeColors = [palette.sky, palette.green, palette.yellow, palette.peach, palette.pink, palette.mauve];
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
      ctx.fillStyle = !key.mapped ? palette.surface0 : isActive ? palette.yellow : colorWithAlpha(mappedColor, isHovered ? 0.78 : 0.34);
      ctx.fill(path);
      ctx.strokeStyle = isSelected ? palette.green : isHovered ? palette.lavender : palette.surface2;
      ctx.lineWidth = isSelected ? 2.2 : 1;
      ctx.stroke(path);
      if (radius >= 13) {
        ctx.fillStyle = isActive ? palette.crust : palette.text;
        ctx.font = `${isActive ? "bold " : ""}${Math.max(7, Math.min(10, radius * 0.35))}px Consolas`;
        ctx.textAlign = "center";
        ctx.fillText(key.input_label, x, y - 3);
        ctx.fillStyle = palette.subtext1;
        ctx.fillText(key.mapped ? compactPitchIdentityLabel(key, tuningDivisions) : "OFF", x, y + 8);
      }
      state.keyRects.push({nodeId:key.input_node_id, note:key.input_midi_note, x:x-radius, y:y-radius, w:radius*2, h:radius*2, black:false, role:"hex", centerX:x, centerY:y, radius});
    });
  }

  function draw() {
    canvas.title = "";
    const {context:ctx, width, height} = resizeCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const keyboard = getKeyboard();
    const keys = keyboard.keys;
    const active = new Map(keyboard.active.map((item) => [
      item.input_node_id || `midi:${item.midi_note}`,
      item,
    ]));
    state.keyRects = [];
    if (keyboard.surface.kind === "hex") {
      drawHex(ctx, width, height, keys, active, state.snapshot.tuning.divisions);
    } else {
      drawPiano(ctx, width, height, keys, active, state.snapshot.tuning.divisions);
      drawChordBasisMarker(ctx, width, height, keys);
    }
    const hoveredKey = keys.find((key) => key.input_node_id === state.hoveredInputId);
    const selectedKey = keys.find((key) => key.input_node_id === state.selectedInputId);
    const descriptions = [];
    if (hoveredKey?.mapped) descriptions.push(`悬停 ${hoveredKey.input_label} · ${hoveredKey.frequency_hz.toFixed(3)} Hz`);
    if (selectedKey?.mapped) descriptions.push(`已选择 ${selectedKey.input_label} · ${selectedKey.frequency_hz.toFixed(3)} Hz`);
    canvas.title = [canvas.title, ...descriptions].filter(Boolean).join(" · ");
  }

  function keyFromPointer(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const candidates = state.keyRects.filter((item) => x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h);
    const hex = candidates
      .filter((item) => item.role === "hex")
      .sort((first, second) => Math.hypot(x - first.centerX, y - first.centerY) - Math.hypot(x - second.centerX, y - second.centerY))[0];
    if (hex && Math.hypot(x - hex.centerX, y - hex.centerY) <= hex.radius) return hex;
    return candidates.find((item) => item.black) || candidates[0] || null;
  }

  return {draw, keyFromPointer};
}

