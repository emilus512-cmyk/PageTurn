/* ═══════════════════════════════════════════════════════════════════
   ABSOLUTE STUDIO X — automation scheduler (audio engine side)
   Bakes point curves onto AudioParams via setValueCurveAtTime.
   The AudioParam interpolates linearly between curve samples at audio
   rate, so linear segments play back sample-accurately — completely
   independent of the UI render loop. Works for both the realtime
   AudioContext and the OfflineAudioContext used by export, which is
   what guarantees playback === bounce.
   Browser-only module. Depends on: automation-core.js (autoCurve),
   automation-validator.js (ensureTrackAutomation).
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";

  const CURVE_RATE = 200;        // curve samples per second (5 ms grid)
  const MAX_CURVE_SAMPLES = 240000;

  const clampNum = (v, a, b) => Math.min(b, Math.max(a, v));
  const dbToLin = (db) => Math.pow(10, db / 20);
  const volMap = (db) => (db <= -59.5 ? 0 : dbToLin(db)); // -60 dB → true silence

  /* nodes: { autoVol: GainNode, autoPan: StereoPannerNode, autoMute: GainNode } */
  function scheduleTrack(nodes, track, fromPos, when, end) {
    root.AutomationValidator.ensureTrackAutomation(track);
    const dur = Math.max(0.5, end - fromPos);
    const N = Math.min(MAX_CURVE_SAMPLES, Math.max(2, Math.ceil(dur * CURVE_RATE)));
    const sched = (param, pts, base, step, map, lo, hi) => {
      if (!pts.length) return;
      const curve = autoCurve(pts, base, step, fromPos, dur, N, (v) => clampNum(map(v), lo, hi));
      try {
        param.cancelScheduledValues(0);
        param.setValueCurveAtTime(curve, when, dur);
      } catch (e) { /* never block playback */ }
    };
    sched(nodes.autoVol.gain, track.automation.volume, track.gainDb, false, volMap, 0, 4);
    sched(nodes.autoPan.pan, track.automation.pan, track.pan, false, (v) => v, -1, 1);
    sched(nodes.autoMute.gain, track.automation.mute, 0, true, (v) => 1 - Math.round(v), 0, 1);
  }

  function cancelTrack(nodes) {
    for (const p of [nodes.autoVol.gain, nodes.autoPan.pan, nodes.autoMute.gain]) {
      try { p.cancelScheduledValues(0); } catch (e) {}
    }
  }

  root.AutomationScheduler = { scheduleTrack, cancelTrack, volMap, CURVE_RATE };
})(typeof globalThis !== "undefined" ? globalThis : this);
