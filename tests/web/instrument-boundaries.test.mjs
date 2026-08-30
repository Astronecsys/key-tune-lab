import assert from "node:assert/strict";
import test from "node:test";

import { FastApiInstrumentClient } from "../../src/music_lab/web/instrument-client.js";
import { selectKeyboardView, selectTuningSpace } from "../../src/music_lab/web/instrument-selectors.js";
import { InstrumentStore } from "../../src/music_lab/web/instrument-store.js";

test("instrument client is the only owner of FastAPI paths", async () => {
  const calls = [];
  const client = new FastApiInstrumentClient({
    requestJsonImpl:async (path, options = {}) => {
      calls.push({path, options});
      return {ok:true};
    },
    locationRef:{protocol:"https:", host:"example.test"},
    WebSocketImpl:class {},
  });

  await client.setTuning("31edo");
  await client.noteOn("K69", 101);
  await client.setTrackCompileMode("target", "nearest_frequency");

  assert.deepEqual(calls.map((call) => call.path), [
    "/api/tuning",
    "/api/input/K69/on",
    "/api/tracks/target/compile",
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), {id:"31edo"});
  assert.deepEqual(JSON.parse(calls[1].options.body), {velocity:101});
});

test("instrument store preserves the current read model while exposing subscriptions", () => {
  const target = {snapshot:null, analysis:null, phase:null};
  const store = new InstrumentStore(target);
  const changes = [];
  store.subscribe((kind) => changes.push(kind));

  store.replaceSnapshot({
    schema_version:9,
    midi:{}, audio:{}, keyboard:{active:[]},
    tracks:[{id:"performance", name:"演奏", notes:[]}],
  });
  store.mergeLive({
    schema_version:9,
    midi:{connected:true}, audio:{running:true}, keyboard_active:[],
    recording:false, record_elapsed_seconds:0, performance:[],
    performance_name:"演奏", last_control_change:null,
    playback:{playing:false}, chord:{size:0},
  });
  store.replaceAnalysis({schema_version:9, spectrum:[]});
  store.replacePhase({samples:[0], sampleRateHz:48000});

  assert.deepEqual(changes, ["snapshot", "live", "analysis", "phase"]);
  assert.equal(store.snapshot.midi.connected, true);
  assert.equal(store.phase.sampleRateHz, 48000);
});

test("selectors normalize legacy keyboard and tuning snapshots without DOM access", () => {
  const snapshot = {
    tuning:{divisions:12, equave_ratio:2, reference_midi:69, reference_frequency_hz:440},
    keyboard:{keys:[{midi_note:69, key_label:"K69"}]},
  };
  const keyboard = selectKeyboardView(snapshot);
  const space = selectTuningSpace(snapshot);

  assert.equal(keyboard.keys[0].input_node_id, "midi:69");
  assert.equal(keyboard.mapping.anchor_node_id, "midi:69");
  assert.equal(space.degree_count, 12);
  assert.equal(space.degrees[0].ratio, 1);
});

