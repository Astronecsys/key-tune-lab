import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, requestFloat32, requestJson } from "../../src/music_lab/web/api-client.js";
import {
  PresentationActionRegistry,
  valueAtPath,
} from "../../src/music_lab/web/presentation-actions.js";
import { TelemetryScheduler } from "../../src/music_lab/web/telemetry-scheduler.js";

test("API client preserves server errors and validates binary schema", async () => {
  await assert.rejects(
    requestJson("/broken", {}, async () => ({
      ok:false,
      status:400,
      statusText:"Bad Request",
      json:async () => ({detail:"坏请求"}),
    })),
    (error) => error instanceof ApiError && error.message === "坏请求" && error.status === 400,
  );

  const bytes = new Float32Array([0.25, -0.5]).buffer;
  const result = await requestFloat32("/phase", {
    minimumSchemaVersion:8,
    maximumSchemaVersion:9,
    fetchImpl:async () => ({
      ok:true,
      status:200,
      headers:{get:(name) => ({"X-Schema-Version":"9", "X-Sample-Rate-Hz":"48000"})[name]},
      arrayBuffer:async () => bytes,
    }),
  });
  assert.deepEqual([...result.samples], [0.25, -0.5]);
  assert.equal(result.sampleRateHz, 48000);
});

test("telemetry scheduler only runs visible demand and coalesces requests", async () => {
  let resolveAnalysis;
  let analysisCalls = 0;
  const invalidated = [];
  const scheduler = new TelemetryScheduler({
    documentRef:{hidden:false},
    timerApi:{setInterval:() => 1, clearInterval:() => {}},
    isLiveActive:() => false,
    isPanelVisible:(id) => id !== "outputPhasePanel",
    refreshLive:async () => {},
    refreshAnalysis:() => {
      analysisCalls += 1;
      return new Promise((resolve) => { resolveAnalysis = resolve; });
    },
    refreshPhase:async () => { throw new Error("hidden phase should not refresh"); },
    invalidatePanel:(id) => invalidated.push(id),
  });

  scheduler.tickVisuals();
  scheduler.tickVisuals();
  assert.equal(analysisCalls, 1);
  assert.deepEqual(invalidated, ["lissajousPanel", "lissajousPanel"]);
  resolveAnalysis();
  await Promise.resolve();
});

test("presentation action registry is extensible, cancellable, and reports failures", async () => {
  const calls = [];
  const errors = [];
  const registry = new PresentationActionRegistry()
    .register("remember", async (action) => calls.push(action.value));

  const result = await registry.run(
    [{type:"remember", value:1}, {type:"unknown"}, {type:"remember", value:2}],
    {onError:(error) => errors.push(error.message)},
  );

  assert.deepEqual(calls, [1]);
  assert.equal(result.error.message, "未知场景动作：unknown");
  assert.deepEqual(errors, ["未知场景动作：unknown"]);
  assert.equal(valueAtPath({audio:{running:true}}, "audio.running"), true);
});
