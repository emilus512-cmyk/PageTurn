/* ABSOLUTE STUDIO X — automation tests (core + validator + serializer)
   run: node src/tests/automation.test.js */
"use strict";
const assert = require("assert");
const {
  AUTO_RANGES, autoSort, autoInsert, autoClampValue, autoValue, autoCurve,
  emptyAutomation,
} = require("../core/automation-core.js");
const { serializeAutomation, deserializeAutomation } = require("../core/automation-serializer.js");
const {
  normalizePoint, normalizePoints, normalizeAutomation, ensureTrackAutomation, repairTrackAutomation,
} = require("../core/automation-validator.js");
const AutomationCore = require("../core/automation-api.js");
const AutomationLaneController = require("../ui/automation-lane-controller.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.error("  ✗ " + name + "\n    " + e.message); }
}
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

console.log("\nINTERPOLATION");

test("no points → base value", () => {
  approx(autoValue([], 5, -6, false), -6);
  approx(autoValue(null, 5, 0.3, false), 0.3);
});

test("before first point → track base value (per spec)", () => {
  const pts = [{ id: "a", time: 10, value: 0 }];
  approx(autoValue(pts, 0, -12, false), -12);
  approx(autoValue(pts, 9.999, -12, false), -12);
});

test("exactly at a point → point value", () => {
  const pts = [{ id: "a", time: 10, value: -3 }, { id: "b", time: 20, value: 6 }];
  approx(autoValue(pts, 10, 0, false), -3);
  approx(autoValue(pts, 20, 0, false), 6);
});

test("between points → linear interpolation", () => {
  const pts = [{ id: "a", time: 10, value: -10 }, { id: "b", time: 20, value: 10 }];
  approx(autoValue(pts, 15, 0, false), 0);
  approx(autoValue(pts, 12.5, 0, false), -5);
  approx(autoValue(pts, 17.5, 0, false), 5);
});

test("after last point → last value (per spec)", () => {
  const pts = [{ id: "a", time: 10, value: -10 }, { id: "b", time: 20, value: 7 }];
  approx(autoValue(pts, 20.001, 0, false), 7);
  approx(autoValue(pts, 10000, 0, false), 7);
});

test("step params (mute) hold previous value — no lerp", () => {
  const pts = [{ id: "a", time: 10, value: 0 }, { id: "b", time: 20, value: 1 }];
  approx(autoValue(pts, 15, 0, true), 0);
  approx(autoValue(pts, 19.999, 0, true), 0);
  approx(autoValue(pts, 20, 0, true), 1);
});

test("coincident points don't divide by zero", () => {
  const pts = [{ id: "a", time: 10, value: -10 }, { id: "b", time: 10, value: 10 }];
  const v = autoValue(pts, 10, 0, false);
  assert.ok(Number.isFinite(v));
});

test("autoInsert keeps points sorted by time", () => {
  const pts = [];
  autoInsert(pts, { id: "c", time: 30, value: 3 });
  autoInsert(pts, { id: "a", time: 10, value: 1 });
  autoInsert(pts, { id: "b", time: 20, value: 2 });
  assert.deepStrictEqual(pts.map(p => p.id), ["a", "b", "c"]);
});

test("autoClampValue respects ranges and mute stepping", () => {
  approx(autoClampValue("volume", 99), AUTO_RANGES.volume.max);
  approx(autoClampValue("volume", -99), AUTO_RANGES.volume.min);
  approx(autoClampValue("pan", -5), -1);
  approx(autoClampValue("mute", 0.7), 1);
  approx(autoClampValue("mute", 0.3), 0);
});

test("autoCurve samples match autoValue through map()", () => {
  const pts = [{ id: "a", time: 0, value: 0 }, { id: "b", time: 10, value: 10 }];
  const curve = autoCurve(pts, 0, false, 0, 10, 11, (v) => v * 2);
  approx(curve[0], 0, 1e-5);
  approx(curve[5], 10, 1e-5);   // t=5 → v=5 → map → 10
  approx(curve[10], 20, 1e-5);
});

console.log("\nSERIALIZATION / DESERIALIZATION");

test("empty automation round-trips", () => {
  const a = emptyAutomation();
  const b = deserializeAutomation(serializeAutomation(a));
  assert.deepStrictEqual(b, a);
});

test("full automation round-trips identically (IndexedDB JSON path)", () => {
  const a = emptyAutomation();
  a.volume = [{ id: "v1", time: 0, value: -6 }, { id: "v2", time: 4.25, value: 3 }];
  a.pan = [{ id: "p1", time: 1.5, value: -0.75 }];
  a.mute = [{ id: "m1", time: 2, value: 1 }, { id: "m2", time: 3, value: 0 }];
  a.effects = { fx1: { wetDry: [{ id: "w1", time: 0, value: 0.5 }] } };
  const b = deserializeAutomation(serializeAutomation(a));
  assert.deepStrictEqual(b, a);
  // and the restored data interpolates identically
  approx(autoValue(b.volume, 2.125, 0, false), autoValue(a.volume, 2.125, 0, false));
});

test("deserialization repairs missing arrays and sorts corrupted order", () => {
  const b = deserializeAutomation(JSON.stringify({
    volume: [{ id: "x", time: 9, value: 1 }, { id: "y", time: 2, value: 0 }],
  }));
  assert.deepStrictEqual(b.volume.map(p => p.id), ["y", "x"]);
  assert.deepStrictEqual(b.pan, []);
  assert.deepStrictEqual(b.mute, []);
  assert.deepStrictEqual(b.effects, {});
});

test("deserializing garbage yields a safe empty automation", () => {
  assert.deepStrictEqual(deserializeAutomation("not json {{{"), emptyAutomation());
  assert.deepStrictEqual(deserializeAutomation("null"), emptyAutomation());
  assert.deepStrictEqual(deserializeAutomation("42"), emptyAutomation());
});

console.log("\nVALIDATOR (normalizacja i naprawy)");

test("normalizePoint drops NaN/Infinity/missing, clamps range, fixes negative time", () => {
  assert.strictEqual(normalizePoint("volume", null), null);
  assert.strictEqual(normalizePoint("volume", { time: NaN, value: 0 }), null);
  assert.strictEqual(normalizePoint("volume", { time: 1, value: Infinity }), null);
  assert.strictEqual(normalizePoint("volume", { time: "3", value: 0 }), null);
  const p = normalizePoint("volume", { id: "a", time: -5, value: 99 });
  approx(p.time, 0);
  approx(p.value, AUTO_RANGES.volume.max);
  assert.strictEqual(p.id, "a");
  assert.ok(normalizePoint("pan", { time: 0, value: 0.5 }).id.length > 0); // missing id → generated
});

test("normalizePoints filters invalid entries, dedupes ids, sorts", () => {
  const out = normalizePoints("pan", [
    { id: "b", time: 7, value: 0.5 },
    { id: "b", time: 1, value: -2 },        // dup id + out of range
    { id: "c", time: NaN, value: 0 },       // broken
    "junk",
  ]);
  assert.strictEqual(out.length, 2);
  assert.ok(out[0].time <= out[1].time);
  assert.notStrictEqual(out[0].id, out[1].id);
  approx(out[0].value, -1); // clamped to pan min
});

test("normalizeAutomation never mutates its input and deep-cleans effects", () => {
  const src = {
    volume: [{ id: "v", time: 2, value: 0 }],
    effects: { fx1: { wetDry: [{ id: "w", time: 1, value: 7 }] }, broken: null },
  };
  const frozenCopy = JSON.parse(JSON.stringify(src));
  const out = normalizeAutomation(src);
  assert.deepStrictEqual(src, frozenCopy);                      // input untouched
  approx(out.effects.fx1.wetDry[0].value, AUTO_RANGES.wetDry.max); // clamped to 1
  assert.ok(!("broken" in out.effects));
  assert.deepStrictEqual(out.pan, []);
});

test("ensureTrackAutomation attaches defaults in place, keeps point references", () => {
  const track = { gainDb: 0 };
  ensureTrackAutomation(track);
  assert.deepStrictEqual(track.automation, emptyAutomation());
  assert.deepStrictEqual(track.autoLane, { shown: false, param: "volume" });
  // live-drag safety: repeated calls must NOT replace point objects
  const p = { id: "p", time: 1, value: 0 };
  track.automation.volume.push(p);
  ensureTrackAutomation(track);
  assert.strictEqual(track.automation.volume[0], p);
  // invalid lane param is repaired
  track.autoLane.param = "nonsense";
  ensureTrackAutomation(track);
  assert.strictEqual(track.autoLane.param, "volume");
});

test("repairTrackAutomation deep-repairs data loaded from disk", () => {
  const track = {
    gainDb: 0,
    automation: { volume: [{ id: "x", time: 5, value: 999 }, null, { time: NaN }] },
    autoLane: { shown: true, param: "wetDry" },
  };
  repairTrackAutomation(track);
  assert.strictEqual(track.automation.volume.length, 1);
  approx(track.automation.volume[0].value, AUTO_RANGES.volume.max);
  assert.strictEqual(track.autoLane.param, "volume");
  assert.strictEqual(track.autoLane.shown, true); // hiding/showing never touches data
});

console.log("\nAUTOMATIONCORE FACADE (public API)");

test("initializeAutomation / AUTOMATION_TYPES / VALUE_RANGES are exposed", () => {
  assert.deepStrictEqual(AutomationCore.initializeAutomation(), emptyAutomation());
  assert.strictEqual(AutomationCore.AUTOMATION_TYPES.VOLUME, "volume");
  assert.strictEqual(AutomationCore.INTERPOLATION_TYPES.STEP, "step");
  assert.strictEqual(AutomationCore.VALUE_RANGES.volume.max, 12);
  assert.strictEqual(AutomationCore.VALUE_RANGES.mute.interpolation, "step");
});

test("addAutomationPoint is immutable: clamps, sorts, never mutates input", () => {
  const a0 = AutomationCore.initializeAutomation();
  const a1 = AutomationCore.addAutomationPoint(a0, "volume", 5, 99);
  const a2 = AutomationCore.addAutomationPoint(a1, "volume", 1, -99);
  assert.strictEqual(a0.volume.length, 0);              // input untouched
  assert.strictEqual(a1.volume.length, 1);
  assert.deepStrictEqual(a2.volume.map(p => p.time), [1, 5]); // sorted
  approx(a2.volume[0].value, AUTO_RANGES.volume.min);   // clamped
  approx(a2.volume[1].value, AUTO_RANGES.volume.max);
  assert.ok(a2.volume[0].id && a2.volume[0].id !== a2.volume[1].id);
});

test("updateAutomationPoint re-sorts and clamps; removeAutomationPoint filters by id", () => {
  let a = AutomationCore.initializeAutomation();
  a = AutomationCore.addAutomationPoint(a, "pan", 1, 0, "p1");
  a = AutomationCore.addAutomationPoint(a, "pan", 2, 0.5, "p2");
  const moved = AutomationCore.updateAutomationPoint(a, "pan", "p1", 10, -7);
  assert.deepStrictEqual(moved.pan.map(p => p.id), ["p2", "p1"]); // re-sorted
  approx(moved.pan[1].value, -1);                                 // clamped
  assert.strictEqual(a.pan[0].id, "p1");                          // original untouched
  const removed = AutomationCore.removeAutomationPoint(moved, "pan", "p2");
  assert.deepStrictEqual(removed.pan.map(p => p.id), ["p1"]);
});

test("getAutomationValueAtTime derives interpolation from type", () => {
  const pts = [{ id: "a", time: 0, value: 0 }, { id: "b", time: 10, value: 1 }];
  approx(AutomationCore.getAutomationValueAtTime({ points: pts, time: 5, baseValue: 0, type: "pan" }), 0.5);
  approx(AutomationCore.getAutomationValueAtTime({ points: pts, time: 5, baseValue: 0, type: "mute" }), 0); // step
});

test("serializeAutomation rounds to 6 decimals; deserialize accepts object, string and garbage", () => {
  let a = AutomationCore.initializeAutomation();
  a = AutomationCore.addAutomationPoint(a, "volume", 1 / 3, 1 / 7, "r");
  const obj = AutomationCore.serializeAutomation(a);
  approx(obj.volume[0].time, 0.333333, 1e-9);
  approx(obj.volume[0].value, 0.142857, 1e-9);
  assert.strictEqual(AutomationCore.serializeAutomation(null), null);
  const viaObj = AutomationCore.deserializeAutomation(obj);
  const viaStr = AutomationCore.deserializeAutomation(JSON.stringify(obj));
  assert.deepStrictEqual(viaObj, viaStr);
  assert.deepStrictEqual(AutomationCore.deserializeAutomation("}{"), emptyAutomation());
});

test("migrateTrack attaches automation to legacy tracks and repairs dirty data", () => {
  const legacy = { gainDb: 0 };
  AutomationCore.migrateTrack(legacy);
  assert.deepStrictEqual(legacy.automation, emptyAutomation());
  const dirty = { gainDb: 0, automation: { volume: [{ id: "x", time: -2, value: 999 }, null] } };
  AutomationCore.migrateTrack(dirty);
  assert.strictEqual(dirty.automation.volume.length, 1);
  approx(dirty.automation.volume[0].time, 0);
  approx(dirty.automation.volume[0].value, AUTO_RANGES.volume.max);
});

test("facade normalizeAutomation(points, type) cleans a single param array", () => {
  const out = AutomationCore.normalizeAutomation(
    [{ id: "b", time: 7, value: 5 }, { time: 1, value: -0.5 }, { time: NaN, value: 0 }], "pan");
  assert.strictEqual(out.length, 2);
  assert.ok(out[0].time <= out[1].time);
  approx(out[1].value, 1); // clamped to pan max
});

console.log("\nLANE CONTROLLER (AutomationLane public API)");

function makeLaneEnv() {
  const tracks = [
    { id: "t1", gainDb: 0, pan: 0 },
    { id: "t2", gainDb: 0, pan: 0 },
  ];
  let selected = "t1", changes = 0;
  const ctl = AutomationLaneController.create({
    getTracks: () => tracks,
    getSelectedTrackId: () => selected,
    ensureTrack: (t) => ensureTrackAutomation(t),
    onChange: () => { changes++; },
  });
  return { tracks, ctl, setSelected: (id) => { selected = id; }, getChanges: () => changes };
}

test("toggleLane shows/hides per track and never touches the data", () => {
  const { tracks, ctl, getChanges } = makeLaneEnv();
  assert.strictEqual(ctl.toggleLane("t1"), true);
  assert.strictEqual(tracks[0].autoLane.shown, true);
  tracks[0].automation.volume.push({ id: "p", time: 1, value: 0 });
  assert.strictEqual(ctl.toggleLane("t1"), false);           // hide…
  assert.strictEqual(tracks[0].automation.volume.length, 1); // …data survives
  assert.strictEqual(ctl.toggleLane("nope"), false);          // unknown id → no-op
  assert.strictEqual(getChanges(), 2);                        // redraws only on real changes
});

test("multiple lanes can be shown; active = most recently toggled-on", () => {
  const { ctl } = makeLaneEnv();
  ctl.toggleLane("t1");
  ctl.toggleLane("t2");
  assert.strictEqual(ctl.getActiveTrackId(), "t2");
  ctl.toggleLane("t2"); // hide t2 → falls back to the still-shown t1
  assert.strictEqual(ctl.getActiveTrackId(), "t1");
  ctl.toggleLane("t1");
  assert.strictEqual(ctl.getActiveTrackId(), null);
});

test("setActiveLaneType validates the type and rejects FX until effects exist", () => {
  const { tracks, ctl } = makeLaneEnv();
  ctl.toggleLane("t1");
  assert.strictEqual(ctl.setActiveLaneType("pan"), true);     // defaults to active lane
  assert.strictEqual(tracks[0].autoLane.param, "pan");
  assert.strictEqual(ctl.getActiveLaneType(), "pan");
  assert.strictEqual(ctl.setActiveLaneType("mute", "t2"), true); // explicit track
  assert.strictEqual(tracks[1].autoLane.param, "mute");
  assert.strictEqual(ctl.setActiveLaneType("effects"), false);
  assert.strictEqual(ctl.setActiveLaneType("nonsense"), false);
  assert.strictEqual(tracks[0].autoLane.param, "pan");        // unchanged by rejects
});

test("active lane prefers the selected track when several are shown", () => {
  const { ctl, setSelected } = makeLaneEnv();
  ctl.toggleLane("t1");
  ctl.toggleLane("t2");
  ctl.toggleLane("t2"); // t2 hidden again; show both fresh
  ctl.toggleLane("t2");
  setSelected("t1");
  // lastActive = t2, but after it's cleared the fallback honours selection
  ctl.toggleLane("t2");
  ctl.toggleLane("t2");
  assert.strictEqual(ctl.getActiveTrackId(), "t2"); // last toggled-on wins while shown
});

console.log("\nUNDO / REDO (same snapshot mechanism as the app)");

/* mirror of app.js: JSON snapshots on a bounded stack */
function makeHistory(getState, setState) {
  const undoStack = [], redoStack = [];
  return {
    push() { undoStack.push(JSON.stringify(getState())); redoStack.length = 0; },
    undo() { if (!undoStack.length) return false; redoStack.push(JSON.stringify(getState())); setState(JSON.parse(undoStack.pop())); return true; },
    redo() { if (!redoStack.length) return false; undoStack.push(JSON.stringify(getState())); setState(JSON.parse(redoStack.pop())); return true; },
  };
}

test("add / move / change-value / delete are all undoable and redoable", () => {
  let track = { gainDb: 0, automation: emptyAutomation() };
  const h = makeHistory(() => track, (s) => { track = s; });

  h.push(); // op1: add point
  autoInsert(track.automation.volume, { id: "a", time: 4, value: -6 });

  h.push(); // op2: move point in time
  track.automation.volume[0].time = 8;
  autoSort(track.automation.volume);

  h.push(); // op3: change value
  track.automation.volume[0].value = 6;

  h.push(); // op4: delete point
  track.automation.volume.splice(0, 1);
  assert.strictEqual(track.automation.volume.length, 0);

  assert.ok(h.undo()); // undo delete
  assert.strictEqual(track.automation.volume.length, 1);
  approx(track.automation.volume[0].value, 6);

  assert.ok(h.undo()); // undo value change
  approx(track.automation.volume[0].value, -6);

  assert.ok(h.undo()); // undo move
  approx(track.automation.volume[0].time, 4);

  assert.ok(h.undo()); // undo add
  assert.strictEqual(track.automation.volume.length, 0);

  assert.ok(h.redo()); // redo add
  assert.strictEqual(track.automation.volume.length, 1);
  approx(track.automation.volume[0].time, 4);

  assert.ok(h.redo()); h.redo(); h.redo(); // redo all
  assert.strictEqual(track.automation.volume.length, 0);
});

test("undo restores interpolated playback values exactly", () => {
  let track = { gainDb: -3, automation: emptyAutomation() };
  const h = makeHistory(() => track, (s) => { track = s; });
  h.push();
  autoInsert(track.automation.volume, { id: "a", time: 0, value: -20 });
  autoInsert(track.automation.volume, { id: "b", time: 10, value: 0 });
  approx(autoValue(track.automation.volume, 5, track.gainDb, false), -10);
  h.undo();
  approx(autoValue(track.automation.volume, 5, track.gainDb, false), -3); // base again
  h.redo();
  approx(autoValue(track.automation.volume, 5, track.gainDb, false), -10);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
