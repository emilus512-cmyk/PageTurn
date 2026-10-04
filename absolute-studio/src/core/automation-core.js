/* ═══════════════════════════════════════════════════════════════════
   ABSOLUTE STUDIO X — automation core (pure, testable, no DOM/audio)
   Points: { id, time (sec), value (param units) }, kept sorted by time.
   Semantics:
     - before first point  → track base value
     - between points      → linear interpolation (step params: hold previous)
     - after last point    → last point's value
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

const AUTO_RANGES = {
  volume: { min: -60, max: 12, step: false }, // dB; -60 treated as -inf
  pan:    { min: -1,  max: 1,  step: false }, // L100 .. R100
  mute:   { min: 0,   max: 1,  step: true  }, // 1 = muted
  wetDry: { min: 0,   max: 1,  step: false }, // plugin wet/dry (model-ready)
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

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    AUTO_RANGES, autoSort, autoInsert, autoClampValue, autoValue, autoCurve,
    emptyAutomation,
  };
}
