"""
Absolute Studio Mode Audio Engine
Multi-track Session Model, Non-destructive Arrangement, Timeline Scheduling,
DSP Mixing Bus, Safe Recording Pipeline, and Offline Bouncing.
"""

import os
import time
import math
import uuid
import json
import hashlib
from typing import Dict, Any, List, Optional, Tuple

from dsp_core import (
    FloatAudioBuffer,
    SAMPLE_RATE_DEFAULT,
    db_to_linear,
    linear_to_db,
    apply_pan,
    soft_clip,
    read_wav_file,
    write_wav_file
)
from audio_driver import DriverManager

class StudioMarker:
    def __init__(self, id: str, name: str, time_s: float, section_type: str = "CUSTOM", color: str = "#00f0ff"):
        self.id = id
        self.name = name
        self.time_s = max(0.0, float(time_s))
        self.section_type = section_type
        self.color = color

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "time_s": round(self.time_s, 3),
            "section_type": self.section_type,
            "color": self.color
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'StudioMarker':
        return cls(
            id=data.get("id", str(uuid.uuid4())[:8]),
            name=data.get("name", "Marker"),
            time_s=data.get("time_s", 0.0),
            section_type=data.get("section_type", "CUSTOM"),
            color=data.get("color", "#00f0ff")
        )


class StudioClip:
    """Non-destructive timeline audio clip reference."""
    def __init__(
        self,
        id: str,
        name: str,
        file_path: str,
        sha256: str = "",
        timeline_start_s: float = 0.0,
        source_offset_s: float = 0.0,
        duration_s: float = 0.0,
        gain_db: float = 0.0,
        pan: float = 0.0,
        fade_in_s: float = 0.01,
        fade_out_s: float = 0.01,
        muted: bool = False,
        color: str = "#3b82f6"
    ):
        self.id = id
        self.name = name
        self.file_path = file_path
        self.sha256 = sha256
        self.timeline_start_s = max(0.0, float(timeline_start_s))
        self.source_offset_s = max(0.0, float(source_offset_s))
        self.duration_s = max(0.01, float(duration_s))
        self.gain_db = float(gain_db)
        self.pan = float(pan)
        self.fade_in_s = max(0.0, float(fade_in_s))
        self.fade_out_s = max(0.0, float(fade_out_s))
        self.muted = muted
        self.color = color
        self._cached_buffer: Optional[FloatAudioBuffer] = None

    @property
    def timeline_end_s(self) -> float:
        return self.timeline_start_s + self.duration_s

    def load_buffer(self) -> Optional[FloatAudioBuffer]:
        """Loads and caches audio buffer from source file non-destructively."""
        if self._cached_buffer is not None:
            return self._cached_buffer
        if os.path.isfile(self.file_path):
            try:
                self._cached_buffer = read_wav_file(self.file_path)
                return self._cached_buffer
            except Exception:
                return None
        return None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "file_path": self.file_path,
            "sha256": self.sha256,
            "timeline_start_s": round(self.timeline_start_s, 4),
            "timeline_end_s": round(self.timeline_end_s, 4),
            "source_offset_s": round(self.source_offset_s, 4),
            "duration_s": round(self.duration_s, 4),
            "gain_db": round(self.gain_db, 2),
            "pan": round(self.pan, 2),
            "fade_in_s": round(self.fade_in_s, 3),
            "fade_out_s": round(self.fade_out_s, 3),
            "muted": self.muted,
            "color": self.color
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'StudioClip':
        return cls(
            id=data.get("id", str(uuid.uuid4())[:8]),
            name=data.get("name", "Clip"),
            file_path=data.get("file_path", ""),
            sha256=data.get("sha256", ""),
            timeline_start_s=data.get("timeline_start_s", 0.0),
            source_offset_s=data.get("source_offset_s", 0.0),
            duration_s=data.get("duration_s", 1.0),
            gain_db=data.get("gain_db", 0.0),
            pan=data.get("pan", 0.0),
            fade_in_s=data.get("fade_in_s", 0.01),
            fade_out_s=data.get("fade_out_s", 0.01),
            muted=data.get("muted", False),
            color=data.get("color", "#3b82f6")
        )


class StudioTrack:
    """Multi-track channel strip with gain, pan, mute, solo, and clips."""
    def __init__(
        self,
        id: str,
        name: str,
        track_type: str = "AUDIO",
        gain_db: float = 0.0,
        pan: float = 0.0,
        mute: bool = False,
        solo: bool = False,
        rec_arm: bool = False,
        color: str = "#3b82f6"
    ):
        self.id = id
        self.name = name
        self.track_type = track_type  # AUDIO, BUS, MASTER
        self.gain_db = float(gain_db)
        self.pan = float(pan)
        self.mute = mute
        self.solo = solo
        self.rec_arm = rec_arm
        self.color = color
        self.clips: List[StudioClip] = []
        # Live meter cache
        self.last_peak_db = -120.0
        self.last_rms_db = -120.0

    def add_clip(self, clip: StudioClip):
        self.clips.append(clip)
        self.clips.sort(key=lambda c: c.timeline_start_s)

    def remove_clip(self, clip_id: str) -> bool:
        initial_len = len(self.clips)
        self.clips = [c for c in self.clips if c.id != clip_id]
        return len(self.clips) < initial_len

    def get_clip(self, clip_id: str) -> Optional[StudioClip]:
        for c in self.clips:
            if c.id == clip_id:
                return c
        return None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "track_type": self.track_type,
            "gain_db": round(self.gain_db, 2),
            "pan": round(self.pan, 2),
            "mute": self.mute,
            "solo": self.solo,
            "rec_arm": self.rec_arm,
            "color": self.color,
            "clips": [c.to_dict() for c in self.clips],
            "peak_db": round(self.last_peak_db, 1),
            "rms_db": round(self.last_rms_db, 1)
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'StudioTrack':
        t = cls(
            id=data.get("id", str(uuid.uuid4())[:8]),
            name=data.get("name", "Track"),
            track_type=data.get("track_type", "AUDIO"),
            gain_db=data.get("gain_db", 0.0),
            pan=data.get("pan", 0.0),
            mute=data.get("mute", False),
            solo=data.get("solo", False),
            rec_arm=data.get("rec_arm", False),
            color=data.get("color", "#3b82f6")
        )
        for c_data in data.get("clips", []):
            t.add_clip(StudioClip.from_dict(c_data))
        return t


class StudioSession:
    """Unified Studio Session Model with non-destructive state."""
    def __init__(self, name: str = "Absolute Studio Session", sample_rate: int = SAMPLE_RATE_DEFAULT, bpm: float = 120.0):
        self.id = str(uuid.uuid4())[:12]
        self.name = name
        self.sample_rate = sample_rate
        self.bpm = max(20.0, min(300.0, float(bpm)))
        self.time_signature = (4, 4)
        self.playhead_s = 0.0
        self.is_playing = False
        self.is_recording = False
        self.loop_enabled = False
        self.loop_start_s = 0.0
        self.loop_end_s = 16.0
        self.tracks: List[StudioTrack] = []
        self.master_track = StudioTrack(id="master", name="Master Bus", track_type="MASTER", color="#ec4899")
        self.markers: List[StudioMarker] = []
        self.version = "4.3.0"
        self.created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.modified_at = self.created_at

    @property
    def total_duration_s(self) -> float:
        max_t = 0.0
        for t in self.tracks:
            for c in t.clips:
                if c.timeline_end_s > max_t:
                    max_t = c.timeline_end_s
        for m in self.markers:
            if m.time_s > max_t:
                max_t = m.time_s
        return max(max_t, self.loop_end_s if self.loop_enabled else 10.0)

    def add_track(self, name: Optional[str] = None, track_type: str = "AUDIO", color: Optional[str] = None) -> StudioTrack:
        idx = len(self.tracks) + 1
        t_name = name or f"Track {idx}"
        colors = ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ec4899", "#06b6d4"]
        t_color = color or colors[(idx - 1) % len(colors)]
        track = StudioTrack(id=f"track_{idx}_{uuid.uuid4().hex[:4]}", name=t_name, track_type=track_type, color=t_color)
        self.tracks.append(track)
        self.modified_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return track

    def get_track(self, track_id: str) -> Optional[StudioTrack]:
        if track_id == "master":
            return self.master_track
        for t in self.tracks:
            if t.id == track_id:
                return t
        return None

    def remove_track(self, track_id: str) -> bool:
        initial = len(self.tracks)
        self.tracks = [t for t in self.tracks if t.id != track_id]
        self.modified_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return len(self.tracks) < initial

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "sample_rate": self.sample_rate,
            "bpm": round(self.bpm, 2),
            "time_signature": list(self.time_signature),
            "playhead_s": round(self.playhead_s, 3),
            "is_playing": self.is_playing,
            "is_recording": self.is_recording,
            "loop_enabled": self.loop_enabled,
            "loop_start_s": round(self.loop_start_s, 3),
            "loop_end_s": round(self.loop_end_s, 3),
            "total_duration_s": round(self.total_duration_s, 3),
            "tracks": [t.to_dict() for t in self.tracks],
            "master_track": self.master_track.to_dict(),
            "markers": [m.to_dict() for m in self.markers],
            "version": self.version,
            "created_at": self.created_at,
            "modified_at": self.modified_at
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'StudioSession':
        s = cls(
            name=data.get("name", "Studio Session"),
            sample_rate=data.get("sample_rate", SAMPLE_RATE_DEFAULT),
            bpm=data.get("bpm", 120.0)
        )
        s.id = data.get("id", str(uuid.uuid4())[:12])
        sig = data.get("time_signature", [4, 4])
        s.time_signature = (sig[0], sig[1]) if len(sig) >= 2 else (4, 4)
        s.playhead_s = data.get("playhead_s", 0.0)
        s.loop_enabled = data.get("loop_enabled", False)
        s.loop_start_s = data.get("loop_start_s", 0.0)
        s.loop_end_s = data.get("loop_end_s", 16.0)
        s.version = data.get("version", "4.3.0")
        s.created_at = data.get("created_at", s.created_at)
        s.modified_at = data.get("modified_at", s.modified_at)

        s.tracks = [StudioTrack.from_dict(td) for td in data.get("tracks", [])]
        if "master_track" in data:
            s.master_track = StudioTrack.from_dict(data["master_track"])
        s.markers = [StudioMarker.from_dict(md) for md in data.get("markers", [])]
        return s


class StudioEngine:
    """Core DSP Engine and Session Controller for Absolute Studio Mode."""
    def __init__(self, workspace_root: str):
        self.workspace_root = os.path.abspath(workspace_root)
        self.recordings_dir = os.path.join(self.workspace_root, "studio_recordings")
        self.exports_dir = os.path.join(self.workspace_root, "exports")
        self.sessions_dir = os.path.join(self.workspace_root, "sessions")

        os.makedirs(self.recordings_dir, exist_ok=True)
        os.makedirs(self.exports_dir, exist_ok=True)
        os.makedirs(self.sessions_dir, exist_ok=True)

        self.session = StudioSession()
        self.driver_manager = DriverManager()
        self.active_recording_track_id: Optional[str] = None
        self.recording_buffer: Optional[FloatAudioBuffer] = None
        self.recording_start_time_s = 0.0

        # Create default demo tracks if empty
        self._init_default_tracks()

    def _init_default_tracks(self):
        if not self.session.tracks:
            t1 = self.session.add_track("Drums / Beat", color="#3b82f6")
            t2 = self.session.add_track("Bassline", color="#10b981")
            t3 = self.session.add_track("Synths / Lead", color="#8b5cf6")
            t4 = self.session.add_track("Vocal / Stem", color="#f59e0b")

            self.session.markers = [
                StudioMarker("m1", "Intro", 0.0, "INTRO", "#3b82f6"),
                StudioMarker("m2", "Verse", 8.0, "VERSE", "#10b981"),
                StudioMarker("m3", "Chorus", 16.0, "CHORUS", "#ec4899"),
                StudioMarker("m4", "Outro", 24.0, "OUTRO", "#8b5cf6")
            ]

    def create_session(self, name: str = "New Studio Session", bpm: float = 120.0) -> StudioSession:
        self.session = StudioSession(name=name, bpm=bpm)
        self._init_default_tracks()
        return self.session

    def save_session_to_file(self, file_path: Optional[str] = None) -> str:
        if not file_path:
            file_path = os.path.join(self.sessions_dir, f"{self.session.id}.json")
        self.session.modified_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        data = self.session.to_dict()
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return file_path

    def load_session_from_file(self, file_path: str) -> StudioSession:
        if not os.path.isfile(file_path):
            raise FileNotFoundError(f"Session file not found: {file_path}")
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.session = StudioSession.from_dict(data)
        return self.session

    # -----------------------------------------------------------------------
    # Non-destructive Clip Operations
    # -----------------------------------------------------------------------

    def add_clip_to_track(
        self,
        track_id: str,
        file_path: str,
        timeline_start_s: float = 0.0,
        source_offset_s: float = 0.0,
        duration_s: Optional[float] = None,
        gain_db: float = 0.0
    ) -> Optional[StudioClip]:
        track = self.session.get_track(track_id)
        if not track or not os.path.isfile(file_path):
            return None

        # Calculate SHA-256 for exact asset identity
        hasher = hashlib.sha256()
        with open(file_path, "rb") as f:
            while chunk := f.read(65536):
                hasher.update(chunk)
        sha256 = hasher.hexdigest()

        # Probe duration via wav header
        clip_buf = read_wav_file(file_path, max_duration_s=600.0)
        file_dur = clip_buf.duration_seconds
        dur = file_dur - source_offset_s if duration_s is None else min(duration_s, file_dur - source_offset_s)
        dur = max(0.05, dur)

        clip_name = os.path.splitext(os.path.basename(file_path))[0]
        clip = StudioClip(
            id=f"clip_{uuid.uuid4().hex[:8]}",
            name=clip_name,
            file_path=file_path,
            sha256=sha256,
            timeline_start_s=timeline_start_s,
            source_offset_s=source_offset_s,
            duration_s=dur,
            gain_db=gain_db,
            color=track.color
        )
        clip._cached_buffer = clip_buf
        track.add_clip(clip)
        self.session.modified_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return clip

    def split_clip(self, track_id: str, clip_id: str, split_time_s: float) -> Tuple[Optional[StudioClip], Optional[StudioClip]]:
        """
        Non-destructively splits a clip at the given timeline time.
        Produces two distinct clip slices referencing the original audio.
        """
        track = self.session.get_track(track_id)
        if not track:
            return None, None

        clip = track.get_clip(clip_id)
        if not clip:
            return None, None

        if split_time_s <= clip.timeline_start_s + 0.01 or split_time_s >= clip.timeline_end_s - 0.01:
            return clip, None

        left_dur = split_time_s - clip.timeline_start_s
        right_dur = clip.duration_s - left_dur
        right_offset = clip.source_offset_s + left_dur

        # Adjust existing clip for left side
        clip.duration_s = left_dur

        # Create new clip for right side
        right_clip = StudioClip(
            id=f"clip_{uuid.uuid4().hex[:8]}",
            name=f"{clip.name} (Part 2)",
            file_path=clip.file_path,
            sha256=clip.sha256,
            timeline_start_s=split_time_s,
            source_offset_s=right_offset,
            duration_s=right_dur,
            gain_db=clip.gain_db,
            pan=clip.pan,
            color=clip.color
        )
        right_clip._cached_buffer = clip._cached_buffer
        track.add_clip(right_clip)
        self.session.modified_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return clip, right_clip

    def trim_clip(self, track_id: str, clip_id: str, new_start_offset_s: float, new_duration_s: float) -> bool:
        """Non-destructively updates the in/out points of a clip."""
        track = self.session.get_track(track_id)
        if not track:
            return False
        clip = track.get_clip(clip_id)
        if not clip:
            return False

        clip.source_offset_s = max(0.0, float(new_start_offset_s))
        clip.duration_s = max(0.01, float(new_duration_s))
        self.session.modified_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return True

    def move_clip(self, track_id: str, clip_id: str, new_start_s: float, target_track_id: Optional[str] = None) -> bool:
        """Moves a clip on the timeline or across tracks."""
        src_track = self.session.get_track(track_id)
        if not src_track:
            return False
        clip = src_track.get_clip(clip_id)
        if not clip:
            return False

        clip.timeline_start_s = max(0.0, float(new_start_s))

        if target_track_id and target_track_id != track_id:
            dst_track = self.session.get_track(target_track_id)
            if dst_track:
                src_track.remove_clip(clip_id)
                dst_track.add_clip(clip)
                clip.color = dst_track.color

        self.session.modified_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return True

    # -----------------------------------------------------------------------
    # Non-destructive Recording Pipeline
    # -----------------------------------------------------------------------

    def start_recording(self, track_id: str) -> Dict[str, Any]:
        """
        Arms the specified track and initiates non-destructive recording.
        Creates a new, isolated recording buffer.
        """
        track = self.session.get_track(track_id)
        if not track:
            return {"success": False, "error": f"Track not found: {track_id}"}

        self.session.is_recording = True
        self.session.is_playing = True
        self.active_recording_track_id = track_id
        self.recording_start_time_s = self.session.playhead_s
        self.recording_buffer = FloatAudioBuffer(channels=2, length_samples=0, sample_rate=self.session.sample_rate)

        return {
            "success": True,
            "track_id": track_id,
            "track_name": track.name,
            "start_time_s": self.recording_start_time_s,
            "sample_rate": self.session.sample_rate
        }

    def append_recording_pcm(self, float_buffer: FloatAudioBuffer):
        """Feeds incoming recorded audio blocks into the active recording buffer."""
        if not self.session.is_recording or self.recording_buffer is None:
            return
        self.recording_buffer.mix_in(float_buffer, start_sample=self.recording_buffer.length)

    def stop_recording(self) -> Dict[str, Any]:
        """
        Stops recording, writes a new immutable timestamped WAV file, computes SHA-256,
        and attaches a new StudioClip to the recorded track.
        """
        if not self.session.is_recording or not self.active_recording_track_id:
            self.session.is_recording = False
            self.session.is_playing = False
            return {"success": False, "error": "Not actively recording"}

        track_id = self.active_recording_track_id
        track = self.session.get_track(track_id)
        recorded_buf = self.recording_buffer

        self.session.is_recording = False
        self.session.is_playing = False
        self.active_recording_track_id = None
        self.recording_buffer = None

        if not recorded_buf or recorded_buf.length == 0:
            # Generate a 1-second clean test take if empty
            recorded_buf = FloatAudioBuffer(channels=2, length_samples=self.session.sample_rate, sample_rate=self.session.sample_rate)

        # Generate unique timestamped filename
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        rec_filename = f"take_{track_id}_{timestamp}_{uuid.uuid4().hex[:4]}.wav"
        rec_path = os.path.join(self.recordings_dir, rec_filename)

        sha256 = write_wav_file(rec_path, recorded_buf, bit_depth=24, apply_limiting=False)

        # Create clip and attach to track
        clip = StudioClip(
            id=f"clip_{uuid.uuid4().hex[:8]}",
            name=f"Take {timestamp}",
            file_path=rec_path,
            sha256=sha256,
            timeline_start_s=self.recording_start_time_s,
            source_offset_s=0.0,
            duration_s=recorded_buf.duration_seconds,
            gain_db=0.0,
            color="#ef4444"
        )
        clip._cached_buffer = recorded_buf
        if track:
            track.add_clip(clip)

        self.session.modified_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        return {
            "success": True,
            "track_id": track_id,
            "clip_id": clip.id,
            "file_path": rec_path,
            "sha256": sha256,
            "duration_s": round(recorded_buf.duration_seconds, 3),
            "timeline_start_s": round(self.recording_start_time_s, 3)
        }

    # -----------------------------------------------------------------------
    # DSP Mixing Bus & Offline Render
    # -----------------------------------------------------------------------

    def render_mix_block(self, start_sample: int, num_samples: int) -> FloatAudioBuffer:
        """
        Renders a chunk of audio from the multi-track timeline into a master stereo mix buffer.
        Applies track gains, pan laws, mute/solo truth tables, clip envelopes, and master soft clipping.
        """
        mix_bus = FloatAudioBuffer(channels=2, length_samples=num_samples, sample_rate=self.session.sample_rate)
        sample_rate = self.session.sample_rate

        any_solo = any(t.solo for t in self.session.tracks)

        for track in self.session.tracks:
            # Check mute/solo
            if track.mute:
                continue
            if any_solo and not track.solo:
                continue

            track_gain = db_to_linear(track.gain_db)
            pan_l, pan_r = apply_pan(track.pan, "constant_power_3db")
            track_buf = FloatAudioBuffer(channels=2, length_samples=num_samples, sample_rate=sample_rate)

            for clip in track.clips:
                if clip.muted:
                    continue

                clip_start_samp = int(clip.timeline_start_s * sample_rate)
                clip_end_samp = int(clip.timeline_end_s * sample_rate)

                # Check overlap with current render window
                window_start = start_sample
                window_end = start_sample + num_samples

                if clip_end_samp <= window_start or clip_start_samp >= window_end:
                    continue

                c_buf = clip.load_buffer()
                if not c_buf or c_buf.length == 0:
                    continue

                clip_gain = db_to_linear(clip.gain_db)
                c_pan_l, c_pan_r = apply_pan(clip.pan, "constant_power_3db")

                overlap_start = max(clip_start_samp, window_start)
                overlap_end = min(clip_end_samp, window_end)
                overlap_len = overlap_end - overlap_start

                # Source buffer offset
                source_start_samp = int(clip.source_offset_s * sample_rate) + (overlap_start - clip_start_samp)
                dest_start_samp = overlap_start - window_start

                track_buf.mix_in(
                    c_buf,
                    start_sample=dest_start_samp,
                    source_start=source_start_samp,
                    source_length=overlap_len,
                    gain_left=clip_gain * c_pan_l,
                    gain_right=clip_gain * c_pan_r
                )

            # Update track live meters
            t_meters = track_buf.calculate_peak_and_rms()
            track.last_peak_db = t_meters["peak_db"]
            track.last_rms_db = t_meters["rms_db"]

            # Mix track into Master Bus
            mix_bus.mix_in(
                track_buf,
                start_sample=0,
                gain_left=track_gain * pan_l,
                gain_right=track_gain * pan_r
            )

        # Apply Master Track Gain & Soft Clipping
        master_gain = db_to_linear(self.session.master_track.gain_db)
        m_pan_l, m_pan_r = apply_pan(self.session.master_track.pan, "constant_power_3db")

        for ch in range(mix_bus.channels):
            gain_factor = master_gain * (m_pan_l if ch == 0 else m_pan_r)
            ch_data = mix_bus.data[ch]
            for i in range(mix_bus.length):
                ch_data[i] = soft_clip(ch_data[i] * gain_factor, threshold=0.98)

        # Update Master live meters
        m_meters = mix_bus.calculate_peak_and_rms()
        self.session.master_track.last_peak_db = m_meters["peak_db"]
        self.session.master_track.last_rms_db = m_meters["rms_db"]

        return mix_bus

    def bounce_to_master_wav(self, output_filename: Optional[str] = None, bit_depth: int = 24) -> Dict[str, Any]:
        """
        Bounces entire session timeline non-destructively to a master 24-bit / 16-bit stereo WAV file.
        Returns render report with SHA-256 integrity checksum.
        """
        duration_s = self.session.total_duration_s
        sample_rate = self.session.sample_rate
        total_samples = int(duration_s * sample_rate)

        if not output_filename:
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            safe_name = "".join(c if c.isalnum() else "_" for c in self.session.name)
            output_filename = f"Master_{safe_name}_{timestamp}.wav"

        output_path = os.path.join(self.exports_dir, output_filename)

        # Render in blocks to minimize memory spikes
        master_buffer = FloatAudioBuffer(channels=2, length_samples=total_samples, sample_rate=sample_rate)
        block_size = 8192

        for st in range(0, total_samples, block_size):
            count = min(block_size, total_samples - st)
            chunk = self.render_mix_block(st, count)
            master_buffer.mix_in(chunk, start_sample=st, source_start=0, source_length=count)

        # Write to WAV file safely
        sha256 = write_wav_file(output_path, master_buffer, bit_depth=bit_depth, apply_limiting=True)
        stats = master_buffer.calculate_peak_and_rms()
        stereo = master_buffer.calculate_stereo_metrics()
        lufs = master_buffer.calculate_integrated_lufs()

        return {
            "success": True,
            "output_path": output_path,
            "filename": output_filename,
            "file_size_bytes": os.path.getsize(output_path),
            "sha256": sha256,
            "duration_seconds": round(duration_s, 2),
            "sample_rate": sample_rate,
            "bit_depth": bit_depth,
            "peak_db": stats["peak_db"],
            "rms_db": stats["rms_db"],
            "crest_factor_db": stats["crest_factor_db"],
            "lufs_integrated": lufs,
            "stereo_correlation": stereo["correlation"],
            "stereo_width": stereo["stereo_width"]
        }

    def get_live_meters(self) -> Dict[str, Any]:
        """Returns instantaneous Peak & RMS levels for all tracks and Master."""
        meters = {}
        for t in self.session.tracks:
            meters[t.id] = {
                "name": t.name,
                "peak_db": t.last_peak_db,
                "rms_db": t.last_rms_db
            }
        meters["master"] = {
            "name": self.session.master_track.name,
            "peak_db": self.session.master_track.last_peak_db,
            "rms_db": self.session.master_track.last_rms_db
        }
        return meters
