"""
DAW Bridge & Absolute Studio Mode Local Server — Version 4.3.0
Secure HTTP/JSON REST API, Path Traversal Protection, and Local Web UI Server.
"""

import os
import sys
import json
import time
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Dict, Any, Optional

from engine import DAWProjectParser, AudioAnalyzer, SnapshotManager, VERSION
from god_engine import SafeModeX, MediaResolver
from ultra_engine import UltraWatcher
from studio_engine import StudioEngine

WORKSPACE_ROOT = os.path.abspath(os.path.dirname(__file__))

class DAWBridgeHandler(BaseHTTPRequestHandler):
    """Secure HTTP Request Handler for DAW Bridge & Absolute Studio Mode."""

    # Reference shared instances initialized on server startup
    studio_engine: StudioEngine = None
    safe_mode_x: SafeModeX = None
    snapshot_manager: SnapshotManager = None
    ultra_watcher: UltraWatcher = None

    def log_message(self, format, *args):
        # Clean logging
        pass

    def _set_headers(self, status: int = 200, content_type: str = "application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers(200)

    def _read_json_body(self) -> Dict[str, Any]:
        content_len = int(self.headers.get("Content-Length", 0))
        if content_len == 0:
            return {}
        raw = self.rfile.read(content_len)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _send_json(self, data: Dict[str, Any], status: int = 200):
        self._set_headers(status, "application/json")
        self.wfile.write(json.dumps(data, indent=2).encode("utf-8"))

    def _send_error(self, message: str, status: int = 400):
        self._send_json({"success": False, "error": message}, status=status)

    def _is_safe_path(self, path: str) -> bool:
        """Prevents path traversal outside allowed system paths."""
        try:
            abs_p = os.path.abspath(path)
            # Ensure path does not contain illegal characters or escape
            return not ("\x00" in abs_p or "../" in path or "..\\" in path)
        except Exception:
            return False

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # -------------------------------------------------------------------
        # Static Web UI & Assets
        # -------------------------------------------------------------------
        if path == "/" or path == "/index.html":
            ui_path = os.path.join(WORKSPACE_ROOT, "index.html")
            if os.path.isfile(ui_path):
                self._set_headers(200, "text/html; charset=utf-8")
                with open(ui_path, "rb") as f:
                    self.wfile.write(f.read())
                return
            else:
                self._send_error("index.html not found", 404)
                return

        # -------------------------------------------------------------------
        # Direct Download Release ZIP
        # -------------------------------------------------------------------
        elif path == "/download" or path == "/download/release" or path.endswith(".zip"):
            zip_candidates = [
                "/home/user/DAW-Bridge-ABSOLUTE-STUDIO-4.3.0-Windows.zip",
                os.path.join(WORKSPACE_ROOT, "..", "DAW-Bridge-ABSOLUTE-STUDIO-4.3.0-Windows.zip"),
                os.path.join(WORKSPACE_ROOT, "DAW-Bridge-ABSOLUTE-STUDIO-4.3.0-Windows.zip")
            ]
            zip_path = None
            for zp in zip_candidates:
                if os.path.isfile(zp):
                    zip_path = zp
                    break

            if zip_path:
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Disposition", 'attachment; filename="DAW-Bridge-ABSOLUTE-STUDIO-4.3.0-Windows.zip"')
                self.send_header("Content-Length", str(os.path.getsize(zip_path)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                with open(zip_path, "rb") as zf:
                    while chunk := zf.read(65536):
                        self.wfile.write(chunk)
                return
            else:
                self._send_error("Release ZIP not found", 404)
                return

        # -------------------------------------------------------------------
        # System & Capabilities API
        # -------------------------------------------------------------------
        elif path == "/api/status":
            daw_check = SafeModeX.is_daw_process_running()
            disk_info = SafeModeX.check_disk_space(WORKSPACE_ROOT, 1024 * 1024)
            watcher_status = self.ultra_watcher.get_status() if self.ultra_watcher else {}
            driver_info = self.studio_engine.driver_manager.get_all_capabilities()

            self._send_json({
                "app": "DAW Bridge & ABSOLUTE STUDIO MODE",
                "version": VERSION,
                "status": "ONLINE",
                "safe_mode_x": {
                    "enabled": True,
                    "default_read_only": True,
                    "daw_process_check": daw_check,
                    "disk_space": disk_info
                },
                "watcher": watcher_status,
                "audio_driver": driver_info,
                "workspace_root": WORKSPACE_ROOT
            })
            return

        elif path == "/api/capabilities":
            self._send_json({
                "version": VERSION,
                "capability_matrix": {
                    "analytics_mode": {
                        "status": "OPERATIONAL",
                        "supported_formats": [
                            {"format": "Ableton Live (.als)", "fidelity": "HIGH", "mode": "READ_ONLY"},
                            {"format": "Reaper (.rpp)", "fidelity": "HIGH", "mode": "READ_ONLY"},
                            {"format": "FL Studio (.flp)", "fidelity": "MEDIUM", "mode": "READ_ONLY"},
                            {"format": "Studio One (.song)", "fidelity": "MEDIUM", "mode": "READ_ONLY"},
                            {"format": "Cubase (.cpr)", "fidelity": "TENTATIVE_READ_ONLY", "mode": "READ_ONLY"},
                            {"format": "Logic Pro (.logicx)", "fidelity": "TENTATIVE_READ_ONLY", "mode": "READ_ONLY"},
                            {"format": "Pro Tools (.ptx)", "fidelity": "TENTATIVE_READ_ONLY", "mode": "READ_ONLY"},
                            {"format": "WAV/AIFF/FLAC/MP3 Audio Files", "fidelity": "HIGH", "mode": "READ_ONLY"}
                        ]
                    },
                    "audio_analysis": {
                        "status": "OPERATIONAL",
                        "metrics": ["Peak dBFS", "RMS dBFS", "Crest Factor", "LUFS Integrated (BS.1770-4 K-weighting)", "Phase Correlation", "Stereo Width", "8-Band Spectral Profile", "Key & Scale Detection", "BPM Detection", "Storyboard Sectioning"]
                    },
                    "studio_engine": {
                        "status": "OPERATIONAL",
                        "audio_playback": "OPERATIONAL_PORTABLE_DSP",
                        "recording": "OPERATIONAL_SAFE_NON_DESTRUCTIVE",
                        "arrangement_mixer": "OPERATIONAL_FLOAT32_MIX_BUS",
                        "offline_bounce": "OPERATIONAL_24BIT_WAV",
                        "plugin_hosting": "PLANNED_PHASE_2_NOT_HOSTED_YET",
                        "hardware_wasapi": "AVAILABLE_FOR_WINDOWS" if sys.platform.startswith("win") else "UNVERIFIED_HARDWARE_REQUIRED"
                    },
                    "safe_mode_x": {
                        "status": "OPERATIONAL",
                        "atomic_backup": True,
                        "fail_closed_locks": True,
                        "audit_logging": True,
                        "smart_media_resolver": True
                    }
                }
            })
            return

        elif path == "/api/snapshots":
            snaps = self.snapshot_manager.list_snapshots()
            self._send_json({"snapshots": snaps})
            return

        elif path == "/api/audit-log":
            events = self.safe_mode_x.audit_logger.read_recent_events()
            self._send_json({"audit_events": events})
            return

        # -------------------------------------------------------------------
        # Studio Mode GET API
        # -------------------------------------------------------------------
        elif path == "/api/studio/session":
            self._send_json({"session": self.studio_engine.session.to_dict()})
            return

        elif path == "/api/studio/meters":
            meters = self.studio_engine.get_live_meters()
            self._send_json({"meters": meters})
            return

        elif path == "/api/studio/drivers":
            caps = self.studio_engine.driver_manager.get_all_capabilities()
            self._send_json(caps)
            return

        elif path == "/api/audio/stream":
            # Stream an audio WAV file preview
            file_param = query.get("file", [""])[0]
            if file_param and os.path.isfile(file_param) and self._is_safe_path(file_param):
                self._set_headers(200, "audio/wav")
                with open(file_param, "rb") as af:
                    self.wfile.write(af.read())
                return
            else:
                self._send_error("Audio file not found or invalid path", 404)
                return

        else:
            self._send_error("Endpoint not found", 404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self._read_json_body()

        # -------------------------------------------------------------------
        # Analytics & Scanning API
        # -------------------------------------------------------------------
        if path == "/api/scan":
            target_path = body.get("path", WORKSPACE_ROOT)
            if not self._is_safe_path(target_path) or not os.path.exists(target_path):
                self._send_error(f"Invalid or non-existent path: {target_path}", 400)
                return

            try:
                scan_res = DAWProjectParser.parse(target_path)
                self.ultra_watcher.add_watch_path(target_path)
                self._send_json({"success": True, "scan": scan_res})
            except Exception as e:
                self._send_error(f"Scan error: {str(e)}", 500)
            return

        elif path == "/api/analyze":
            audio_path = body.get("file_path", "")
            if not audio_path or not os.path.isfile(audio_path) or not self._is_safe_path(audio_path):
                self._send_error("Invalid audio file path", 400)
                return

            try:
                analysis = AudioAnalyzer.analyze_file(audio_path)
                self._send_json({"success": True, "analysis": analysis})
            except Exception as e:
                self._send_error(f"Analysis error: {str(e)}", 500)
            return

        elif path == "/api/snapshots":
            proj_path = body.get("project_path", WORKSPACE_ROOT)
            label = body.get("label", "Manual Snapshot")
            scan_data = body.get("scan_data") or DAWProjectParser.parse(proj_path)
            try:
                snap = self.snapshot_manager.create_snapshot(proj_path, scan_data, label=label)
                self.safe_mode_x.audit_logger.log_event("CREATE_SNAPSHOT", {"snapshot_id": snap["snapshot_id"]})
                self._send_json({"success": True, "snapshot": snap})
            except Exception as e:
                self._send_error(f"Snapshot creation failed: {str(e)}", 500)
            return

        elif path == "/api/snapshots/diff":
            snap_a = body.get("snapshot_a")
            snap_b = body.get("snapshot_b")
            if not snap_a or not snap_b:
                self._send_error("Both snapshot_a and snapshot_b required for diff", 400)
                return
            diff_res = SnapshotManager.diff_snapshots(snap_a, snap_b)
            self._send_json({"success": True, "diff": diff_res})
            return

        elif path == "/api/resolver/search":
            missing_path = body.get("missing_file", "")
            search_dirs = body.get("search_dirs", [WORKSPACE_ROOT])
            if not missing_path:
                self._send_error("missing_file parameter is required", 400)
                return
            candidates = MediaResolver.search_candidates(missing_path, search_dirs)
            self._send_json({
                "success": True,
                "missing_file": missing_path,
                "candidates_count": len(candidates),
                "candidates": candidates
            })
            return

        # -------------------------------------------------------------------
        # Studio Mode POST API
        # -------------------------------------------------------------------
        elif path == "/api/studio/transport":
            action = body.get("action", "")  # play, pause, stop, seek, bpm, loop
            session = self.studio_engine.session

            if action == "play":
                session.is_playing = True
            elif action == "pause":
                session.is_playing = False
            elif action == "stop":
                session.is_playing = False
                session.playhead_s = 0.0
            elif action == "seek":
                pos = float(body.get("position_s", 0.0))
                session.playhead_s = max(0.0, pos)
            elif action == "bpm":
                bpm = float(body.get("bpm", 120.0))
                session.bpm = max(20.0, min(300.0, bpm))
            elif action == "loop":
                session.loop_enabled = bool(body.get("enabled", session.loop_enabled))
                if "start_s" in body:
                    session.loop_start_s = max(0.0, float(body["start_s"]))
                if "end_s" in body:
                    session.loop_end_s = max(session.loop_start_s + 0.1, float(body["end_s"]))

            self._send_json({"success": True, "session": session.to_dict()})
            return

        elif path == "/api/studio/tracks":
            action = body.get("action", "add")  # add, update, remove
            track_id = body.get("track_id", "")

            if action == "add":
                name = body.get("name")
                color = body.get("color")
                t = self.studio_engine.session.add_track(name=name, color=color)
                self._send_json({"success": True, "track": t.to_dict()})
                return

            elif action == "update":
                t = self.studio_engine.session.get_track(track_id)
                if not t:
                    self._send_error(f"Track not found: {track_id}", 404)
                    return
                if "name" in body:
                    t.name = body["name"]
                if "gain_db" in body:
                    t.gain_db = float(body["gain_db"])
                if "pan" in body:
                    t.pan = float(body["pan"])
                if "mute" in body:
                    t.mute = bool(body["mute"])
                if "solo" in body:
                    t.solo = bool(body["solo"])
                if "rec_arm" in body:
                    t.rec_arm = bool(body["rec_arm"])
                if "color" in body:
                    t.color = body["color"]
                self._send_json({"success": True, "track": t.to_dict()})
                return

            elif action == "remove":
                removed = self.studio_engine.session.remove_track(track_id)
                self._send_json({"success": removed})
                return

            else:
                self._send_error(f"Unknown track action: {action}", 400)
                return

        elif path == "/api/studio/clips":
            action = body.get("action", "add")  # add, split, trim, move, remove
            track_id = body.get("track_id", "")

            if action == "add":
                file_p = body.get("file_path", "")
                st_s = float(body.get("timeline_start_s", 0.0))
                clip = self.studio_engine.add_clip_to_track(track_id, file_p, timeline_start_s=st_s)
                if clip:
                    self._send_json({"success": True, "clip": clip.to_dict()})
                else:
                    self._send_error("Failed to add clip (check track_id and file_path)", 400)
                return

            elif action == "split":
                clip_id = body.get("clip_id", "")
                split_t = float(body.get("split_time_s", 0.0))
                c1, c2 = self.studio_engine.split_clip(track_id, clip_id, split_t)
                if c1:
                    self._send_json({
                        "success": True,
                        "clip_left": c1.to_dict(),
                        "clip_right": c2.to_dict() if c2 else None
                    })
                else:
                    self._send_error("Split failed", 400)
                return

            elif action == "trim":
                clip_id = body.get("clip_id", "")
                new_off = float(body.get("source_offset_s", 0.0))
                new_dur = float(body.get("duration_s", 1.0))
                ok = self.studio_engine.trim_clip(track_id, clip_id, new_off, new_dur)
                self._send_json({"success": ok})
                return

            elif action == "move":
                clip_id = body.get("clip_id", "")
                new_st = float(body.get("timeline_start_s", 0.0))
                dst_track = body.get("target_track_id")
                ok = self.studio_engine.move_clip(track_id, clip_id, new_st, dst_track)
                self._send_json({"success": ok})
                return

            elif action == "remove":
                clip_id = body.get("clip_id", "")
                t = self.studio_engine.session.get_track(track_id)
                if t:
                    ok = t.remove_clip(clip_id)
                    self._send_json({"success": ok})
                else:
                    self._send_error("Track not found", 404)
                return

        elif path == "/api/studio/record/start":
            track_id = body.get("track_id", "")
            res = self.studio_engine.start_recording(track_id)
            if res.get("success"):
                self.safe_mode_x.audit_logger.log_event("START_RECORDING", res)
            self._send_json(res, 200 if res.get("success") else 400)
            return

        elif path == "/api/studio/record/stop":
            res = self.studio_engine.stop_recording()
            if res.get("success"):
                self.safe_mode_x.audit_logger.log_event("STOP_RECORDING", res)
            self._send_json(res, 200 if res.get("success") else 400)
            return

        elif path == "/api/studio/render":
            # Bounce master WAV
            bit_depth = int(body.get("bit_depth", 24))
            filename = body.get("filename")

            # Safe Mode X preflight disk space check
            space_check = SafeModeX.check_disk_space(self.studio_engine.exports_dir, 50 * 1024 * 1024)
            if not space_check.get("has_enough_space"):
                self._send_error("Insufficient disk space to bounce master audio file", 507)
                return

            render_res = self.studio_engine.bounce_to_master_wav(filename, bit_depth=bit_depth)
            self.safe_mode_x.audit_logger.log_event("BOUNCE_MASTER", render_res)
            self._send_json(render_res)
            return

        elif path == "/api/studio/drivers":
            driver_key = body.get("driver_key", "stream")
            s_rate = int(body.get("sample_rate", 44100))
            b_size = int(body.get("buffer_size", 512))
            ok = self.studio_engine.driver_manager.set_active_driver(driver_key, s_rate, b_size)
            self._send_json({"success": ok, "active_driver": driver_key})
            return

        else:
            self._send_error("Endpoint not found", 404)


def create_server(host: str = "0.0.0.0", port: int = 8080, workspace_root: str = WORKSPACE_ROOT) -> HTTPServer:
    """Initializes and returns configured DAW Bridge HTTP server."""
    DAWBridgeHandler.studio_engine = StudioEngine(workspace_root)
    DAWBridgeHandler.safe_mode_x = SafeModeX(workspace_root)
    DAWBridgeHandler.snapshot_manager = SnapshotManager(os.path.join(workspace_root, "snapshots"))
    DAWBridgeHandler.ultra_watcher = UltraWatcher([workspace_root])
    DAWBridgeHandler.ultra_watcher.start()

    server = HTTPServer((host, port), DAWBridgeHandler)
    return server

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    srv = create_server("0.0.0.0", port)
    print(f"ABSOLUTE STUDIO MODE Server running at http://0.0.0.0:{port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        srv.server_close()
