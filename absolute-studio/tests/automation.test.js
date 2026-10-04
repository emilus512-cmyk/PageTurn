/* ABSOLUTE STUDIO X — automation core tests
   run: node tests/automation.test.js */
"use strict";
const assert = require("assert");
const {
  AUTO_RANGES, autoSort, autoInsert, autoClampValue, autoValue, autoCurve,
  emptyAutomation, serializeAutomation, deserializeAutomation,
} = require("../automation-core.js");

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
