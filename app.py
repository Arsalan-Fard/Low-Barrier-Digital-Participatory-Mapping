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

from backend import (camera, config, detection, floorplan, map_sheets, markers, pages, paper_watch, recorder,
                     sessions, shutdown_event, street_network, street_screen, surface, workshops)
from digitizer import server as digitizer

app = Flask(__name__, static_folder=str(config.WEB_DIR), static_url_path="")
for feature in (pages, camera, detection, surface, markers, street_screen, paper_watch, map_sheets, floorplan,
                sessions, workshops, recorder, street_network):
    app.register_blueprint(feature.bp)
# The Digitizer (digitizer/): photographed paper sheets to data, reviewed by hand.
app.register_blueprint(digitizer.bp, url_prefix="/digitizer")

kiosk_browser_process = None


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


def open_browser_when_ready(host, port):
    """Open the app in a Chrome/Edge fullscreen app window once the server accepts connections."""
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
        browser = find_chromium_browser()
        if browser:
            try:
                # --app gives a window without tabs or address bar; F11 / Esc still leave fullscreen.
                kiosk_browser_process = subprocess.Popen([browser, f"--app={url}", "--start-fullscreen"])
                print("[Browser] fullscreen app mode — F11 or Esc to toggle, or use the on-screen Exit button")
                return
            except Exception:
                pass
        print("[Browser] no Chrome/Edge found — opening the default browser")
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
    parser.add_argument("--apriltag-family", default=None, nargs="+",
                        help="Initial AprilTag family/families. Defaults to the marker settings, whose changes "
                             "then update the detector live.")
    parser.add_argument("--aruco-min-area", type=float, default=200,
                        help="Minimum tag area in px² (filters small false positives)")
    parser.set_defaults(auto_exposure=False)
    return parser.parse_args()


def main():
    args = parse_args()

    source = camera.parse_source(args.source)
    if source is None:
        try:
            source = camera.discover_ip_camera()
        except Exception as exc:  # an odd network must not stop the app; the home page retries
            print(f"[Camera] Looking for an IP camera failed: {exc}")
        if source is None:
            print("[Camera] No IP camera found on :8080/video — starting without a camera. "
                  "Pass --source 0/1/URL to attach one.")
    camera.init_camera(source)
    detection.start_detector(args)
    street_network.load_cached_network()

    threading.Thread(target=camera.camera_loop, daemon=True).start()
    threading.Thread(target=detection.detector_loop, daemon=True).start()
    # Photographs the pen drawings on the map view sheets whenever no hand is over them.
    threading.Thread(target=paper_watch.watch_loop, daemon=True).start()
    # Smart exposure starts as the command line says; Camera Tuning turns it on and off from there.
    camera.camera_control_values.update(smartExposure=1 if args.auto_exposure else 0,
                                        smartTarget=args.auto_exposure_target,
                                        smartFloor=args.auto_exposure_floor)
    threading.Thread(target=camera.auto_exposure_loop, daemon=True).start()
    recorder.setup_recorder()

    port = find_available_port(args.host, args.port)
    if port != args.port:
        print(f"[Backend] port {args.port} is unavailable; using {port}")
    display_host = "127.0.0.1" if args.host in ("0.0.0.0", "", None) else args.host
    print(f"[Backend] http://{display_host}:{port}")
    print(f"[Camera] source: {source if source is not None else '(none)'}")
    open_browser_when_ready(args.host, port)

    logging.getLogger("werkzeug").setLevel(logging.ERROR)  # no per-request access log
    try:
        app.run(host=args.host, port=port, debug=False, use_reloader=False, threaded=True)
    finally:
        shutdown_event.set()


if __name__ == "__main__":
    main()
