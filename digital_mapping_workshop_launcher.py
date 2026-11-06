"""Entry point of the standalone (PyInstaller) build: bundled files are read from the resource folder,
everything the app writes goes next to the executable. Arguments are passed on to app.py."""
import sys
import threading
from pathlib import Path

import app as backend_app
from backend import config


def _app_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _resource_dir():
    frozen_resources = Path(getattr(sys, "_MEIPASS", ""))
    if frozen_resources and (frozen_resources / "web" / "index.html").exists():
        return frozen_resources
    return Path(__file__).resolve().parent


def _use_folders(resource_root, user_root):
    data_dir = user_root / "data"
    sessions_dir = user_root / "sessions"
    for path in (data_dir / "map_sheets", sessions_dir / "timelines", user_root / "backend_recordings"):
        path.mkdir(parents=True, exist_ok=True)

    config.ROOT = resource_root
    config.WEB_DIR = resource_root / "web"
    backend_app.app.static_folder = str(resource_root / "web")

    config.SESSIONS_DIR = sessions_dir
    config.TIMELINE_SESSIONS_DIR = sessions_dir / "timelines"
    config.CUSTOM_OBJECTS_FILE = data_dir / "custom_objects.geojson"
    config.BACKEND_RECORDINGS_DIR = user_root / "backend_recordings"
    config.OSMNX_NETWORK_FILE = data_dir / "osmnx_network.geojson"
    config.MAP_SHEETS_DIR = data_dir / "map_sheets"
    config.DIGITIZED_SHEETS_DIR = data_dir / "digitized_sheets"
    config.DIGITIZER_VLM_FILE = data_dir / "vlm.json"

    external_token = user_root / "token.txt"
    if not external_token.exists():
        try:
            external_token.write_text("", encoding="utf-8")
        except OSError:
            pass
    config.MAPBOX_TOKEN_FILE = external_token if external_token.exists() else resource_root / "token.txt"

    bundled_custom_objects = resource_root / "data" / "custom_objects.geojson"
    if not config.CUSTOM_OBJECTS_FILE.exists() and bundled_custom_objects.exists():
        try:
            config.CUSTOM_OBJECTS_FILE.write_text(bundled_custom_objects.read_text(encoding="utf-8"), encoding="utf-8")
        except OSError:
            pass


def _run_backend(args):
    sys.argv = [sys.argv[0]] + args
    backend_app.main()


def main():
    resource_root = _resource_dir()
    user_root = _app_dir()
    _use_folders(resource_root, user_root)
    print("[Launcher] resources:", resource_root, flush=True)
    print("[Launcher] writable data:", user_root, flush=True)

    thread = threading.Thread(target=_run_backend, args=(list(sys.argv[1:]),), daemon=False)
    thread.start()
    try:
        while thread.is_alive():
            thread.join(timeout=0.5)
    except KeyboardInterrupt:
        backend_app.shutdown_event.set()
        print("\n[Launcher] shutting down...", flush=True)


if __name__ == "__main__":
    main()
