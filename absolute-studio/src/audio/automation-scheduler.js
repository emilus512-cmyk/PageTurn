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

  /* cancel pending curves without a value jump where the engine supports it */
  function cancelParam(param) {
    try {
      if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(0);
      else param.cancelScheduledValues(0);
    } catch (e) { /* never block playback */ }
  }

  /* nodes: { autoVol: GainNode, autoPan: StereoPannerNode, autoMute: GainNode } */
  function scheduleTrack(nodes, track, fromPos, when, end) {
    root.AutomationValidator.ensureTrackAutomation(track);
    const dur = Math.max(0.5, end - fromPos);
    const N = Math.min(MAX_CURVE_SAMPLES, Math.max(2, Math.ceil(dur * CURVE_RATE)));
    const sched = (param, pts, base, step, map, lo, hi) => {
      if (!pts.length) return;
      const curve = autoCurve(pts, base, step, fromPos, dur, N, (v) => clampNum(map(v), lo, hi));
      cancelParam(param);
      try {
        param.setValueCurveAtTime(curve, when, dur);
      } catch (e) { /* never block playback */ }
    };
    sched(nodes.autoVol.gain, track.automation.volume, track.gainDb, false, volMap, 0, 4);
    sched(nodes.autoPan.pan, track.automation.pan, track.pan, false, (v) => v, -1, 1);
    sched(nodes.autoMute.gain, track.automation.mute, 0, true, (v) => 1 - Math.round(v), 0, 1);
  }

  function cancelTrack(nodes) {
    for (const p of [nodes.autoVol.gain, nodes.autoPan.pan, nodes.autoMute.gain]) cancelParam(p);
  }

  /* latest automation point across all tracks/params — defines the horizon */
  function lastAutomationTime(tracks) {
    let m = 0;
    for (const t of tracks) {
      if (!t.automation) continue;
      for (const k of ["volume", "pan", "mute"]) {
        const pts = t.automation[k];
        if (pts && pts.length) m = Math.max(m, pts[pts.length - 1].time);
      }
    }
    return m;
  }

  /* ── transport-level orchestration ──
     Bind once to the app (DI), then call before every playback/export
     and whenever a point is edited mid-playback.
     env: { getTracks(), getNodes(trackId) -> nodes|null, sessionEnd() } */
  function createTransportScheduler(env) {
    const horizon = (fromPos) =>
      Math.max(env.sessionEnd(), lastAutomationTime(env.getTracks()) + 1, fromPos + 2);

    /* fromPos: timeline seconds; when: AudioContext time of fromPos */
    function scheduleAll(fromPos, when) {
      const end = horizon(fromPos);
      for (const t of env.getTracks()) {
        const n = env.getNodes(t.id);
        if (n) scheduleTrack(n, t, fromPos, when, end);
      }
      return end;
    }

    /* mid-playback edit → re-bake curves slightly ahead of the playhead.
       Timeline→context conversion: a timeline position T sounds at
       playStartCtx + (T - playStartPos). This is the piece naive
       schedulers get wrong by passing point.time straight to AudioParams. */
    function rescheduleFromPlayhead({ pos, playStartPos, playStartCtx, lookahead = 0.06 }) {
      const fromPos = pos + lookahead;
      const when = playStartCtx + (fromPos - playStartPos);
      scheduleAll(fromPos, when);
      return { fromPos, when };
    }

    function cancelAll() {
      for (const t of env.getTracks()) {
        const n = env.getNodes(t.id);
        if (n) cancelTrack(n);
      }
    }

    return { scheduleAll, rescheduleFromPlayhead, cancelAll };
  }

  const api = { scheduleTrack, cancelTrack, volMap, CURVE_RATE, lastAutomationTime, createTransportScheduler };
  root.AutomationScheduler = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
