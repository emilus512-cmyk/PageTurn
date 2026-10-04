/* ═══════════════════════════════════════════════════════════════════
   ABSOLUTE STUDIO X — AutomationCore public API (facade)
   Stable, UI-free entry point over the granular modules:
     core       → math, constants, immutable point ops
     validator  → normalization & repair
     serializer → rounded JSON round-trip
   Independent of React/UI state and requestAnimationFrame by
   construction — nothing in core/ touches the DOM or the render loop.
   AudioParam scheduling intentionally lives in src/audio/, not here:
   the facade stays loadable in Node (tests) and Workers.
   ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(
      require("./automation-core.js"),
      require("./automation-validator.js"),
      require("./automation-serializer.js")
    );
  } else {
    root.AutomationCore = factory(
      {
        AUTOMATION_TYPES, INTERPOLATION_TYPES, AUTO_RANGES,
        emptyAutomation, getAutomationValueAtTime, generatePointId,
        addAutomationPoint, removeAutomationPoint, updateAutomationPoint,
      },
      root.AutomationValidator,
      root.AutomationSerializer
    );
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (core, validator, serializer) {
  "use strict";

  return {
    /* ── main ── */
    /* (points, type) → clean, clamped, sorted copy of ONE point array */
    normalizeAutomation: (points, type) => validator.normalizePoints(type, points),
    /* ({ points, time, baseValue, type }) → value; linear for VOL/PAN, step for MUTE */
    getAutomationValueAtTime: core.getAutomationValueAtTime,
    /* automation object → rounded plain-JSON object (6 decimals), or null */
    serializeAutomation: (automation) => (automation ? serializer.toJSONObject(automation) : null),
    /* raw object or JSON string (or null/garbage) → safe automation object */
    deserializeAutomation: (raw) => serializer.deserializeAutomation(raw),

    /* ── operations (immutable: always return a new automation object) ── */
    initializeAutomation: core.emptyAutomation,
    addAutomationPoint: core.addAutomationPoint,
    removeAutomationPoint: core.removeAutomationPoint,
    updateAutomationPoint: core.updateAutomationPoint,
    /* track without automation (or with raw/dirty automation) → repaired in place */
    migrateTrack: (track) => validator.repairTrackAutomation(track),

    /* ── constants ── */
    AUTOMATION_TYPES: core.AUTOMATION_TYPES,
    INTERPOLATION_TYPES: core.INTERPOLATION_TYPES,
    VALUE_RANGES: core.AUTO_RANGES,
    generatePointId: core.generatePointId,
  };
});
