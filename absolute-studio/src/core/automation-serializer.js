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

  function serializeAutomation(a) {
    return JSON.stringify(validator.normalizeAutomation(a));
  }

  function deserializeAutomation(s) {
    let parsed = null;
    try { parsed = JSON.parse(s); } catch (e) { parsed = null; }
    return validator.normalizeAutomation(parsed);
  }

  return { serializeAutomation, deserializeAutomation };
});
