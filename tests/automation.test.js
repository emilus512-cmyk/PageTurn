/**
 * Convenience shim — run from the repo root:
 *   node tests/automation.test.js
 * The real suite lives in absolute-studio/src/tests/automation.test.js
 * (next to the modules it tests); this file just forwards to it.
 */
require("../absolute-studio/src/tests/automation.test.js");
