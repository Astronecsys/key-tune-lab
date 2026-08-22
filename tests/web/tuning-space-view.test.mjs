import assert from "node:assert/strict";
import test from "node:test";

import {
  activeTuningPoints,
  tuningPointFromCoordinates,
  tuningRingLayout,
} from "../../src/music_lab/web/tuning-space-view.js";

const space = {
  degree_count:4,
  equave_ratio:2,
  equave_expression:"2",
  degrees:[0, 1, 2, 3].map((index) => ({
    id:`d${index}`,
    index,
    ratio:2 ** (index / 4),
    expression:`2^(${index}/4)`,
    normalized_position:index / 4,
  })),
  construction:{
    kind:"generator_lattice",
    basis:[{
      expression:"3/2",
      ratio:1.5,
      normalized_position:Math.log2(1.5),
    }],
  },
};

test("tuning ring fixes d0 at the top and follows logarithmic positions", () => {
  const layout = tuningRingLayout(space, 600, 120);
  const origin = layout.degrees[0];
  const quarter = layout.degrees[1];
  assert.ok(Math.abs(origin.x - layout.centerX) < 1e-9);
  assert.ok(origin.y < layout.centerY);
  assert.ok(quarter.x > layout.centerX);
  assert.ok(Math.abs(quarter.y - layout.centerY) < 1e-9);
  assert.equal(layout.basis[0].visual_id, "basis:0");
});

test("tuning ring hit testing selects the nearest visible identity", () => {
  const layout = tuningRingLayout(space, 600, 120);
  const points = layout.degrees.map((point) => ({...point, hitRadius:8}));
  const target = points[2];
  assert.equal(
    tuningPointFromCoordinates(points, target.x + 1, target.y + 1).id,
    "d2",
  );
  assert.equal(tuningPointFromCoordinates(points, 599, 119), null);
});

test("finite tuning tones light their compiled degree", () => {
  const finiteSpace = {...space, construction:{kind:"equal_division"}};
  const active = activeTuningPoints(finiteSpace, [{
    midi_note:64,
    pitch_label:"d3",
    degree:3,
    frequency_hz:660,
    ratio_from_reference:1.5,
  }], 0);
  assert.equal(active.length, 1);
  assert.equal(active[0].normalized_position, 0.75);
  assert.equal(active[0].frequency_hz, 660);
});

test("open lattices project live ratios into the equave", () => {
  const active = activeTuningPoints(space, [{
    midi_note:67,
    pitch_label:"q1r0",
    degree:0,
    frequency_hz:660,
    ratio_from_reference:3,
  }], 0);
  assert.ok(Math.abs(active[0].normalized_position - Math.log2(1.5)) < 1e-9);
  assert.ok(Math.abs(active[0].ratio - 1.5) < 1e-9);
});

test("live projection falls back to calibrated frequencies", () => {
  const active = activeTuningPoints(space, [{
    midi_note:67,
    pitch_label:"q1r0",
    degree:0,
    frequency_hz:660,
  }], 0, 440);
  assert.ok(Math.abs(active[0].normalized_position - Math.log2(1.5)) < 1e-9);
});
