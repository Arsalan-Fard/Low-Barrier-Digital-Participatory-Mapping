"""Folders, files and API keys. The standalone launcher reassigns the paths before main() runs,
so other modules read them as config.X at call time."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
MAPUTNIK_DIST_DIR = ROOT / "map-style-editor" / "maputnik" / "dist"
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

# The Digitizer (digitizer/, the page at /digitizer/): its sticker and pen legend, one folder per
# digitised sheet (participant data, never bundled), and the colour palettes it learned before it
# stopped learning (read only). It reads MAP_SHEETS_DIR and saves each sheet's GeoJSON into SESSIONS_DIR.
DIGITIZER_LEGEND_FILE = ROOT / "digitizer" / "legend.json"
DIGITIZED_SHEETS_DIR = ROOT / "data" / "digitized_sheets"
DIGITIZER_PALETTES_DIR = ROOT / "data" / "digitizer_palettes"
# The optional handwriting model's server address (set in the Digitizer page).
DIGITIZER_VLM_FILE = ROOT / "data" / "vlm.json"

FLOORPLAN_DIR = ROOT / "floorplan"
FLOORPLAN_DXF_FILE = FLOORPLAN_DIR / "Télécom Palaiseau_RDC_simplified.dxf"


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
