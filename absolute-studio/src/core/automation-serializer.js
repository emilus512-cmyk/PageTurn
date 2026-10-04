/* ═══════════════════════════════════════════════════════════════════
   ABSOLUTE STUDIO X — automation serializer
   Canonical JSON round-trip for automation data (session file,
   IndexedDB, snapshots). Always validates on the way in AND out, so
   whatever reaches disk — or comes back from it — is well-formed.
   ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./automation-validator.js"));
  } else {
    root.AutomationSerializer = factory(root.AutomationValidator);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (validator) {
  "use strict";

  /* 6 decimal places: sub-microsecond time precision, stable diffs,
     no float noise accumulating across save/load cycles */
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const roundPoints = (arr) => arr.map(p => ({ id: p.id, time: r6(p.time), value: r6(p.value) }));

  /* normalized, rounded, plain-JSON automation object */
  function toJSONObject(a) {
    const n = validator.normalizeAutomation(a);
    const out = { volume: roundPoints(n.volume), pan: roundPoints(n.pan), mute: roundPoints(n.mute), effects: {} };
    for (const fxId of Object.keys(n.effects)) {
      out.effects[fxId] = { wetDry: roundPoints(n.effects[fxId].wetDry) };
    }
    return out;
  }

  function serializeAutomation(a) {
    return JSON.stringify(toJSONObject(a));
  }

  function deserializeAutomation(s) {
    let parsed = null;
    try { parsed = typeof s === "string" ? JSON.parse(s) : s; } catch (e) { parsed = null; }
    return validator.normalizeAutomation(parsed);
  }

  return { toJSONObject, serializeAutomation, deserializeAutomation };
});
