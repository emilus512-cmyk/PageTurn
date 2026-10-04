/* ═══════════════════════════════════════════════════════════════════
   ABSOLUTE STUDIO X INFINITY OMEGA
   The timeline is god. The mixer is docked right. REC is top-left.
   Make records. Nothing else.
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

/* ───────────────────────── utils ───────────────────────── */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const db2lin = (db) => Math.pow(10, db / 20);
const lin2db = (v) => (v <= 0.0000316 ? -90 : 20 * Math.log10(v));

const TRACK_COLORS = ["#e05d4e", "#e0a04e", "#d4c84a", "#6fc95b", "#4ec9b0", "#4ea3e0", "#7d6fe0", "#c45ec9", "#e05e94", "#8a9aa8"];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove("show"), ms);
}

/* ───────────────────────── state ───────────────────────── */
const state = {
  name: "Untitled",
  bpm: 120,
  tsN: 4, tsD: 4,
  tracks: [],   // {id,name,type:'audio'|'midi',color,gainDb,pan,mute,solo,armed,monitor,lanes}
  clips: [],    // {id,trackId,start,duration,offset,bufferId,gainDb,fadeIn,fadeOut,lane,active,name,semi, notes?[{p,s,l,v}],lenBeats?}
  markers: [],  // {id,time,label,color}
  loop: { on: false, start: 0, end: 8 },
};

// view / transport (not undoable)
const view = {
  pxPerSec: 48, scrollX: 0, scrollY: 0,
  snap: true,
  playing: false, recording: false,
  playhead: 0, playStartPos: 0, playStartCtx: 0,
  selectedClips: new Set(), selectedTrack: null,
  dirty: true,
  prClipId: null, prScrollY: 420,
  metro: false,
  lastSave: 0,
};

const HEADER_W = 172, RULER_H = 30, ARR_H = 24, LANE_H = 64, LANE_H_MULTI = 44, AUTO_H = 58;

/* automation model helpers (core math lives in automation-core.js) */
function ensureAutoModel(t) {
  if (!t.automation) t.automation = emptyAutomation();
  for (const k of ["volume", "pan", "mute"]) if (!Array.isArray(t.automation[k])) t.automation[k] = [];
  if (!t.automation.effects) t.automation.effects = {};
  if (!t.autoLane) t.autoLane = { shown: false, param: "volume" };
  return t;
}
function autoPoints(t, param) { return ensureAutoModel(t).automation[param]; }
function autoBase(t, param) { return param === "volume" ? t.gainDb : param === "pan" ? t.pan : 0; }
const volMap = (db) => (db <= -59.5 ? 0 : db2lin(db));

// audio data registry: bufferId -> {sr, chans:[Float32Array,...]}  (raw, engine-agnostic)
const audioStore = new Map();
const peakCache = new Map();   // bufferId -> {bucket, min:F32, max:F32}
const abufCache = new Map();   // bufferId -> AudioBuffer (live ctx)

const undoStack = [], redoStack = [];
function snapshot() { return JSON.stringify({ bpm: state.bpm, tsN: state.tsN, tsD: state.tsD, tracks: state.tracks, clips: state.clips, markers: state.markers, loop: state.loop }); }
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}
function applySnap(s) {
  const o = JSON.parse(s);
  Object.assign(state, o);
  state.tracks.forEach(ensureAutoModel);
  view.selectedClips.clear();
  if (view.prClipId && !state.clips.find(c => c.id === view.prClipId)) closePianoRoll();
  applyTrackGains(); rescheduleAutomationLive(); rebuildMixer(); invalidate();
}
function undo() { if (!undoStack.length) return toast("Nothing to undo"); redoStack.push(snapshot()); applySnap(undoStack.pop()); toast("Undo"); }
function redo() { if (!redoStack.length) return toast("Nothing to redo"); undoStack.push(snapshot()); applySnap(redoStack.pop()); toast("Redo"); }

const spb = () => 60 / state.bpm;                 // seconds per beat
const barLen = () => spb() * state.tsN * (4 / state.tsD);
function snapTime(t, fine) {
  if (!view.snap) return Math.max(0, t);
  const g = fine ? spb() / 4 : spb();
  return Math.max(0, Math.round(t / g) * g);
}

/* ───────────────────────── audio engine ───────────────────────── */
let ctx = null, master = null;
const trackNodes = new Map(); // trackId -> {input,pan,gain,mute,analyser, meter:{peak,hold,clip}}
let activeSources = [];       // {stop()}
let metroTimer = null, metroNextBeat = 0;

function ensureCtx() {
  if (ctx) { if (ctx.state === "suspended") ctx.resume(); return ctx; }
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  master = {
    input: ctx.createGain(),
    limiter: ctx.createDynamicsCompressor(),
    gain: ctx.createGain(),
    analyser: ctx.createAnalyser(),
    meter: { peak: 0, hold: 0, clip: false },
    gainDb: 0,
  };
  master.limiter.threshold.value = -1;
  master.limiter.knee.value = 0;
  master.limiter.ratio.value = 20;
  master.limiter.attack.value = 0.002;
  master.limiter.release.value = 0.1;
  master.analyser.fftSize = 2048;
  master.input.connect(master.limiter).connect(master.gain).connect(master.analyser).connect(ctx.destination);
  $("stSr").textContent = ctx.sampleRate + " Hz";
  for (const t of state.tracks) ensureTrackNodes(t);
  return ctx;
}

function ensureTrackNodes(t) {
  if (!ctx || trackNodes.has(t.id)) return trackNodes.get(t.id);
  const n = {
    input: ctx.createGain(),
    pan: ctx.createStereoPanner(),
    autoPan: ctx.createStereoPanner(),   // automation-only
    gain: ctx.createGain(),
    autoVol: ctx.createGain(),           // automation-only
    autoMute: ctx.createGain(),          // automation-only
    mute: ctx.createGain(),
    analyser: ctx.createAnalyser(),
    meter: { peak: 0, hold: 0, clip: false },
  };
  n.analyser.fftSize = 1024;
  n.input.connect(n.pan).connect(n.autoPan).connect(n.gain).connect(n.autoVol)
    .connect(n.autoMute).connect(n.mute).connect(n.analyser).connect(master.input);
  trackNodes.set(t.id, n);
  applyTrackGains();
  return n;
}

const trySetParam = (p, v) => { try { p.value = v; } catch (e) { /* curve scheduled — engine owns it */ } };

function applyTrackGains() {
  if (!ctx) return;
  const anySolo = state.tracks.some(t => t.solo);
  const ph = view.playhead;
  for (const t of state.tracks) {
    const n = trackNodes.get(t.id);
    if (!n) continue;
    ensureAutoModel(t);
    const volPts = t.automation.volume, panPts = t.automation.pan, mutePts = t.automation.mute;

    // volume: with automation the lane owns the level (fader = base before 1st point)
    if (volPts.length) {
      n.gain.gain.value = 1;
      if (!view.playing) trySetParam(n.autoVol.gain, volMap(autoValue(volPts, ph, t.gainDb, false)));
    } else {
      n.gain.gain.value = db2lin(t.gainDb);
      trySetParam(n.autoVol.gain, 1);
    }
    // pan
    if (panPts.length) {
      n.pan.pan.value = 0;
      if (!view.playing) trySetParam(n.autoPan.pan, clamp(autoValue(panPts, ph, t.pan, false), -1, 1));
    } else {
      n.pan.pan.value = t.pan;
      trySetParam(n.autoPan.pan, 0);
    }
    // mute automation (1 = muted); manual mute stays independent on n.mute
    if (mutePts.length) {
      if (!view.playing) trySetParam(n.autoMute.gain, 1 - Math.round(autoValue(mutePts, ph, 0, true)));
    } else {
      trySetParam(n.autoMute.gain, 1);
    }
    const audible = !t.mute && (!anySolo || t.solo);
    n.mute.gain.value = audible ? 1 : 0;
  }
  if (master) master.gain.gain.value = db2lin(master.gainDb);
}

/* schedule automation curves on AudioParams — runs in the audio engine,
   independent of UI render; linear between curve samples ≙ our model */
const AUTO_CURVE_RATE = 200; // curve pts/sec (AudioParam interpolates linearly between)
function scheduleAutomation(nodes, t, fromPos, when, end) {
  ensureAutoModel(t);
  const dur = Math.max(0.5, end - fromPos);
  const N = Math.min(240000, Math.max(2, Math.ceil(dur * AUTO_CURVE_RATE)));
  const sched = (param, pts, base, step, map, clampLo, clampHi) => {
    if (!pts.length) return;
    const curve = autoCurve(pts, base, step, fromPos, dur, N, (v) => clamp(map(v), clampLo, clampHi));
    try {
      param.cancelScheduledValues(0);
      param.setValueCurveAtTime(curve, when, dur);
    } catch (e) { /* never block playback */ }
  };
  sched(nodes.autoVol.gain, t.automation.volume, t.gainDb, false, volMap, 0, 4);
  sched(nodes.autoPan.pan, t.automation.pan, t.pan, false, (v) => v, -1, 1);
  sched(nodes.autoMute.gain, t.automation.mute, 0, true, (v) => 1 - Math.round(v), 0, 1);
}

function lastAutomationTime() {
  let m = 0;
  for (const t of state.tracks) {
    if (!t.automation) continue;
    for (const k of ["volume", "pan", "mute"]) {
      const pts = t.automation[k];
      if (pts && pts.length) m = Math.max(m, pts[pts.length - 1].time);
    }
  }
  return m;
}

function scheduleAutomationAll(fromPos, when) {
  const end = Math.max(sessionLength(), lastAutomationTime() + 1, fromPos + 2);
  for (const t of state.tracks) {
    const n = trackNodes.get(t.id);
    if (n) scheduleAutomation(n, t, fromPos, when, end);
  }
}

function cancelAutomationAll() {
  if (!ctx) return;
  for (const [, n] of trackNodes) {
    for (const p of [n.autoVol.gain, n.autoPan.pan, n.autoMute.gain]) {
      try { p.cancelScheduledValues(0); } catch (e) {}
    }
  }
}

/* re-bake curves mid-playback after an automation edit (no transport hiccup) */
function rescheduleAutomationLive() {
  if (!ctx || !view.playing || view.recording) return;
  const fromPos = currentPos() + 0.06;
  const when = view.playStartCtx + (fromPos - view.playStartPos);
  const end = Math.max(sessionLength(), lastAutomationTime() + 1, fromPos + 2);
  for (const t of state.tracks) {
    const n = trackNodes.get(t.id);
    if (n) scheduleAutomation(n, t, fromPos, when, end);
  }
}

function getAudioBuffer(bufferId, forCtx) {
  const raw = audioStore.get(bufferId);
  if (!raw) return null;
  if (forCtx === ctx && abufCache.has(bufferId)) return abufCache.get(bufferId);
  const b = forCtx.createBuffer(raw.chans.length, raw.chans[0].length, raw.sr);
  raw.chans.forEach((ch, i) => b.copyToChannel(ch, i));
  if (forCtx === ctx) abufCache.set(bufferId, b);
  return b;
}

/* clip scheduling (shared between live playback and offline export) */
function scheduleClip(c, t, acx, destInput, fromPos, startCtxTime, sources) {
  if (!c.active) return;
  const rate = Math.pow(2, (c.semi || 0) / 12);
  const timelineDur = c.duration;
  const clipEnd = c.start + timelineDur;
  if (clipEnd <= fromPos + 0.001) return;

  const g = acx.createGain();
  g.connect(destInput);
  const base = db2lin(c.gainDb || 0);
  const offIntoClip = Math.max(0, fromPos - c.start);           // timeline seconds into clip
  const when = startCtxTime + Math.max(0, c.start - fromPos);
  const fi = (c.fadeIn || 0) / 1000, fo = (c.fadeOut || 0) / 1000;

  // envelope
  g.gain.setValueAtTime(0.0001, Math.max(0, when - 0.001));
  if (fi > 0 && offIntoClip < fi) {
    g.gain.setValueAtTime(base * (offIntoClip / fi || 0.0001), when);
    g.gain.linearRampToValueAtTime(base, when + (fi - offIntoClip));
  } else {
    g.gain.setValueAtTime(base, when);
  }
  if (fo > 0) {
    const foStartTl = timelineDur - fo;
    if (offIntoClip < timelineDur) {
      const t0 = when + Math.max(0, foStartTl - offIntoClip);
      g.gain.setValueAtTime(base, t0);
      g.gain.linearRampToValueAtTime(0.0001, when + (timelineDur - offIntoClip));
    }
  }

  if (t.type === "audio" && c.bufferId) {
    const buf = getAudioBuffer(c.bufferId, acx);
    if (!buf) return;
    const src = acx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(g);
    const srcOffset = (c.offset || 0) + offIntoClip * rate;
    const srcDur = (timelineDur - offIntoClip) * rate;
    if (srcDur <= 0) return;
    try { src.start(when, srcOffset, srcDur); } catch (e) { return; }
    sources.push({ stop: () => { try { src.stop(); } catch (e) {} g.disconnect(); } });
  } else if (t.type === "midi" && c.notes) {
    const sp = spb();
    for (const n of c.notes) {
      const ns = c.start + n.s * sp, ne = ns + n.l * sp;
      if (ne <= fromPos || ns >= clipEnd) continue;
      scheduleSynthNote(acx, g, n, Math.max(ns, fromPos), ne, fromPos, startCtxTime, sources, ns < fromPos);
    }
    sources.push({ stop: () => { try { g.disconnect(); } catch (e) {} } });
  }
}

function scheduleSynthNote(acx, dest, n, absStart, absEnd, fromPos, startCtxTime, sources, late) {
  if (late) return; // don't resume mid-note
  const when = startCtxTime + (absStart - fromPos);
  const dur = absEnd - absStart;
  const freq = 440 * Math.pow(2, (n.p - 69) / 12);
  const osc = acx.createOscillator();
  const osc2 = acx.createOscillator();
  const flt = acx.createBiquadFilter();
  const env = acx.createGain();
  osc.type = "sawtooth"; osc.frequency.value = freq;
  osc2.type = "square"; osc2.frequency.value = freq * 0.5; osc2.detune.value = 6;
  flt.type = "lowpass"; flt.frequency.value = Math.min(12000, freq * 7); flt.Q.value = 0.8;
  const vel = (n.v || 100) / 127 * 0.22;
  env.gain.setValueAtTime(0.0001, when);
  env.gain.linearRampToValueAtTime(vel, when + 0.006);
  env.gain.setTargetAtTime(vel * 0.72, when + 0.006, 0.12);
  env.gain.setTargetAtTime(0.0001, when + dur, 0.035);
  osc.connect(flt); osc2.connect(flt); flt.connect(env).connect(dest);
  osc.start(when); osc2.start(when);
  const stopAt = when + dur + 0.3;
  osc.stop(stopAt); osc2.stop(stopAt);
  sources.push({ stop: () => { try { osc.stop(); osc2.stop(); } catch (e) {} } });
}

function play(fromPos) {
  ensureCtx();
  stopAllSources();
  cancelAutomationAll();
  view.playStartPos = fromPos;
  view.playhead = fromPos;
  view.playStartCtx = ctx.currentTime + 0.08;
  for (const t of state.tracks) {
    ensureTrackNodes(t);
    const n = trackNodes.get(t.id);
    for (const c of state.clips.filter(c => c.trackId === t.id)) {
      scheduleClip(c, t, ctx, n.input, fromPos, view.playStartCtx, activeSources);
    }
  }
  view.playing = true;
  applyTrackGains();                       // neutralize base params under automation
  scheduleAutomationAll(fromPos, view.playStartCtx);
  $("btnPlay").classList.add("playing");
  startMetronome(fromPos);
  invalidate();
}

function stopPlayback(returnToStart = true) {
  stopAllSources();
  stopMetronome();
  cancelAutomationAll();
  if (view.playing && returnToStart && !view.recording) view.playhead = view.playStartPos;
  view.playing = false;
  applyTrackGains();                       // park params at playhead's automated values
  $("btnPlay").classList.remove("playing");
  invalidate();
}

function stopAllSources() {
  for (const s of activeSources) s.stop();
  activeSources = [];
}

function currentPos() {
  if (!view.playing || !ctx) return view.playhead;
  return Math.max(view.playStartPos, view.playStartPos + (ctx.currentTime - view.playStartCtx));
}

/* metronome: lookahead scheduler */
function startMetronome(fromPos) {
  if (!view.metro) return;
  metroNextBeat = Math.ceil(fromPos / spb() - 0.0001);
  metroTimer = setInterval(() => {
    const horizon = ctx.currentTime + 0.12;
    while (true) {
      const beatTime = view.playStartCtx + (metroNextBeat * spb() - view.playStartPos);
      if (beatTime > horizon) break;
      if (beatTime >= ctx.currentTime - 0.02) {
        const isBar = metroNextBeat % state.tsN === 0;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = isBar ? 1568 : 1046;
        g.gain.setValueAtTime(0.0001, beatTime);
        g.gain.linearRampToValueAtTime(isBar ? 0.5 : 0.3, beatTime + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, beatTime + 0.06);
        o.connect(g).connect(master.gain);
        o.start(beatTime); o.stop(beatTime + 0.08);
      }
      metroNextBeat++;
    }
  }, 30);
}
function stopMetronome() { if (metroTimer) { clearInterval(metroTimer); metroTimer = null; } }

/* ───────────────────────── recording ───────────────────────── */
let mediaStream = null, recNode = null, recSrc = null, monitorGain = null;
let recChunks = [], recStartPos = 0, recTrackId = null;

async function getMic() {
  if (mediaStream) return mediaStream;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  return mediaStream;
}

async function toggleRecord() {
  if (view.recording) { stopRecord(); return; }
  let track = state.tracks.find(t => t.armed);
  if (!track) {
    track = state.tracks.find(t => t.id === view.selectedTrack && t.type === "audio");
    if (!track) track = state.tracks.find(t => t.type === "audio");
    if (!track) track = addTrack("audio", false);
    track.armed = true;
    rebuildMixer();
  }
  if (track.type !== "audio") { toast("Arm an AUDIO track to record (MIDI: draw in piano roll)"); return; }
  ensureCtx();
  try { await getMic(); } catch (e) {
    toast("Microphone unavailable — check browser permission (open preview in its own tab if blocked)");
    return;
  }
  recSrc = ctx.createMediaStreamSource(mediaStream);
  recNode = ctx.createScriptProcessor(4096, 1, 1);
  recChunks = [];
  recNode.onaudioprocess = (e) => {
    if (!view.recording) return;
    recChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  const sink = ctx.createGain(); sink.gain.value = 0;
  recSrc.connect(recNode); recNode.connect(sink); sink.connect(ctx.destination);
  if (track.monitor) {
    monitorGain = ctx.createGain(); monitorGain.gain.value = 1;
    recSrc.connect(monitorGain).connect(ensureTrackNodes(track).input);
  }
  recTrackId = track.id;
  recStartPos = view.playhead;
  view.recording = true;
  $("btnRec").classList.add("recording");
  play(recStartPos);
  toast("● RECORDING — " + track.name);
}

function stopRecord() {
  view.recording = false;
  $("btnRec").classList.remove("recording");
  if (recNode) { recNode.disconnect(); recNode.onaudioprocess = null; recNode = null; }
  if (recSrc) { try { recSrc.disconnect(); } catch (e) {} recSrc = null; }
  if (monitorGain) { try { monitorGain.disconnect(); } catch (e) {} monitorGain = null; }
  stopPlayback(false);

  const total = recChunks.reduce((a, c) => a + c.length, 0);
  if (total < ctx.sampleRate * 0.05) { toast("Take discarded (too short)"); recChunks = []; return; }
  const data = new Float32Array(total);
  let off = 0;
  for (const c of recChunks) { data.set(c, off); off += c.length; }
  recChunks = [];

  const bufferId = uid();
  audioStore.set(bufferId, { sr: ctx.sampleRate, chans: [data] });
  saveAudioToDb(bufferId);

  pushUndo();
  const track = state.tracks.find(t => t.id === recTrackId);
  const dur = total / ctx.sampleRate;
  const takeNum = state.clips.filter(c => c.trackId === recTrackId).length + 1;
  const clip = {
    id: uid(), trackId: recTrackId, start: recStartPos, duration: dur, offset: 0,
    bufferId, gainDb: 0, fadeIn: 5, fadeOut: 10, lane: 0, active: true,
    name: "Take " + takeNum, semi: 0,
  };
  // unlimited takes: stack — new take on lane 0, overlapping previous takes drop a lane & mute
  for (const c of state.clips.filter(c => c.trackId === recTrackId)) {
    if (c.start < clip.start + clip.duration && clip.start < c.start + c.duration) {
      c.lane += 1;
      c.active = false;
    }
  }
  state.clips.push(clip);
  track.lanes = Math.max(1, ...state.clips.filter(c => c.trackId === recTrackId).map(c => c.lane + 1));
  view.playhead = recStartPos + dur;
  selectOnly(clip.id);
  invalidate();
  saveSession(true);
  toast("Take saved — " + dur.toFixed(1) + "s (" + clip.name + ")");
}

/* ───────────────────────── tracks & clips ───────────────────────── */
function addTrack(type, withUndo = true) {
  if (withUndo) pushUndo();
  const n = state.tracks.length;
  const t = {
    id: uid(),
    name: (type === "audio" ? "Audio " : "Inst ") + (n + 1),
    type, color: TRACK_COLORS[n % TRACK_COLORS.length],
    gainDb: 0, pan: 0, mute: false, solo: false, armed: false, monitor: false, lanes: 1,
    automation: emptyAutomation(),
    autoLane: { shown: false, param: "volume" },
  };
  state.tracks.push(t);
  view.selectedTrack = t.id;
  if (ctx) ensureTrackNodes(t);
  rebuildMixer(); invalidate();
  return t;
}

function deleteTrack(tid) {
  pushUndo();
  state.clips = state.clips.filter(c => c.trackId !== tid);
  state.tracks = state.tracks.filter(t => t.id !== tid);
  if (view.selectedTrack === tid) view.selectedTrack = state.tracks[0]?.id || null;
  rebuildMixer(); invalidate();
}

function selectOnly(clipId) {
  view.selectedClips.clear();
  if (clipId) {
    view.selectedClips.add(clipId);
    const c = state.clips.find(c => c.id === clipId);
    if (c) view.selectedTrack = c.trackId;
  }
  invalidate();
}

function activateTake(clip) {
  // comping: clicking an inactive take makes it the audible one
  for (const c of state.clips.filter(c => c.trackId === clip.trackId && c !== clip)) {
    if (c.start < clip.start + clip.duration && clip.start < c.start + c.duration) c.active = false;
  }
  clip.active = true;
}

function duplicateSelection() {
  if (!view.selectedClips.size) return;
  pushUndo();
  const newIds = [];
  for (const id of view.selectedClips) {
    const c = state.clips.find(c => c.id === id);
    if (!c) continue;
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = uid();
    copy.start = c.start + c.duration;
    if (copy.notes) copy.notes = c.notes.map(n => ({ ...n }));
    state.clips.push(copy);
    newIds.push(copy.id);
  }
  view.selectedClips = new Set(newIds);
  invalidate();
  toast("Duplicated");
}

function deleteSelection() {
  if (!view.selectedClips.size) return;
  pushUndo();
  state.clips = state.clips.filter(c => !view.selectedClips.has(c.id));
  for (const t of state.tracks) {
    t.lanes = Math.max(1, ...state.clips.filter(c => c.trackId === t.id).map(c => c.lane + 1), 1);
  }
  view.selectedClips.clear();
  if (view.prClipId && !state.clips.find(c => c.id === view.prClipId)) closePianoRoll();
  invalidate();
}

function splitSelection() {
  const pos = view.playhead;
  const targets = state.clips.filter(c => view.selectedClips.has(c.id) && pos > c.start + 0.01 && pos < c.start + c.duration - 0.01);
  if (!targets.length) return toast("Playhead must be inside a selected clip");
  pushUndo();
  for (const c of targets) {
    const rate = Math.pow(2, (c.semi || 0) / 12);
    const left = pos - c.start;
    const right = JSON.parse(JSON.stringify(c));
    right.id = uid();
    right.start = pos;
    right.duration = c.duration - left;
    right.fadeIn = 10;
    if (c.bufferId) right.offset = (c.offset || 0) + left * rate;
    if (c.notes) {
      const sp = spb(), cutBeats = left / sp;
      right.notes = c.notes.filter(n => n.s >= cutBeats).map(n => ({ ...n, s: n.s - cutBeats }));
      c.notes = c.notes.filter(n => n.s < cutBeats);
      right.lenBeats = (c.lenBeats || 0) - cutBeats;
      c.lenBeats = cutBeats;
    }
    c.duration = left;
    c.fadeOut = Math.min(c.fadeOut, 10);
    state.clips.push(right);
  }
  invalidate();
  toast("Split");
}

function trimToPlayhead(end) {
  const pos = view.playhead;
  const targets = state.clips.filter(c => view.selectedClips.has(c.id) && pos > c.start && pos < c.start + c.duration);
  if (!targets.length) return;
  pushUndo();
  for (const c of targets) {
    const rate = Math.pow(2, (c.semi || 0) / 12);
    if (end) {
      c.duration = pos - c.start;
    } else {
      const d = pos - c.start;
      if (c.bufferId) c.offset = (c.offset || 0) + d * rate;
      if (c.notes) { const sp = spb(); c.notes = c.notes.filter(n => n.s * sp >= d).map(n => ({ ...n, s: n.s - d / sp })); }
      c.start = pos; c.duration -= d;
    }
  }
  invalidate();
}

function nudgeSelection(dir, fine) {
  if (!view.selectedClips.size) return;
  pushUndo();
  const step = (fine ? spb() / 4 : spb()) * dir;
  for (const id of view.selectedClips) {
    const c = state.clips.find(c => c.id === id);
    if (c) c.start = Math.max(0, c.start + step);
  }
  invalidate();
}

/* ───────────────────────── waveform peaks ───────────────────────── */
function getPeaks(bufferId) {
  if (peakCache.has(bufferId)) return peakCache.get(bufferId);
  const raw = audioStore.get(bufferId);
  if (!raw) return null;
  const data = raw.chans[0];
  const bucket = 256;
  const n = Math.ceil(data.length / bucket);
  const min = new Float32Array(n), max = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let mn = 1e9, mx = -1e9;
    const s = i * bucket, e = Math.min(data.length, s + bucket);
    for (let j = s; j < e; j++) { const v = data[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
    min[i] = mn; max[i] = mx;
  }
  const p = { bucket, min, max, sr: raw.sr };
  peakCache.set(bufferId, p);
  return p;
}

/* ───────────────────────── timeline canvas ───────────────────────── */
const cv = $("timeline"), g2 = cv.getContext("2d");
let cw = 0, chh = 0, dpr = 1;
let layout = []; // [{track,y,h,laneH}]

function invalidate() { view.dirty = true; }

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  cw = r.width; chh = r.height;
  cv.width = Math.round(cw * dpr); cv.height = Math.round(chh * dpr);
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  invalidate();
}
new ResizeObserver(resizeCanvas).observe(cv);

const timeToX = (t) => HEADER_W + t * view.pxPerSec - view.scrollX;
const xToTime = (x) => (x - HEADER_W + view.scrollX) / view.pxPerSec;

function computeLayout() {
  layout = [];
  let y = RULER_H + ARR_H - view.scrollY;
  for (const t of state.tracks) {
    const laneH = t.lanes > 1 ? LANE_H_MULTI : LANE_H;
    const h = laneH * t.lanes;
    const autoShown = !!(t.autoLane && t.autoLane.shown);
    layout.push({ track: t, y, h, laneH, autoShown, autoY: y + h + 1, autoH: autoShown ? AUTO_H : 0 });
    y += h + 1 + (autoShown ? AUTO_H + 1 : 0);
  }
  return y + view.scrollY; // content bottom
}

function drawTimeline() {
  computeLayout();
  g2.fillStyle = "#0a0a0b";
  g2.fillRect(0, 0, cw, chh);

  const t0 = Math.max(0, xToTime(HEADER_W)), t1 = xToTime(cw);
  const beat = spb(), bar = barLen();

  // ── grid (under everything in track area) ──
  const gridTop = RULER_H + ARR_H;
  let beatPx = beat * view.pxPerSec;
  const showBeats = beatPx > 7;
  for (let b = Math.floor(t0 / beat); b * beat < t1; b++) {
    const t = b * beat;
    const x = timeToX(t);
    if (x < HEADER_W) continue;
    const isBar = Math.abs(t % bar) < 0.0001 || bar - (t % bar) < 0.0001;
    if (!isBar && !showBeats) continue;
    g2.strokeStyle = isBar ? "#232329" : "#151518";
    g2.beginPath(); g2.moveTo(x + 0.5, gridTop); g2.lineTo(x + 0.5, chh); g2.stroke();
  }

  // ── loop region ──
  if (state.loop.on) {
    const x1 = timeToX(state.loop.start), x2 = timeToX(state.loop.end);
    g2.fillStyle = "rgba(10,132,255,0.07)";
    g2.fillRect(Math.max(HEADER_W, x1), gridTop, x2 - Math.max(HEADER_W, x1), chh - gridTop);
  }

  // ── tracks ──
  for (const L of layout) {
    if (L.y + L.h < gridTop || L.y > chh) continue;
    const t = L.track;
    const selected = t.id === view.selectedTrack;
    // lane row bg
    g2.fillStyle = selected ? "#101016" : "#0c0c0e";
    g2.fillRect(HEADER_W, Math.max(gridTop, L.y), cw - HEADER_W, L.h);
    g2.strokeStyle = "#1a1a1f";
    g2.beginPath(); g2.moveTo(HEADER_W, L.y + L.h + 0.5); g2.lineTo(cw, L.y + L.h + 0.5); g2.stroke();

    // clips
    for (const c of state.clips) {
      if (c.trackId !== t.id) continue;
      drawClip(c, t, L);
    }

    // automation lane (lives on the timeline, right under the clips)
    if (L.autoShown && L.autoY + L.autoH > gridTop && L.autoY < chh) drawAutoLane(L);

    // header
    drawTrackHeader(t, L, selected);
  }

  // empty hint
  if (!state.tracks.length) {
    g2.fillStyle = "#3a3a42";
    g2.font = "14px monospace";
    g2.textAlign = "center";
    g2.fillText("Ctrl+T — new audio track · Ctrl+M — new MIDI track · drop audio files here", (cw + HEADER_W) / 2, (chh + gridTop) / 2);
    g2.textAlign = "left";
  }

  // ── arranger lane ──
  g2.fillStyle = "#0e0e11";
  g2.fillRect(0, RULER_H, cw, ARR_H);
  g2.strokeStyle = "#232329";
  g2.beginPath(); g2.moveTo(0, RULER_H + ARR_H + 0.5); g2.lineTo(cw, RULER_H + ARR_H + 0.5); g2.stroke();
  const sorted = [...state.markers].sort((a, b) => a.time - b.time);
  g2.font = "10px monospace";
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    const x = timeToX(m.time);
    const nx = i + 1 < sorted.length ? timeToX(sorted[i + 1].time) : cw + 20;
    if (nx < HEADER_W || x > cw) continue;
    g2.fillStyle = m.color + "2e";
    g2.fillRect(Math.max(HEADER_W, x), RULER_H + 1, nx - Math.max(HEADER_W, x) - 1, ARR_H - 2);
    g2.fillStyle = m.color;
    g2.fillRect(Math.max(HEADER_W, x), RULER_H + 1, 2, ARR_H - 2);
    g2.fillText(m.label, Math.max(HEADER_W, x) + 6, RULER_H + 16);
  }
  g2.fillStyle = "#0e0e11"; g2.fillRect(0, RULER_H, HEADER_W, ARR_H);
  g2.fillStyle = "#55555e"; g2.fillText("ARRANGER", 10, RULER_H + 16);

  // ── ruler ──
  g2.fillStyle = "#101014";
  g2.fillRect(0, 0, cw, RULER_H);
  g2.strokeStyle = "#232329";
  g2.beginPath(); g2.moveTo(0, RULER_H + 0.5); g2.lineTo(cw, RULER_H + 0.5); g2.stroke();
  if (state.loop.on) {
    const x1 = timeToX(state.loop.start), x2 = timeToX(state.loop.end);
    g2.fillStyle = "rgba(10,132,255,0.35)";
    g2.fillRect(Math.max(HEADER_W, x1), 2, x2 - Math.max(HEADER_W, x1), 6);
  }
  g2.fillStyle = "#6a6a74"; g2.font = "10px monospace";
  const barPx = bar * view.pxPerSec;
  const barStep = barPx > 44 ? 1 : barPx > 22 ? 2 : barPx > 11 ? 4 : 8;
  for (let bn = Math.floor(t0 / bar); bn * bar < t1; bn++) {
    const x = timeToX(bn * bar);
    if (x < HEADER_W) continue;
    g2.strokeStyle = "#2e2e36";
    g2.beginPath(); g2.moveTo(x + 0.5, bn % barStep === 0 ? 12 : 22); g2.lineTo(x + 0.5, RULER_H); g2.stroke();
    if (bn % barStep === 0) g2.fillText(String(bn + 1), x + 4, 21);
  }
  g2.fillStyle = "#101014"; g2.fillRect(0, 0, HEADER_W, RULER_H);
  g2.fillStyle = "#44444c"; g2.font = "9px monospace";
  g2.fillText("ABSOLUTE STUDIO X", 10, 19);

  // ── playhead ──
  const px = timeToX(view.playhead);
  if (px >= HEADER_W - 1) {
    g2.strokeStyle = view.recording ? "#ff3b30" : "#e8e8ec";
    g2.lineWidth = 1;
    g2.beginPath(); g2.moveTo(px + 0.5, 0); g2.lineTo(px + 0.5, chh); g2.stroke();
    g2.fillStyle = view.recording ? "#ff3b30" : "#e8e8ec";
    g2.beginPath(); g2.moveTo(px - 5, 0); g2.lineTo(px + 6, 0); g2.lineTo(px + 0.5, 9); g2.closePath(); g2.fill();
  }
}

function drawClip(c, t, L) {
  const x = timeToX(c.start);
  const w = Math.max(3, c.duration * view.pxPerSec);
  if (x + w < HEADER_W || x > cw) return;
  const laneY = L.y + c.lane * L.laneH;
  const h = L.laneH - 3;
  if (laneY + h < RULER_H + ARR_H || laneY > chh) return;

  const sel = view.selectedClips.has(c.id);
  const alpha = c.active ? 1 : 0.32;
  g2.save();
  g2.globalAlpha = alpha;
  g2.beginPath();
  const rx = Math.max(HEADER_W, x);
  const rw = Math.min(x + w, cw) - rx;
  g2.rect(rx, laneY + 1, rw, h);
  g2.clip();

  // body
  g2.fillStyle = sel ? shade(t.color, 0.55) : shade(t.color, 0.3);
  g2.fillRect(x, laneY + 1, w, h);
  g2.fillStyle = shade(t.color, 0.75);
  g2.fillRect(x, laneY + 1, w, 13);

  // waveform
  if (t.type === "audio" && c.bufferId) {
    const p = getPeaks(c.bufferId);
    if (p) {
      const rate = Math.pow(2, (c.semi || 0) / 12);
      g2.strokeStyle = sel ? "#ffffff" : shade(t.color, 1.25);
      g2.beginPath();
      const mid = laneY + 14 + (h - 14) / 2;
      const amp = (h - 16) / 2 * db2lin(Math.min(12, c.gainDb || 0));
      const px0 = Math.max(rx, x), px1 = Math.min(x + w, cw);
      for (let sx = Math.floor(px0); sx <= px1; sx++) {
        const tl = (sx - x) / view.pxPerSec;            // timeline sec into clip
        const srcSec = (c.offset || 0) + tl * rate;
        const bi = Math.floor(srcSec * p.sr / p.bucket);
        if (bi < 0 || bi >= p.min.length) continue;
        g2.moveTo(sx + 0.5, mid + p.min[bi] * amp);
        g2.lineTo(sx + 0.5, mid + Math.max(p.max[bi] * amp, p.min[bi] * amp + 1));
      }
      g2.stroke();
    }
  } else if (t.type === "midi" && c.notes) {
    // mini note preview
    g2.fillStyle = sel ? "#fff" : shade(t.color, 1.3);
    const sp = spb();
    let pmin = 127, pmax = 0;
    for (const n of c.notes) { pmin = Math.min(pmin, n.p); pmax = Math.max(pmax, n.p); }
    if (pmin > pmax) { pmin = 48; pmax = 72; }
    const span = Math.max(12, pmax - pmin + 1);
    for (const n of c.notes) {
      const nx = x + n.s * sp * view.pxPerSec;
      const nw = Math.max(2, n.l * sp * view.pxPerSec - 1);
      const ny = laneY + 15 + (1 - (n.p - pmin + 0.5) / span) * (h - 18);
      g2.fillRect(nx, ny, nw, 2.5);
    }
  }

  // fades
  const fiW = (c.fadeIn || 0) / 1000 * view.pxPerSec;
  const foW = (c.fadeOut || 0) / 1000 * view.pxPerSec;
  g2.strokeStyle = "rgba(255,255,255,0.5)";
  if (fiW > 1) { g2.beginPath(); g2.moveTo(x, laneY + h); g2.lineTo(x + fiW, laneY + 2); g2.stroke(); }
  if (foW > 1) { g2.beginPath(); g2.moveTo(x + w - foW, laneY + 2); g2.lineTo(x + w, laneY + h); g2.stroke(); }

  // label
  g2.fillStyle = sel ? "#000" : "rgba(0,0,0,0.75)";
  g2.font = "10px monospace";
  let label = c.name || "";
  if (c.semi) label += "  ♪" + (c.semi > 0 ? "+" : "") + c.semi;
  if (c.gainDb) label += "  " + (c.gainDb > 0 ? "+" : "") + c.gainDb.toFixed(1) + "dB";
  g2.fillText(label, Math.max(rx, x) + 5, laneY + 11);
  g2.restore();

  // selection border
  if (sel) {
    g2.strokeStyle = "#fff";
    g2.lineWidth = 1;
    g2.strokeRect(rx + 0.5, laneY + 1.5, rw - 1, h - 1);
    g2.lineWidth = 1;
  }
}

/* ── automation lane drawing ── */
const AUTO_PAD = 7;
function autoValToY(param, v, L) {
  const r = AUTO_RANGES[param];
  return L.autoY + AUTO_PAD + (1 - (v - r.min) / (r.max - r.min)) * (L.autoH - 2 * AUTO_PAD);
}
function autoYToVal(param, y, L) {
  const r = AUTO_RANGES[param];
  const f = 1 - clamp((y - (L.autoY + AUTO_PAD)) / (L.autoH - 2 * AUTO_PAD), 0, 1);
  return autoClampValue(param, r.min + f * (r.max - r.min));
}

function drawAutoLane(L) {
  const t = L.track, param = t.autoLane.param;
  const y0 = L.autoY, h = L.autoH;
  const r = AUTO_RANGES[param];
  const pts = autoPoints(t, param);
  const base = autoBase(t, param);

  // lane bg
  g2.fillStyle = "#0b0d11";
  g2.fillRect(HEADER_W, y0, cw - HEADER_W, h);
  g2.strokeStyle = "#1e1e24";
  g2.beginPath(); g2.moveTo(HEADER_W, y0 + h + 0.5); g2.lineTo(cw, y0 + h + 0.5); g2.stroke();

  // reference lines + axis labels
  g2.font = "8px monospace";
  const refs = param === "volume" ? [{ v: 12, l: "+12" }, { v: 0, l: "0dB" }, { v: -60, l: "-inf" }]
    : param === "pan" ? [{ v: 1, l: "R100" }, { v: 0, l: "C" }, { v: -1, l: "L100" }]
    : [{ v: 1, l: "MUTE" }, { v: 0, l: "PLAY" }];
  for (const rf of refs) {
    const y = autoValToY(param, rf.v, L);
    g2.strokeStyle = rf.v === 0 && param !== "mute" ? "#2b2b33" : "#1a1a20";
    g2.beginPath(); g2.moveTo(HEADER_W, y + 0.5); g2.lineTo(cw, y + 0.5); g2.stroke();
    g2.fillStyle = "#4a4a54";
    g2.fillText(rf.l, HEADER_W + 4, y - 1 < y0 + 8 ? y + 8 : y - 2);
  }

  // curve (base before first point → dashed look when empty)
  const step = !!r.step;
  g2.strokeStyle = t.color;
  g2.lineWidth = 1.5;
  if (!pts.length) g2.setLineDash([4, 4]);
  g2.beginPath();
  let first = true;
  for (let sx = HEADER_W; sx <= cw; sx += 2) {
    const v = autoClampValue(param, autoValue(pts, Math.max(0, xToTime(sx)), base, step));
    const y = autoValToY(param, v, L);
    if (first) { g2.moveTo(sx, y); first = false; } else g2.lineTo(sx, y);
  }
  g2.stroke();
  g2.setLineDash([]);
  g2.lineWidth = 1;

  // points
  for (const p of pts) {
    const x = timeToX(p.time);
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

  // lane header (left of timeline)
  g2.fillStyle = "#0f1016";
  g2.fillRect(0, y0, HEADER_W, h);
  g2.strokeStyle = "#232329";
  g2.strokeRect(0.5, y0 + 0.5, HEADER_W - 1, h);
  g2.fillStyle = t.color;
  g2.fillRect(0, y0, 4, h);
  g2.fillStyle = "#55555e";
  g2.font = "9px monospace";
  g2.fillText("AUTOMATION", 12, y0 + 13);
  g2.font = "10px monospace";
  for (const b of autoButtons(L)) {
    const dis = b.disabled;
    g2.fillStyle = b.on ? t.color + "" : "#1b1b20";
    if (b.on) { g2.globalAlpha = 0.25; g2.fillRect(b.x, b.y, b.w, b.h); g2.globalAlpha = 1; }
    else g2.fillRect(b.x, b.y, b.w, b.h);
    g2.strokeStyle = b.on ? t.color : "#2e2e36";
    g2.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
    g2.fillStyle = dis ? "#3a3a42" : b.on ? t.color : "#76767e";
    g2.fillText(b.label, b.x + (b.w - b.label.length * 6) / 2, b.y + 12);
  }
}

function autoButtons(L) {
  const y = L.autoY + L.autoH - 23;
  const t = L.track;
  const param = t.autoLane.param;
  return [
    { label: "VOL", param: "volume", on: param === "volume", x: 12, y, w: 32, h: 16 },
    { label: "PAN", param: "pan", on: param === "pan", x: 48, y, w: 32, h: 16 },
    { label: "MUTE", param: "mute", on: param === "mute", x: 84, y, w: 36, h: 16 },
    { label: "FX", param: "fx", on: false, disabled: true, x: 124, y, w: 24, h: 16 },
    { label: "×", act: "close", x: HEADER_W - 22, y: L.autoY + 4, w: 15, h: 14 },
  ];
}

function drawTrackHeader(t, L, selected) {
  const y = L.y;
  if (y + L.h < RULER_H + ARR_H - 1) return;
  g2.fillStyle = selected ? "#191922" : "#121216";
  g2.fillRect(0, y, HEADER_W, L.h);
  g2.strokeStyle = "#232329";
  g2.strokeRect(0.5, y + 0.5, HEADER_W - 1, L.h);
  g2.fillStyle = t.color;
  g2.fillRect(0, y, 4, L.h);

  g2.fillStyle = "#d8d8dc";
  g2.font = "11px monospace";
  const idx = state.tracks.indexOf(t) + 1;
  g2.fillText((idx <= 9 ? idx + " " : "") + t.name, 12, y + 15);
  g2.fillStyle = "#55555e";
  g2.font = "9px monospace";
  g2.fillText(t.type.toUpperCase() + (t.lanes > 1 ? " · " + state.clips.filter(c => c.trackId === t.id).length + " TAKES" : ""), 12, y + 28);

  // buttons: R M S I
  const btns = headerButtons(t, L);
  g2.font = "10px monospace";
  for (const b of btns) {
    g2.fillStyle = b.on ? b.onColor + "33" : "#1b1b20";
    g2.fillRect(b.x, b.y, b.w, b.h);
    g2.strokeStyle = b.on ? b.onColor : "#2e2e36";
    g2.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
    g2.fillStyle = b.on ? b.onColor : "#76767e";
    g2.fillText(b.label, b.x + 6, b.y + 12);
  }
}

function headerButtons(t, L) {
  const by = L.y + L.h - 22;
  const defs = [
    { label: "R", on: t.armed, onColor: "#ff3b30", key: "arm" },
    { label: "M", on: t.mute, onColor: "#ffd60a", key: "mute" },
    { label: "S", on: t.solo, onColor: "#30d158", key: "solo" },
    { label: "I", on: t.monitor, onColor: "#0a84ff", key: "monitor" },
  ];
  return defs.map((d, i) => ({ ...d, x: 12 + i * 26, y: by, w: 20, h: 16, track: t }));
}

function shade(hex, f) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const m = (v) => clamp(Math.round(v * f), 0, 255);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

/* ───────────────────────── timeline interaction ───────────────────────── */
let drag = null;

function hitTest(mx, my) {
  if (my < RULER_H) return { zone: "ruler" };
  if (my < RULER_H + ARR_H) {
    if (mx > HEADER_W) {
      const sorted = [...state.markers].sort((a, b) => a.time - b.time);
      for (const m of sorted) {
        const x = timeToX(m.time);
        if (mx >= x - 4 && mx <= x + 60) return { zone: "marker", marker: m };
      }
    }
    return { zone: "arranger" };
  }
  for (const L of layout) {
    // automation lane region
    if (L.autoShown && my >= L.autoY && my < L.autoY + L.autoH) {
      if (mx < HEADER_W) {
        for (const b of autoButtons(L)) {
          if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return { zone: "autoBtn", btn: b, track: L.track, L };
        }
        return { zone: "autoHeader", track: L.track, L };
      }
      const param = L.track.autoLane.param;
      const pts = autoPoints(L.track, param);
      for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        const px = timeToX(p.time), py = autoValToY(param, p.value, L);
        if ((mx - px) * (mx - px) + (my - py) * (my - py) <= 49) return { zone: "autoPoint", point: p, param, track: L.track, L };
      }
      return { zone: "autoLane", param, track: L.track, L };
    }
    if (my < L.y || my >= L.y + L.h) continue;
    if (mx < HEADER_W) {
      for (const b of headerButtons(L.track, L)) {
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return { zone: "hbtn", btn: b, track: L.track };
      }
      return { zone: "header", track: L.track };
    }
    const lane = Math.floor((my - L.y) / L.laneH);
    // topmost (last drawn ~ later in array) clip wins
    const cands = state.clips.filter(c => c.trackId === L.track.id && c.lane === lane);
    for (let i = cands.length - 1; i >= 0; i--) {
      const c = cands[i];
      const x = timeToX(c.start), w = Math.max(3, c.duration * view.pxPerSec);
      if (mx >= x && mx <= x + w) {
        const edge = Math.min(8, w / 4);
        if (mx <= x + edge) return { zone: "clipL", clip: c, track: L.track, L };
        if (mx >= x + w - edge) return { zone: "clipR", clip: c, track: L.track, L };
        return { zone: "clip", clip: c, track: L.track, L };
      }
    }
    return { zone: "lane", track: L.track, lane, L };
  }
  return { zone: "void" };
}

cv.addEventListener("pointerdown", (e) => {
  ensureCtx();
  cv.focus();
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const hit = hitTest(mx, my);
  cv.setPointerCapture(e.pointerId);

  if (hit.zone === "ruler") {
    if (e.shiftKey || my < 10) {
      const t = snapTime(xToTime(mx));
      drag = { mode: "loop", anchor: t };
      state.loop.start = t; state.loop.end = t; state.loop.on = true;
      $("btnLoop").classList.add("on");
    } else {
      drag = { mode: "scrub" };
      setPlayhead(snapTime(xToTime(mx), e.altKey));
    }
  } else if (hit.zone === "marker") {
    if (e.button === 2) {
      pushUndo();
      state.markers = state.markers.filter(m => m !== hit.marker);
    } else {
      drag = { mode: "marker", marker: hit.marker, undoPushed: false };
      setPlayhead(hit.marker.time);
    }
  } else if (hit.zone === "arranger" && mx > HEADER_W) {
    // click empty arranger = jump
    setPlayhead(snapTime(xToTime(mx)));
  } else if (hit.zone === "autoBtn") {
    if (hit.btn.disabled) { toast("FX wet/dry: no effects on this track yet (model ready)"); return; }
    if (hit.btn.act === "close") hit.track.autoLane.shown = false;
    else hit.track.autoLane.param = hit.btn.param;
    invalidate();
  } else if (hit.zone === "autoHeader") {
    view.selectedTrack = hit.track.id;
    rebuildMixer(); invalidate();
  } else if (hit.zone === "autoPoint") {
    view.selectedTrack = hit.track.id;
    if (e.button === 2 || e.detail === 2) {
      // delete point
      pushUndo();
      const arr = autoPoints(hit.track, hit.param);
      const i = arr.indexOf(hit.point);
      if (i >= 0) arr.splice(i, 1);
      applyTrackGains(); rescheduleAutomationLive(); invalidate();
      drag = null;
      return;
    }
    drag = {
      mode: "autoPoint", track: hit.track, param: hit.param, point: hit.point, L: hit.L,
      undoPushed: false, lock: null, pressX: mx, pressY: my,
      orig: { time: hit.point.time, value: hit.point.value },
    };
    invalidate();
  } else if (hit.zone === "autoLane") {
    view.selectedTrack = hit.track.id;
    if (e.button === 2) return;
    // click on the line = add a point (then drag it)
    pushUndo();
    const time = e.altKey ? Math.max(0, xToTime(mx)) : snapTime(xToTime(mx));
    const value = autoYToVal(hit.param, my, hit.L);
    const p = autoInsert(autoPoints(hit.track, hit.param), { id: uid(), time, value });
    drag = {
      mode: "autoPoint", track: hit.track, param: hit.param, point: p, L: hit.L,
      undoPushed: true, lock: null, pressX: mx, pressY: my,
      orig: { time: p.time, value: p.value },
    };
    applyTrackGains(); invalidate();
  } else if (hit.zone === "hbtn") {
    toggleHeaderBtn(hit.btn.key, hit.track);
  } else if (hit.zone === "header") {
    view.selectedTrack = hit.track.id;
    if (e.detail === 2) {
      const name = prompt("Track name:", hit.track.name);
      if (name) { pushUndo(); hit.track.name = name; rebuildMixer(); }
    }
    if (e.button === 2) {
      if (confirm("Delete track \"" + hit.track.name + "\"?")) deleteTrack(hit.track.id);
    }
    rebuildMixer(); invalidate();
  } else if (hit.zone === "clip" || hit.zone === "clipL" || hit.zone === "clipR") {
    const c = hit.clip;
    if (e.button === 2) { selectOnly(c.id); openInspector(c, e.clientX, e.clientY); drag = null; return; }
    if (!e.shiftKey && !view.selectedClips.has(c.id)) selectOnly(c.id);
    else if (e.shiftKey) { view.selectedClips.add(c.id); view.selectedTrack = c.trackId; }
    if (!c.active) { pushUndo(); activateTake(c); toast("Take active: " + c.name); }
    if (e.detail === 2) {
      drag = null;
      if (hit.track.type === "midi") openPianoRoll(c);
      else openInspector(c, e.clientX, e.clientY);
      invalidate();
      return;
    }
    const mode = hit.zone === "clip" ? "move" : hit.zone === "clipL" ? "trimL" : "trimR";
    drag = {
      mode, clip: c, undoPushed: false,
      grabDt: xToTime(mx) - c.start,
      orig: { start: c.start, duration: c.duration, offset: c.offset || 0 },
      origSel: [...view.selectedClips].map(id => { const cc = state.clips.find(q => q.id === id); return cc && { c: cc, start: cc.start }; }).filter(Boolean),
    };
    invalidate();
  } else if (hit.zone === "lane") {
    view.selectedTrack = hit.track.id;
    view.selectedClips.clear();
    if (e.detail === 2 && hit.track.type === "midi") {
      // create a MIDI clip: 2 bars
      pushUndo();
      const start = snapTime(xToTime(mx));
      const lenBeats = state.tsN * 2 * (4 / state.tsD);
      const c = {
        id: uid(), trackId: hit.track.id, start, duration: lenBeats * spb(), offset: 0,
        gainDb: 0, fadeIn: 0, fadeOut: 0, lane: 0, active: true, name: "MIDI", semi: 0,
        notes: [], lenBeats,
      };
      state.clips.push(c);
      selectOnly(c.id);
      openPianoRoll(c);
    }
    rebuildMixer(); invalidate();
  } else if (hit.zone === "void") {
    view.selectedClips.clear(); invalidate();
  }
});

function toggleHeaderBtn(key, t) {
  if (key === "arm") { state.tracks.forEach(q => { if (q !== t) q.armed = false; }); t.armed = !t.armed; }
  if (key === "mute") t.mute = !t.mute;
  if (key === "solo") t.solo = !t.solo;
  if (key === "monitor") t.monitor = !t.monitor;
  applyTrackGains(); rebuildMixer(); invalidate();
}

cv.addEventListener("pointermove", (e) => {
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;

  if (!drag) {
    const hit = hitTest(mx, my);
    cv.style.cursor =
      hit.zone === "clipL" || hit.zone === "clipR" ? "ew-resize" :
      hit.zone === "clip" ? "grab" :
      hit.zone === "autoPoint" ? "grab" :
      hit.zone === "autoLane" ? "crosshair" :
      hit.zone === "ruler" || hit.zone === "arranger" ? "text" : "default";
    return;
  }

  if (drag.mode === "autoPoint") {
    if (!drag.undoPushed) { pushUndo(); drag.undoPushed = true; }
    let time = e.altKey ? Math.max(0, xToTime(mx)) : snapTime(xToTime(mx)); // Alt = snap off
    let value = autoYToVal(drag.param, my, drag.L);
    if (e.shiftKey) {
      // constrain to dominant axis
      if (!drag.lock) {
        const dx = Math.abs(mx - drag.pressX), dy = Math.abs(my - drag.pressY);
        if (dx > 3 || dy > 3) drag.lock = dx >= dy ? "x" : "y";
      }
      if (drag.lock === "x") value = drag.orig.value;
      else if (drag.lock === "y") time = drag.orig.time;
    } else drag.lock = null;
    drag.point.time = time;
    drag.point.value = value;
    autoSort(autoPoints(drag.track, drag.param));
    applyTrackGains(); invalidate();
    return;
  }

  const fine = e.altKey;
  if (drag.mode === "scrub") {
    setPlayhead(snapTime(xToTime(mx), fine));
  } else if (drag.mode === "loop") {
    const t = snapTime(xToTime(mx));
    state.loop.start = Math.min(drag.anchor, t);
    state.loop.end = Math.max(drag.anchor, t);
    invalidate();
  } else if (drag.mode === "marker") {
    if (!drag.undoPushed) { pushUndo(); drag.undoPushed = true; }
    drag.marker.time = snapTime(xToTime(mx));
    invalidate();
  } else if (drag.mode === "move") {
    if (!drag.undoPushed) { pushUndo(); drag.undoPushed = true; }
    const newStart = snapTime(xToTime(mx) - drag.grabDt, fine);
    const dt = newStart - drag.orig.start;
    for (const s of drag.origSel) s.c.start = Math.max(0, s.start + dt);
    invalidate();
  } else if (drag.mode === "trimL") {
    if (!drag.undoPushed) { pushUndo(); drag.undoPushed = true; }
    const c = drag.clip;
    const rate = Math.pow(2, (c.semi || 0) / 12);
    let ns = snapTime(xToTime(mx), fine);
    const maxStart = drag.orig.start + drag.orig.duration - 0.05;
    ns = clamp(ns, Math.max(0, drag.orig.start - (c.bufferId ? drag.orig.offset / rate : 1e9)), maxStart);
    const d = ns - drag.orig.start;
    c.start = ns;
    c.duration = drag.orig.duration - d;
    if (c.bufferId) c.offset = drag.orig.offset + d * rate;
    invalidate();
  } else if (drag.mode === "trimR") {
    if (!drag.undoPushed) { pushUndo(); drag.undoPushed = true; }
    const c = drag.clip;
    let ne = snapTime(xToTime(mx), fine);
    let maxDur = 1e9;
    if (c.bufferId) {
      const raw = audioStore.get(c.bufferId);
      const rate = Math.pow(2, (c.semi || 0) / 12);
      if (raw) maxDur = (raw.chans[0].length / raw.sr - (c.offset || 0)) / rate;
    }
    c.duration = clamp(ne - c.start, 0.05, maxDur);
    if (c.notes) c.lenBeats = c.duration / spb();
    invalidate();
  }
});

cv.addEventListener("pointerup", () => {
  if (drag && drag.mode === "autoPoint") rescheduleAutomationLive();
  drag = null; cv.style.cursor = "default";
});
cv.addEventListener("contextmenu", (e) => e.preventDefault());

cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const tAt = xToTime(mx);
    view.pxPerSec = clamp(view.pxPerSec * (e.deltaY < 0 ? 1.15 : 0.87), 8, 400);
    view.scrollX = Math.max(0, tAt * view.pxPerSec - (mx - HEADER_W));
    $("zoom").value = view.pxPerSec;
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    view.scrollX = Math.max(0, view.scrollX + (e.deltaX || e.deltaY));
  } else {
    view.scrollY = Math.max(0, view.scrollY + e.deltaY);
  }
  invalidate();
}, { passive: false });

function setPlayhead(t) {
  view.playhead = Math.max(0, t);
  if (view.playing && !view.recording) { stopPlayback(false); play(view.playhead); }
  else applyTrackGains();                 // park automated params at the new position
  invalidate();
}

/* drag & drop audio import */
cv.addEventListener("dragover", (e) => { e.preventDefault(); cv.classList.add("dropping"); });
cv.addEventListener("dragleave", () => cv.classList.remove("dropping"));
cv.addEventListener("drop", async (e) => {
  e.preventDefault();
  cv.classList.remove("dropping");
  ensureCtx();
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const hit = hitTest(mx, my);
  let start = snapTime(Math.max(0, xToTime(Math.max(mx, HEADER_W))));
  for (const f of e.dataTransfer.files) {
    if (!f.type.startsWith("audio") && !/\.(wav|mp3|flac|ogg|m4a|aif+)$/i.test(f.name)) continue;
    try {
      const ab = await f.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      const chans = [];
      for (let i = 0; i < buf.numberOfChannels; i++) chans.push(new Float32Array(buf.getChannelData(i)));
      const bufferId = uid();
      audioStore.set(bufferId, { sr: buf.sampleRate, chans });
      saveAudioToDb(bufferId);
      pushUndo();
      let track = (hit.track && hit.track.type === "audio") ? hit.track : null;
      if (!track) track = addTrack("audio", false);
      state.clips.push({
        id: uid(), trackId: track.id, start, duration: buf.duration, offset: 0,
        bufferId, gainDb: 0, fadeIn: 5, fadeOut: 10, lane: 0, active: true,
        name: f.name.replace(/\.[^.]+$/, ""), semi: 0,
      });
      start += buf.duration;
      toast("Imported " + f.name);
    } catch (err) {
      toast("Could not decode " + f.name);
    }
  }
  invalidate();
});

/* ───────────────────────── markers ───────────────────────── */
const MARKER_COLORS = ["#e0a04e", "#4ea3e0", "#6fc95b", "#c45ec9", "#4ec9b0", "#e05d4e"];
function addMarker() {
  const label = prompt("Section name:", ["INTRO", "VERSE", "CHORUS", "BRIDGE", "OUTRO"][state.markers.length % 5] || "SECTION");
  if (!label) return;
  pushUndo();
  state.markers.push({ id: uid(), time: snapTime(view.playhead), label: label.toUpperCase(), color: MARKER_COLORS[state.markers.length % MARKER_COLORS.length] });
  invalidate();
}

/* ───────────────────────── mixer ───────────────────────── */
function rebuildMixer() {
  const strips = $("strips");
  strips.innerHTML = "";
  for (const t of state.tracks) strips.appendChild(buildStrip(t, false));
  strips.appendChild(buildStrip(null, true));
}

function buildStrip(t, isMaster) {
  const d = document.createElement("div");
  d.className = "strip" + (isMaster ? " master" : (t.id === view.selectedTrack ? " selected" : ""));
  const name = document.createElement("div");
  name.className = "cname";
  name.textContent = isMaster ? "MASTER" : t.name;
  name.title = isMaster ? "Master bus" : t.name + " — click to select";
  d.appendChild(name);

  const cbar = document.createElement("div");
  cbar.className = "cbar";
  cbar.style.background = isMaster ? "#d8d8dc" : t.color;
  d.appendChild(cbar);

  if (!isMaster) {
    const pan = document.createElement("input");
    pan.type = "range"; pan.className = "pan"; pan.min = -1; pan.max = 1; pan.step = 0.01; pan.value = t.pan;
    pan.title = "Pan";
    pan.oninput = () => { t.pan = parseFloat(pan.value); applyTrackGains(); };
    pan.ondblclick = () => { t.pan = 0; pan.value = 0; applyTrackGains(); };
    d.appendChild(pan);
  } else {
    const sp = document.createElement("div"); sp.style.height = "14px"; d.appendChild(sp);
  }

  const zone = document.createElement("div");
  zone.className = "faderZone";
  const fbox = document.createElement("div");
  fbox.className = "faderBox";
  const fader = document.createElement("input");
  fader.type = "range"; fader.className = "fader";
  fader.min = -60; fader.max = 12; fader.step = 0.1;
  fader.value = isMaster ? (master ? master.gainDb : 0) : t.gainDb;
  fader.oninput = () => {
    const v = parseFloat(fader.value);
    if (isMaster) { ensureCtx(); master.gainDb = v; } else t.gainDb = v;
    applyTrackGains();
    db.textContent = v.toFixed(1) + " dB";
  };
  fader.ondblclick = () => { fader.value = 0; fader.oninput(); };
  fbox.appendChild(fader);
  zone.appendChild(fbox);
  const meter = document.createElement("canvas");
  meter.className = "meter"; meter.width = 12; meter.height = 150;
  meter.dataset.track = isMaster ? "__master" : t.id;
  zone.appendChild(meter);
  d.appendChild(zone);

  const db = document.createElement("div");
  db.className = "dbLabel";
  db.textContent = (isMaster ? (master ? master.gainDb : 0) : t.gainDb).toFixed(1) + " dB";
  d.appendChild(db);

  const row = document.createElement("div");
  row.className = "btnRow";
  if (!isMaster) {
    const bM = document.createElement("button"); bM.className = "bM" + (t.mute ? " on" : ""); bM.textContent = "M"; bM.title = "Mute";
    bM.onclick = () => toggleHeaderBtn("mute", t);
    const bS = document.createElement("button"); bS.className = "bS" + (t.solo ? " on" : ""); bS.textContent = "S"; bS.title = "Solo";
    bS.onclick = () => toggleHeaderBtn("solo", t);
    const bR = document.createElement("button"); bR.className = "bR" + (t.armed ? " on" : ""); bR.textContent = "R"; bR.title = "Record arm";
    bR.onclick = () => toggleHeaderBtn("arm", t);
    const bI = document.createElement("button"); bI.className = "bI" + (t.monitor ? " on" : ""); bI.textContent = "I"; bI.title = "Input monitoring";
    bI.onclick = () => toggleHeaderBtn("monitor", t);
    row.append(bM, bS, bR, bI);
  } else {
    const lab = document.createElement("div");
    lab.style.cssText = "font-size:9px;color:var(--dim)";
    lab.id = "masterLufs";
    lab.textContent = "LUFS —";
    row.appendChild(lab);
  }
  d.appendChild(row);

  if (!isMaster) {
    name.onclick = () => { view.selectedTrack = t.id; rebuildMixer(); invalidate(); };
    name.ondblclick = () => {
      const nn = prompt("Track name:", t.name);
      if (nn) { pushUndo(); t.name = nn; rebuildMixer(); invalidate(); }
    };
  }
  return d;
}

/* meters */
const meterBuf = new Float32Array(2048);
let lufsAcc = [], lufsTick = 0;
function drawMeters() {
  const canvases = document.querySelectorAll(".meter");
  for (const m of canvases) {
    const id = m.dataset.track;
    const node = id === "__master" ? master : trackNodes.get(id);
    const mg = m.getContext("2d");
    const H = m.height;
    mg.fillStyle = "#060607";
    mg.fillRect(0, 0, 12, H);
    if (!node) continue;
    const an = node.analyser;
    an.getFloatTimeDomainData(meterBuf.subarray(0, an.fftSize));
    let peak = 0, sum = 0;
    for (let i = 0; i < an.fftSize; i++) { const v = Math.abs(meterBuf[i]); if (v > peak) peak = v; sum += meterBuf[i] * meterBuf[i]; }
    const rms = Math.sqrt(sum / an.fftSize);
    node.meter.peak = Math.max(peak, node.meter.peak * 0.86);
    if (peak >= 0.999) node.meter.clip = true;
    const toY = (v) => H - clamp((lin2db(v) + 60) / 66, 0, 1) * H;
    // rms bar
    const yR = toY(rms);
    const grad = mg.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, "#1f8a3c"); grad.addColorStop(0.72, "#3fcf6a"); grad.addColorStop(0.88, "#ffd60a"); grad.addColorStop(1, "#ff3b30");
    mg.fillStyle = grad;
    mg.fillRect(1, yR, 10, H - yR);
    // peak line
    const yP = toY(node.meter.peak);
    mg.fillStyle = node.meter.peak >= 0.999 ? "#ff3b30" : "#d8d8dc";
    mg.fillRect(1, yP, 10, 1.5);
    // clip LED
    mg.fillStyle = node.meter.clip ? "#ff3b30" : "#2a0d0b";
    mg.fillRect(1, 0, 10, 3);
    if (id === "__master" && view.playing) {
      lufsAcc.push(sum / an.fftSize);
      if (lufsAcc.length > 180) lufsAcc.shift();
      if (++lufsTick % 15 === 0) {
        const ms = lufsAcc.reduce((a, b) => a + b, 0) / lufsAcc.length;
        const lufs = ms > 0 ? (-0.691 + 10 * Math.log10(ms)).toFixed(1) : "—";
        const el = $("masterLufs");
        if (el) el.textContent = "≈" + lufs + " LUFS";
      }
    }
  }
}
document.addEventListener("dblclick", (e) => {
  if (e.target.classList && e.target.classList.contains("meter")) {
    const id = e.target.dataset.track;
    const node = id === "__master" ? master : trackNodes.get(id);
    if (node) node.meter.clip = false;
  }
});

/* ───────────────────────── clip inspector ───────────────────────── */
let insClip = null;
function openInspector(c, x, y) {
  insClip = c;
  pushUndo();
  const el = $("inspector");
  el.classList.remove("hidden");
  el.style.left = clamp(x, 10, window.innerWidth - 290) + "px";
  el.style.top = clamp(y, 60, window.innerHeight - 260) + "px";
  $("insName").value = c.name || "";
  $("insGain").value = c.gainDb || 0;
  $("insGainV").textContent = (c.gainDb || 0).toFixed(1) + " dB";
  $("insFadeIn").value = c.fadeIn || 0;
  $("insFadeInV").textContent = (c.fadeIn || 0) + " ms";
  $("insFadeOut").value = c.fadeOut || 0;
  $("insFadeOutV").textContent = (c.fadeOut || 0) + " ms";
  $("insPitch").value = c.semi || 0;
  $("insPitchV").textContent = (c.semi || 0) + " st";
  $("insPitchRow").style.display = c.bufferId ? "" : "none";
}
$("insName").oninput = () => { if (insClip) { insClip.name = $("insName").value; invalidate(); } };
$("insGain").oninput = () => { if (insClip) { insClip.gainDb = parseFloat($("insGain").value); $("insGainV").textContent = insClip.gainDb.toFixed(1) + " dB"; invalidate(); } };
$("insFadeIn").oninput = () => { if (insClip) { insClip.fadeIn = parseFloat($("insFadeIn").value); $("insFadeInV").textContent = insClip.fadeIn + " ms"; invalidate(); } };
$("insFadeOut").oninput = () => { if (insClip) { insClip.fadeOut = parseFloat($("insFadeOut").value); $("insFadeOutV").textContent = insClip.fadeOut + " ms"; invalidate(); } };
$("insPitch").oninput = () => {
  if (!insClip) return;
  insClip.semi = parseInt($("insPitch").value, 10);
  $("insPitchV").textContent = (insClip.semi > 0 ? "+" : "") + insClip.semi + " st";
  invalidate();
};
$("insClose").onclick = () => { $("inspector").classList.add("hidden"); insClip = null; };
$("insDelete").onclick = () => {
  if (insClip) { view.selectedClips = new Set([insClip.id]); deleteSelection(); }
  $("inspector").classList.add("hidden"); insClip = null;
};

/* ───────────────────────── piano roll ───────────────────────── */
const prPanel = $("pianoroll"), prCv = $("prCanvas"), pg = prCv.getContext("2d");
const PR_KEY_W = 52, PR_ROW = 13, PR_PPB = 72, PR_PMAX = 107, PR_PMIN = 24;
let prW = 0, prH = 0, prDrag = null, prLastLen = 1;

function openPianoRoll(c) {
  view.prClipId = c.id;
  prPanel.classList.remove("hidden");
  $("prClipName").textContent = c.name + " — " + (state.tracks.find(t => t.id === c.trackId)?.name || "");
  resizePr();
  prDraw();
}
function closePianoRoll() { view.prClipId = null; prPanel.classList.add("hidden"); invalidate(); }
$("prClose").onclick = closePianoRoll;

function resizePr() {
  const r = prCv.getBoundingClientRect();
  prW = r.width; prH = r.height;
  prCv.width = Math.round(prW * dpr); prCv.height = Math.round(prH * dpr);
  pg.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(() => { resizePr(); prDraw(); }).observe(prCv);

const prClip = () => state.clips.find(c => c.id === view.prClipId);
const prPitchToY = (p) => (PR_PMAX - p) * PR_ROW - view.prScrollY;
const prYToPitch = (y) => PR_PMAX - Math.floor((y + view.prScrollY) / PR_ROW);
const prBeatToX = (b) => PR_KEY_W + b * PR_PPB;
const prXToBeat = (x) => (x - PR_KEY_W) / PR_PPB;

function prDraw() {
  const c = prClip();
  if (!c || prPanel.classList.contains("hidden")) return;
  pg.fillStyle = "#0c0c0e";
  pg.fillRect(0, 0, prW, prH);
  const lenBeats = c.lenBeats || c.duration / spb();

  // rows
  for (let p = PR_PMAX; p >= PR_PMIN; p--) {
    const y = prPitchToY(p);
    if (y + PR_ROW < 0 || y > prH) continue;
    const black = [1, 3, 6, 8, 10].includes(p % 12);
    pg.fillStyle = black ? "#0a0a0c" : "#101013";
    pg.fillRect(PR_KEY_W, y, prW - PR_KEY_W, PR_ROW - 1);
    if (p % 12 === 0) {
      pg.strokeStyle = "#2a2a31";
      pg.beginPath(); pg.moveTo(PR_KEY_W, y + PR_ROW); pg.lineTo(prW, y + PR_ROW); pg.stroke();
    }
  }
  // grid: 16ths
  for (let b = 0; b <= lenBeats + 0.001; b += 0.25) {
    const x = prBeatToX(b);
    if (x > prW) break;
    const isBeat = Math.abs(b % 1) < 0.001;
    const isBar = Math.abs(b % state.tsN) < 0.001;
    pg.strokeStyle = isBar ? "#34343c" : isBeat ? "#222228" : "#17171b";
    pg.beginPath(); pg.moveTo(x + 0.5, 0); pg.lineTo(x + 0.5, prH); pg.stroke();
  }
  // end shade
  const endX = prBeatToX(lenBeats);
  pg.fillStyle = "rgba(0,0,0,0.5)";
  pg.fillRect(endX, 0, prW - endX, prH);

  // notes
  const track = state.tracks.find(t => t.id === c.trackId);
  for (const n of c.notes) {
    const x = prBeatToX(n.s), w = Math.max(4, n.l * PR_PPB - 1);
    const y = prPitchToY(n.p);
    pg.fillStyle = prDrag && prDrag.note === n ? "#fff" : (track ? track.color : "#4ea3e0");
    pg.fillRect(x, y + 1, w, PR_ROW - 3);
    pg.strokeStyle = "rgba(0,0,0,0.6)";
    pg.strokeRect(x + 0.5, y + 1.5, w - 1, PR_ROW - 4);
  }

  // playhead in clip
  if (view.playing) {
    const rel = (currentPos() - c.start) / spb();
    if (rel >= 0 && rel <= lenBeats) {
      const x = prBeatToX(rel);
      pg.strokeStyle = "#e8e8ec";
      pg.beginPath(); pg.moveTo(x, 0); pg.lineTo(x, prH); pg.stroke();
    }
  }

  // keys
  pg.fillStyle = "#121216";
  pg.fillRect(0, 0, PR_KEY_W, prH);
  pg.font = "9px monospace";
  for (let p = PR_PMAX; p >= PR_PMIN; p--) {
    const y = prPitchToY(p);
    if (y + PR_ROW < 0 || y > prH) continue;
    const black = [1, 3, 6, 8, 10].includes(p % 12);
    pg.fillStyle = black ? "#1a1a1f" : "#d8d8dc";
    pg.fillRect(0, y + 1, PR_KEY_W - 8, PR_ROW - 2);
    if (p % 12 === 0) {
      pg.fillStyle = "#0a0a0b";
      pg.fillText(NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 1), 4, y + PR_ROW - 3);
    }
  }
}

function prHit(mx, my) {
  const c = prClip();
  if (!c) return null;
  for (let i = c.notes.length - 1; i >= 0; i--) {
    const n = c.notes[i];
    const x = prBeatToX(n.s), w = Math.max(4, n.l * PR_PPB - 1), y = prPitchToY(n.p);
    if (mx >= x && mx <= x + w && my >= y && my <= y + PR_ROW) {
      return { note: n, edge: mx >= x + w - 5 };
    }
  }
  return null;
}

prCv.addEventListener("pointerdown", (e) => {
  ensureCtx();
  const r = prCv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const c = prClip();
  if (!c) return;
  prCv.setPointerCapture(e.pointerId);
  if (mx < PR_KEY_W) {
    const p = prYToPitch(my);
    previewNote(p, c.trackId);
    return;
  }
  const hit = prHit(mx, my);
  if (e.button === 2) {
    if (hit) { pushUndo(); c.notes = c.notes.filter(n => n !== hit.note); prDraw(); invalidate(); }
    return;
  }
  if (hit) {
    pushUndo();
    prDrag = { note: hit.note, mode: hit.edge ? "resize" : "move", grabB: prXToBeat(mx) - hit.note.s, origS: hit.note.s, origL: hit.note.l };
  } else {
    pushUndo();
    const b = Math.max(0, Math.floor(prXToBeat(mx) / 0.25) * 0.25);
    const p = prYToPitch(my);
    if (p < PR_PMIN || p > PR_PMAX) return;
    const n = { p, s: b, l: prLastLen, v: 100 };
    c.notes.push(n);
    previewNote(p, c.trackId);
    prDrag = { note: n, mode: "resize", grabB: 0, origS: b, origL: n.l };
    prDraw(); invalidate();
  }
});

prCv.addEventListener("pointermove", (e) => {
  const r = prCv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  if (!prDrag) {
    const hit = prHit(mx, my);
    prCv.style.cursor = hit ? (hit.edge ? "ew-resize" : "grab") : "cell";
    return;
  }
  const c = prClip();
  if (!c) return;
  const n = prDrag.note;
  if (prDrag.mode === "move") {
    n.s = Math.max(0, Math.round((prXToBeat(mx) - prDrag.grabB) / 0.25) * 0.25);
    const p = prYToPitch(my);
    if (p >= PR_PMIN && p <= PR_PMAX && p !== n.p) { n.p = p; previewNote(p, c.trackId); }
  } else {
    n.l = Math.max(0.25, Math.round((prXToBeat(mx) - n.s) / 0.25) * 0.25);
    prLastLen = n.l;
  }
  prDraw(); invalidate();
});
prCv.addEventListener("pointerup", () => { prDrag = null; });
prCv.addEventListener("contextmenu", (e) => e.preventDefault());
prCv.addEventListener("wheel", (e) => {
  e.preventDefault();
  view.prScrollY = clamp(view.prScrollY + e.deltaY, 0, (PR_PMAX - PR_PMIN) * PR_ROW - 100);
  prDraw();
}, { passive: false });

function previewNote(p, trackId) {
  if (!ctx) return;
  const t = state.tracks.find(t => t.id === trackId);
  const n = t ? ensureTrackNodes(t) : null;
  const dest = n ? n.input : master.input;
  const tmp = [];
  scheduleSynthNote(ctx, dest, { p, l: 1, v: 100, s: 0 }, 0, 0.25, 0, ctx.currentTime + 0.01, tmp, false);
}

/* ───────────────────────── export ───────────────────────── */
function sessionLength() {
  let end = 0;
  for (const c of state.clips) if (c.active) end = Math.max(end, c.start + c.duration);
  return end;
}

async function renderMix(sr, soloTrackId) {
  const len = sessionLength();
  if (len <= 0) throw new Error("Session is empty");
  const frames = Math.ceil((len + 1.5) * sr);
  const ocx = new OfflineAudioContext(2, frames, sr);
  const mIn = ocx.createGain();
  const lim = ocx.createDynamicsCompressor();
  lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
  const mg = ocx.createGain();
  mg.gain.value = db2lin(master ? master.gainDb : 0);
  mIn.connect(lim).connect(mg).connect(ocx.destination);
  const anySolo = state.tracks.some(t => t.solo);
  const sources = [];
  for (const t of state.tracks) {
    if (soloTrackId && t.id !== soloTrackId) continue;
    if (!soloTrackId) {
      if (t.mute || (anySolo && !t.solo)) continue;
    }
    ensureAutoModel(t);
    const inp = ocx.createGain();
    const pan = ocx.createStereoPanner();
    const autoPan = ocx.createStereoPanner();
    const gn = ocx.createGain();
    const autoVol = ocx.createGain();
    const autoMute = ocx.createGain();
    // same automation semantics as live playback
    pan.pan.value = t.automation.pan.length ? 0 : t.pan;
    gn.gain.value = t.automation.volume.length ? 1 : db2lin(t.gainDb);
    inp.connect(pan).connect(autoPan).connect(gn).connect(autoVol).connect(autoMute).connect(mIn);
    scheduleAutomation({ autoVol, autoPan, autoMute }, t, 0, 0, frames / sr);
    for (const c of state.clips.filter(c => c.trackId === t.id)) {
      scheduleClip(c, t, ocx, inp, 0, 0, sources);
    }
  }
  return await ocx.startRendering();
}

function measureLufsApprox(buf) {
  // BS.1770-flavoured: mean square over whole programme, both channels (no gating/K-weighting)
  let sum = 0, n = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i += 4) { sum += d[i] * d[i]; n++; }
  }
  const ms = sum / n;
  return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -90;
}

function encodeWav(buf, bits) {
  const nCh = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
  const bytesPer = bits / 8;
  const dataSize = n * nCh * bytesPer;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); dv.setUint32(4, 36 + dataSize, true); wstr(8, "WAVE");
  wstr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, nCh, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * nCh * bytesPer, true); dv.setUint16(32, nCh * bytesPer, true);
  dv.setUint16(34, bits, true);
  wstr(36, "data"); dv.setUint32(40, dataSize, true);
  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = clamp(chans[c][i], -1, 1);
      if (bits === 16) { dv.setInt16(o, v * 32767, true); o += 2; }
      else { const iv = Math.round(v * 8388607); dv.setUint8(o, iv & 0xff); dv.setUint8(o + 1, (iv >> 8) & 0xff); dv.setUint8(o + 2, (iv >> 16) & 0xff); o += 3; }
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

function applyNormalize(buf, mode) {
  let gainDb = 0;
  if (mode === "peak") {
    let pk = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; }
    }
    if (pk > 0) gainDb = -1 - lin2db(pk);
  } else {
    const lufs = measureLufsApprox(buf);
    gainDb = parseFloat(mode) - lufs;
  }
  const g = db2lin(gainDb);
  if (Math.abs(gainDb) < 0.05) return 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = clamp(d[i] * g, -1, 1);
  }
  return gainDb;
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

let exporting = false;
async function doExport() {
  if (exporting) return toast("Export already running in background…");
  const name = $("expName").value.trim() || "Master";
  const bits = parseInt($("expBits").value, 10);
  const sr = parseInt($("expSr").value, 10);
  const norm = $("expNorm").value;
  const stems = $("expStems").checked;
  $("exportDlg").classList.add("hidden");
  exporting = true;
  toast("Rendering in background — keep working…", 4000);
  try {
    if (stems) {
      let i = 0;
      for (const t of state.tracks) {
        if (!state.clips.some(c => c.trackId === t.id && c.active)) continue;
        const buf = await renderMix(sr, t.id);
        if (norm !== "none") applyNormalize(buf, norm);
        downloadBlob(encodeWav(buf, bits), name + "_STEM_" + (++i) + "_" + t.name.replace(/\W+/g, "_") + ".wav");
      }
      toast("Stems exported — " + i + " files");
    } else {
      const buf = await renderMix(sr, null);
      let msg = "";
      if (norm !== "none") {
        const gdb = applyNormalize(buf, norm);
        msg = norm === "peak" ? " (peak → -1 dBFS)" : " (≈" + norm + " LUFS, " + (gdb >= 0 ? "+" : "") + gdb.toFixed(1) + " dB)";
      }
      downloadBlob(encodeWav(buf, bits), name + ".wav");
      toast("Exported " + name + ".wav" + msg, 4000);
    }
  } catch (e) {
    toast("Export failed: " + e.message);
  }
  exporting = false;
}
$("expGo").onclick = doExport;
$("expCancel").onclick = () => $("exportDlg").classList.add("hidden");
function openExport() { ensureCtx(); $("exportDlg").classList.remove("hidden"); $("expName").select(); }

/* ───────────────────────── persistence (IndexedDB) ───────────────────────── */
let idb = null;
function openDb() {
  return new Promise((res) => {
    const rq = indexedDB.open("absolute-studio-x", 1);
    rq.onupgradeneeded = () => {
      rq.result.createObjectStore("kv");
      rq.result.createObjectStore("audio");
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(null);
  });
}

function saveAudioToDb(bufferId) {
  if (!idb) return;
  const raw = audioStore.get(bufferId);
  if (!raw) return;
  try {
    idb.transaction("audio", "readwrite").objectStore("audio").put({ sr: raw.sr, chans: raw.chans }, bufferId);
  } catch (e) { /* quota — session JSON still saves */ }
}

function saveSession(silent) {
  if (!idb) return;
  const used = new Set(state.clips.map(c => c.bufferId).filter(Boolean));
  const json = JSON.stringify({
    name: state.name, bpm: state.bpm, tsN: state.tsN, tsD: state.tsD,
    tracks: state.tracks, clips: state.clips, markers: state.markers, loop: state.loop,
    masterDb: master ? master.gainDb : 0,
    view: { pxPerSec: view.pxPerSec, scrollX: view.scrollX, metro: view.metro, snap: view.snap, playhead: view.playhead },
    savedAt: Date.now(),
  });
  try {
    const tx = idb.transaction(["kv", "audio"], "readwrite");
    tx.objectStore("kv").put(json, "session");
    // prune unused audio
    const store = tx.objectStore("audio");
    store.getAllKeys().onsuccess = function () {
      for (const k of this.result) if (!used.has(k)) store.delete(k);
    };
    view.lastSave = Date.now();
    if (!silent) toast("Session saved");
  } catch (e) {
    if (!silent) toast("Save failed: " + e.message);
  }
}

async function loadSession() {
  idb = await openDb();
  if (!idb) return false;
  return new Promise((res) => {
    const tx = idb.transaction(["kv", "audio"]);
    const rq = tx.objectStore("kv").get("session");
    rq.onsuccess = () => {
      if (!rq.result) return res(false);
      try {
        const o = JSON.parse(rq.result);
        state.name = o.name || "Untitled";
        state.bpm = o.bpm; state.tsN = o.tsN; state.tsD = o.tsD;
        state.tracks = o.tracks; state.clips = o.clips; state.markers = o.markers || [];
        state.tracks.forEach(ensureAutoModel);        // migrate pre-automation sessions
        state.loop = o.loop || { on: false, start: 0, end: 8 };
        if (o.view) {
          view.pxPerSec = o.view.pxPerSec || 48;
          view.scrollX = o.view.scrollX || 0;
          view.metro = !!o.view.metro;
          view.snap = o.view.snap !== false;
          view.playhead = o.view.playhead || 0;
        }
        const arq = tx.objectStore("audio").getAllKeys();
        arq.onsuccess = () => {
          const keys = arq.result;
          let pending = keys.length;
          if (!pending) return res(true);
          const store = idb.transaction("audio").objectStore("audio");
          for (const k of keys) {
            const r2 = store.get(k);
            r2.onsuccess = () => {
              if (r2.result) audioStore.set(k, r2.result);
              if (--pending === 0) res(true);
            };
            r2.onerror = () => { if (--pending === 0) res(true); };
          }
        };
      } catch (e) { res(false); }
    };
    rq.onerror = () => res(false);
  });
}

setInterval(() => saveSession(true), 30000); // autosave: every 30s, invisible

/* ───────────────────────── hotkeys ───────────────────────── */
document.addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") e.target.blur(); });

document.addEventListener("keydown", (e) => {
  const ae = document.activeElement;
  const tag = ae && ae.tagName;
  const typing = (tag === "INPUT" && ae.type !== "range" && ae.type !== "checkbox") || tag === "SELECT" || tag === "TEXTAREA";
  const mod = e.ctrlKey || e.metaKey;

  if (typing && !(mod && ["s", "e", "r", "z"].includes(e.key.toLowerCase()))) return;

  const k = e.key.toLowerCase();

  if (e.code === "Space") { e.preventDefault(); if (ae && ae.blur) ae.blur(); togglePlay(); return; }
  if (e.key === "Enter" && !typing) { e.preventDefault(); stopPlayback(false); view.playhead = 0; invalidate(); return; }
  if (e.key === "Escape") { if (view.prClipId) closePianoRoll(); $("inspector").classList.add("hidden"); $("exportDlg").classList.add("hidden"); return; }

  if (mod && k === "r") { e.preventDefault(); toggleRecord(); return; }
  if (mod && k === "t") { e.preventDefault(); addTrack("audio"); toast("New audio track"); return; }
  if (mod && k === "m") { e.preventDefault(); addTrack("midi"); toast("New MIDI track"); return; }
  if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (mod && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (mod && k === "s" && !e.shiftKey) { e.preventDefault(); saveSession(false); return; }
  if (mod && k === "e") { e.preventDefault(); openExport(); return; }
  if (mod && k === "d") { e.preventDefault(); duplicateSelection(); return; }
  if (mod && e.key === "[") { e.preventDefault(); trimToPlayhead(false); return; }
  if (mod && e.key === "]") { e.preventDefault(); trimToPlayhead(true); return; }
  if (mod) return;

  if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); nudgeSelection(-1, e.shiftKey); return; }
  if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); nudgeSelection(1, e.shiftKey); return; }
  if (e.altKey && k === "a") {
    e.preventDefault();
    const t = selTrack() || state.tracks[0];
    if (t) {
      ensureAutoModel(t);
      t.autoLane.shown = !t.autoLane.shown;
      view.selectedTrack = t.id;
      invalidate();
      toast("Automation lane " + (t.autoLane.shown ? "ON" : "OFF") + " — " + t.name + " (hiding keeps the data)");
    }
    return;
  }
  if (typing) return;

  if (k === "r") { toggleRecord(); return; }
  if (k === "b") { splitSelection(); return; }
  if (k === "g") { view.snap = !view.snap; $("btnSnap").classList.toggle("on", view.snap); toast("Snap " + (view.snap ? "ON" : "OFF")); return; }
  if (k === "l") { toggleLoop(); return; }
  if (k === "m" && e.shiftKey) { addMarker(); return; }
  if (k === "m") { const t = selTrack(); if (t) toggleHeaderBtn("mute", t); return; }
  if (k === "s") { const t = selTrack(); if (t) toggleHeaderBtn("solo", t); return; }
  if (e.key === "Delete" || e.key === "Backspace") { deleteSelection(); return; }
  if (e.key === "+" || e.key === "=") { view.pxPerSec = clamp(view.pxPerSec * 1.25, 8, 400); $("zoom").value = view.pxPerSec; invalidate(); return; }
  if (e.key === "-") { view.pxPerSec = clamp(view.pxPerSec * 0.8, 8, 400); $("zoom").value = view.pxPerSec; invalidate(); return; }
  if (e.key === "Home") { view.playhead = 0; view.scrollX = 0; invalidate(); return; }
  if (/^[1-9]$/.test(e.key)) {
    const t = state.tracks[parseInt(e.key, 10) - 1];
    if (t) { view.selectedTrack = t.id; rebuildMixer(); invalidate(); }
    return;
  }
});

function selTrack() { return state.tracks.find(t => t.id === view.selectedTrack); }

function togglePlay() {
  ensureCtx();
  if (view.recording) { stopRecord(); return; }
  if (view.playing) stopPlayback(true);
  else play(view.playhead);
}

function toggleLoop() {
  state.loop.on = !state.loop.on;
  $("btnLoop").classList.toggle("on", state.loop.on);
  if (state.loop.on && state.loop.end <= state.loop.start) { state.loop.start = 0; state.loop.end = barLen() * 4; }
  invalidate();
}

/* ───────────────────────── transport wiring ───────────────────────── */
$("btnRec").onclick = toggleRecord;
$("btnPlay").onclick = togglePlay;
$("btnStop").onclick = () => { if (view.recording) stopRecord(); else stopPlayback(true); };
$("bpm").onchange = () => {
  const v = clamp(parseFloat($("bpm").value) || 120, 20, 400);
  pushUndo();
  const oldSpb = spb();
  state.bpm = v;
  $("bpm").value = v;
  // MIDI clips follow tempo (beats are truth); audio stays put (nondestructive)
  for (const c of state.clips) if (c.notes) c.duration = (c.lenBeats || c.duration / oldSpb) * spb();
  invalidate(); prDraw();
};
$("tsig").onchange = () => {
  const [n, d] = $("tsig").value.split("/").map(Number);
  pushUndo(); state.tsN = n; state.tsD = d; invalidate(); prDraw();
};
$("btnMetro").onclick = () => {
  view.metro = !view.metro;
  $("btnMetro").classList.toggle("on", view.metro);
  if (view.playing) { stopMetronome(); if (view.metro) { ensureCtx(); startMetronome(currentPos()); } }
};
$("btnSnap").onclick = () => { view.snap = !view.snap; $("btnSnap").classList.toggle("on", view.snap); };
$("btnLoop").onclick = toggleLoop;
$("zoom").oninput = () => { view.pxPerSec = parseFloat($("zoom").value); invalidate(); };
$("btnAddAudio").onclick = () => addTrack("audio");
$("btnAddMidi").onclick = () => addTrack("midi");
$("btnMarker").onclick = addMarker;
$("btnSave").onclick = () => saveSession(false);
$("btnExport").onclick = openExport;

/* ───────────────────────── status bar + main loop ───────────────────────── */
function fmtBars(t) {
  const b = barLen();
  const bars = Math.floor(t / b);
  const beats = Math.floor((t - bars * b) / spb());
  const sub = Math.floor(((t - bars * b) % spb()) / (spb() / 4));
  return (bars + 1) + "." + (beats + 1) + "." + (sub + 1);
}
function fmtTime(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 1000);
  return m + ":" + String(s).padStart(2, "0") + "." + String(ms).padStart(3, "0");
}

let lastFrame = performance.now(), cpuAvg = 0;
function frame() {
  const fStart = performance.now();

  if (view.playing) {
    view.playhead = currentPos();
    // loop
    if (state.loop.on && !view.recording && view.playhead >= state.loop.end - 0.005) {
      stopPlayback(false);
      play(state.loop.start);
    }
    // follow playhead
    const px = timeToX(view.playhead);
    if (px > cw - 60) view.scrollX += px - (cw - 60);
    if (px < HEADER_W) view.scrollX = Math.max(0, view.playhead * view.pxPerSec - 40);
    invalidate();
  }

  if (view.dirty) { drawTimeline(); view.dirty = false; }
  if (view.playing || view.recording) { drawMeters(); if (view.prClipId) prDraw(); }
  else if (performance.now() % 400 < 20) drawMeters();

  // status bar
  const pos = view.playhead;
  $("posDisplay").innerHTML = fmtBars(pos) + " <small>|</small> " + fmtTime(pos);
  $("stBars").textContent = fmtBars(pos);
  $("stTime").textContent = fmtTime(pos);
  $("stSmp").textContent = ctx ? Math.floor(pos * ctx.sampleRate).toLocaleString() : "0";
  $("stSession").textContent = state.name;
  $("stSaved").textContent = view.lastSave ? "saved " + Math.round((Date.now() - view.lastSave) / 1000) + "s ago" : "";

  const dt = performance.now() - fStart;
  cpuAvg = cpuAvg * 0.95 + (dt / 16.7) * 100 * 0.05;
  const cpuEl = $("stCpu");
  cpuEl.innerHTML = "CPU <b>" + Math.min(99, Math.round(cpuAvg)) + "%</b>";
  cpuEl.classList.toggle("hot", cpuAvg > 70);

  requestAnimationFrame(frame);
}

/* ───────────────────────── boot ───────────────────────── */
(async function boot() {
  resizeCanvas();
  const recovered = await loadSession();
  if (recovered && state.tracks.length) {
    toast("Session recovered — " + state.tracks.length + " tracks, " + state.clips.length + " clips");
    $("bpm").value = state.bpm;
    $("tsig").value = state.tsN + "/" + state.tsD;
    $("zoom").value = view.pxPerSec;
    $("btnMetro").classList.toggle("on", view.metro);
    $("btnSnap").classList.toggle("on", view.snap);
    $("btnLoop").classList.toggle("on", state.loop.on);
    view.selectedTrack = state.tracks[0]?.id || null;
  } else {
    // black canvas. timeline. nothing more. (plus two tracks so REC just works)
    addTrack("audio", false);
    state.tracks[0].armed = true;
  }
  rebuildMixer();
  invalidate();
  cv.focus();
  requestAnimationFrame(frame);
})();

window.addEventListener("beforeunload", () => saveSession(true));
