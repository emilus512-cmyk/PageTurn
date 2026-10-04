/* ═══════════════════════════════════════════════════════════════════
   ABSOLUTE STUDIO X — automation validator
   Normalization & repair: drops broken points, clamps out-of-range
   values, restores missing arrays, dedupes ids, keeps points sorted.
   Pure data — no DOM, no WebAudio. Shared by browser and Node tests.
   ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./automation-core.js"));
  } else {
    // browser: core was loaded first, its declarations are lexical globals
    root.AutomationValidator = factory({ AUTO_RANGES, autoSort, autoClampValue, emptyAutomation });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (core) {
  "use strict";
  const { AUTO_RANGES, autoSort, autoClampValue, emptyAutomation } = core;

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const genId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  /* single point → repaired copy, or null if unsalvageable */
  function normalizePoint(param, p) {
    if (!p || typeof p !== "object" || !isNum(p.time) || !isNum(p.value)) return null;
    return {
      id: typeof p.id === "string" && p.id ? p.id : genId(),
      time: Math.max(0, p.time),
      value: autoClampValue(param, p.value),
    };
  }

  /* point array → clean, sorted, id-deduped copy */
  function normalizePoints(param, arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const p of arr) {
      const np = normalizePoint(param, p);
      if (!np) continue;
      if (seen.has(np.id)) np.id = genId();
      seen.add(np.id);
      out.push(np);
    }
    return autoSort(out);
  }

  /* whole automation object → deep-cleaned copy (never mutates input) */
  function normalizeAutomation(a) {
    const out = emptyAutomation();
    if (!a || typeof a !== "object") return out;
    for (const k of ["volume", "pan", "mute"]) out[k] = normalizePoints(k, a[k]);
    if (a.effects && typeof a.effects === "object") {
      for (const fxId of Object.keys(a.effects)) {
        const fx = a.effects[fxId];
        if (!fx || typeof fx !== "object") continue;
        out.effects[fxId] = { wetDry: normalizePoints("wetDry", fx.wetDry) };
      }
    }
    return out;
  }

  /* cheap in-place guard — safe to call per frame/event; never replaces
     point objects (live drag handles keep their references) */
  function ensureTrackAutomation(track) {
    if (!track.automation || typeof track.automation !== "object") track.automation = emptyAutomation();
    for (const k of ["volume", "pan", "mute"]) {
      if (!Array.isArray(track.automation[k])) track.automation[k] = [];
    }
    if (!track.automation.effects || typeof track.automation.effects !== "object") track.automation.effects = {};
    if (!track.autoLane || typeof track.autoLane !== "object") track.autoLane = { shown: false, param: "volume" };
    if (!AUTO_RANGES[track.autoLane.param] || track.autoLane.param === "wetDry") track.autoLane.param = "volume";
    return track;
  }

  /* deep repair — for data coming from disk/IndexedDB */
  function repairTrackAutomation(track) {
    track.automation = normalizeAutomation(track.automation);
    return ensureTrackAutomation(track);
  }

  return { normalizePoint, normalizePoints, normalizeAutomation, ensureTrackAutomation, repairTrackAutomation };
});
