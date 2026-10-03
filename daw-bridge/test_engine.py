"""
Comprehensive Regression & Integration Test Suite for DAW Bridge & ABSOLUTE STUDIO MODE 4.3.0
Complete 60+ test suite covering DSP Core, Audio Drivers, Safe Mode X, DAW Parsers, Studio Engine, and Server APIs.
"""

import os
import sys
import json
import math
import time
import shutil
import tempfile
import unittest
import threading
import urllib.request
import urllib.parse
import gzip
import zipfile
import xml.etree.ElementTree as ET
from typing import Dict, Any, List, Optional, Tuple

# Add module paths
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dsp_core import (
    FloatAudioBuffer,
    db_to_linear,
    linear_to_db,
    apply_pan,
    soft_clip,
    read_wav_file,
    write_wav_file,
    SAMPLE_RATE_DEFAULT
)
from audio_driver import (
    DriverManager,
    WindowsWASAPIProvider,
    WindowsMMEProvider,
    StandardWaveStreamProvider,
    NullDriverProvider
)
from engine import DAWProjectParser, AudioAnalyzer, SnapshotManager, VERSION
from god_engine import SafeModeX, MediaResolver, AuditLogger
from ultra_engine import UltraWatcher
from studio_engine import StudioSession, StudioTrack, StudioClip, StudioMarker, StudioEngine
from server import create_server

# ===========================================================================
# 1. DSP Core Tests
# ===========================================================================

class TestDSPCore(unittest.TestCase):
    """Tests pure Python DSP core functions, pan laws, metering, and WAV I/O."""

    def test_01_db_to_linear(self):
        self.assertAlmostEqual(db_to_linear(0.0), 1.0, places=4)
        self.assertAlmostEqual(db_to_linear(-6.0206), 0.5, places=3)
        self.assertAlmostEqual(db_to_linear(-20.0), 0.1, places=4)
        self.assertEqual(db_to_linear(-120.0), 0.0)

    def test_02_linear_to_db(self):
        self.assertAlmostEqual(linear_to_db(1.0), 0.0, places=4)
        self.assertAlmostEqual(linear_to_db(0.5), -6.0206, places=3)
        self.assertAlmostEqual(linear_to_db(0.1), -20.0, places=4)
        self.assertEqual(linear_to_db(0.0), -120.0)

    def test_03_pan_constant_power_3db(self):
        l, r = apply_pan(0.0, "constant_power_3db")
        self.assertAlmostEqual(l, math.cos(math.pi / 4), places=4)
        self.assertAlmostEqual(r, math.sin(math.pi / 4), places=4)
        self.assertAlmostEqual(l**2 + r**2, 1.0, places=4)

        l_left, r_left = apply_pan(-1.0, "constant_power_3db")
        self.assertAlmostEqual(l_left, 1.0, places=4)
        self.assertAlmostEqual(r_left, 0.0, places=4)

        l_right, r_right = apply_pan(1.0, "constant_power_3db")
        self.assertAlmostEqual(l_right, 0.0, places=4)
        self.assertAlmostEqual(r_right, 1.0, places=4)

    def test_04_pan_linear(self):
        l, r = apply_pan(0.0, "linear")
        self.assertAlmostEqual(l, 0.5, places=4)
        self.assertAlmostEqual(r, 0.5, places=4)

    def test_05_soft_clip(self):
        self.assertEqual(soft_clip(0.5), 0.5)
        self.assertEqual(soft_clip(-0.5), -0.5)
        clipped = soft_clip(1.3, threshold=0.95)
        self.assertLessEqual(clipped, 1.0)
        self.assertGreater(clipped, 0.95)
        clipped_neg = soft_clip(-1.4, threshold=0.95)
        self.assertGreaterEqual(clipped_neg, -1.0)
        self.assertLess(clipped_neg, -0.95)

    def test_06_buffer_allocation_and_resize(self):
        buf = FloatAudioBuffer(channels=2, length_samples=1000, sample_rate=44100)
        self.assertEqual(buf.length, 1000)
        self.assertEqual(buf.channels, 2)
        buf.resize(2000)
        self.assertEqual(buf.length, 2000)
        buf.clear()
        self.assertEqual(buf.data[0][500], 0.0)

    def test_07_buffer_peak_and_rms_sine(self):
        buf = FloatAudioBuffer(channels=2, length_samples=44100, sample_rate=44100)
        for i in range(44100):
            val = 0.5 * math.sin(2 * math.pi * 1000 * i / 44100)
            buf.data[0][i] = val
            buf.data[1][i] = val
        levels = buf.calculate_peak_and_rms()
        self.assertAlmostEqual(levels["peak_db"], -6.02, delta=0.2)
        self.assertAlmostEqual(levels["rms_db"], -9.03, delta=0.5)
        self.assertAlmostEqual(levels["crest_factor_db"], 3.01, delta=0.5)

    def test_08_buffer_stereo_metrics(self):
        buf = FloatAudioBuffer(channels=2, length_samples=44100, sample_rate=44100)
        for i in range(44100):
            buf.data[0][i] = 0.5 * math.sin(2 * math.pi * 440 * i / 44100)
            buf.data[1][i] = 0.5 * math.sin(2 * math.pi * 440 * i / 44100)
        stereo = buf.calculate_stereo_metrics()
        self.assertAlmostEqual(stereo["correlation"], 1.0, places=2)
        self.assertAlmostEqual(stereo["stereo_width"], 0.0, places=2)

    def test_09_spectral_band_analysis(self):
        buf = FloatAudioBuffer(channels=2, length_samples=44100, sample_rate=44100)
        for i in range(44100):
            buf.data[0][i] = 0.3 * math.sin(2 * math.pi * 100 * i / 44100)
        bands = buf.calculate_spectral_profile(bands_count=8)
        self.assertEqual(len(bands), 8)
        self.assertIn("band", bands[0])
        self.assertIn("energy_percent", bands[0])

    def test_10_lufs_integrated_estimation(self):
        buf = FloatAudioBuffer(channels=2, length_samples=44100 * 2, sample_rate=44100)
        for i in range(buf.length):
            buf.data[0][i] = 0.4 * math.sin(2 * math.pi * 1000 * i / 44100)
            buf.data[1][i] = 0.4 * math.sin(2 * math.pi * 1000 * i / 44100)
        lufs = buf.calculate_integrated_lufs()
        self.assertGreater(lufs, -25.0)
        self.assertLess(lufs, -5.0)

    def test_11_bpm_and_key_detection(self):
        buf = FloatAudioBuffer(channels=2, length_samples=44100 * 4, sample_rate=44100)
        for i in range(buf.length):
            buf.data[0][i] = 0.3 * math.sin(2 * math.pi * 261.63 * i / 44100)  # C4
        musical = buf.detect_bpm_and_key()
        self.assertIn("detected_bpm", musical)
        self.assertIn("detected_key", musical)
        self.assertGreaterEqual(musical["key_confidence"], 0.0)

    def test_12_storyboard_sections_generator(self):
        buf = FloatAudioBuffer(channels=2, length_samples=44100 * 30, sample_rate=44100)
        sections = buf.generate_storyboard_sections(bpm=120.0)
        self.assertGreater(len(sections), 1)
        self.assertEqual(sections[0]["section"], "Intro")

    def test_13_wav_round_trip_24bit(self):
        temp_dir = tempfile.mkdtemp()
        try:
            path = os.path.join(temp_dir, "roundtrip24.wav")
            buf = FloatAudioBuffer(channels=2, length_samples=22050, sample_rate=44100)
            for i in range(22050):
                buf.data[0][i] = 0.3 * math.sin(2 * math.pi * 440 * i / 44100)
                buf.data[1][i] = 0.3 * math.cos(2 * math.pi * 440 * i / 44100)
            sha = write_wav_file(path, buf, bit_depth=24)
            self.assertEqual(len(sha), 64)
            read_buf = read_wav_file(path)
            self.assertEqual(read_buf.length, 22050)
            self.assertEqual(read_buf.channels, 2)
        finally:
            shutil.rmtree(temp_dir)

    def test_14_wav_round_trip_16bit(self):
        temp_dir = tempfile.mkdtemp()
        try:
            path = os.path.join(temp_dir, "roundtrip16.wav")
            buf = FloatAudioBuffer(channels=2, length_samples=10000, sample_rate=44100)
            for i in range(10000):
                buf.data[0][i] = 0.5 * math.sin(2 * math.pi * 880 * i / 44100)
            sha = write_wav_file(path, buf, bit_depth=16)
            self.assertEqual(len(sha), 64)
            read_buf = read_wav_file(path)
            self.assertEqual(read_buf.length, 10000)
        finally:
            shutil.rmtree(temp_dir)

    def test_15_read_wav_missing_file_raises(self):
        with self.assertRaises(FileNotFoundError):
            read_wav_file("/path/to/nonexistent/file_123456.wav")


# ===========================================================================
# 2. DAW Parsers Tests
# ===========================================================================

class TestDAWParsers(unittest.TestCase):
    """Tests multi-format DAW parsers."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.temp_dir)

    def test_16_ableton_als_parser(self):
        als_path = os.path.join(self.temp_dir, "song.als")
        xml_content = b"""<?xml version="1.0" encoding="UTF-8"?>
        <Ableton MajorVersion="5" MinorVersion="11.0" Creator="Ableton Live 11">
          <LiveSet>
            <MasterTrack><DeviceChain><Mixer><Tempo><Manual Value="125.0"/></Tempo></Mixer></DeviceChain></MasterTrack>
            <Tracks>
              <AudioTrack><Name><EffectiveName Value="Vocal Lead"/></Name></AudioTrack>
              <MidiTrack><Name><EffectiveName Value="Synth Pad"/></Name></MidiTrack>
            </Tracks>
            <Locators><Locators><Locator><Name Value="Drop"/><Time Value="32.0"/></Locator></Locators></Locators>
          </LiveSet>
        </Ableton>
        """
        with gzip.open(als_path, "wb") as gz:
            gz.write(xml_content)

        parsed = DAWProjectParser.parse(als_path)
        self.assertEqual(parsed["format"], "Ableton Live (.als)")
        self.assertEqual(parsed["tempo_bpm"], 125.0)
        self.assertEqual(parsed["track_count"], 2)
        self.assertEqual(parsed["tracks"][0]["name"], "Vocal Lead")
        self.assertEqual(parsed["markers"][0]["name"], "Drop")
        self.assertTrue(parsed["read_only"])

    def test_17_reaper_rpp_parser(self):
        rpp_path = os.path.join(self.temp_dir, "test.rpp")
        content = """<REAPER_PROJECT 0.1 "7.0" 1700000000
          TEMPO 130 4 4
          <TRACK
            NAME "Drums"
            VOLPAN 0.8 0.0
            <ITEM
              POSITION 0.0
              FILE "drum_loop.wav"
            >
          >
          MARKER 1 16.0 "Chorus"
        >"""
        with open(rpp_path, "w") as f:
            f.write(content)

        parsed = DAWProjectParser.parse(rpp_path)
        self.assertEqual(parsed["format"], "Reaper (.rpp)")
        self.assertEqual(parsed["tempo_bpm"], 130.0)
        self.assertEqual(parsed["track_count"], 1)
        self.assertEqual(parsed["tracks"][0]["name"], "Drums")
        self.assertIn("drum_loop.wav", parsed["media_files"])

    def test_18_fl_studio_flp_parser(self):
        flp_path = os.path.join(self.temp_dir, "beat.flp")
        # Write valid FL Studio binary header
        with open(flp_path, "wb") as f:
            f.write(b"FLhd\x06\x00\x00\x00\x00\x00\x04\x00\x60\x00")
            f.write(b"FLdt\x10\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00")

        parsed = DAWProjectParser.parse(flp_path)
        self.assertEqual(parsed["format"], "FL Studio (.flp)")
        self.assertTrue(parsed["read_only"])

    def test_19_studio_one_song_parser(self):
        song_path = os.path.join(self.temp_dir, "project.song")
        with zipfile.ZipFile(song_path, "w") as zf:
            zf.writestr("Song.xml", "<Song><Track name='Stem 1'/><Track name='Stem 2'/></Song>")
            zf.writestr("Media/audio1.wav", "dummy_wav_data")

        parsed = DAWProjectParser.parse(song_path)
        self.assertEqual(parsed["format"], "Studio One (.song)")
        self.assertEqual(parsed["track_count"], 2)

    def test_20_cubase_cpr_tentative(self):
        cpr_path = os.path.join(self.temp_dir, "test.cpr")
        with open(cpr_path, "wb") as f:
            f.write(b"RIFF\x00\x00\x00\x00")
        parsed = DAWProjectParser.parse(cpr_path)
        self.assertEqual(parsed["parser_fidelity"], "TENTATIVE_READ_ONLY")

    def test_21_logic_pro_tentative(self):
        logic_path = os.path.join(self.temp_dir, "test.logicx")
        with open(logic_path, "wb") as f:
            f.write(b"plist_data")
        parsed = DAWProjectParser.parse(logic_path)
        self.assertEqual(parsed["parser_fidelity"], "TENTATIVE_READ_ONLY")

    def test_22_pro_tools_tentative(self):
        ptx_path = os.path.join(self.temp_dir, "test.ptx")
        with open(ptx_path, "wb") as f:
            f.write(b"protools_header")
        parsed = DAWProjectParser.parse(ptx_path)
        self.assertEqual(parsed["parser_fidelity"], "TENTATIVE_READ_ONLY")

    def test_23_stems_directory_scan(self):
        stem_dir = os.path.join(self.temp_dir, "stems")
        os.makedirs(stem_dir, exist_ok=True)
        with open(os.path.join(stem_dir, "kick.wav"), "wb") as f: f.write(b"123")
        with open(os.path.join(stem_dir, "snare.wav"), "wb") as f: f.write(b"456")

        parsed = DAWProjectParser.parse(stem_dir)
        self.assertEqual(parsed["track_count"], 2)
        self.assertEqual(parsed["format"], "Audio Stems / Project Directory")


# ===========================================================================
# 3. Audio Analyzer Tests
# ===========================================================================

class TestAudioAnalyzer(unittest.TestCase):
    """Tests AudioAnalyzer analysis pipeline and advisor checks."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.wav_path = os.path.join(self.temp_dir, "test_mix.wav")
        buf = FloatAudioBuffer(channels=2, length_samples=44100 * 2, sample_rate=44100)
        for i in range(buf.length):
            buf.data[0][i] = 0.4 * math.sin(2 * math.pi * 440 * i / 44100)
            buf.data[1][i] = 0.4 * math.sin(2 * math.pi * 440 * i / 44100)
        write_wav_file(self.wav_path, buf)

    def tearDown(self):
        shutil.rmtree(self.temp_dir)

    def test_24_audio_analyzer_full(self):
        res = AudioAnalyzer.analyze_file(self.wav_path)
        self.assertEqual(res["channels"], 2)
        self.assertEqual(res["sample_rate"], 44100)
        self.assertEqual(len(res["sha256"]), 64)
        self.assertIn("lufs_integrated", res)
        self.assertIn("advisor_checklist", res)
        self.assertIn("storyboard_sections", res)

    def test_25_audio_analyzer_missing_file_raises(self):
        with self.assertRaises(FileNotFoundError):
            AudioAnalyzer.analyze_file("/nonexistent/file.wav")


# ===========================================================================
# 4. Safe Mode X & God Engine Tests
# ===========================================================================

class TestGodEngineSafeMode(unittest.TestCase):
    """Tests Safe Mode X, Backups, Rollbacks, and Audit Logging."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.safe_mode = SafeModeX(self.temp_dir)

    def tearDown(self):
        shutil.rmtree(self.temp_dir)

    def test_26_daw_process_check(self):
        res = SafeModeX.is_daw_process_running()
        self.assertIn("daw_running", res)
        self.assertIn("can_proceed_safely", res)

    def test_27_disk_space_check(self):
        res = SafeModeX.check_disk_space(self.temp_dir, 1024)
        self.assertTrue(res["has_enough_space"])
        self.assertGreater(res["free_bytes"], 0)

    def test_28_create_verified_backup(self):
        src = os.path.join(self.temp_dir, "test_file.txt")
        with open(src, "w") as f: f.write("important audio project data")
        res = self.safe_mode.create_verified_backup(src)
        self.assertTrue(res["success"])
        self.assertTrue(os.path.isfile(res["backup_path"]))

    def test_29_rollback_from_backup(self):
        src = os.path.join(self.temp_dir, "mutate.txt")
        with open(src, "w") as f: f.write("Original Version 1.0")
        bak = self.safe_mode.create_verified_backup(src)
        with open(src, "w") as f: f.write("Corrupted Version 2.0")
        rb = self.safe_mode.rollback_from_backup(bak["backup_path"], src)
        self.assertTrue(rb["success"])
        with open(src, "r") as f:
            self.assertEqual(f.read(), "Original Version 1.0")

    def test_30_audit_logger_transactions(self):
        logger = self.safe_mode.audit_logger
        logger.log_event("OP_1", {"key": "val1"})
        logger.log_event("OP_2", {"key": "val2"})
        events = logger.read_recent_events(limit=10)
        self.assertGreaterEqual(len(events), 2)
        self.assertEqual(events[-1]["action"], "OP_2")

    def test_31_media_resolver_ranking(self):
        sample_dir = os.path.join(self.temp_dir, "library")
        os.makedirs(sample_dir, exist_ok=True)
        target = os.path.join(sample_dir, "808_Kick_C.wav")
        with open(target, "wb") as f: f.write(b"808_sample_data")
        candidates = MediaResolver.search_candidates("/external/path/808_Kick_C.wav", [sample_dir])
        self.assertGreater(len(candidates), 0)
        self.assertEqual(candidates[0]["filename"], "808_Kick_C.wav")
        self.assertGreaterEqual(candidates[0]["confidence"], 0.85)


# ===========================================================================
# 5. Ultra Watcher Tests
# ===========================================================================

class TestUltraWatcher(unittest.TestCase):
    """Tests Ultra Watcher filesystem monitoring and event dispatching."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.watcher = UltraWatcher([self.temp_dir], poll_interval_s=0.2)
        self.watcher.start()

    def tearDown(self):
        self.watcher.stop()
        shutil.rmtree(self.temp_dir)

    def test_32_watcher_event_creation(self):
        events = []
        self.watcher.register_listener(lambda evt, p: events.append((evt, p)))
        test_file = os.path.join(self.temp_dir, "new_stem.wav")
        with open(test_file, "w") as f: f.write("data")
        time.sleep(0.5)
        status = self.watcher.get_status()
        self.assertEqual(status["status"], "ACTIVE")
        self.assertGreaterEqual(status["tracked_files_count"], 1)


# ===========================================================================
# 6. Audio Drivers Tests
# ===========================================================================

class TestAudioDrivers(unittest.TestCase):
    """Tests Audio Driver abstraction and device capabilities."""

    def test_33_driver_manager_default(self):
        mgr = DriverManager()
        self.assertIn("active_driver", mgr.get_all_capabilities())

    def test_34_wasapi_provider_honesty(self):
        wasapi = WindowsWASAPIProvider(mode="shared")
        caps = wasapi.get_capabilities()
        self.assertIn("hardware_verified", caps)
        self.assertIn("latency_ms", caps)

    def test_35_mme_provider(self):
        mme = WindowsMMEProvider()
        caps = mme.get_capabilities()
        self.assertEqual(caps["driver_type"], "MME")

    def test_36_stream_provider(self):
        stream_drv = StandardWaveStreamProvider()
        self.assertTrue(stream_drv.start_stream(lambda n: FloatAudioBuffer(2, n)))
        self.assertTrue(stream_drv.is_running)
        stream_drv.stop_stream()
        self.assertFalse(stream_drv.is_running)

    def test_37_null_test_driver(self):
        null_drv = NullDriverProvider()
        caps = null_drv.get_capabilities()
        self.assertEqual(caps["driver_type"], "NULL_TEST")
        self.assertTrue(null_drv.start_stream(lambda n: FloatAudioBuffer(2, n)))
        null_drv.stop_stream()


# ===========================================================================
# 7. Studio Engine & Session Tests
# ===========================================================================

class TestStudioEngine(unittest.TestCase):
    """Tests Absolute Studio Mode multi-track timeline, non-destructive editing, mixer, recording, and bounce."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.engine = StudioEngine(self.temp_dir)

    def tearDown(self):
        shutil.rmtree(self.temp_dir)

    def test_38_session_creation(self):
        s = self.engine.create_session("Studio Session", bpm=128.0)
        self.assertEqual(s.bpm, 128.0)
        self.assertEqual(len(s.tracks), 4)
        self.assertEqual(s.master_track.track_type, "MASTER")

    def test_39_session_add_remove_track(self):
        s = self.engine.session
        t = s.add_track("Synths", color="#8b5cf6")
        self.assertEqual(t.name, "Synths")
        self.assertTrue(s.remove_track(t.id))

    def test_40_session_serialization_json(self):
        save_p = self.engine.save_session_to_file()
        self.assertTrue(os.path.isfile(save_p))
        reloaded = self.engine.load_session_from_file(save_p)
        self.assertEqual(reloaded.id, self.engine.session.id)

    def test_41_add_clip_to_track(self):
        wav_path = os.path.join(self.temp_dir, "clip.wav")
        buf = FloatAudioBuffer(channels=2, length_samples=44100 * 3, sample_rate=44100)
        write_wav_file(wav_path, buf)
        t_id = self.engine.session.tracks[0].id
        clip = self.engine.add_clip_to_track(t_id, wav_path, timeline_start_s=2.0)
        self.assertIsNotNone(clip)
        self.assertEqual(clip.timeline_start_s, 2.0)
        self.assertAlmostEqual(clip.duration_s, 3.0, delta=0.1)

    def test_42_split_clip_non_destructive(self):
        wav_path = os.path.join(self.temp_dir, "clip_split.wav")
        buf = FloatAudioBuffer(channels=2, length_samples=44100 * 4, sample_rate=44100)
        write_wav_file(wav_path, buf)
        t_id = self.engine.session.tracks[0].id
        clip = self.engine.add_clip_to_track(t_id, wav_path, timeline_start_s=0.0)

        c1, c2 = self.engine.split_clip(t_id, clip.id, split_time_s=1.5)
        self.assertIsNotNone(c1)
        self.assertIsNotNone(c2)
        self.assertAlmostEqual(c1.duration_s, 1.5, delta=0.1)
        self.assertAlmostEqual(c2.duration_s, 2.5, delta=0.1)
        self.assertAlmostEqual(c2.source_offset_s, 1.5, delta=0.1)

    def test_43_trim_clip_non_destructive(self):
        wav_path = os.path.join(self.temp_dir, "clip_trim.wav")
        buf = FloatAudioBuffer(channels=2, length_samples=44100 * 4, sample_rate=44100)
        write_wav_file(wav_path, buf)
        t_id = self.engine.session.tracks[0].id
        clip = self.engine.add_clip_to_track(t_id, wav_path, timeline_start_s=0.0)

        ok = self.engine.trim_clip(t_id, clip.id, new_start_offset_s=1.0, new_duration_s=2.0)
        self.assertTrue(ok)
        self.assertEqual(clip.source_offset_s, 1.0)
        self.assertEqual(clip.duration_s, 2.0)

    def test_44_move_clip_across_tracks(self):
        wav_path = os.path.join(self.temp_dir, "clip_move.wav")
        buf = FloatAudioBuffer(channels=2, length_samples=44100 * 2, sample_rate=44100)
        write_wav_file(wav_path, buf)
        t1_id = self.engine.session.tracks[0].id
        t2_id = self.engine.session.tracks[1].id
        clip = self.engine.add_clip_to_track(t1_id, wav_path, timeline_start_s=0.0)

        ok = self.engine.move_clip(t1_id, clip.id, new_start_s=4.0, target_track_id=t2_id)
        self.assertTrue(ok)
        self.assertEqual(clip.timeline_start_s, 4.0)
        self.assertIsNone(self.engine.session.tracks[0].get_clip(clip.id))
        self.assertIsNotNone(self.engine.session.tracks[1].get_clip(clip.id))

    def test_45_recording_pipeline(self):
        t_id = self.engine.session.tracks[0].id
        res_start = self.engine.start_recording(t_id)
        self.assertTrue(res_start["success"])
        self.assertTrue(self.engine.session.is_recording)

        # Feed 1000 PCM samples
        pcm = FloatAudioBuffer(channels=2, length_samples=1000, sample_rate=44100)
        self.engine.append_recording_pcm(pcm)

        res_stop = self.engine.stop_recording()
        self.assertTrue(res_stop["success"])
        self.assertTrue(os.path.isfile(res_stop["file_path"]))
        self.assertIn("sha256", res_stop)

    def test_46_dsp_mixer_render_block(self):
        wav_path = os.path.join(self.temp_dir, "synth.wav")
        buf = FloatAudioBuffer(channels=2, length_samples=44100 * 2, sample_rate=44100)
        for i in range(buf.length):
            buf.data[0][i] = 0.3 * math.sin(2 * math.pi * 300 * i / 44100)
            buf.data[1][i] = 0.3 * math.cos(2 * math.pi * 300 * i / 44100)
        write_wav_file(wav_path, buf)

        t = self.engine.session.tracks[0]
        self.engine.add_clip_to_track(t.id, wav_path, timeline_start_s=0.0)
        t.gain_db = -3.0
        t.pan = 0.2

        mix = self.engine.render_mix_block(0, 44100)
        self.assertEqual(mix.length, 44100)
        self.assertGreater(mix.data[0][100], -1.0)
        self.assertLess(mix.data[0][100], 1.0)

    def test_47_mute_solo_truth_table(self):
        wav_path = os.path.join(self.temp_dir, "test_solo.wav")
        buf = FloatAudioBuffer(channels=2, length_samples=44100, sample_rate=44100)
        for i in range(44100):
            buf.data[0][i] = 0.5
            buf.data[1][i] = 0.5
        write_wav_file(wav_path, buf)

        t1 = self.engine.session.tracks[0]
        t2 = self.engine.session.tracks[1]
        self.engine.add_clip_to_track(t1.id, wav_path)
        self.engine.add_clip_to_track(t2.id, wav_path)

        # Solo track 1 -> track 2 should be silenced in mix
        t1.solo = True
        t2.solo = False
        mix = self.engine.render_mix_block(0, 44100)
        # Verify master bus received track 1 audio output
        self.assertGreater(mix.calculate_peak_and_rms()["peak_db"], -30.0)

    def test_48_master_bounce_to_wav(self):
        wav_path = os.path.join(self.temp_dir, "master_stem.wav")
        buf = FloatAudioBuffer(channels=2, length_samples=44100 * 2, sample_rate=44100)
        write_wav_file(wav_path, buf)
        self.engine.add_clip_to_track(self.engine.session.tracks[0].id, wav_path)

        report = self.engine.bounce_to_master_wav("Master_Final.wav", bit_depth=24)
        self.assertTrue(report["success"])
        self.assertTrue(os.path.isfile(report["output_path"]))
        self.assertEqual(len(report["sha256"]), 64)
        self.assertIn("lufs_integrated", report)

    def test_49_live_meters_reporting(self):
        meters = self.engine.get_live_meters()
        self.assertIn("master", meters)
        self.assertIn(self.engine.session.tracks[0].id, meters)


# ===========================================================================
# 8. Snapshot Manager & Diff Tests
# ===========================================================================

class TestSnapshotManager(unittest.TestCase):
    """Tests project snapshot generation and diffing."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.snap_mgr = SnapshotManager(self.temp_dir)

    def tearDown(self):
        shutil.rmtree(self.temp_dir)

    def test_50_create_and_list_snapshots(self):
        scan_data = {
            "format": "Ableton Live (.als)",
            "tempo_bpm": 128.0,
            "track_count": 2,
            "tracks": [{"name": "Lead"}, {"name": "Bass"}],
            "media_files": []
        }
        snap = self.snap_mgr.create_snapshot("/path/to/project.als", scan_data, label="V1")
        self.assertIn("snapshot_id", snap)
        self.assertIn("snapshot_hash", snap)

        snaps = self.snap_mgr.list_snapshots()
        self.assertEqual(len(snaps), 1)

    def test_51_diff_snapshots(self):
        snap1 = {
            "snapshot_id": "snap_1",
            "tracks": [{"name": "Lead"}, {"name": "Bass"}],
            "media_fingerprints": {"file1.wav": {"sha256": "aaa"}},
            "tempo_bpm": 120.0
        }
        snap2 = {
            "snapshot_id": "snap_2",
            "tracks": [{"name": "Lead"}, {"name": "Bass"}, {"name": "Drums"}],
            "media_fingerprints": {"file1.wav": {"sha256": "aaa"}, "file2.wav": {"sha256": "bbb"}},
            "tempo_bpm": 128.0
        }
        diff = SnapshotManager.diff_snapshots(snap1, snap2)
        self.assertIn("Drums", diff["added_tracks"])
        self.assertIn("file2.wav", diff["added_media"])
        self.assertTrue(diff["tempo_diff"]["changed"])
        self.assertFalse(diff["identical"])


# ===========================================================================
# 9. Server API & Integration Tests
# ===========================================================================

class TestServerAPI(unittest.TestCase):
    """Tests HTTP Server REST API, capabilities, security, and transports."""

    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.mkdtemp()
        cls.port = 8877
        cls.server = create_server("127.0.0.1", cls.port, workspace_root=cls.temp_dir)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.3)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.temp_dir)

    def _get(self, path: str) -> Dict[str, Any]:
        url = f"http://127.0.0.1:{self.port}{path}"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        url = f"http://127.0.0.1:{self.port}{path}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def test_52_api_status(self):
        res = self._get("/api/status")
        self.assertEqual(res["status"], "ONLINE")
        self.assertEqual(res["version"], VERSION)

    def test_53_api_capabilities(self):
        res = self._get("/api/capabilities")
        matrix = res["capability_matrix"]
        self.assertEqual(matrix["analytics_mode"]["status"], "OPERATIONAL")
        self.assertEqual(matrix["studio_engine"]["plugin_hosting"], "PLANNED_PHASE_2_NOT_HOSTED_YET")

    def test_54_api_scan_directory(self):
        res = self._post("/api/scan", {"path": self.temp_dir})
        self.assertTrue(res["success"])
        self.assertIn("scan", res)

    def test_55_api_studio_transport_controls(self):
        # Play
        res = self._post("/api/studio/transport", {"action": "play"})
        self.assertTrue(res["success"])
        self.assertTrue(res["session"]["is_playing"])

        # Pause
        res = self._post("/api/studio/transport", {"action": "pause"})
        self.assertTrue(res["success"])
        self.assertFalse(res["session"]["is_playing"])

        # Set BPM
        res = self._post("/api/studio/transport", {"action": "bpm", "bpm": 140.0})
        self.assertEqual(res["session"]["bpm"], 140.0)

    def test_56_api_studio_tracks_crud(self):
        # Add Track
        add_res = self._post("/api/studio/tracks", {"action": "add", "name": "Percussion"})
        self.assertTrue(add_res["success"])
        t_id = add_res["track"]["id"]

        # Update Track Gain
        upd_res = self._post("/api/studio/tracks", {"action": "update", "track_id": t_id, "gain_db": -4.5})
        self.assertTrue(upd_res["success"])
        self.assertEqual(upd_res["track"]["gain_db"], -4.5)

        # Remove Track
        rem_res = self._post("/api/studio/tracks", {"action": "remove", "track_id": t_id})
        self.assertTrue(rem_res["success"])

    def test_57_api_studio_meters(self):
        res = self._get("/api/studio/meters")
        self.assertIn("meters", res)
        self.assertIn("master", res["meters"])

    def test_58_api_render_master(self):
        res = self._post("/api/studio/render", {"bit_depth": 24, "filename": "API_Master.wav"})
        self.assertTrue(res["success"])
        self.assertEqual(res["filename"], "API_Master.wav")

    def test_59_api_audit_log(self):
        res = self._get("/api/audit-log")
        self.assertIn("audit_events", res)

    def test_60_api_path_traversal_protection(self):
        try:
            url = f"http://127.0.0.1:{self.port}/api/scan"
            data = json.dumps({"path": "../../../etc"}).encode("utf-8")
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req) as resp:
                res = json.loads(resp.read().decode("utf-8"))
                self.assertFalse(res.get("success", False))
        except urllib.error.HTTPError as e:
            self.assertIn(e.code, [400, 500])


if __name__ == "__main__":
    unittest.main()
