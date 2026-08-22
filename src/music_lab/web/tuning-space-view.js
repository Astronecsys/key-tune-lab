const TAU = Math.PI * 2;

export function activeTuningPoints(space, tones, referenceDegree, referenceFrequencyHz = null) {
  const reference = space.degrees.find((degree) => degree.index === referenceDegree)
    || space.degrees[0];
  if (!reference) return [];
  return (tones || []).flatMap((tone, index) => {
    const finiteDegree = space.construction.kind !== "generator_lattice"
      ? space.degrees.find((degree) => degree.index === tone.degree)
      : null;
    let normalizedPosition = finiteDegree?.normalized_position;
    if (!Number.isFinite(normalizedPosition)) {
      const directRatio = Number(tone.ratio_from_reference);
      const frequencyRatio = Number(tone.frequency_hz) / Number(referenceFrequencyHz);
      const ratioFromReference = directRatio > 0 ? directRatio : frequencyRatio;
      if (!(ratioFromReference > 0)) return [];
      normalizedPosition = positiveModulo(
        Math.log(reference.ratio * ratioFromReference) / Math.log(space.equave_ratio),
        1,
      );
    }
    const pitchClassRatio = space.equave_ratio ** normalizedPosition;
    return [{
      id:tone.pitch_label || finiteDegree?.id || `live-${index + 1}`,
      visual_id:`active:${tone.midi_note ?? tone.input_node_id ?? index}:${index}`,
      kind:"active",
      degree:tone.degree,
      expression:finiteDegree?.expression || tone.ratio_label || tone.pitch_label || "实时音高",
      ratio:pitchClassRatio,
      normalized_position:normalizedPosition,
      frequency_hz:Number(tone.frequency_hz),
      colorIndex:index,
    }];
  });
}

export function tuningRingLayout(space, width, height) {
  const contentHeight = Math.max(40, height - 19);
  const radius = Math.max(22, Math.min(contentHeight * 0.39, width * 0.155));
  const centerX = Math.max(radius + 11, Math.min(width * 0.18, radius + 24));
  const centerY = Math.max(radius + 5, contentHeight / 2);
  const pointAt = (normalizedPosition, extraRadius = 0) => {
    const angle = -Math.PI / 2 + normalizedPosition * TAU;
    return {
      angle,
      x:centerX + (radius + extraRadius) * Math.cos(angle),
      y:centerY + (radius + extraRadius) * Math.sin(angle),
    };
  };
  const degrees = space.degrees.map((degree) => ({
    ...pointAt(degree.normalized_position),
    ...degree,
    visual_id:`degree:${degree.id}`,
    kind:"degree",
  }));
  const basis = (space.construction.basis || []).map((item, index) => ({
    ...pointAt(item.normalized_position, -13),
    id:`g${index + 1}`,
    visual_id:`basis:${index}`,
    kind:"basis",
    expression:item.expression,
    ratio:item.ratio,
    normalized_position:item.normalized_position,
  }));
  return {
    centerX,
    centerY,
    radius,
    pointAt,
    degrees,
    basis,
    rulerLeft:Math.max(centerX + radius + 25, width * 0.37),
    rulerRight:width - 13,
    rulerY:height - 15,
  };
}

export function tuningPointDescription(point) {
  const coordinate = Number(point.normalized_position || 0);
  const angle = coordinate * 360;
  const prefix = point.kind === "basis" ? `生成基 ${point.id}` : point.id;
  return `${prefix} · ${point.expression} · ${Number(point.ratio).toFixed(8)}× · u=${coordinate.toFixed(6)} · θ=${angle.toFixed(2)}°`;
}

export function tuningPointFromCoordinates(points, x, y) {
  return points
    .map((point) => ({point, distance:Math.hypot(x - point.x, y - point.y)}))
    .filter((candidate) => candidate.distance <= candidate.point.hitRadius)
    .sort((first, second) => first.distance - second.distance)[0]?.point || null;
}

export function drawTuningSpaceCanvas({
  canvas,
  space,
  referenceDegree,
  activePitches = [],
  selectedVisualId,
  palette,
  relationColors,
  fallbackName,
}) {
  const {context:ctx, width, height} = resizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  if (width < 80 || height < 56) return [];
  const layout = tuningRingLayout(space, width, height);
  const {
    centerX, centerY, radius, pointAt, degrees, basis,
    rulerLeft, rulerRight, rulerY,
  } = layout;
  const active = activePitches.map((point, index) => ({
    ...pointAt(point.normalized_position),
    ...point,
    colorIndex:point.colorIndex ?? index,
    color:relationColors[(point.colorIndex ?? index) % relationColors.length],
  }));
  const visualPoints = [];

  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = palette.surface1;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = colorWithAlpha(palette.sky, 0.2);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius - 7, 0, TAU);
  ctx.stroke();

  if (space.construction.kind === "generator_chain") {
    const generationOrder = [...degrees].sort((first, second) => (
      first.generator_coordinate - second.generator_coordinate
    ));
    ctx.strokeStyle = colorWithAlpha(palette.mauve, 0.28);
    ctx.lineWidth = 1.1;
    generationOrder.slice(1).forEach((point, index) => {
      const previous = generationOrder[index];
      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.quadraticCurveTo(centerX, centerY, point.x, point.y);
      ctx.stroke();
    });
  }

  degrees.forEach((point) => {
    const isOrigin = point.index === 0;
    const isSelected = point.visual_id === selectedVisualId;
    const inner = pointAt(point.normalized_position, isSelected ? -9 : -6);
    const outer = pointAt(point.normalized_position, isSelected ? 10 : 6);
    ctx.strokeStyle = isOrigin ? palette.yellow : isSelected ? palette.green : palette.sky;
    ctx.lineWidth = isSelected ? 2.4 : space.degree_count > 72 ? 1 : 1.5;
    ctx.beginPath();
    ctx.moveTo(inner.x, inner.y);
    ctx.lineTo(outer.x, outer.y);
    ctx.stroke();
    if (space.degree_count <= 72 || isSelected || isOrigin) {
      ctx.fillStyle = isOrigin ? palette.yellow : isSelected ? palette.green : palette.sky;
      ctx.beginPath();
      ctx.arc(point.x, point.y, isSelected ? 4.2 : 2.6, 0, TAU);
      ctx.fill();
    }
    visualPoints.push({
      ...point,
      hitRadius:Math.max(6, 11 - Math.min(5, space.degree_count / 24)),
    });
  });

  basis.forEach((point, index) => {
    const isSelected = point.visual_id === selectedVisualId;
    const basisColor = isSelected
      ? palette.green
      : relationColors[index % relationColors.length];
    ctx.fillStyle = basisColor;
    ctx.beginPath();
    ctx.arc(point.x, point.y, isSelected ? 5 : 3.8, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = colorWithAlpha(basisColor, 0.6);
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    visualPoints.push({...point, hitRadius:8});
  });

  drawActivePitches(ctx, active, pointAt, relationColors, selectedVisualId);
  visualPoints.unshift(...active.map((point) => ({...point, hitRadius:10})));

  drawReferenceMarker(ctx, degrees, referenceDegree, pointAt, palette);
  drawCenterLabel(ctx, space, centerX, centerY, palette);
  drawUnwrappedRuler(
    ctx,
    degrees,
    referenceDegree,
    selectedVisualId,
    active,
    rulerLeft,
    rulerRight,
    rulerY,
    palette,
  );
  drawReadout(
    ctx,
    space,
    [...active, ...degrees, ...basis],
    selectedVisualId,
    rulerLeft,
    rulerRight,
    palette,
  );
  ctx.restore();

  canvas.dataset.constructionKind = space.construction.kind;
  canvas.dataset.referenceDegree = String(referenceDegree);
  canvas.dataset.originAngleDegrees = "-90";
  canvas.dataset.activePitchCount = String(active.length);
  const basisCount = basis.length;
  canvas.setAttribute(
    "aria-label",
    `${space.name || fallbackName}；${space.degree_count} 个音级${basisCount ? `；${basisCount} 个生成基` : ""}；等价区间 ${space.equave_expression}；${active.length} 个实时音高`,
  );
  return visualPoints;
}

function drawActivePitches(ctx, active, pointAt, relationColors, selectedVisualId) {
  const occupancy = new Map();
  active.forEach((point) => {
    const slot = Math.round(point.normalized_position * 100000);
    const lane = occupancy.get(slot) || 0;
    occupancy.set(slot, lane + 1);
    const color = relationColors[point.colorIndex % relationColors.length];
    const marker = pointAt(point.normalized_position, lane * 4);
    point.x = marker.x;
    point.y = marker.y;
    point.angle = marker.angle;
    const selected = point.visual_id === selectedVisualId;
    ctx.shadowColor = color;
    ctx.shadowBlur = selected ? 14 : 9;
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 3.5 : 2.5;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 6.5 + lane * 1.2, 0, TAU);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = colorWithAlpha(color, selected ? 0.8 : 0.45);
    ctx.beginPath();
    ctx.arc(point.x, point.y, selected ? 4.2 : 3.2, 0, TAU);
    ctx.fill();
  });
}

function drawReferenceMarker(ctx, degrees, referenceDegree, pointAt, palette) {
  const referencePoint = degrees.find((point) => point.index === referenceDegree);
  if (!referencePoint) return;
  const marker = pointAt(referencePoint.normalized_position, 15);
  ctx.fillStyle = palette.mauve;
  ctx.beginPath();
  ctx.moveTo(marker.x, marker.y);
  ctx.lineTo(
    marker.x - 5 * Math.cos(referencePoint.angle - 0.55),
    marker.y - 5 * Math.sin(referencePoint.angle - 0.55),
  );
  ctx.lineTo(
    marker.x - 5 * Math.cos(referencePoint.angle + 0.55),
    marker.y - 5 * Math.sin(referencePoint.angle + 0.55),
  );
  ctx.closePath();
  ctx.fill();
  ctx.font = "bold 9px Consolas";
  ctx.textAlign = "center";
  ctx.fillText("T", marker.x, marker.y - 7);
}

function drawCenterLabel(ctx, space, centerX, centerY, palette) {
  ctx.textAlign = "center";
  ctx.fillStyle = palette.text;
  ctx.font = "bold 11px Consolas";
  ctx.fillText(`E = ${space.equave_expression}`, centerX, centerY - 2);
  ctx.fillStyle = palette.overlay0;
  ctx.font = "8px Consolas";
  ctx.fillText(
    space.construction.kind === "generator_lattice" ? "OPEN" : `${space.degree_count} DEG`,
    centerX,
    centerY + 11,
  );
}

function drawUnwrappedRuler(
  ctx,
  degrees,
  referenceDegree,
  selectedVisualId,
  active,
  rulerLeft,
  rulerRight,
  rulerY,
  palette,
) {
  const rulerWidth = Math.max(1, rulerRight - rulerLeft);
  if (rulerWidth <= 60) return;
  ctx.strokeStyle = palette.surface2;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rulerLeft, rulerY);
  ctx.lineTo(rulerRight, rulerY);
  ctx.stroke();
  degrees.forEach((point) => {
    const x = rulerLeft + point.normalized_position * rulerWidth;
    ctx.strokeStyle = point.index === referenceDegree
      ? palette.mauve
      : point.index === 0 ? palette.yellow : colorWithAlpha(palette.sky, 0.68);
    ctx.lineWidth = point.visual_id === selectedVisualId ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, rulerY - (point.visual_id === selectedVisualId ? 10 : 6));
    ctx.lineTo(x, rulerY + 2);
    ctx.stroke();
  });
  active.forEach((point) => {
    const x = rulerLeft + point.normalized_position * rulerWidth;
    ctx.strokeStyle = colorWithAlpha(
      point.color || palette.green,
      0.95,
    );
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x, rulerY - 12);
    ctx.lineTo(x, rulerY + 2);
    ctx.stroke();
  });
  ctx.fillStyle = palette.overlay0;
  ctx.font = "8px Consolas";
  ctx.textAlign = "left";
  ctx.fillText("1×", rulerLeft, rulerY + 10);
  ctx.textAlign = "right";
  ctx.fillText("E×", rulerRight, rulerY + 10);
}

function drawReadout(
  ctx,
  space,
  points,
  selectedVisualId,
  rulerLeft,
  rulerRight,
  palette,
) {
  const inspected = points.find((point) => point.visual_id === selectedVisualId)
    || points.find((point) => point.kind === "active")
    || points.find((point) => point.kind === "degree")
    || points[0];
  const infoWidth = Math.max(20, rulerRight - rulerLeft);
  ctx.textAlign = "left";
  ctx.fillStyle = palette.sky;
  ctx.font = "bold 9px Consolas";
  ctx.fillText(constructionKindLabel(space.construction.kind), rulerLeft, 15);
  if (!inspected) return;
  ctx.fillStyle = inspected.kind === "active"
    ? palette.green
    : inspected.kind === "basis"
    ? palette.pink
    : inspected.index === 0 ? palette.yellow : palette.text;
  ctx.font = "bold 11px Consolas";
  ctx.fillText(
    fitCanvasText(
      ctx,
      `${inspected.kind === "active" ? "LIVE " : inspected.kind === "basis" ? "生成基 " : ""}${inspected.id} · ${Number(inspected.ratio).toFixed(8)}×`,
      infoWidth,
    ),
    rulerLeft,
    33,
  );
  ctx.fillStyle = palette.subtext1;
  ctx.font = "9px Consolas";
  const identityLine = inspected.kind === "active" && Number.isFinite(inspected.frequency_hz)
    ? `${inspected.expression} · ${inspected.frequency_hz.toFixed(3)} Hz`
    : inspected.expression;
  ctx.fillText(fitCanvasText(ctx, identityLine, infoWidth), rulerLeft, 48);
  ctx.fillStyle = palette.overlay0;
  ctx.fillText(
    `u ${Number(inspected.normalized_position).toFixed(6)} · θ ${(Number(inspected.normalized_position) * 360).toFixed(2)}°`,
    rulerLeft,
    62,
  );
}

function constructionKindLabel(kind) {
  return {
    equal_division:"EQUAL DIVISION",
    generator_chain:"GENERATOR CHAIN",
    generator_lattice:"OPEN LATTICE",
    explicit:"EXPLICIT DEGREES",
    ratio_set:"RATIO SET",
  }[kind] || String(kind || "TUNING SPACE").toUpperCase();
}

function fitCanvasText(ctx, text, maximumWidth) {
  if (ctx.measureText(text).width <= maximumWidth) return text;
  let clipped = text;
  while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maximumWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}…`;
}

function colorWithAlpha(hex, alpha) {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha))})`;
}

function positiveModulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
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
  return {context, width:rect.width, height:rect.height};
}
