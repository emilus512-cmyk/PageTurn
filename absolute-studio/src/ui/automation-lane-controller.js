/* ═══════════════════════════════════════════════════════════════════
   ABSOLUTE STUDIO X — AutomationLane controller (public API)
   Programmatic control of automation lanes: toggle per track (Alt+A),
   switch lane parameter, query active lane. State lives on the tracks
   themselves (track.autoLane) — the single source of truth shared with
   the canvas renderer — so this controller is DOM-free and Node-testable.
   Multiple tracks may show lanes simultaneously; "active" = the most
   recently toggled-on lane that is still shown.
   ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.AutomationLaneController = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LANE_TYPES = ["volume", "pan", "mute"]; // 'effects' unlocks with the FX rack
  const LANE_HEIGHTS = { collapsed: 0, expanded: 58 };

  /* env: { getTracks, getSelectedTrackId?, ensureTrack, onChange } */
  function create(env) {
    let lastActiveTrackId = null;

    const trackById = (id) => env.getTracks().find(t => t.id === id) || null;
    const shownTracks = () => env.getTracks().filter(t => t.autoLane && t.autoLane.shown);

    /* Alt+A — show/hide the lane; hiding never deletes automation data */
    function toggleLane(trackId) {
      const t = trackById(trackId);
      if (!t) return false;
      env.ensureTrack(t);
      t.autoLane.shown = !t.autoLane.shown;
      if (t.autoLane.shown) lastActiveTrackId = t.id;
      else if (lastActiveTrackId === t.id) lastActiveTrackId = null;
      env.onChange();
      return t.autoLane.shown;
    }

    /* switch VOL | PAN | MUTE for a lane (defaults to the active one) */
    function setActiveLaneType(type, trackId) {
      if (!LANE_TYPES.includes(type)) return false; // FX rejected until effects exist
      const t = trackById(trackId || getActiveTrackId() || "");
      if (!t) return false;
      env.ensureTrack(t);
      t.autoLane.param = type;
      env.onChange();
      return true;
    }

    function getActiveTrackId() {
      if (lastActiveTrackId) {
        const t = trackById(lastActiveTrackId);
        if (t && t.autoLane && t.autoLane.shown) return t.id;
        lastActiveTrackId = null;
      }
      const shown = shownTracks();
      if (shown.length) {
        const sel = env.getSelectedTrackId && env.getSelectedTrackId();
        const selShown = shown.find(t => t.id === sel);
        return (selShown || shown[0]).id;
      }
      return null;
    }

    function getActiveLaneType(trackId) {
      const t = trackById(trackId || getActiveTrackId() || "");
      return t && t.autoLane ? t.autoLane.param : null;
    }

    /* canvas world: "render" = request a timeline redraw */
    function render() { env.onChange(); }

    return { toggleLane, setActiveLaneType, render, getActiveTrackId, getActiveLaneType };
  }

  return { create, LANE_TYPES, LANE_HEIGHTS };
});
