/* ═══════════════════════════════════════════════════════════════════
   ABSOLUTE STUDIO X — automation lane renderer (UI side)
   Draws the lane directly on the timeline canvas, under the track's
   clips: curve, points, dB / L-C-R axes, param switcher. Pure drawing —
   no state mutation, no audio. Colors come from automation-styles.css
   custom properties so theming stays in CSS.
   Browser-only module. Depends on: automation-core.js.
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";

  const AUTO_PAD = 7;
  const clampNum = (v, a, b) => Math.min(b, Math.max(a, v));

  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => (cs.getPropertyValue(name) || "").trim() || fb;
    return {
      bg: v("--auto-lane-bg", "#0b0d11"),
      grid: v("--auto-lane-grid", "#1a1a20"),
      zero: v("--auto-lane-zero", "#2b2b33"),
      label: v("--auto-lane-label", "#4a4a54"),
      header: v("--auto-lane-header", "#0f1016"),
      border: v("--auto-lane-border", "#232329"),
      btnBg: v("--auto-lane-btn", "#1b1b20"),
      btnBorder: v("--auto-lane-btn-border", "#2e2e36"),
      btnText: v("--auto-lane-btn-text", "#76767e"),
      btnDisabled: v("--auto-lane-btn-disabled", "#3a3a42"),
    };
  }

  /* env: { getG2, getCw, headerW, timeToX, xToTime, autoPoints, autoBase, getDrag } */
  function create(env) {
    const theme = readTheme();

    function autoValToY(param, v, L) {
      const r = AUTO_RANGES[param];
      return L.autoY + AUTO_PAD + (1 - (v - r.min) / (r.max - r.min)) * (L.autoH - 2 * AUTO_PAD);
    }

    function autoYToVal(param, y, L) {
      const r = AUTO_RANGES[param];
      const f = 1 - clampNum((y - (L.autoY + AUTO_PAD)) / (L.autoH - 2 * AUTO_PAD), 0, 1);
      return autoClampValue(param, r.min + f * (r.max - r.min));
    }

    function autoButtons(L) {
      const y = L.autoY + L.autoH - 23;
      const param = L.track.autoLane.param;
      return [
        { label: "VOL", param: "volume", on: param === "volume", x: 12, y, w: 32, h: 16 },
        { label: "PAN", param: "pan", on: param === "pan", x: 48, y, w: 32, h: 16 },
        { label: "MUTE", param: "mute", on: param === "mute", x: 84, y, w: 36, h: 16 },
        { label: "FX", param: "fx", on: false, disabled: true, x: 124, y, w: 24, h: 16 },
        { label: "×", act: "close", x: env.headerW - 22, y: L.autoY + 4, w: 15, h: 14 },
      ];
    }

    function drawAutoLane(L) {
      const g2 = env.getG2();
      const cw = env.getCw();
      const HEADER_W = env.headerW;
      const t = L.track, param = t.autoLane.param;
      const y0 = L.autoY, h = L.autoH;
      const r = AUTO_RANGES[param];
      const pts = env.autoPoints(t, param);
      const base = env.autoBase(t, param);
      const drag = env.getDrag();

      // lane bg
      g2.fillStyle = theme.bg;
      g2.fillRect(HEADER_W, y0, cw - HEADER_W, h);
      g2.strokeStyle = theme.grid;
      g2.beginPath(); g2.moveTo(HEADER_W, y0 + h + 0.5); g2.lineTo(cw, y0 + h + 0.5); g2.stroke();

      // reference lines + axis labels
      g2.font = "8px monospace";
      const refs = param === "volume" ? [{ v: 12, l: "+12" }, { v: 0, l: "0dB" }, { v: -60, l: "-inf" }]
        : param === "pan" ? [{ v: 1, l: "R100" }, { v: 0, l: "C" }, { v: -1, l: "L100" }]
        : [{ v: 1, l: "MUTE" }, { v: 0, l: "PLAY" }];
      for (const rf of refs) {
        const y = autoValToY(param, rf.v, L);
        g2.strokeStyle = rf.v === 0 && param !== "mute" ? theme.zero : theme.grid;
        g2.beginPath(); g2.moveTo(HEADER_W, y + 0.5); g2.lineTo(cw, y + 0.5); g2.stroke();
        g2.fillStyle = theme.label;
        g2.fillText(rf.l, HEADER_W + 4, y - 1 < y0 + 8 ? y + 8 : y - 2);
      }

      // curve (dashed base line when no points yet)
      const step = !!r.step;
      g2.strokeStyle = t.color;
      g2.lineWidth = 1.5;
      if (!pts.length) g2.setLineDash([4, 4]);
      g2.beginPath();
      let first = true;
      for (let sx = HEADER_W; sx <= cw; sx += 2) {
        const v = autoClampValue(param, autoValue(pts, Math.max(0, env.xToTime(sx)), base, step));
        const y = autoValToY(param, v, L);
        if (first) { g2.moveTo(sx, y); first = false; } else g2.lineTo(sx, y);
      }
      g2.stroke();
      g2.setLineDash([]);
      g2.lineWidth = 1;

      // empty-state hint
      if (!pts.length) {
        g2.fillStyle = "rgba(255,255,255,0.16)";
        g2.font = "10px monospace";
        g2.fillText("click to add a point · drag to shape · dbl-click deletes · Shift locks axis · Alt = free", HEADER_W + 46, y0 + 13);
      }

      // points
      for (const p of pts) {
        const x = env.timeToX(p.time);
        if (x < HEADER_W - 5 || x > cw + 5) continue;
        const y = autoValToY(param, p.value, L);
        const hot = drag && drag.mode === "autoPoint" && drag.point === p;
        g2.beginPath();
        g2.arc(x, y, hot ? 5 : 3.5, 0, Math.PI * 2);
        g2.fillStyle = hot ? "#fff" : t.color;
        g2.fill();
        g2.strokeStyle = "#0a0a0b";
        g2.stroke();
      }

      // lane header (left column)
      g2.fillStyle = theme.header;
      g2.fillRect(0, y0, HEADER_W, h);
      g2.strokeStyle = theme.border;
      g2.strokeRect(0.5, y0 + 0.5, HEADER_W - 1, h);
      g2.fillStyle = t.color;
      g2.fillRect(0, y0, 4, h);
      g2.fillStyle = theme.btnText;
      g2.font = "9px monospace";
      g2.fillText("AUTOMATION", 12, y0 + 13);
      g2.font = "10px monospace";
      for (const b of autoButtons(L)) {
        if (b.on) {
          g2.globalAlpha = 0.25;
          g2.fillStyle = t.color;
          g2.fillRect(b.x, b.y, b.w, b.h);
          g2.globalAlpha = 1;
        } else {
          g2.fillStyle = theme.btnBg;
          g2.fillRect(b.x, b.y, b.w, b.h);
        }
        g2.strokeStyle = b.on ? t.color : theme.btnBorder;
        g2.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
        g2.fillStyle = b.disabled ? theme.btnDisabled : b.on ? t.color : theme.btnText;
        g2.fillText(b.label, b.x + (b.w - b.label.length * 6) / 2, b.y + 12);
      }
    }

    return { AUTO_PAD, autoValToY, autoYToVal, autoButtons, drawAutoLane };
  }

  root.AutomationLaneUI = { create };
})(typeof globalThis !== "undefined" ? globalThis : this);
