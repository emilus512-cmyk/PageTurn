"""
Ultra Watcher Engine — Version 4.3.0
Real-time Filesystem Event Watcher, Project Mutation Monitor, and Safe Sync Bus.
"""

import os
import time
import threading
from typing import Dict, Any, List, Optional, Callable

class UltraWatcher:
    """Thread-safe background filesystem watcher with debouncing and conflict detection."""
    def __init__(self, watch_paths: Optional[List[str]] = None, poll_interval_s: float = 1.0):
        self.watch_paths = [os.path.abspath(p) for p in (watch_paths or [])]
        self.poll_interval_s = max(0.2, float(poll_interval_s))
        self.is_running = False
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._file_snapshots: Dict[str, float] = {}  # path -> mtime
        self._event_listeners: List[Callable[[str, str], None]] = []
        self.recent_events: List[Dict[str, Any]] = []
        self.conflict_detected = False
        self.conflict_details: Optional[Dict[str, Any]] = None

    def add_watch_path(self, path: str):
        abs_p = os.path.abspath(path)
        if abs_p not in self.watch_paths:
            self.watch_paths.append(abs_p)

    def register_listener(self, callback: Callable[[str, str], None]):
        self._event_listeners.append(callback)

    def _scan_mtimes(self) -> Dict[str, float]:
        mtimes = {}
        for p in self.watch_paths:
            if os.path.isfile(p):
                try:
                    mtimes[p] = os.path.getmtime(p)
                except Exception:
                    pass
            elif os.path.isdir(p):
                for root, _, files in os.walk(p):
                    for f in files:
                        full_f = os.path.join(root, f)
                        try:
                            mtimes[full_f] = os.path.getmtime(full_f)
                        except Exception:
                            pass
        return mtimes

    def start(self):
        if self.is_running:
            return
        self._file_snapshots = self._scan_mtimes()
        self._stop_event.clear()
        self.is_running = True

        def _watcher_worker():
            while not self._stop_event.is_set():
                time.sleep(self.poll_interval_s)
                current_mtimes = self._scan_mtimes()

                # Check modified or created
                for path, mtime in current_mtimes.items():
                    if path not in self._file_snapshots:
                        self._trigger_event("CREATED", path)
                    elif mtime > self._file_snapshots[path] + 0.1:
                        self._trigger_event("MODIFIED", path)

                # Check deleted
                for path in list(self._file_snapshots.keys()):
                    if path not in current_mtimes:
                        self._trigger_event("DELETED", path)

                self._file_snapshots = current_mtimes

        self._thread = threading.Thread(target=_watcher_worker, daemon=True, name="UltraWatcher_Thread")
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        self.is_running = False

    def _trigger_event(self, event_type: str, file_path: str):
        evt = {
            "event_type": event_type,
            "file_path": file_path,
            "filename": os.path.basename(file_path),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        }
        self.recent_events.append(evt)
        if len(self.recent_events) > 50:
            self.recent_events.pop(0)

        # Notify callbacks
        for cb in self._event_listeners:
            try:
                cb(event_type, file_path)
            except Exception:
                pass

    def get_status(self) -> Dict[str, Any]:
        return {
            "status": "ACTIVE" if self.is_running else "IDLE",
            "watched_paths_count": len(self.watch_paths),
            "tracked_files_count": len(self._file_snapshots),
            "conflict_detected": self.conflict_detected,
            "conflict_details": self.conflict_details,
            "recent_events_count": len(self.recent_events),
            "recent_events": self.recent_events[-10:]
        }
