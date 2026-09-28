"""Digital Mapping Workshop: the camera and AprilTag tracking backend and its web server.

Run `python app.py --help` for the options. The routes live in backend/, one module per feature.
"""
import argparse
import logging
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser

from flask import Flask, jsonify

from backend import (camera, config, detection, floorplan, map_sheets, markers, pages, recorder, sessions,
                     shutdown_event, street_network, street_screen, surface, workshops)

app = Flask(__name__, static_folder=str(config.WEB_DIR), static_url_path="")
for feature in (pages, camera, detection, surface, markers, street_screen, map_sheets, floorplan, sessions,
                workshops, recorder, street_network):
    app.register_blueprint(feature.bp)

# The Digitizer (digitizer/, a package that also runs on its own) is mounted at /digitizer/.
# Without torch and transformers it digitises sheets without its VLM.
try:
    from digitizer.server import bp as digitizer_blueprint
    DIGITIZER_UNAVAILABLE = ""
except ImportError as exc:
    digitizer_blueprint = None
    DIGITIZER_UNAVAILABLE = f"{type(exc).__name__}: {exc}"

kiosk_browser_process = None


def configure_digitizer():
    """Point the Digitizer at this app's folders; its "Move to Results" writes into SESSIONS_DIR."""
    app.config.update(DIGITIZER_RUNS=str(config.DIGITIZER_RUNS_DIR), DIGITIZER_SESSIONS=str(config.DIGITIZER_SESSIONS_DIR),
                      DIGITIZER_HOME="/home", DIGITIZER_RESULTS=str(config.SESSIONS_DIR))
    os.environ["DIGITIZER_SHEETS"] = str(config.MAP_SHEETS_DIR)


configure_digitizer()
if digitizer_blueprint is not None:
    app.register_blueprint(digitizer_blueprint, url_prefix="/digitizer")
else:
    @app.route("/digitizer/")
    def digitizer_unavailable():
        return (f"<p>The Digitizer could not be loaded ({DIGITIZER_UNAVAILABLE}). Install its packages: "
                "<code>pip install -r digitizer/requirements.txt</code>. <a href='/home'>Back</a></p>", 503)


@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    """The home page's Exit button: close the fullscreen browser window and stop the app."""
    def exit_soon():
        time.sleep(0.2)
        shutdown_event.set()
        if kiosk_browser_process is not None:
            try:
                kiosk_browser_process.terminate()
            except Exception:
                pass
        os._exit(0)

    threading.Thread(target=exit_soon, daemon=True).start()
    return jsonify({"ok": True})


def find_chromium_browser():
    """Chrome or Edge, for the fullscreen app window, or None."""
    if sys.platform == "win32":
        program_files = os.environ.get("PROGRAMFILES", r"C:\Program Files")
        program_files_x86 = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
        candidates = [
            program_files + r"\Google\Chrome\Application\chrome.exe",
            program_files_x86 + r"\Google\Chrome\Application\chrome.exe",
            os.environ.get("LOCALAPPDATA", "") + r"\Google\Chrome\Application\chrome.exe",
            program_files_x86 + r"\Microsoft\Edge\Application\msedge.exe",
            program_files + r"\Microsoft\Edge\Application\msedge.exe",
        ]
    else:
        candidates = [shutil.which(name) for name in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge")]
        candidates += [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def find_available_port(host, preferred_port, search_limit=100):
    """`preferred_port` if free, else the next free one after it, else any port the OS picks (as does 0)."""
    preferred_port = int(preferred_port)
    if preferred_port < 0 or preferred_port > 65535:
        raise ValueError("Port must be between 0 and 65535.")
    bind_host = "0.0.0.0" if host in ("0.0.0.0", "", None) else str(host)
    family = socket.AF_INET6 if ":" in bind_host else socket.AF_INET

    def try_bind(port):
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            # Without this, Windows lets a second socket appear to bind a port that is already taken.
            if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind((bind_host, int(port)))
            return int(probe.getsockname()[1])

    if preferred_port == 0:
        return try_bind(0)
    last_port = min(65535, preferred_port + max(1, int(search_limit)) - 1)
    for port in range(preferred_port, last_port + 1):
        try:
            return try_bind(port)
        except OSError:
            continue
    return try_bind(0)


def open_browser_when_ready(host, port, kiosk):
    """Open the app once the server accepts connections; kiosk = Chrome/Edge fullscreen app window."""
    target_host = "127.0.0.1" if host in ("0.0.0.0", "", None) else host
    url = f"http://{target_host}:{port}/"

    def open_when_ready():
        global kiosk_browser_process
        deadline = time.time() + 5.0
        while time.time() < deadline and not shutdown_event.is_set():
            try:
                with socket.create_connection((target_host, int(port)), timeout=0.3):
                    break
            except OSError:
                time.sleep(0.1)
        if shutdown_event.is_set():
            return
        if kiosk:
            browser = find_chromium_browser()
            if browser:
                try:
                    # --app gives a window without tabs or address bar; F11 / Esc still leave fullscreen.
                    kiosk_browser_process = subprocess.Popen([browser, f"--app={url}", "--start-fullscreen"])
                    print("[Browser] fullscreen app mode — F11 or Esc to toggle, or use the on-screen Exit button")
                    return
                except Exception:
                    pass
            print("[Browser] kiosk requested but no Chrome/Edge found — falling back to default browser")
        # In a frozen macOS .app the webbrowser module can fail silently; `open` does not.
        if sys.platform == "darwin":
            try:
                subprocess.Popen(["open", url])
                return
            except Exception:
                pass
        try:
            webbrowser.open(url, new=2)
        except Exception:
            pass

    threading.Thread(target=open_when_ready, daemon=True).start()


def parse_args():
    default_threads = max(1, int(round((os.cpu_count() or 2) / 2.0)))
    parser = argparse.ArgumentParser(description="Digital Mapping Workshop AprilTag backend")
    parser.add_argument("--source", default=None,
                        help="Camera source (0, 1, or URL). If omitted, auto-discovers :8080/video")
    parser.add_argument("--auto-exposure", dest="auto_exposure", action="store_true",
                        help="Closed-loop highlight-metered exposure for an IP Webcam source: keeps the bright "
                             "projection just below clipping so tag borders stay readable (off by default; "
                             "overrides manual exposure while active; no-op for non-IP sources)")
    parser.add_argument("--no-auto-exposure", dest="auto_exposure", action="store_false",
                        help="Disable automatic exposure control (already the default)")
    parser.add_argument("--auto-exposure-target", type=float, default=205.0,
                        help="Auto-exposure highlight target (p95 luminance 0-255). Lower = darker / safer against clipping")
    parser.add_argument("--auto-exposure-floor", type=float, default=100.0,
                        help="Auto-exposure anti-darkening floor (p75 luminance): never darken below this, "
                             "so bright UI/glare can't spiral the scene to black")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5000,
                        help="Preferred local port. If occupied, the app automatically uses the next available port.")
    parser.add_argument("--detector", choices=["pupil", "aruco"], default="aruco",
                        help="Detection backend: 'aruco' (default, OpenCV ArUco) or 'pupil' (pupil_apriltags)")
    parser.add_argument("--apriltag-family", default=None, nargs="+",
                        help="Initial AprilTag family/families. Defaults to the marker settings, whose changes "
                             "then update the detector live.")
    parser.add_argument("--apriltag-threads", type=int, default=default_threads + 5)
    parser.add_argument("--apriltag-quad-decimate", type=float, default=1.0)
    parser.add_argument("--apriltag-quad-sigma", type=float, default=0.0)
    parser.add_argument("--apriltag-refine-edges", dest="apriltag_refine_edges", action="store_true")
    parser.add_argument("--no-apriltag-refine-edges", dest="apriltag_refine_edges", action="store_false")
    parser.add_argument("--apriltag-decode-sharpening", type=float, default=0.25)
    parser.add_argument("--aruco-min-area", type=float, default=200,
                        help="Minimum tag area in px² for the ArUco backend (filters small false positives)")
    parser.add_argument("--no-browser", action="store_true",
                        help="Don't open the app in a browser when the server starts")
    parser.add_argument("--kiosk", dest="kiosk", action="store_true",
                        help="Open in Chrome/Edge fullscreen app mode (already the default; kept for compatibility)")
    parser.add_argument("--windowed", "--no-kiosk", dest="kiosk", action="store_false",
                        help="Open in a normal browser window instead of the default fullscreen app mode")
    parser.add_argument("--no-recording-hotkey", action="store_true",
                        help="Disable the Ctrl+Shift+R backend camera+voice recording hotkey")
    parser.add_argument("--recording-fps", type=float, default=20.0, help="FPS for backend camera recordings")
    parser.add_argument("--recording-audio-device", default=None,
                        help="Microphone device index or name for backend recordings")
    parser.add_argument("--recording-output", choices=["mp4", "raw"], default="mp4",
                        help="Backend recording output format. Default: mp4")
    parser.add_argument("--keep-recording-raw", action="store_true",
                        help="Keep temporary AVI/WAV streams after successful MP4 creation")
    parser.add_argument("--recording-segment-minutes", type=float, default=5.0,
                        help="Rotate backend recording files every N minutes. Default: 5")
    parser.add_argument("--no-recording-indicator", action="store_true",
                        help="Disable the small red recording indicator dot")
    parser.add_argument("--list-audio-devices", action="store_true",
                        help="Print available microphone input devices and exit")
    parser.set_defaults(auto_exposure=False, apriltag_refine_edges=True, kiosk=True)
    return parser.parse_args()


def main():
    configure_digitizer()  # the standalone launcher may have moved the data folders since import
    args = parse_args()
    if args.list_audio_devices:
        recorder.print_audio_devices()
        return

    source = camera.parse_source(args.source)
    if source is None:
        source = camera.discover_ip_camera()
        if source is None:
            print("[Camera] No IP camera found on :8080/video — starting without a camera. "
                  "Pass --source 0/1/URL to attach one.")
    camera.init_camera(source)
    detection.start_detector(args)
    street_network.load_cached_network()

    threading.Thread(target=camera.camera_loop, daemon=True).start()
    threading.Thread(target=detection.detector_loop, daemon=True).start()
    if args.auto_exposure:
        threading.Thread(target=camera.auto_exposure_loop, daemon=True,
                         args=(args.auto_exposure_target, args.auto_exposure_floor)).start()
    recorder.setup_recorder(args)

    port = find_available_port(args.host, args.port)
    if port != args.port:
        print(f"[Backend] port {args.port} is unavailable; using {port}")
    display_host = "127.0.0.1" if args.host in ("0.0.0.0", "", None) else args.host
    print(f"[Backend] http://{display_host}:{port}")
    print(f"[Camera] source: {source if source is not None else '(none)'}")
    if not args.no_browser:
        open_browser_when_ready(args.host, port, args.kiosk)

    logging.getLogger("werkzeug").setLevel(logging.ERROR)  # no per-request access log
    try:
        app.run(host=args.host, port=port, debug=False, use_reloader=False, threaded=True)
    finally:
        shutdown_event.set()


if __name__ == "__main__":
    main()
