/* ═══════════════════════════════════════════════════════════════════
   ABSOLUTE STUDIO X — automation core (pure, testable, no DOM/audio)
   Points: { id, time (sec), value (param units) }, kept sorted by time.
   Semantics:
     - before first point  → track base value
     - between points      → linear interpolation (step params: hold previous)
     - after last point    → last point's value
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

const AUTOMATION_TYPES = { VOLUME: "volume", PAN: "pan", MUTE: "mute" };
const INTERPOLATION_TYPES = { LINEAR: "linear", STEP: "step" };

const AUTO_RANGES = {
  // volume stays in dB (spec: -∞ … +12 dB); dB→gain mapping is the scheduler's job
  volume: { min: -60, max: 12, step: false, base: 0,  interpolation: "linear", label: "+12 dB, 0 dB, -inf dB" },
  pan:    { min: -1,  max: 1,  step: false, base: 0,  interpolation: "linear", label: "L100, C, R100" },
  mute:   { min: 0,   max: 1,  step: true,  base: 0,  interpolation: "step",   label: "0 or 1" },
  wetDry: { min: 0,   max: 1,  step: false, base: 1,  interpolation: "linear", label: "dry 0 … wet 1" },
};

function autoSort(points) {
  points.sort((a, b) => a.time - b.time);
  return points;
}

function autoInsert(points, p) {
  points.push(p);
  autoSort(points);
  return p;
}

function autoClampValue(param, v) {
  const r = AUTO_RANGES[param];
  if (!r) return v;
  v = Math.min(r.max, Math.max(r.min, v));
  return r.step ? Math.round(v) : v;
}

function autoValue(points, t, base, step) {
  if (!points || !points.length) return base;
  if (t < points[0].time) return base;
  let prev = points[0];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (t < p.time) {
      if (step) return prev.value;
      const span = p.time - prev.time;
      if (span <= 1e-9) return p.value;
      const f = (t - prev.time) / span;
      return prev.value + (p.value - prev.value) * f;
    }
    prev = p;
  }
  return prev.value;
}

/* Sample a parameter curve over [from, from+dur] into n values (for
   AudioParam.setValueCurveAtTime — linear between samples ≙ our model). */
function autoCurve(points, base, step, from, dur, n, map) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = from + (dur * i) / (n - 1);
    out[i] = map(autoValue(points, t, base, step));
  }
  return out;
}

function emptyAutomation() {
  return { volume: [], pan: [], mute: [], effects: {} };
}

/* object-arg convenience: interpolation mode derived from the param type */
function getAutomationValueAtTime({ points, time, baseValue, type }) {
  const r = AUTO_RANGES[type];
  return autoValue(points, time, baseValue, !!(r && r.step));
}

function generatePointId() {
  return "pt_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 11);
}

/* ── immutable point operations ──
   Return a NEW automation object; the input is never mutated.
   (The live editor uses in-place edits + undo snapshots for drag
   performance; these are for programmatic/stateless flows.) */
function addAutomationPoint(automation, type, time, value, id) {
  const src = (automation && Array.isArray(automation[type])) ? automation[type] : [];
  const next = src.map(p => ({ ...p }));
  next.push({
    id: id || generatePointId(),
    time: Math.max(0, time),
    value: autoClampValue(type, value),
  });
  autoSort(next);
  return { ...automation, [type]: next };
}

function removeAutomationPoint(automation, type, pointId) {
  const src = (automation && Array.isArray(automation[type])) ? automation[type] : [];
  return { ...automation, [type]: src.filter(p => p.id !== pointId) };
}

function updateAutomationPoint(automation, type, pointId, newTime, newValue) {
  const src = (automation && Array.isArray(automation[type])) ? automation[type] : [];
  const next = src.map(p => (p.id === pointId
    ? { ...p, time: Math.max(0, newTime), value: autoClampValue(type, newValue) }
    : { ...p }));
  autoSort(next);
  return { ...automation, [type]: next };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    AUTOMATION_TYPES, INTERPOLATION_TYPES, AUTO_RANGES,
    autoSort, autoInsert, autoClampValue, autoValue, autoCurve,
    emptyAutomation, getAutomationValueAtTime, generatePointId,
    addAutomationPoint, removeAutomationPoint, updateAutomationPoint,
  };
}
