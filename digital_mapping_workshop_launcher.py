import contextlib
import socket
import sys
import threading
from pathlib import Path

import app as backend_app


def _app_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _resource_dir():
    frozen_resources = Path(getattr(sys, "_MEIPASS", ""))
    if frozen_resources and (frozen_resources / "web" / "index.html").exists():
        return frozen_resources
    return Path(__file__).resolve().parent


def _has_arg(args, name):
    return name in args or any(arg.startswith(name + "=") for arg in args)


def _arg_value(args, name, fallback):
    for i, arg in enumerate(args):
        if arg == name and i + 1 < len(args):
            return args[i + 1]
        if arg.startswith(name + "="):
            return arg.split("=", 1)[1]
    return fallback


def _find_free_port(start):
    for port in range(int(start), int(start) + 100):
        with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    return int(start)


def _patch_backend_paths(resource_root, user_root):
    data_dir = user_root / "data"
    sessions_dir = user_root / "sessions"

    for path in (
        data_dir,
        sessions_dir,
        sessions_dir / "timelines",
        user_root / "audio_chunks",
        user_root / "backend_recordings",
    ):
        path.mkdir(parents=True, exist_ok=True)

    backend_app.ROOT = resource_root
    backend_app.WEB_DIR = resource_root / "web"
    backend_app.app.static_folder = str(resource_root / "web")

    backend_app.SESSIONS_DIR = sessions_dir
    backend_app.TIMELINE_SESSIONS_DIR = sessions_dir / "timelines"
    backend_app.CUSTOM_OBJECTS_FILE = data_dir / "custom_objects.geojson"
    backend_app.AUDIO_CHUNKS_DIR = user_root / "audio_chunks"
    backend_app.BACKEND_RECORDINGS_DIR = user_root / "backend_recordings"
    backend_app.OSMNX_NETWORK_FILE = data_dir / "osmnx_network.geojson"
    backend_app.FLOORPLAN_VGA_FILE = data_dir / "floorplan_vga_last.geojson"
    backend_app.CALIBRATION_FILE = user_root / "calibration_offsets.json"

    external_token = user_root / "token.txt"
    if not external_token.exists():
        try:
            external_token.write_text("", encoding="utf-8")
        except OSError:
            pass
    backend_app.MAPBOX_TOKEN_FILE = external_token if external_token.exists() else (resource_root / "token.txt")

    bundled_custom_objects = resource_root / "data" / "custom_objects.geojson"
    if not backend_app.CUSTOM_OBJECTS_FILE.exists() and bundled_custom_objects.exists():
        try:
            backend_app.CUSTOM_OBJECTS_FILE.write_text(
                bundled_custom_objects.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
        except OSError:
            pass


def _run_backend(args):
    sys.argv = [sys.argv[0]] + args
    backend_app.main()


def main():
    # Browser opening (fullscreen by default, --windowed / --no-browser to
    # change) is handled entirely by the backend — args pass straight through.
    app_args = list(sys.argv[1:])

    requested_port = int(_arg_value(app_args, "--port", "5000") or "5000")
    port = requested_port if _has_arg(app_args, "--port") else _find_free_port(requested_port)
    if not _has_arg(app_args, "--port"):
        app_args.extend(["--port", str(port)])

    resource_root = _resource_dir()
    user_root = _app_dir()
    _patch_backend_paths(resource_root, user_root)

    print("[Launcher] resources:", resource_root, flush=True)
    print("[Launcher] writable data:", user_root, flush=True)
    print("[Launcher] browser: http://127.0.0.1:%d/" % int(port), flush=True)

    thread = threading.Thread(target=_run_backend, args=(app_args,), daemon=False)
    thread.start()

    try:
        while thread.is_alive():
            thread.join(timeout=0.5)
    except KeyboardInterrupt:
        backend_app.shutdown_event.set()
        print("\n[Launcher] shutting down...", flush=True)


if __name__ == "__main__":
    main()
