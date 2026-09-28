"""Backend recording of the camera feed, the microphone and the screen, toggled by Ctrl+Shift+R or
the map page's Record button (/api/record). Streams rotate into segments that end up as MP4s."""
import ctypes
import json
import math
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import wave

import cv2
import numpy as np
from flask import Blueprint, jsonify, request

from . import camera, config, shutdown_event
from .helpers import utc_now_iso

try:
    import ctypes.wintypes  # the hotkey's message loop; Windows only
except (ImportError, ValueError):
    pass

bp = Blueprint("recorder", __name__)

camera_recorder = None  # set by setup_recorder(); shared by the hotkey and /api/record


class RecordingIndicator:
    """A small red dot in the top-right corner of the screen while recording (Windows)."""

    def __init__(self, size=18, margin=18):
        self.size = size
        self.margin = margin
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        if os.name != "nt":
            return
        if self.thread is not None and self.thread.is_alive():
            if self.stop_event.is_set():
                self.thread.join(timeout=0.3)
            if self.thread.is_alive():
                return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def _run(self):
        try:
            import tkinter as tk
        except Exception as exc:
            print(f"[Recorder] Recording indicator unavailable: {exc}", flush=True)
            return
        root = None
        try:
            root = tk.Tk()
            root.overrideredirect(True)
            root.attributes("-topmost", True)
            root.configure(bg="black")
            try:
                root.attributes("-transparentcolor", "black")
            except Exception:
                pass
            x = max(0, root.winfo_screenwidth() - self.size - self.margin)
            root.geometry(f"{self.size}x{self.size}+{x}+{self.margin}")
            canvas = tk.Canvas(root, width=self.size, height=self.size, bg="black", highlightthickness=0, bd=0)
            canvas.pack(fill="both", expand=True)
            canvas.create_oval(2, 2, self.size - 2, self.size - 2, fill="#e11d2f", outline="#8a0d19")

            def poll_stop():
                if self.stop_event.is_set() or shutdown_event.is_set():
                    try:
                        root.quit()
                    except Exception:
                        pass
                    return
                root.after(100, poll_stop)

            root.after(100, poll_stop)
            root.mainloop()
        except Exception as exc:
            print(f"[Recorder] Recording indicator failed: {exc}", flush=True)
        finally:
            # Tk must be torn down on the thread that created it, or Python raises
            # "Tcl_AsyncDelete: async handler deleted by the wrong thread" later.
            if root is not None:
                try:
                    root.destroy()
                except Exception:
                    pass


class CameraVoiceRecorder:
    def __init__(self, fps=20.0, audio_device=None, output_format="mp4", keep_raw=False,
                 segment_seconds=300.0, show_indicator=True):
        self.fps = max(1.0, float(fps))
        self.audio_device = audio_device
        self.output_format = str(output_format or "mp4").lower()
        self.keep_raw = bool(keep_raw)
        self.segment_seconds = max(10.0, float(segment_seconds or 300.0))
        self.show_indicator = bool(show_indicator)
        self.indicator = RecordingIndicator()
        self.lock = threading.Lock()
        self.recording = False
        self.stop_event = None
        self.session_dir = None
        self.video_path = None
        self.audio_path = None
        self.metadata_path = None
        self.video_segment_frames = {}
        self.audio_segment_bytes = {}
        self.started_at = 0.0
        self.started_iso = ""
        self.video_thread = None
        self.audio_thread = None
        self.audio_stream = None
        self.audio_queue = None
        self.audio_channels = 0
        self.audio_samplerate = 0
        self.audio_bytes = 0
        self.audio_error = ""
        self.audio_device_info = {}
        self.audio_peak = 0
        self.audio_square_sum = 0
        self.audio_sample_count = 0
        self.video_frames = 0
        self.video_width = 0
        self.video_height = 0
        self.screen_thread = None
        self.screen_path = None
        self.screen_mp4_path = None
        self.screen_frames = 0
        self.screen_width = 0
        self.screen_height = 0
        self.screen_error = ""

    def is_recording(self):
        with self.lock:
            return self.recording

    def start(self):
        with self.lock:
            if self.recording:
                return False, "already_recording"
            frame = camera.frame_copy()
            if frame is None:
                return False, "no_camera_frame"

            timestamp = time.strftime("%Y%m%d_%H%M%S")
            session_dir = config.BACKEND_RECORDINGS_DIR / f"recording_{timestamp}"
            suffix = 1
            while session_dir.exists():
                suffix += 1
                session_dir = config.BACKEND_RECORDINGS_DIR / f"recording_{timestamp}_{suffix}"
            session_dir.mkdir(parents=True, exist_ok=False)

            self.stop_event = threading.Event()
            self.session_dir = session_dir
            self.video_path = session_dir / "segment_0001_camera_feed.avi"
            self.audio_path = session_dir / "segment_0001_microphone.wav"
            self.metadata_path = session_dir / "metadata.json"
            self.screen_path = session_dir / "screen_feed.avi"
            self.screen_mp4_path = session_dir / f"{session_dir.name}_screen.mp4"
            self.video_segment_frames = {}
            self.audio_segment_bytes = {}
            self.started_at = time.time()
            self.started_iso = utc_now_iso(self.started_at)
            self.video_frames = 0
            self.video_height = int(frame.shape[0])
            self.video_width = int(frame.shape[1])
            self.screen_frames = 0
            self.screen_width = 0
            self.screen_height = 0
            self.screen_error = ""
            self.audio_bytes = 0
            self.audio_error = ""
            self.audio_device_info = {}
            self.audio_peak = 0
            self.audio_square_sum = 0
            self.audio_sample_count = 0
            self.audio_queue = queue.Queue()
            self.recording = True

            self.video_thread = threading.Thread(target=self._video_loop, daemon=True)
            self.video_thread.start()
            self.screen_thread = threading.Thread(target=self._screen_loop, daemon=True)
            self.screen_thread.start()
            self._start_audio()
            if self.show_indicator:
                self.indicator.start()
            print(f"[Recorder] Started camera+voice recording: {session_dir}", flush=True)
            return True, str(session_dir)

    def _segment_index(self, timestamp):
        elapsed = max(0.0, float(timestamp) - float(self.started_at or timestamp))
        return int(elapsed // self.segment_seconds) + 1

    def _segment_paths(self, index):
        """(camera .avi, microphone .wav, .mp4) of segment `index`."""
        name = f"segment_{int(index):04d}"
        return (
            self.session_dir / f"{name}_camera_feed.avi",
            self.session_dir / f"{name}_microphone.wav",
            self.session_dir / f"{name}.mp4",
        )

    def _start_audio(self):
        try:
            import sounddevice as sd

            device = sd.query_devices(self.audio_device, kind="input")
            channels = min(2, max(1, int(device.get("max_input_channels") or 1)))
            samplerate = int(float(device.get("default_samplerate") or 44100))
            self.audio_channels = channels
            self.audio_samplerate = samplerate
            self.audio_device_info = {
                "name": str(device.get("name") or ""),
                "hostapi": int(device.get("hostapi") or 0),
                "selector": self.audio_device,
            }
            self.audio_thread = threading.Thread(target=self._audio_writer_loop, daemon=True)
            self.audio_thread.start()
            self.audio_stream = sd.InputStream(device=self.audio_device, samplerate=samplerate,
                                               channels=channels, dtype="int16", callback=self._audio_callback)
            self.audio_stream.start()
            print(f"[Recorder] Microphone: {self.audio_device_info['name']} ({channels} ch, {samplerate} Hz)", flush=True)
        except Exception as exc:
            self.audio_error = str(exc)
            self.audio_stream = None
            print(f"[Recorder] Microphone recording unavailable: {exc}", flush=True)

    def _audio_callback(self, indata, _frames, _time_info, status):
        if status:
            print(f"[Recorder] Audio status: {status}", flush=True)
        if self.stop_event is None or self.stop_event.is_set() or self.audio_queue is None:
            return
        try:
            self.audio_queue.put((time.time(), indata.copy().tobytes()), block=False)
        except Exception:
            pass

    def _audio_writer_loop(self):
        wav = None
        active_segment = None
        try:
            while self.stop_event is not None and (not self.stop_event.is_set() or not self.audio_queue.empty()):
                try:
                    captured_at, chunk = self.audio_queue.get(timeout=0.1)
                except queue.Empty:
                    continue
                segment = self._segment_index(captured_at)
                if segment != active_segment:
                    if wav is not None:
                        wav.close()
                    wav = wave.open(str(self._segment_paths(segment)[1]), "wb")
                    wav.setnchannels(int(self.audio_channels or 1))
                    wav.setsampwidth(2)
                    wav.setframerate(int(self.audio_samplerate or 44100))
                    active_segment = segment
                wav.writeframes(chunk)
                self.audio_bytes += len(chunk)
                self.audio_segment_bytes[segment] = self.audio_segment_bytes.get(segment, 0) + len(chunk)
                samples = np.frombuffer(chunk, dtype=np.int16).astype(np.int64)
                if samples.size:
                    self.audio_peak = max(self.audio_peak, int(np.max(np.abs(samples))))
                    self.audio_square_sum += int(np.sum(samples * samples))
                    self.audio_sample_count += int(samples.size)
        except Exception as exc:
            self.audio_error = str(exc)
            print(f"[Recorder] Audio write failed: {exc}", flush=True)
        finally:
            if wav is not None:
                wav.close()

    def _video_loop(self):
        writer = None
        active_segment = None
        try:
            fourcc = cv2.VideoWriter_fourcc(*"MJPG")
            next_frame_at = time.time()
            while self.stop_event is not None and not self.stop_event.is_set():
                segment = self._segment_index(time.time())
                if segment != active_segment:
                    if writer is not None:
                        writer.release()
                    writer = cv2.VideoWriter(str(self._segment_paths(segment)[0]), fourcc, self.fps,
                                             (self.video_width, self.video_height))
                    if not writer.isOpened():
                        raise RuntimeError("video_writer_open_failed")
                    active_segment = segment

                frame = camera.frame_copy()
                if frame is not None:
                    if frame.shape[1] != self.video_width or frame.shape[0] != self.video_height:
                        frame = cv2.resize(frame, (self.video_width, self.video_height), interpolation=cv2.INTER_AREA)
                    writer.write(frame)
                    self.video_frames += 1
                    self.video_segment_frames[segment] = self.video_segment_frames.get(segment, 0) + 1

                next_frame_at += 1.0 / self.fps
                time.sleep(max(0.001, next_frame_at - time.time()))
        except Exception as exc:
            print(f"[Recorder] Video recording failed: {exc}", flush=True)
        finally:
            if writer is not None:
                writer.release()

    def _screen_loop(self):
        """Record the primary monitor as a constant-rate MJPG .avi at the recorder fps. Every time
        slot gets a frame (a slow grab is repeated to fill the gap), so the video stays real-time
        and in sync with the camera and audio."""
        try:
            import mss
        except Exception as exc:
            self.screen_error = "mss_unavailable: " + str(exc)
            print(f"[Recorder] Screen capture disabled: {exc}", flush=True)
            return
        writer = None
        try:
            mss_open = getattr(mss, "MSS", None) or mss.mss  # newer mss versions call it MSS
            with mss_open() as sct:
                monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
                self.screen_width = int(monitor["width"])
                self.screen_height = int(monitor["height"])
                writer = cv2.VideoWriter(str(self.screen_path), cv2.VideoWriter_fourcc(*"MJPG"), self.fps,
                                         (self.screen_width, self.screen_height))
                if not writer.isOpened():
                    raise RuntimeError("screen_writer_open_failed")
                start = time.time()
                written = 0
                while self.stop_event is not None and not self.stop_event.is_set():
                    frame = np.array(sct.grab(monitor))[:, :, :3]  # BGRA -> BGR
                    if frame.shape[1] != self.screen_width or frame.shape[0] != self.screen_height:
                        frame = cv2.resize(frame, (self.screen_width, self.screen_height), interpolation=cv2.INTER_AREA)
                    target = max(written + 1, int((time.time() - start) * self.fps))
                    while written < target:
                        writer.write(frame)
                        written += 1
                    self.screen_frames = written
                    wait = (start + written / self.fps) - time.time()
                    if wait > 0:
                        time.sleep(min(wait, 1.0 / self.fps))
        except Exception as exc:
            self.screen_error = str(exc)
            print(f"[Recorder] Screen recording failed: {exc}", flush=True)
        finally:
            if writer is not None:
                writer.release()

    @staticmethod
    def _find_ffmpeg():
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            return ffmpeg
        try:
            import imageio_ffmpeg
        except ImportError:
            return None
        return imageio_ffmpeg.get_ffmpeg_exe()

    def _write_mp4(self, video_path, audio_path, output_path):
        """Encode video (+ audio) to H.264 MP4 with ffmpeg. Returns (ok, error)."""
        if not video_path.exists():
            return False, "missing_video"
        ffmpeg = self._find_ffmpeg()
        if not ffmpeg:
            return False, "ffmpeg_not_found"
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin", "-y", "-i", str(video_path)]
        has_audio = audio_path is not None and audio_path.exists() and audio_path.stat().st_size > 44
        if has_audio:
            command += ["-i", str(audio_path), "-map", "0:v:0", "-map", "1:a:0", "-shortest"]
        else:
            command += ["-map", "0:v:0"]
        command += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]
        if has_audio:
            command += ["-c:a", "aac", "-b:a", "128k"]
        command += ["-movflags", "+faststart", str(output_path)]

        result = subprocess.run(command, text=True, capture_output=True)
        if result.returncode == 0:
            return True, ""
        try:
            output_path.unlink(missing_ok=True)
        except Exception:
            pass
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        return False, detail[-1] if detail else f"ffmpeg_exit_{result.returncode}"

    def _finalize_segments(self):
        """Turn each recorded segment into an MP4 (when asked to), dropping its raw streams unless kept."""
        indexes = set()
        pattern = re.compile(r"^segment_(\d{4})_(?:camera_feed\.avi|microphone\.wav)$")
        for path in self.session_dir.iterdir():
            match = pattern.match(path.name)
            if match:
                indexes.add(int(match.group(1)))

        finalized = []
        for index in sorted(indexes):
            video_path, audio_path, mp4_path = self._segment_paths(index)
            has_video = video_path.exists() and video_path.stat().st_size > 0
            has_audio = audio_path.exists() and audio_path.stat().st_size > 44
            mp4_file = ""
            error = ""
            if self.output_format == "mp4" and has_video:
                ok, error = self._write_mp4(video_path, audio_path if has_audio else None, mp4_path)
                if ok:
                    mp4_file = mp4_path.name
                    print(f"[Recorder] Created MP4 segment: {mp4_path}", flush=True)
                    if not self.keep_raw:
                        for path in (video_path, audio_path):
                            try:
                                path.unlink(missing_ok=True)
                            except Exception as exc:
                                print(f"[Recorder] Could not remove raw stream {path}: {exc}", flush=True)
                else:
                    print(f"[Recorder] MP4 segment creation failed: {error}", flush=True)
            finalized.append({
                "index": index,
                "video": video_path.name if video_path.exists() else "",
                "audio": audio_path.name if audio_path.exists() else "",
                "mp4": mp4_file,
                "frames": int(self.video_segment_frames.get(index, 0)),
                "audioBytes": int(self.audio_segment_bytes.get(index, 0)),
                "error": error,
            })
        return finalized

    def stop(self):
        with self.lock:
            if not self.recording:
                return None, "not_recording"
            self.stop_event.set()

        if self.audio_stream is not None:
            try:
                self.audio_stream.stop()
                self.audio_stream.close()
            except Exception as exc:
                self.audio_error = str(exc)
        for thread in (self.video_thread, self.audio_thread, self.screen_thread):
            if thread is not None:
                thread.join(timeout=3.0)
        self.indicator.stop()

        screen_mp4 = ""
        if self.screen_path.exists() and self.screen_frames > 0:
            ok, error = self._write_mp4(self.screen_path, None, self.screen_mp4_path)
            if ok:
                screen_mp4 = self.screen_mp4_path.name
                if not self.keep_raw:
                    try:
                        self.screen_path.unlink()
                    except Exception:
                        pass
            elif not self.screen_error:
                self.screen_error = error

        stopped_at = time.time()
        audio_rms = math.sqrt(self.audio_square_sum / self.audio_sample_count) if self.audio_sample_count else 0.0
        audio_silent = self.audio_bytes > 0 and self.audio_peak <= 1 and audio_rms < 1.0
        segments = self._finalize_segments()
        mp4_files = [segment["mp4"] for segment in segments if segment["mp4"]]
        errors = [segment["error"] for segment in segments if segment["error"]]
        metadata = {
            "startedAt": self.started_iso,
            "stoppedAt": utc_now_iso(stopped_at),
            "durationSeconds": round(max(0.0, stopped_at - self.started_at), 3),
            "source": camera.camera_source,
            "output": {
                "format": "mp4_segments" if mp4_files else "raw_segments",
                "file": mp4_files[0] if len(mp4_files) == 1 else "",
                "files": mp4_files,
                "segmentSeconds": round(float(self.segment_seconds), 3),
                "error": "; ".join(errors),
            },
            "video": {
                "file": self.video_path.name if self.video_path.exists() else "",
                "fps": self.fps,
                "frames": int(self.video_frames),
                "width": int(self.video_width),
                "height": int(self.video_height),
            },
            "screen": {
                "file": screen_mp4,
                "captured": self.screen_frames > 0,
                "fps": round(self.fps, 3),
                "nominalFps": self.fps,
                "frames": int(self.screen_frames),
                "width": int(self.screen_width),
                "height": int(self.screen_height),
                "error": self.screen_error,
            },
            "audio": {
                "file": self.audio_path.name if self.audio_path.exists() else "",
                "captured": self.audio_bytes > 0,
                "channels": int(self.audio_channels),
                "sampleRate": int(self.audio_samplerate),
                "bytes": int(self.audio_bytes),
                "device": self.audio_device_info,
                "peak": int(self.audio_peak),
                "rms": round(float(audio_rms), 3),
                "silent": bool(audio_silent),
                "error": self.audio_error,
            },
            "segments": segments,
        }
        try:
            self.metadata_path.write_text(json.dumps(metadata, ensure_ascii=True, indent=2), encoding="utf-8")
        except Exception as exc:
            print(f"[Recorder] Metadata write failed: {exc}", flush=True)

        session_dir = self.session_dir
        with self.lock:
            self.recording = False
            self.stop_event = None
            self.video_thread = None
            self.audio_thread = None
            self.screen_thread = None
            self.audio_stream = None
            self.audio_queue = None

        if audio_silent:
            print("[Recorder] Warning: microphone file contains near-silence. "
                  "Check the selected input device or microphone mute/level.", flush=True)
        print(f"[Recorder] Saved recording: {session_dir}", flush=True)
        return {"directory": str(session_dir), **metadata}, None


def _show_recorder_info(message):
    """Show `message` in a Windows message box, on its own thread: a modal box on the hotkey
    thread would swallow the next Ctrl+Shift+R."""
    print(f"[Recorder] {message}", flush=True)
    if os.name == "nt":
        threading.Thread(target=ctypes.windll.user32.MessageBoxW,
                         args=(None, str(message), "Camera Recorder", 0x40), daemon=True).start()


def _handle_recording_hotkey(recorder):
    if not recorder.is_recording():
        ok, detail = recorder.start()
        if ok:
            _show_recorder_info("Camera and microphone recording started.\nPress Ctrl+Shift+R again to stop and save.")
        else:
            _show_recorder_info(f"Recording could not start: {detail}")
        return

    result, error = recorder.stop()
    if error:
        _show_recorder_info(f"Recording could not stop: {error}")
        return
    output = result.get("output") or {}
    files = output.get("files") or []
    saved_file = output.get("file") or (files[0] if len(files) == 1 else "")
    if len(files) > 1:
        _show_recorder_info(f"Recording saved:\n{result.get('directory')}\n{len(files)} MP4 parts")
    elif saved_file:
        _show_recorder_info(f"Recording saved:\n{result.get('directory')}\\{saved_file}")
    else:
        _show_recorder_info(f"Recording saved as raw streams:\n{output.get('error') or result.get('directory')}")


def start_recording_hotkey(recorder):
    if os.name != "nt":
        print("[Recorder] Ctrl+Shift+R hotkey is only enabled on Windows.", flush=True)
        return

    def hotkey_loop():
        user32 = ctypes.windll.user32
        hotkey_id = 0x524543
        mod_control_shift_norepeat = 0x0002 | 0x0004 | 0x4000
        vk_r = 0x52
        wm_hotkey = 0x0312
        if not user32.RegisterHotKey(None, hotkey_id, mod_control_shift_norepeat, vk_r):
            print("[Recorder] Could not register Ctrl+Shift+R hotkey.", flush=True)
            return
        print("[Recorder] Ctrl+Shift+R starts/stops backend camera+voice recording.", flush=True)
        msg = ctypes.wintypes.MSG()
        try:
            while not shutdown_event.is_set():
                if user32.GetMessageW(ctypes.byref(msg), None, 0, 0) in (0, -1):
                    break
                if msg.message == wm_hotkey and msg.wParam == hotkey_id:
                    _handle_recording_hotkey(recorder)
        finally:
            user32.UnregisterHotKey(None, hotkey_id)

    threading.Thread(target=hotkey_loop, daemon=True).start()


def audio_device_selector(value):
    """--recording-audio-device: a device index, a name, or None for the default microphone."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return text


def print_audio_devices():
    try:
        import sounddevice as sd
    except Exception as exc:
        print(f"[Recorder] Could not import sounddevice: {exc}")
        return
    hostapis = sd.query_hostapis()
    for index, device in enumerate(sd.query_devices()):
        inputs = int(device.get("max_input_channels") or 0)
        if inputs <= 0:
            continue
        hostapi = hostapis[int(device.get("hostapi") or 0)].get("name", "unknown")
        samplerate = int(float(device.get("default_samplerate") or 0))
        print(f"{index}: {device.get('name')} | {hostapi} inputs={inputs} default_samplerate={samplerate}")


def setup_recorder(args):
    global camera_recorder
    camera_recorder = CameraVoiceRecorder(
        fps=args.recording_fps,
        audio_device=audio_device_selector(args.recording_audio_device),
        output_format=args.recording_output,
        keep_raw=args.keep_recording_raw,
        segment_seconds=max(10.0, float(args.recording_segment_minutes) * 60.0),
        show_indicator=not args.no_recording_indicator,
    )
    if not args.no_recording_hotkey:
        start_recording_hotkey(camera_recorder)


@bp.route("/api/record", methods=["GET"])
def api_record_status():
    recorder = camera_recorder
    return jsonify({"ok": True, "available": recorder is not None,
                    "recording": recorder.is_recording() if recorder else False})


@bp.route("/api/record", methods=["POST"])
def api_record_control():
    """{"action": "start" | "stop" | "toggle"} for the same recorder the hotkey drives."""
    recorder = camera_recorder
    if recorder is None:
        return jsonify({"ok": False, "error": "recorder_unavailable"}), 503
    action = str((request.get_json(silent=True) or {}).get("action", "toggle")).lower()
    if action == "toggle":
        action = "stop" if recorder.is_recording() else "start"
    if action == "start":
        ok, detail = recorder.start()
        if not ok:
            return jsonify({"ok": False, "recording": recorder.is_recording(), "error": detail}), 409
        return jsonify({"ok": True, "recording": True, "directory": detail})
    if action == "stop":
        result, error = recorder.stop()
        if error:
            return jsonify({"ok": False, "recording": recorder.is_recording(), "error": error}), 409
        output = result.get("output") or {}
        files = output.get("files") or ([output["file"]] if output.get("file") else [])
        return jsonify({"ok": True, "recording": False, "directory": result.get("directory", ""), "files": files})
    return jsonify({"ok": False, "error": "bad_action"}), 400
