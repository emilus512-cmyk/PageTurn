# ABSOLUTE STUDIO X INFINITY OMEGA

*Nie software. Studio. Make records. Nothing else.*

A zero-install, browser-native DAW built straight from the vision doc. Open it, you see a
black timeline, a docked mixer, and REC. Everything else disappears.

## Run

```bash
cd absolute-studio
python3 -m http.server 8080 --bind 0.0.0.0
# open http://localhost:8080
```

No build step. No dependencies. Three files: `index.html`, `style.css`, `app.js`.

> Recording needs microphone permission (HTTPS or localhost). If the page is embedded in an
> iframe that blocks the mic, open it in its own tab.

## What's in (mapped to the spec)

| Spec | Status |
|---|---|
| Timeline is god (80% screen, all tracks/clips/markers visible) | ✅ canvas timeline, zoom slider + Ctrl+wheel, 1-direction scroll |
| Mixer docked right, never hidden | ✅ fader, pan, meter (RMS+peak+clip LED), M/S/R/I per track, master with ≈LUFS readout |
| REC top-left, one action (arm → input → monitor → record) | ✅ Ctrl+R or R — auto-arms, auto-creates a track if needed |
| Unlimited takes, stacked, no questions asked | ✅ each take lands on lane 0, older takes drop down muted |
| Comping — click a take segment to make it live | ✅ click an inactive take; undo returns the previous one |
| Nondestructive everything | ✅ trim/slip/split/gain/fades/varispeed never touch source audio |
| Crossfades / clip gain / fade handles | ✅ per-clip fades (default-ish 20 ms zone), gain envelope via inspector (right-click clip) |
| Varispeed pitch (±12 st) | ✅ clip inspector (labelled varispeed — repitch style) |
| Automation lanes on the timeline (Alt+A) | ✅ Volume (-∞…+12 dB) / Pan (L100–C–R100) / Mute per track; linear interpolation, base value before first point; plays live + in export; lane lives under the track, no panel |
| Arranger track with sections | ✅ Shift+M markers (INTRO/VERSE/CHORUS…), click = jump, drag = move |
| Tempo / time signatures | ✅ BPM field (MIDI clips rescale, audio stays put), 4/4 · 3/4 · 6/8 · 5/4 · 7/8 |
| MIDI + piano roll (split view, same window) | ✅ double-click an Inst track → draw notes; built-in poly synth |
| Loop playback | ✅ drag in ruler top strip, L toggles |
| Metronome | ✅ CLICK button, bar-accented |
| Undo/redo unlimited-ish | ✅ 200 levels |
| Autosave every 30 s + session recovery | ✅ IndexedDB (audio included); crash → reopen → session restored |
| Export: WAV 16/24-bit, 44.1/48 k, background, stems, -14/-12 LUFS normalize | ✅ Ctrl+E — renders offline while you keep working |
| Drag & drop audio import | ✅ drop files on the timeline |
| Status bar: bars/beats, time, sample pos, SR, CPU, session | ✅ |

### Hotkeys (as specced)

```
Ctrl+T new audio · Ctrl+M new MIDI · Ctrl+R / R record · Space play/stop · Enter to 0
Ctrl+Z / Ctrl+Shift+Z undo/redo · Ctrl+S save · Ctrl+E export · Ctrl+D duplicate
Ctrl+[ / Ctrl+] trim to playhead · Alt+←/→ nudge · B split · G snap · L loop
Shift+M marker · M mute · S solo · 1–9 select track · +/- zoom · Del delete
Alt+A automation lane (click = add point · drag = move · double/right-click = delete
                       Shift = axis lock · Alt while dragging = snap off)
```

## Structure

```
absolute-studio/
├── index.html / style.css / app.js   # shell: timeline, mixer, transport, wiring
└── src/
    ├── core/
    │   ├── automation-core.js        # pure math + constants + immutable point ops
    │   ├── automation-api.js         # AutomationCore facade — stable public API
    │   ├── automation-serializer.js  # rounded (6 dp) JSON round-trip, validates both ways
    │   └── automation-validator.js   # normalization & repair of untrusted/disk data
    ├── ui/
    │   ├── automation-lane.js            # lane renderer on the timeline canvas
    │   ├── automation-lane-controller.js # AutomationLane public API (toggle/type/active)
    │   ├── automation-editor.js          # add/drag/delete points, axis lock, snap
    │   └── automation-styles.css         # lane theme (CSS custom properties)
    ├── audio/
    │   └── automation-scheduler.js   # AudioParam curves + transport orchestration
    │                                 # (scheduleAll / rescheduleFromPlayhead / cancelAll;
    │                                 #  timeline→context time conversion lives here)
    └── tests/
        └── automation.test.js        # 21 assertions, plain Node
```

`core/` modules are pure (no DOM, no WebAudio) and run in both browser and Node.
`ui/` and `audio/` are browser modules wired into `app.js` by dependency injection —
the scheduler drives AudioParams independently of the render loop, and the same
scheduling code runs in the realtime context and the offline exporter, so playback
and bounce always agree.

**`AutomationCore`** (from `automation-api.js`) is the stable public surface:
`normalizeAutomation(points, type)`, `getAutomationValueAtTime({points,time,baseValue,type})`,
`serializeAutomation` / `deserializeAutomation` (6-decimal rounding, accepts object/string/garbage),
immutable `addAutomationPoint` / `updateAutomationPoint` / `removeAutomationPoint`,
`migrateTrack` for legacy projects, plus `AUTOMATION_TYPES` / `INTERPOLATION_TYPES` /
`VALUE_RANGES` constants. Volume is expressed in dB (−∞…+12 per spec); the dB→gain
mapping happens in the audio scheduler, which also prefers `cancelAndHoldAtTime`
for click-free curve takeover.

**`AutomationLane`** (on `window`, from `automation-lane-controller.js`) is the lane
control surface: `toggleLane(trackId)`, `setActiveLaneType(type[, trackId])`, `render()`,
`getActiveTrackId()`, `getActiveLaneType()`. It's DOM-free — lane state lives on the
tracks themselves (`track.autoLane`), shared with the canvas renderer, so lanes stay
pixel-aligned with clips under every zoom/scroll and multiple lanes can be open at once.

## Tests

```bash
node src/tests/automation.test.js   # 48 assertions: interpolation, validator, serializer, facade, lane controller, headless editor, scheduler, compat, undo/redo
```

The suite also runs in GitHub Actions on every push (`.github/workflows/main.yml`):
syntax check of all modules, a browser load-order smoke test, and the full assertion suite.

## Not yet (honest roadmap)

- VST/VST3 hosting — impossible in a browser sandbox; the native bridge lives in `../daw-bridge`
  (plugin sandboxing per spec = one process per plugin, planned Phase 2 there).
- Sends/returns, group buses; FX wet/dry automation waits for an effects rack
  (the data model — `automation.effects[effectId].wetDry` — is already in place).
- Loop-record take cycling, punch in/out.
- True time-stretch (tempo change without repitch) — current pitch control is varispeed.
- MP3/FLAC encode (WAV is the lossless primary per spec).
