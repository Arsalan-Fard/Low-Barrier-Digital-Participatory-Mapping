"""Folders, files and API keys. The standalone launcher reassigns the paths before main() runs,
so other modules read them as config.X at call time."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
MAPUTNIK_DIST_DIR = ROOT / "map-style-editor" / "maputnik" / "dist"
CALIBRATION_FILE = ROOT / "calibration_offsets.json"
MAPBOX_TOKEN_FILE = ROOT / "token.txt"

SESSIONS_DIR = ROOT / "sessions"
TIMELINE_SESSIONS_DIR = SESSIONS_DIR / "timelines"
EXPO_SESSIONS_DIR = SESSIONS_DIR / "expo"
BACKEND_RECORDINGS_DIR = ROOT / "backend_recordings"

CUSTOM_OBJECTS_FILE = ROOT / "data" / "custom_objects.geojson"
WORKSHOPS_FILE = ROOT / "data" / "workshops.json"
DATA_LAYER_CATALOG_FILE = ROOT / "data" / "data_layer_catalog.json"
MARKER_SETTINGS_FILE = ROOT / "data" / "marker_settings.json"
OSMNX_NETWORK_FILE = ROOT / "data" / "osmnx_network.geojson"
CUSTOM_LAYERS_DIR = ROOT / "data" / "custom_layers"
WORKSHOP_ASSETS_DIR = ROOT / "data" / "workshop_assets"
MAP_SHEETS_DIR = ROOT / "data" / "map_sheets"

FLOORPLAN_DIR = ROOT / "floorplan"
FLOORPLAN_DXF_FILE = FLOORPLAN_DIR / "Télécom Palaiseau_RDC_simplified.dxf"

DIGITIZER_RUNS_DIR = ROOT / "digitizer" / "runs"
DIGITIZER_SESSIONS_DIR = ROOT / "digitizer" / "sessions"


def token_line(index):
    """Line `index` of token.txt (0: Mapbox token, 1: Google Maps key), or ""."""
    try:
        lines = MAPBOX_TOKEN_FILE.read_text(encoding="utf-8").splitlines()
    except Exception:
        return ""
    if index < len(lines):
        return lines[index].strip()
    return ""


def mapbox_token():
    return os.environ.get("MAPBOX_TOKEN", "").strip() or token_line(0)


def google_maps_key():
    return os.environ.get("GOOGLE_MAPS_API_KEY", "").strip() or token_line(1)
