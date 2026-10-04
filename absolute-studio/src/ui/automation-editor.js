/* ═══════════════════════════════════════════════════════════════════
   ABSOLUTE STUDIO X — automation editor (UI side)
   Hit-testing and pointer interaction for lane editing:
     click            → add point (snapped; Alt = snap off)
     drag point       → move in time + value (Shift = axis lock)
     dbl / right-click → delete point
   Every mutation goes through env.pushUndo and triggers a live
   reschedule so playback follows edits without stopping.
   Browser-only module. Depends on: automation-core.js, lane UI.
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";

    /* env: { laneUI, laneController, headerW, autoPoints, pushUndo, applyTrackGains,
            reschedule, invalidate, snapTime, xToTime, uid, toast, selectTrack, rebuildMixer } */
  function create(env) {
    const laneUI = env.laneUI;

    function hitTest(mx, my, L) {
      const t = L.track;
      if (mx < env.headerW) {
        for (const b of laneUI.autoButtons(L)) {
          if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
            return { zone: "autoBtn", btn: b, track: t, L };
          }
        }
        return { zone: "autoHeader", track: t, L };
      }
      const param = t.autoLane.param;
      const pts = env.autoPoints(t, param);
      for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        const px = env.timeToX(p.time), py = laneUI.autoValToY(param, p.value, L);
        if ((mx - px) * (mx - px) + (my - py) * (my - py) <= 49) {
          return { zone: "autoPoint", point: p, param, track: t, L };
        }
      }
      return { zone: "autoLane", param, track: t, L };
    }

    /* returns a drag object (or null when the gesture is already done) */
    function onPointerDown(hit, e, mx, my) {
      if (hit.zone === "autoBtn") {
        if (hit.btn.disabled) { env.toast("FX wet/dry: no effects on this track yet (model ready)"); return null; }
        // route through the public lane controller — one source of truth
        if (hit.btn.act === "close") env.laneController.toggleLane(hit.track.id);
        else env.laneController.setActiveLaneType(hit.btn.param, hit.track.id);
        return null;
      }
      if (hit.zone === "autoHeader") {
        env.selectTrack(hit.track.id);
        env.rebuildMixer();
        env.invalidate();
        return null;
      }
      if (hit.zone === "autoPoint") {
        env.selectTrack(hit.track.id);
        if (e.button === 2 || e.detail === 2) {
          // delete point
          env.pushUndo();
          const arr = env.autoPoints(hit.track, hit.param);
          const i = arr.indexOf(hit.point);
          if (i >= 0) arr.splice(i, 1);
          env.applyTrackGains();
          env.reschedule();
          env.invalidate();
          return null;
        }
        env.invalidate();
        return {
          mode: "autoPoint", track: hit.track, param: hit.param, point: hit.point, L: hit.L,
          undoPushed: false, lock: null, pressX: mx, pressY: my,
          orig: { time: hit.point.time, value: hit.point.value },
        };
      }
      if (hit.zone === "autoLane") {
        env.selectTrack(hit.track.id);
        if (e.button === 2) return null;
        // click on the line = add a point, then keep dragging it
        env.pushUndo();
        const time = e.altKey ? Math.max(0, env.xToTime(mx)) : env.snapTime(env.xToTime(mx));
        const value = laneUI.autoYToVal(hit.param, my, hit.L);
        const p = autoInsert(env.autoPoints(hit.track, hit.param), { id: env.uid(), time, value });
        env.applyTrackGains();
        env.invalidate();
        return {
          mode: "autoPoint", track: hit.track, param: hit.param, point: p, L: hit.L,
          undoPushed: true, lock: null, pressX: mx, pressY: my,
          orig: { time: p.time, value: p.value },
        };
      }
      return null;
    }

    function onPointerMove(drag, e, mx, my) {
      if (!drag.undoPushed) { env.pushUndo(); drag.undoPushed = true; }
      let time = e.altKey ? Math.max(0, env.xToTime(mx)) : env.snapTime(env.xToTime(mx)); // Alt = snap off
      let value = laneUI.autoYToVal(drag.param, my, drag.L);
      if (e.shiftKey) {
        // constrain to dominant axis
        if (!drag.lock) {
          const dx = Math.abs(mx - drag.pressX), dy = Math.abs(my - drag.pressY);
          if (dx > 3 || dy > 3) drag.lock = dx >= dy ? "x" : "y";
        }
        if (drag.lock === "x") value = drag.orig.value;
        else if (drag.lock === "y") time = drag.orig.time;
      } else {
        drag.lock = null;
      }
      drag.point.time = time;
      drag.point.value = value;
      autoSort(env.autoPoints(drag.track, drag.param));
      env.applyTrackGains();
      env.invalidate();
    }

    function onPointerUp(drag) {
      env.reschedule(); // live playback follows the edit
    }

    return { hitTest, onPointerDown, onPointerMove, onPointerUp };
  }

  root.AutomationEditor = { create };
})(typeof globalThis !== "undefined" ? globalThis : this);
