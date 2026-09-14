import argparse
import base64
import binascii
import contextlib
import ctypes
try:
    import ctypes.wintypes  # Windows-only: used by the Ctrl+Shift+R hotkey loop
except (ImportError, ValueError):
    pass  # non-Windows: every wintypes use is behind an os.name == "nt" guard
import io
import json
import logging
import math
import os
import queue
import random
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
import wave
import webbrowser
import zipfile
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, Response, jsonify, redirect, request, send_from_directory, stream_with_context
from pupil_apriltags import Detector

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"   # all browser-served files (HTML pages, src/, images/, vendor/)
MAPUTNIK_DIST_DIR = ROOT / "map-style-editor" / "maputnik" / "dist"
app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path="")

shutdown_event = threading.Event()
frame_lock = threading.Lock()
tags_lock = threading.Lock()
corners_lock = threading.Lock()
tunnel_lock = threading.Lock()
phone_controller_lock = threading.Lock()
comment_controller_lock = threading.Lock()
surface_lnglat_lock = threading.Lock()
detector_lock = threading.Lock()
detector_manager = None

camera = None
camera_source = ""
kiosk_browser_process = None
latest_frame = None
latest_frame_seq = 0
latest_frame_width = 0
latest_frame_height = 0
latest_camera_fps = 0.0

# Shared MJPEG encode cache. /video_feed clients all consume the same frames,
# so we encode each frame's JPEG once (keyed by seq+quality) and hand the bytes
# to every connected client instead of re-encoding per client.
video_feed_lock = threading.Lock()
video_feed_cache = {"seq": -1, "quality": -1, "data": None}

latest_tags = []
latest_tags_seq = 0
latest_tags_updated_at = 0.0


surface_corners = [None, None, None, None]  # TL, TR, BR, BL in frame pixels
# Tutorial video mask: the expo tutorial plays a clip that CONTAINS AprilTags, which
# the camera would otherwise mis-detect as real tags. The tutorial page posts the
# video's on-screen rectangle in uv (0..1 screen fractions) + an active flag; the
# detection loop maps that through the surface corners into frame pixels and fills it
# flat gray BEFORE detect(), so no tag can be decoded there. None = no mask.
tutorial_mask = {"active": False, "rect": None}   # rect = {u0,v0,u1,v1} in 0..1 screen space
tutorial_mask_lock = threading.Lock()
auto_corners_enabled = False
auto_exposure_enabled = False
auto_exposure_target = 205.0   # highlight (p95) target luminance
auto_exposure_floor = 100.0    # content (p75) floor: never darken below this
CALIBRATION_FILE = ROOT / "calibration_offsets.json"

SESSIONS_DIR = ROOT / "sessions"
TIMELINE_SESSIONS_DIR = SESSIONS_DIR / "timelines"
EXPO_SESSIONS_DIR = SESSIONS_DIR / "expo"
CUSTOM_OBJECTS_FILE = ROOT / "data" / "custom_objects.geojson"
WORKSHOPS_FILE = ROOT / "data" / "workshops.json"
DATA_LAYER_CATALOG_FILE = ROOT / "data" / "data_layer_catalog.json"
RENDERER_CONFIG_FILE = ROOT / "data" / "renderer_config.json"
MARKER_SETTINGS_FILE = ROOT / "data" / "marker_settings.json"
AUDIO_CHUNKS_DIR = ROOT / "audio_chunks"
BACKEND_RECORDINGS_DIR = ROOT / "backend_recordings"
camera_recorder = None   # CameraVoiceRecorder instance (created in main); shared by the Ctrl+Shift+R hotkey and /api/record
OSMNX_NETWORK_FILE = ROOT / "data" / "osmnx_network.geojson"
CUSTOM_LAYERS_DIR = ROOT / "data" / "custom_layers"
WORKSHOP_ASSETS_DIR = ROOT / "data" / "workshop_assets"
MAP_SHEETS_DIR = ROOT / "data" / "map_sheets"
OSMNX_GRAPH_CACHE = {"graph": None, "bbox": None, "loadedAt": 0.0}
# Recently built graphs, keyed by "<network_type>|<bbox>", oldest first. OSMnx's
# own on-disk cache only stores the raw Overpass JSON, which still costs seconds
# to re-parse into a graph; keeping the built graphs makes revisiting an area
# free for the rest of the process's life.
OSMNX_GRAPH_STORE = {}
OSMNX_GRAPH_STORE_MAX = 6
osmnx_lock = threading.Lock()
FLOORPLAN_DIR = ROOT / "floorplan"
FLOORPLAN_DXF_FILE = FLOORPLAN_DIR / "Télécom Palaiseau_RDC_simplified.dxf"
# Cache parsed payloads per DXF path: { path_str: {"mtime": float, "payload": dict} }.
FLOORPLAN_CACHE = {}
floorplan_lock = threading.Lock()


def _safe_dxf_name(name):
    """Sanitize an uploaded filename to a bare, safe .dxf basename."""
    base = os.path.basename(str(name or "")).strip()
    # Drop any path separators / sneaky chars; keep it simple and predictable.
    base = re.sub(r"[^A-Za-z0-9 ._-]", "_", base)
    base = base.lstrip(".") or "floorplan"
    if not base.lower().endswith(".dxf"):
        base += ".dxf"
    return base


def _floorplan_path_for_id(plan_id):
    """Resolve a floorplan id (filename) to a path inside FLOORPLAN_DIR, or None
    if it isn't a real .dxf within that directory (prevents traversal)."""
    if not plan_id:
        return FLOORPLAN_DXF_FILE if FLOORPLAN_DXF_FILE.exists() else None
    name = os.path.basename(str(plan_id))
    if not name.lower().endswith(".dxf"):
        return None
    candidate = (FLOORPLAN_DIR / name).resolve()
    try:
        candidate.relative_to(FLOORPLAN_DIR.resolve())
    except ValueError:
        return None
    return candidate if candidate.exists() else None


def list_floorplans():
    """All .dxf files in FLOORPLAN_DIR as [{id, name}], newest first."""
    if not FLOORPLAN_DIR.exists():
        return []
    files = sorted(FLOORPLAN_DIR.glob("*.dxf"), key=lambda p: p.stat().st_mtime, reverse=True)
    out = []
    for f in files:
        out.append({"id": f.name, "name": f.stem})
    return out
PHONE_CONTROLLER_TAG_MAP = {"1": 11, "2": 12, "3": 13, "4": 14}
COMMENT_CONTROLLER_TAG_MAP = {"1": 15, "2": 16, "3": 17, "4": 18}
PHONE_CONTROLLER_LEASE_TTL_SECONDS = 15.0
MAPBOX_TOKEN_FILE = ROOT / "token.txt"
quick_tunnel_process = None
quick_tunnel_state = {
    "enabled": False,
    "status": "disabled",
    "url": "",
    "error": "",
    "last_line": "",
    "startedAt": "",
}
QUICK_TUNNEL_URL_RE = re.compile(r"https://[a-z0-9.-]+trycloudflare\.com(?:/\S*)?", re.IGNORECASE)
CALIBRATION_GROUP_SPECS = {
    "draw": {"allow_comp": True},
    "sticker": {"allow_comp": False},
    "annotation": {"allow_comp": False},
    "selector": {"allow_comp": False},
}

# Surface corner tags: tag ID -> surface corner index (TL, TR, BR, BL).
# The slot is tied to the tag's position in the PROJECTED image (25=TL, 26=TR,
# 27=BR, 28=BL), so it's correct for any projection geometry. Which of the
# tag's own corners is the surface corner is decided dynamically at detection
# time (the outermost one); the second tuple element is kept only for
# backwards reference and is no longer used.
SURFACE_CORNER_TAGS = {
    25: (0, 3),
    26: (1, 2),
    27: (2, 1),
    28: (3, 0),
}

# The generated AprilTag SVGs use a 10x10 viewBox with a one-cell white quiet
# zone around the detected black tag square. Detector corners land on the black
# square, so scale the tag-center-to-corner vector from 4 cells to 5 cells to
# recover the full printed/projected tag corner.
APRILTAG_SVG_CELLS = 10.0
APRILTAG_QUIET_ZONE_CELLS = 1.0
APRILTAG_OUTER_CORNER_SCALE = (
    APRILTAG_SVG_CELLS / (APRILTAG_SVG_CELLS - 2.0 * APRILTAG_QUIET_ZONE_CELLS)
)

# --- Grid-based auto surface calibration -------------------------------------
# A grid of AprilTags is projected across the whole screen; the camera decodes
# them, a RANSAC homography (camera px -> canvas px) is fit, and the screen
# corners are recovered by back-projecting the canvas bounds. Far sturdier than
# the 4-corner-tag method above (SURFACE_CORNER_TAGS) because many wide-baseline
# correspondences are used, with quality gating + multi-frame confirmation.
# Ported from D:/IP2/Spacious/Artifacts/ourmethod/Geometry/opencv_16h5_live.py.
CALIB_GRID_CANVAS = (1280, 720)                    # abstract canvas; corners map to its bounds
CALIB_GRID_TAG_SIZE = min(CALIB_GRID_CANVAS) // 8  # full SVG tag-box side in canvas px
# Tag centres as (id, x_frac, y_frac). The screen corners are recovered by
# back-projecting the canvas bounds (0..1) through the fitted homography, so
# accuracy at the corners depends on how FAR they sit beyond the tag hull:
# any tag inset becomes an extrapolation that amplifies reprojection error
# (the old layout's 0.16/0.84 vertical inset is exactly why the recovered box
# undershot the screen edges). So push the grid out to ~0.055/0.945 on BOTH
# axes -- as close to the edges as an ~11vmin projected tag fits -- and include
# the four near-corner tags, so every screen corner is essentially interpolated
# rather than extrapolated. 4x4 grid (ids 0-15; within tag16h5's range too).
_CALIB_XS = (0.06, 0.36, 0.64, 0.94)
_CALIB_YS = (0.06, 0.37, 0.63, 0.94)
CALIB_GRID_LAYOUT = tuple(
    (row * 4 + col, _CALIB_XS[col], _CALIB_YS[row])
    for row in range(4) for col in range(4)
)
CALIB_MIN_TAGS = 4
CALIB_MIN_COVERAGE = 0.55          # detected centres must span >=55% of each axis
CALIB_RANSAC_PX = 6.0
CALIB_MIN_INLIER_RATIO = 0.65
CALIB_MAX_REPROJ_PX = 6.0
CALIB_CONFIRM_FRAMES = 5           # stable estimates required before accepting
CALIB_CANDIDATE_SHIFT_PX = 8.0     # a jump this large restarts the stable window


# Tag CENTRES in canvas px. The centre of a generated SVG marker is the centre
# of its box for every family (the black square is centred regardless of the
# family-dependent quiet-zone fraction), so a centre<->centre correspondence is
# exact without tracking per-family geometry, and is immune to tag rotation /
# rear projection. The detected centre is the mean of a tag's four corners.
CALIB_GRID_TARGET_CENTERS = {
    int(tid): (xf * CALIB_GRID_CANVAS[0], yf * CALIB_GRID_CANVAS[1])
    for tid, xf, yf in CALIB_GRID_LAYOUT
}

grid_calib_enabled = False
grid_calib_candidates = []   # recent np.float32 (4,2) corner estimates (camera px)
grid_calib_status = {
    "active": False, "tags_found": 0, "tags_total": len(CALIB_GRID_LAYOUT),
    "stable": 0, "confirm": CALIB_CONFIRM_FRAMES, "error": None, "done": False,
}


def get_ipv4_candidates():
    out = set()
    host = socket.gethostname()
    for ip in socket.gethostbyname_ex(host)[2]:
        if ip and not ip.startswith("127."):
            out.add(ip)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        out.add(sock.getsockname()[0])
    except Exception:
        pass
    sock.close()
    return sorted(out)


def iter_auto_source_candidates():
    seen = set()
    for ip in get_ipv4_candidates():
        parts = ip.split(".")
        if len(parts) != 4:
            continue
        prefix = ".".join(parts[:3])
        for host in range(1, 255):
            candidate = f"{prefix}.{host}"
            if candidate != ip and candidate not in seen:
                seen.add(candidate)
                yield candidate


def is_tcp_port_open(ip, port, timeout=0.2):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        return sock.connect_ex((ip, port)) == 0
    except Exception:
        return False
    finally:
        sock.close()


def discover_camera_source_on_port(port=8080, path="/video"):
    candidates = list(iter_auto_source_candidates())
    open_ips = []
    with ThreadPoolExecutor(max_workers=min(64, max(1, len(candidates)))) as pool:
        tasks = {pool.submit(is_tcp_port_open, ip, port): ip for ip in candidates}
        for future in as_completed(tasks):
            ip = tasks[future]
            try:
                if future.result():
                    open_ips.append(ip)
            except Exception:
                pass

    for ip in open_ips:
        source = f"http://{ip}:{port}{path}"
        cap = cv2.VideoCapture(source)
        ok, _ = cap.read() if cap.isOpened() else (False, None)
        cap.release()
        if ok:
            return source
    return None


def parse_source(raw):
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except Exception:
        return raw


def empty_feature_collection():
    return {"type": "FeatureCollection", "features": []}


def sanitize_storage_name(raw, fallback):
    text = str(raw or "").strip()
    if not text:
        return str(fallback)
    cleaned = "".join(ch if (ch.isalnum() or ch in ("-", "_")) else "_" for ch in text)
    cleaned = cleaned.strip("._-")
    return cleaned or str(fallback)


def infer_audio_extension(content_type="", original_name=""):
    name = str(original_name or "").lower()
    if "." in name:
        ext = "." + name.rsplit(".", 1)[1]
        if ext in (".webm", ".ogg", ".wav", ".m4a", ".mp4", ".mp3", ".aac", ".opus"):
            return ext

    ctype = str(content_type or "").lower()
    if "webm" in ctype:
        return ".webm"
    if "ogg" in ctype or "opus" in ctype:
        return ".ogg"
    if "wav" in ctype:
        return ".wav"
    if "mp4" in ctype or "m4a" in ctype or "aac" in ctype:
        return ".m4a"
    if "mpeg" in ctype or "mp3" in ctype:
        return ".mp3"
    return ".bin"


def default_phone_controller_state(controller_id):
    key = str(controller_id or "").strip()
    paired_tag_id = PHONE_CONTROLLER_TAG_MAP.get(key)
    return {
        "controllerId": key,
        "pairedTagId": paired_tag_id,
        "active": False,
        "mode": "",
        "annotationText": "",
        "placeToken": 0,
        "updatedAt": "",
    }


def default_comment_controller_state(controller_id):
    key = str(controller_id or "").strip()
    paired_tag_id = COMMENT_CONTROLLER_TAG_MAP.get(key)
    return {
        "controllerId": key,
        "pairedTagId": paired_tag_id,
        "annotationText": "",
        "placeToken": 0,
        "updatedAt": "",
    }


phone_controller_states = {
    key: default_phone_controller_state(key) for key in PHONE_CONTROLLER_TAG_MAP.keys()
}
phone_controller_sessions = {}
comment_controller_states = {
    key: default_comment_controller_state(key) for key in COMMENT_CONTROLLER_TAG_MAP.keys()
}


def prune_phone_controller_sessions_locked(now=None):
    current_time = float(now if now is not None else time.time())
    stale_client_ids = [
        client_id for client_id, session in phone_controller_sessions.items()
        if current_time - float(session.get("lastSeen", 0.0) or 0.0) > PHONE_CONTROLLER_LEASE_TTL_SECONDS
    ]
    for client_id in stale_client_ids:
        phone_controller_sessions.pop(client_id, None)


def snapshot_phone_controller_claims_locked(now=None):
    current_time = float(now if now is not None else time.time())
    prune_phone_controller_sessions_locked(current_time)
    claims = {}
    for client_id, session in phone_controller_sessions.items():
        controller_id = str(session.get("controllerId") or "").strip()
        if controller_id not in PHONE_CONTROLLER_TAG_MAP:
            continue
        claims.setdefault(controller_id, {
            "controllerId": controller_id,
            "clientId": client_id,
            "lastSeen": float(session.get("lastSeen", 0.0) or 0.0),
            "openedAt": float(session.get("openedAt", 0.0) or 0.0),
        })
    return claims


def snapshot_phone_controller_states():
    with phone_controller_lock:
        claims = snapshot_phone_controller_claims_locked()
        states = {}
        for key, value in phone_controller_states.items():
            state = dict(value)
            state["open"] = key in claims
            states[key] = state
        return states


def snapshot_comment_controller_states():
    with comment_controller_lock:
        return {
            key: dict(comment_controller_states.get(key) or default_comment_controller_state(key))
            for key in COMMENT_CONTROLLER_TAG_MAP.keys()
        }


def update_phone_controller_session(payload):
    raw_client_id = payload.get("clientId") or payload.get("sessionClientId") or ""
    client_id = sanitize_storage_name(raw_client_id, "")
    if not client_id:
        return None, "invalid_client"

    action = str(payload.get("action") or "claim").strip().lower()
    now = time.time()
    with phone_controller_lock:
        prune_phone_controller_sessions_locked(now)

        if action == "release":
            phone_controller_sessions.pop(client_id, None)
            return {"controllerId": None, "leases": snapshot_phone_controller_claims_locked(now)}, None

        requested_id = sanitize_storage_name(
            payload.get("requestedControllerId") or payload.get("controllerId"),
            "",
        )
        existing = phone_controller_sessions.get(client_id) or {}
        existing_id = str(existing.get("controllerId") or "").strip()
        occupied_by_other = {
            str(session.get("controllerId") or "").strip()
            for other_client_id, session in phone_controller_sessions.items()
            if other_client_id != client_id
        }

        chosen_id = None
        if requested_id in PHONE_CONTROLLER_TAG_MAP and requested_id not in occupied_by_other:
            chosen_id = requested_id
        elif existing_id in PHONE_CONTROLLER_TAG_MAP and existing_id not in occupied_by_other:
            chosen_id = existing_id
        else:
            for candidate_id in PHONE_CONTROLLER_TAG_MAP.keys():
                if candidate_id not in occupied_by_other:
                    chosen_id = candidate_id
                    break

        if chosen_id is None:
            return {"controllerId": None, "leases": snapshot_phone_controller_claims_locked(now)}, "no_available_controller"

        phone_controller_sessions[client_id] = {
            "controllerId": chosen_id,
            "lastSeen": now,
            "openedAt": float(existing.get("openedAt", now) or now),
        }
        controller_state = dict(phone_controller_states.get(chosen_id) or default_phone_controller_state(chosen_id))
        controller_state["open"] = True
        return {
            "controllerId": chosen_id,
            "pairedTagId": PHONE_CONTROLLER_TAG_MAP.get(chosen_id),
            "controller": controller_state,
            "leases": snapshot_phone_controller_claims_locked(now),
        }, None


def update_phone_controller_state(payload):
    controller_id = sanitize_storage_name(payload.get("controllerId"), "")
    if controller_id not in PHONE_CONTROLLER_TAG_MAP:
        return None

    raw_mode = str(payload.get("mode") or "").strip().lower()
    if raw_mode not in {"draw", "erase", "comment", "select"}:
        raw_mode = ""

    raw_text = str(payload.get("annotationText") or "")
    if len(raw_text) > 220:
        raw_text = raw_text[:220]

    try:
        place_token = int(payload.get("placeToken") or 0)
    except Exception:
        place_token = 0
    if place_token < 0:
        place_token = 0

    updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with phone_controller_lock:
        current = dict(phone_controller_states.get(controller_id) or default_phone_controller_state(controller_id))
        current["pairedTagId"] = PHONE_CONTROLLER_TAG_MAP.get(controller_id)
        current["active"] = bool(raw_mode)
        current["mode"] = raw_mode
        current["annotationText"] = raw_text
        current["placeToken"] = place_token
        current["updatedAt"] = updated_at
        phone_controller_states[controller_id] = current
        return dict(current)


def update_comment_controller_state(payload):
    controller_id = sanitize_storage_name(payload.get("controllerId"), "")
    if controller_id not in COMMENT_CONTROLLER_TAG_MAP:
        return None

    raw_text = str(payload.get("annotationText") or "")
    if len(raw_text) > 220:
        raw_text = raw_text[:220]

    try:
        place_token = int(payload.get("placeToken") or 0)
    except Exception:
        place_token = 0
    if place_token < 0:
        place_token = 0

    updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with comment_controller_lock:
        current = dict(comment_controller_states.get(controller_id) or default_comment_controller_state(controller_id))
        current["pairedTagId"] = COMMENT_CONTROLLER_TAG_MAP.get(controller_id)
        current["annotationText"] = raw_text
        current["placeToken"] = place_token
        current["updatedAt"] = updated_at
        comment_controller_states[controller_id] = current
        return dict(current)


surface_lnglat_corners = {"corners": None, "updatedAt": 0.0}  # corners = [{lng,lat}x4] in TL,TR,BR,BL


def _load_token_lines():
    if not MAPBOX_TOKEN_FILE.exists():
        return []
    try:
        lines = MAPBOX_TOKEN_FILE.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []
    return [line.strip() for line in lines]


def _token_line(index):
    lines = _load_token_lines()
    if index < 0 or index >= len(lines):
        return ""
    return lines[index]


def load_mapbox_token():
    # Prefer env override, then the first token.txt line.
    token = str(os.environ.get("MAPBOX_TOKEN") or "").strip()
    if token:
        return token
    return _token_line(0)


def save_mapbox_token(token):
    # Write the Mapbox token to line 0 of token.txt, preserving the Google
    # Maps key on line 1 (and any further lines).
    lines = _load_token_lines()
    if not lines:
        lines = [""]
    lines[0] = str(token or "").strip()
    MAPBOX_TOKEN_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


DEFAULT_DRAW_OFFSET_CM = 3.0
MARKER_SLOT_DEFAULTS = [
    {"key": "draw-1", "group": "Drawing", "tool": "draw", "label": "Pointer 1", "tagId": 11, "tagId2": None, "selectorTagId": 20, "selectorTagId2": 19, "color": "#ff5b5b", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "draw-2", "group": "Drawing", "tool": "draw", "label": "Pointer 2", "tagId": 12, "tagId2": None, "selectorTagId": None, "selectorTagId2": None, "color": "#3b82f6", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "draw-3", "group": "Drawing", "tool": "draw", "label": "Pointer 3", "tagId": 13, "tagId2": None, "selectorTagId": None, "selectorTagId2": None, "color": "#22cc66", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "draw-4", "group": "Drawing", "tool": "draw", "label": "Pointer 4", "tagId": 14, "tagId2": None, "selectorTagId": None, "selectorTagId2": None, "color": "#111111", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "route-origin", "group": "Shortest-path", "tool": "route-origin", "label": "Route start", "tagId": 9, "color": ""},
    {"key": "route-dest", "group": "Shortest-path", "tool": "route-dest", "label": "Route end", "tagId": 10, "color": ""},
    {"key": "isochrone-5", "group": "Analysis", "tool": "isochrone", "label": "Isochrone 5 min", "tagId": 38, "color": "", "minutes": 5},
    {"key": "isochrone-15", "group": "Analysis", "tool": "isochrone", "label": "Isochrone 15 min", "tagId": 37, "color": "", "minutes": 15},
    {"key": "isovist-1", "group": "Analysis", "tool": "isovist", "label": "Isovist", "tagId": 39, "color": ""},
    # "Comment": one fixed keyboard-location tag + one-or-more post-it tags.
    # The map runtime pairs each post-it with the shared keyboard location.
    {"key": "comment-keyboard", "group": "Comment", "tool": "comment-keyboard", "label": "Keyboard location", "tagId": 1, "color": ""},
    {"key": "comment-postit-1", "group": "Comment", "tool": "comment-postit", "label": "Post-it 1", "tagId": 0, "color": ""},
]
MARKER_COLOR_TOOLS = {"draw"}
# Post-its are addable; the keyboard location and first post-it are fixed
# defaults (never in REMOVABLE_TOOLS, so they are always kept).
MARKER_EXTRA_TOOLS = {"draw", "comment-postit"}
MARKER_REMOVABLE_TOOLS = {"draw"}
MARKER_MULTI_TAG_TOOLS = {"draw"}
MARKER_SELECTOR_PAIR_TOOLS = {"draw"}
MARKER_OFFSET_TOOLS = {"draw"}
MARKER_FAMILY_RE = re.compile(r"^(tag\d+h\d+)_(\d+)\.svg$", re.IGNORECASE)
APRILTAG_GENERATOR_FAMILY_MAP = {
    "tag16h5": cv2.aruco.DICT_APRILTAG_16h5,
    "tag25h9": cv2.aruco.DICT_APRILTAG_25h9,
    "tag36h10": cv2.aruco.DICT_APRILTAG_36h10,
    "tag36h11": cv2.aruco.DICT_APRILTAG_36h11,
}


def available_marker_families():
    families = {}
    for family, dict_id in APRILTAG_GENERATOR_FAMILY_MAP.items():
        try:
            dictionary = cv2.aruco.getPredefinedDictionary(dict_id)
            count = int(dictionary.bytesList.shape[0])
        except Exception:
            count = 0
        if count > 0:
            families.setdefault(family, set()).update(range(count))
    try:
        files = list((WEB_DIR / "apriltags").iterdir())
    except Exception:
        files = []
    for path in files:
        match = MARKER_FAMILY_RE.match(path.name)
        if not match:
            continue
        family = match.group(1)
        tag_id = int(match.group(2))
        families.setdefault(family, set()).add(tag_id)
    out = [
        {"family": family, "ids": sorted(ids)}
        for family, ids in sorted(families.items(), key=lambda item: item[0])
    ]
    return out


def marker_family_ids(family):
    for entry in available_marker_families():
        if entry["family"] == family:
            return set(entry["ids"])
    return set()


class JsonStore:
    """Tiny JSON-file settings store: load = read+sanitize (or sanitized default),
    save = sanitize+write. Owns its own lock. Side effects (e.g. detector resync)
    stay in the thin load_*/save_* wrappers below."""
    def __init__(self, path, sanitize, default):
        self.path = path
        self._sanitize = sanitize
        self._default = default                  # callable or value
        self._lock = threading.Lock()

    def load(self):
        with self._lock:
            if not self.path.exists():
                d = self._default() if callable(self._default) else self._default
                return self._sanitize(d)
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                data = {}
            return self._sanitize(data)

    def save(self, payload):
        settings = self._sanitize(payload)
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(settings, ensure_ascii=True, indent=2), encoding="utf-8")
        return settings


def default_marker_settings():
    return {
        "family": "tag36h11",
        "tagSizeCm": 3.0,
        "slots": [dict(slot) for slot in MARKER_SLOT_DEFAULTS],
    }


def sanitize_marker_color(raw, fallback=""):
    text = str(raw or "").strip()
    if re.match(r"^#[0-9a-fA-F]{6}$", text):
        return text.lower()
    return fallback


def sanitize_marker_offset_cm(raw, fallback=DEFAULT_DRAW_OFFSET_CM):
    try:
        value = float(raw)
    except Exception:
        value = fallback
    return max(0.0, min(20.0, value))


def sanitize_marker_tag_id(raw, allowed_ids):
    if raw in (None, ""):
        return None
    try:
        tag_id = int(raw)
    except Exception:
        return None
    if allowed_ids and tag_id not in allowed_ids:
        return None
    return tag_id


def sanitize_marker_settings(payload):
    defaults = default_marker_settings()
    if not isinstance(payload, dict):
        payload = {}

    available = available_marker_families()
    family_names = [entry["family"] for entry in available]
    family = str(payload.get("family") or defaults["family"]).strip()
    if family not in family_names:
        family = defaults["family"] if defaults["family"] in family_names else (family_names[0] if family_names else defaults["family"])
    allowed_ids = marker_family_ids(family)

    try:
        tag_size = float(payload.get("tagSizeCm", defaults["tagSizeCm"]))
    except Exception:
        tag_size = defaults["tagSizeCm"]
    tag_size = max(1.0, min(20.0, tag_size))

    incoming_slots = payload.get("slots") if isinstance(payload.get("slots"), list) else []
    incoming_by_key = {
        str(slot.get("key") or ""): slot
        for slot in incoming_slots
        if isinstance(slot, dict) and slot.get("key") is not None
    }
    # Migrate the former global tool-selection/eraser pair onto Drawing 1.
    # Once saved, these values live directly on the drawing slot.
    legacy_selector = incoming_by_key.get("eraser-1", {})

    slots = []
    for default_slot in MARKER_SLOT_DEFAULTS:
        if incoming_slots and default_slot["key"] not in incoming_by_key and default_slot["tool"] in MARKER_REMOVABLE_TOOLS:
            continue
        src = incoming_by_key.get(default_slot["key"], {})
        tool = default_slot["tool"]
        tag_id = sanitize_marker_tag_id(src.get("tagId", default_slot.get("tagId")), allowed_ids)
        color = sanitize_marker_color(src.get("color"), default_slot.get("color", "")) if tool in MARKER_COLOR_TOOLS else ""
        slot = dict(default_slot)
        slot["tagId"] = tag_id
        slot["color"] = color
        if tool in MARKER_MULTI_TAG_TOOLS:
            tag_id2 = sanitize_marker_tag_id(src.get("tagId2", default_slot.get("tagId2")), allowed_ids)
            slot["tagId2"] = tag_id2 if tag_id2 != tag_id else None
        if tool in MARKER_SELECTOR_PAIR_TOOLS:
            selector_default = default_slot.get("selectorTagId")
            selector_default2 = default_slot.get("selectorTagId2")
            if default_slot["key"] == "draw-1" and legacy_selector:
                selector_default = legacy_selector.get("tagId", selector_default)
                selector_default2 = legacy_selector.get("tagId2", selector_default2)
            selector_id = sanitize_marker_tag_id(src.get("selectorTagId", selector_default), allowed_ids)
            selector_id2 = sanitize_marker_tag_id(src.get("selectorTagId2", selector_default2), allowed_ids)
            if selector_id in {tag_id, slot.get("tagId2")}:
                selector_id = None
            if selector_id2 in {tag_id, slot.get("tagId2"), selector_id}:
                selector_id2 = None
            slot["selectorTagId"] = selector_id
            slot["selectorTagId2"] = selector_id2
        if tool in MARKER_OFFSET_TOOLS:
            slot["offsetCm"] = sanitize_marker_offset_cm(
                src.get("offsetCm", default_slot.get("offsetCm", DEFAULT_DRAW_OFFSET_CM)),
                default_slot.get("offsetCm", DEFAULT_DRAW_OFFSET_CM),
            )
        if "minutes" in default_slot:
            try:
                slot["minutes"] = max(1, min(180, int(src.get("minutes", default_slot["minutes"]))))
            except Exception:
                slot["minutes"] = default_slot["minutes"]
        slots.append(slot)

    for src in incoming_slots:
        if not isinstance(src, dict):
            continue
        key = str(src.get("key") or "")
        if not key.startswith("extra-"):
            continue
        if any(s["key"] == key for s in slots):
            continue
        tool = str(src.get("tool") or "").strip()
        if tool not in MARKER_EXTRA_TOOLS:
            continue
        group = "Drawing" if tool == "draw" else "Comment"
        default_label = "Pointer" if tool == "draw" else "Post-it"
        tag_id = sanitize_marker_tag_id(src.get("tagId"), allowed_ids)
        color = sanitize_marker_color(src.get("color"), "#ff5b5b") if tool in MARKER_COLOR_TOOLS else ""
        label = str(src.get("label") or default_label).strip()[:80]
        extra = {"key": key, "group": group, "tool": tool, "label": label, "tagId": tag_id, "color": color}
        if tool in MARKER_MULTI_TAG_TOOLS:
            tag_id2 = sanitize_marker_tag_id(src.get("tagId2"), allowed_ids)
            extra["tagId2"] = tag_id2 if tag_id2 != tag_id else None
        if tool in MARKER_SELECTOR_PAIR_TOOLS:
            selector_id = sanitize_marker_tag_id(src.get("selectorTagId"), allowed_ids)
            selector_id2 = sanitize_marker_tag_id(src.get("selectorTagId2"), allowed_ids)
            if selector_id in {tag_id, extra.get("tagId2")}:
                selector_id = None
            if selector_id2 in {tag_id, extra.get("tagId2"), selector_id}:
                selector_id2 = None
            extra["selectorTagId"] = selector_id
            extra["selectorTagId2"] = selector_id2
        if tool in MARKER_OFFSET_TOOLS:
            extra["offsetCm"] = sanitize_marker_offset_cm(src.get("offsetCm"), DEFAULT_DRAW_OFFSET_CM)
        slots.append(extra)

    pointer_number = 0
    for slot in slots:
        if slot.get("tool") == "draw":
            pointer_number += 1
            slot["label"] = f"Pointer {pointer_number}"

    return {"family": family, "tagSizeCm": tag_size, "slots": slots}


MARKER_STORE = JsonStore(MARKER_SETTINGS_FILE, sanitize_marker_settings, default_marker_settings)


def load_marker_settings():
    return MARKER_STORE.load()


def save_marker_settings(payload):
    settings = MARKER_STORE.save(payload)
    sync_detector_with_marker_settings(settings)
    return settings


def marker_settings_payload():
    settings = load_marker_settings()
    payload = dict(settings)
    payload["availableFamilies"] = available_marker_families()
    return payload


def generated_apriltag_svg(family, tag_id):
    family = str(family or "").strip()
    if family not in APRILTAG_GENERATOR_FAMILY_MAP:
        return None
    try:
        dictionary = cv2.aruco.getPredefinedDictionary(APRILTAG_GENERATOR_FAMILY_MAP[family])
        tag_id = int(tag_id)
        if tag_id < 0 or tag_id >= int(dictionary.bytesList.shape[0]):
            return None
        marker_cells = int(getattr(dictionary, "markerSize", 6)) + 2
        marker = cv2.aruco.generateImageMarker(dictionary, tag_id, marker_cells)
    except Exception:
        return None

    viewbox_cells = marker_cells + 2
    rects = []
    for y in range(marker_cells):
        for x in range(marker_cells):
            if int(marker[y, x]) < 128:
                rects.append(f'<rect x="{x + 1}" y="{y + 1}" width="1" height="1"/>')
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {viewbox_cells} {viewbox_cells}" '
        'width="200" height="200" shape-rendering="crispEdges">\n'
        f'<rect x="0" y="0" width="{viewbox_cells}" height="{viewbox_cells}" fill="#fff"/>\n'
        '<g fill="#000">\n'
        + "".join(rects) +
        '\n</g>\n</svg>\n'
    )


def _marker_sheet_entries(raw_entries, family):
    """Sanitize the marker IDs and use labels supplied by the settings page."""
    if isinstance(raw_entries, str):
        if len(raw_entries) > 16000:
            raise ValueError("marker_sheet_payload_too_large")
        try:
            raw_entries = json.loads(raw_entries)
        except (TypeError, ValueError):
            raise ValueError("invalid_marker_sheet_entries")
    if not isinstance(raw_entries, list):
        raise ValueError("invalid_marker_sheet_entries")

    allowed_ids = marker_family_ids(family)
    entries = []
    seen = set()
    for raw in raw_entries[:64]:
        if not isinstance(raw, dict):
            continue
        try:
            tag_id = int(raw.get("id"))
        except (TypeError, ValueError):
            continue
        if tag_id not in allowed_ids or tag_id in seen:
            continue
        use = re.sub(r"\s+", " ", str(raw.get("use") or "")).strip()[:80]
        if not use:
            use = "Marker"
        entries.append({"id": tag_id, "use": use})
        seen.add(tag_id)
    if not entries:
        raise ValueError("no_marker_ids_selected")
    return entries


def _svg_path_for_reportlab(pdf, d):
    """Convert the M/L/H/V/Z subset used by Pointer1.svg to a ReportLab path."""
    token_re = re.compile(
        r"[MmLlHhVvZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
    )
    tokens = token_re.findall(str(d or ""))
    path = pdf.beginPath()
    index = 0
    command = None
    x = y = start_x = start_y = 0.0

    def is_command(token):
        return len(token) == 1 and token.isalpha()

    while index < len(tokens):
        if is_command(tokens[index]):
            command = tokens[index]
            index += 1
        if command is None:
            raise ValueError("pointer_template_invalid")
        lower = command.lower()
        relative = command.islower()
        if lower == "z":
            path.close()
            x, y = start_x, start_y
            command = None
            continue
        if lower in ("m", "l"):
            if index + 1 >= len(tokens) or is_command(tokens[index]):
                raise ValueError("pointer_template_invalid")
            next_x = float(tokens[index])
            next_y = float(tokens[index + 1])
            index += 2
            if relative:
                next_x += x
                next_y += y
            x, y = next_x, next_y
            if lower == "m":
                path.moveTo(x, y)
                start_x, start_y = x, y
                command = "l" if relative else "L"
            else:
                path.lineTo(x, y)
            continue
        if lower == "h":
            if index >= len(tokens) or is_command(tokens[index]):
                raise ValueError("pointer_template_invalid")
            value = float(tokens[index])
            index += 1
            x = x + value if relative else value
            path.lineTo(x, y)
            continue
        if lower == "v":
            if index >= len(tokens) or is_command(tokens[index]):
                raise ValueError("pointer_template_invalid")
            value = float(tokens[index])
            index += 1
            y = y + value if relative else value
            path.lineTo(x, y)
            continue
        raise ValueError("pointer_template_invalid")
    return path


def _draw_pointer_svg(pdf, svg_path, x, y, size):
    """Render the checked-in Pointer1.svg directly into the PDF as vector paths."""
    import xml.etree.ElementTree as ET
    from reportlab.lib.colors import HexColor

    root = ET.parse(svg_path).getroot()
    view_box = [
        float(value)
        for value in str(root.attrib.get("viewBox") or "0 0 100 100").replace(",", " ").split()
    ]
    if len(view_box) != 4 or view_box[2] <= 0 or view_box[3] <= 0:
        raise ValueError("pointer_template_invalid")
    view_x, view_y, view_w, view_h = view_box

    def local_name(node):
        return node.tag.rsplit("}", 1)[-1]

    def style_values(node):
        values = {}
        for item in str(node.attrib.get("style") or "").split(";"):
            if ":" in item:
                key, value = item.split(":", 1)
                values[key.strip()] = value.strip()
        for key in ("fill", "stroke", "stroke-width"):
            if key in node.attrib:
                values[key] = node.attrib[key]
        return values

    def apply_transform(node):
        text = str(node.attrib.get("transform") or "").strip()
        match = re.fullmatch(r"matrix\(([^)]+)\)", text)
        if not text:
            return
        if not match:
            raise ValueError("pointer_template_invalid")
        values = [
            float(value)
            for value in re.split(r"[\s,]+", match.group(1).strip())
            if value
        ]
        if len(values) != 6:
            raise ValueError("pointer_template_invalid")
        pdf.transform(*values)

    def render_node(node):
        pdf.saveState()
        apply_transform(node)
        name = local_name(node)
        if name == "path":
            values = style_values(node)
            fill_value = values.get("fill", "#000000")
            stroke_value = values.get("stroke", "none")
            fill = fill_value.lower() != "none"
            stroke = stroke_value.lower() != "none"
            if fill:
                pdf.setFillColor(HexColor(fill_value))
            if stroke:
                pdf.setStrokeColor(HexColor(stroke_value))
                try:
                    pdf.setLineWidth(float(values.get("stroke-width", 0.25)))
                except (TypeError, ValueError):
                    pdf.setLineWidth(0.25)
                pdf.setLineJoin(2)
            path = _svg_path_for_reportlab(pdf, node.attrib.get("d"))
            pdf.drawPath(path, fill=int(fill), stroke=int(stroke))
        else:
            for child in node:
                render_node(child)
        pdf.restoreState()

    pdf.saveState()
    pdf.translate(x, y + size)
    pdf.scale(size / view_w, -size / view_h)
    pdf.translate(-view_x, -view_y)
    render_node(root)
    pdf.restoreState()


def _draw_marker_sheet_pdf(family, tag_size_cm, entries):
    """Create a printable marker sheet and a dimensioned Pointer1 guide."""
    try:
        from reportlab.lib.pagesizes import A3, A4
        from reportlab.lib.units import cm, mm
        from reportlab.pdfgen import canvas
    except ImportError as exc:
        raise RuntimeError("reportlab_not_installed") from exc

    tag_size = float(tag_size_cm) * cm
    a4_content_width = A4[0] - 24 * mm
    page_size = A4 if tag_size + 8 * mm <= a4_content_width else A3
    page_w, page_h = page_size
    margin = 12 * mm
    content_w = page_w - margin * 2
    card_w = max(36 * mm, tag_size + 6 * mm)
    card_h = tag_size + 14 * mm
    if card_w > content_w:
        raise ValueError("marker_size_does_not_fit_page")
    columns = max(1, int(content_w // card_w))
    guide_zone_h = 118 * mm
    guide_rows = max(0, int((page_h - margin - guide_zone_h) // card_h))
    full_rows = max(1, int((page_h - margin * 2) // card_h))
    guide_capacity = columns * guide_rows
    full_capacity = columns * full_rows

    dictionary = cv2.aruco.getPredefinedDictionary(
        APRILTAG_GENERATOR_FAMILY_MAP[family]
    )
    marker_cells = int(getattr(dictionary, "markerSize", 6)) + 2
    viewbox_cells = marker_cells + 2

    out = io.BytesIO()
    pdf = canvas.Canvas(out, pagesize=page_size, pageCompression=1)
    pdf.setTitle("Marker sheet")
    pdf.setAuthor("Low-Barrier Digital Participatory Mapping")

    def draw_marker(entry, card_x, top_y):
        tag_x = card_x + (card_w - tag_size) * 0.5
        tag_y = top_y - tag_size
        cell = tag_size / viewbox_cells
        marker = cv2.aruco.generateImageMarker(
            dictionary, int(entry["id"]), marker_cells
        )
        pdf.setFillColorRGB(1, 1, 1)
        pdf.rect(tag_x, tag_y, tag_size, tag_size, fill=1, stroke=0)
        pdf.setFillColorRGB(0, 0, 0)
        for row in range(marker_cells):
            for column in range(marker_cells):
                if int(marker[row, column]) < 128:
                    pdf.rect(
                        tag_x + (column + 1) * cell,
                        tag_y + tag_size - (row + 2) * cell,
                        cell,
                        cell,
                        fill=1,
                        stroke=0,
                    )
        center_x = card_x + card_w * 0.5
        pdf.setFillColorRGB(0, 0, 0)
        pdf.setFont("Helvetica-Bold", 9)
        pdf.drawCentredString(center_x, tag_y - 4.2 * mm, f"ID {entry['id']}")
        label = entry["use"]
        font_size = 8.0
        while (
            font_size > 5.5
            and pdf.stringWidth(label, "Helvetica", font_size) > card_w - 2 * mm
        ):
            font_size -= 0.5
        if pdf.stringWidth(label, "Helvetica", font_size) > card_w - 2 * mm:
            while (
                label
                and pdf.stringWidth(label + "...", "Helvetica", font_size)
                > card_w - 2 * mm
            ):
                label = label[:-1]
            label += "..."
        pdf.setFont("Helvetica", font_size)
        pdf.drawCentredString(center_x, tag_y - 8 * mm, label)

    def draw_entries(page_entries, rows):
        for row in range(rows):
            start = row * columns
            row_entries = page_entries[start:start + columns]
            if not row_entries:
                break
            row_x = (page_w - len(row_entries) * card_w) * 0.5
            top_y = page_h - margin - row * card_h
            for column, entry in enumerate(row_entries):
                draw_marker(entry, row_x + column * card_w, top_y)

    def horizontal_dimension(x1, x2, y, label):
        arrow = 2.2 * mm
        pdf.setStrokeColorRGB(0.18, 0.18, 0.18)
        pdf.setFillColorRGB(0.08, 0.08, 0.08)
        pdf.setLineWidth(0.45)
        pdf.line(x1, y, x2, y)
        pdf.line(x1, y, x1 + arrow, y + arrow * 0.55)
        pdf.line(x1, y, x1 + arrow, y - arrow * 0.55)
        pdf.line(x2, y, x2 - arrow, y + arrow * 0.55)
        pdf.line(x2, y, x2 - arrow, y - arrow * 0.55)
        pdf.setFont("Helvetica", 7)
        pdf.drawCentredString((x1 + x2) * 0.5, y + 1.6 * mm, label)

    def vertical_dimension(x, y1, y2, label, label_side=1):
        arrow = 2.2 * mm
        pdf.setStrokeColorRGB(0.18, 0.18, 0.18)
        pdf.setFillColorRGB(0.08, 0.08, 0.08)
        pdf.setLineWidth(0.45)
        pdf.line(x, y1, x, y2)
        pdf.line(x, y1, x - arrow * 0.55, y1 + arrow)
        pdf.line(x, y1, x + arrow * 0.55, y1 + arrow)
        pdf.line(x, y2, x - arrow * 0.55, y2 - arrow)
        pdf.line(x, y2, x + arrow * 0.55, y2 - arrow)
        pdf.saveState()
        pdf.translate(x + label_side * 2.5 * mm, (y1 + y2) * 0.5)
        pdf.rotate(90)
        pdf.setFont("Helvetica", 7)
        pdf.drawCentredString(0, 0, label)
        pdf.restoreState()

    def draw_pointer_guide():
        guide_size = 100 * mm
        guide_x = (page_w - guide_size) * 0.5
        guide_y = 14 * mm
        pointer_path = WEB_DIR / "images" / "Pointer1.svg"
        _draw_pointer_svg(pdf, pointer_path, guide_x, guide_y, guide_size)

        # Pointer1.svg uses one viewBox unit per millimeter.
        unit = guide_size / 100.0
        sx = lambda value: guide_x + value * unit
        sy = lambda value: guide_y + (100.0 - value) * unit
        horizontal_dimension(sx(10.1809), sx(90.1809), sy(5.0), "80 mm")
        vertical_dimension(
            sx(96.0), sy(83.733683), sy(13.73369), "70 mm", label_side=-1
        )
        vertical_dimension(
            sx(4.0), sy(53.73369), sy(13.73369), "40 mm", label_side=1
        )
        pdf.setFillColorRGB(0.08, 0.08, 0.08)
        pdf.setFont("Helvetica", 6.5)
        pdf.drawCentredString(sx(29.854147), sy(11.0), "35 x 35 mm")
        pdf.drawCentredString(sx(70.14585), sy(11.0), "35 x 35 mm")
        pdf.drawCentredString(sx(50.1809), sy(91.5), "30 mm legs")
        pdf.setFont("Helvetica", 9)
        pdf.drawCentredString(
            page_w * 0.5,
            6.5 * mm,
            "This guide shows how to cut and fold the cardboard pointer.",
        )

    if len(entries) <= guide_capacity:
        leading_entries = []
        final_entries = entries
    else:
        split_at = len(entries) - guide_capacity if guide_capacity else len(entries)
        leading_entries = entries[:split_at]
        final_entries = entries[split_at:]

    for start in range(0, len(leading_entries), full_capacity):
        page_entries = leading_entries[start:start + full_capacity]
        draw_entries(page_entries, full_rows)
        pdf.showPage()

    draw_entries(final_entries, guide_rows)
    draw_pointer_guide()
    pdf.showPage()
    pdf.save()
    return out.getvalue(), ("A4" if page_size == A4 else "A3")


def load_google_maps_key():
    # Prefer env override, then the second token.txt line.
    token = str(os.environ.get("GOOGLE_MAPS_API_KEY") or "").strip()
    if token:
        return token
    return _token_line(1)


def load_mapillary_token():
    # Mapillary access token (for the Street View fallback). Env override, then
    # the THIRD token.txt line. Empty = the fallback simply stays inactive.
    token = str(os.environ.get("MAPILLARY_TOKEN") or "").strip()
    if token:
        return token
    return _token_line(2)


def update_quick_tunnel_state(**kwargs):
    with tunnel_lock:
        quick_tunnel_state.update(kwargs)


def snapshot_quick_tunnel_state():
    with tunnel_lock:
        return dict(quick_tunnel_state)


def monitor_quick_tunnel_output(proc):
    global quick_tunnel_process

    try:
        while True:
            line = proc.stdout.readline() if proc.stdout is not None else ""
            if not line:
                break
            text = line.strip()
            if not text:
                continue
            update_quick_tunnel_state(last_line=text)
            print(f"[Tunnel] {text}", flush=True)

            match = QUICK_TUNNEL_URL_RE.search(text)
            if match:
                url = match.group(0)
                update_quick_tunnel_state(status="ready", url=url, error="")
                print(f"[Tunnel] Quick Tunnel ready: {url}", flush=True)
    finally:
        return_code = None
        try:
            return_code = proc.wait(timeout=0.2)
        except Exception:
            pass

        with tunnel_lock:
            if quick_tunnel_process is proc:
                quick_tunnel_process = None

        current = snapshot_quick_tunnel_state()
        if shutdown_event.is_set():
            update_quick_tunnel_state(status="stopped")
        elif current.get("status") != "ready":
            update_quick_tunnel_state(
                status="error",
                error=f"cloudflared_exited_{return_code}" if return_code is not None else "cloudflared_exited",
            )


def start_quick_tunnel(port):
    global quick_tunnel_process

    with tunnel_lock:
        if quick_tunnel_process is not None and quick_tunnel_process.poll() is None:
            return quick_tunnel_process

    cloudflared_path = shutil.which("cloudflared")
    if not cloudflared_path:
        update_quick_tunnel_state(
            enabled=False,
            status="unavailable",
            error="cloudflared_not_found",
            url="",
            startedAt="",
        )
        print("[Tunnel] cloudflared not found on PATH; skipping Quick Tunnel startup.", flush=True)
        return None

    command = [cloudflared_path, "tunnel", "--url", f"http://127.0.0.1:{int(port)}"]
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
        )
    except Exception as exc:
        update_quick_tunnel_state(
            enabled=False,
            status="error",
            error=f"cloudflared_start_failed: {exc}",
            url="",
            startedAt="",
        )
        print(f"[Tunnel] Failed to start cloudflared: {exc}", flush=True)
        return None

    with tunnel_lock:
        quick_tunnel_process = proc
    update_quick_tunnel_state(
        enabled=True,
        status="starting",
        url="",
        error="",
        last_line="",
        startedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )

    threading.Thread(target=monitor_quick_tunnel_output, args=(proc,), daemon=True).start()
    print("[Tunnel] Starting Cloudflare Quick Tunnel...", flush=True)
    return proc


def stop_quick_tunnel():
    global quick_tunnel_process

    with tunnel_lock:
        proc = quick_tunnel_process
        quick_tunnel_process = None

    if proc is None:
        return

    try:
        proc.terminate()
        proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    update_quick_tunnel_state(status="stopped")


def normalize_custom_objects_payload(payload):
    if not isinstance(payload, dict) or payload.get("type") != "FeatureCollection":
        return None

    raw_features = payload.get("features")
    if not isinstance(raw_features, list):
        return None

    features = []
    for raw_feature in raw_features:
        if not isinstance(raw_feature, dict):
            continue
        geometry = raw_feature.get("geometry")
        properties = raw_feature.get("properties")
        if (
            not isinstance(geometry, dict)
            or geometry.get("type") != "Point"
            or not isinstance(properties, dict)
        ):
            continue

        coordinates = geometry.get("coordinates")
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            continue
        try:
            lng = float(coordinates[0])
            lat = float(coordinates[1])
        except Exception:
            continue
        if not math.isfinite(lng) or not math.isfinite(lat):
            continue

        feature_id = str(properties.get("id") or "").strip()
        text = str(properties.get("text") or "").strip()
        mode = str(properties.get("mode") or "").strip()
        color = str(properties.get("color") or "").strip()
        legacy_style_id = str(properties.get("styleId") or "").strip()
        if not color and legacy_style_id:
            legacy_colors = {
                "red-square": "#ff4d4f",
                "blue-circle": "#3b82f6",
                "green-diamond": "#22c55e",
                "blue-triangle": "#3b82f6",
            }
            color = legacy_colors.get(legacy_style_id, "")
        if not feature_id or not text or not mode or not color:
            continue

        features.append(
            {
                "type": "Feature",
                "properties": {
                    "id": feature_id,
                    "text": text,
                    "mode": mode,
                    "color": color,
                },
                "geometry": {"type": "Point", "coordinates": [lng, lat]},
            }
        )

    return {"type": "FeatureCollection", "features": features}


def _find_chromium_browser():
    """Locate Chrome or Edge on Windows. Returns the executable path or None."""
    if sys.platform == "win32":
        candidates = [
            os.environ.get("PROGRAMFILES", r"C:\Program Files") + r"\Google\Chrome\Application\chrome.exe",
            os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)") + r"\Google\Chrome\Application\chrome.exe",
            os.environ.get("LOCALAPPDATA", "") + r"\Google\Chrome\Application\chrome.exe",
            os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)") + r"\Microsoft\Edge\Application\msedge.exe",
            os.environ.get("PROGRAMFILES", r"C:\Program Files") + r"\Microsoft\Edge\Application\msedge.exe",
        ]
    else:
        candidates = [
            shutil.which("google-chrome"),
            shutil.which("chromium"),
            shutil.which("chromium-browser"),
            shutil.which("microsoft-edge"),
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def find_available_port(host, preferred_port, search_limit=100):
    """Return an available TCP port, starting with ``preferred_port``.

    Port 5000 remains the predictable first choice. If it is occupied, nearby
    ports are tried in ascending order; if that range is exhausted, the OS
    chooses an available ephemeral port. Passing ``--port 0`` also asks the OS
    to choose immediately.
    """
    preferred_port = int(preferred_port)
    if preferred_port < 0 or preferred_port > 65535:
        raise ValueError("Port must be between 0 and 65535.")

    bind_host = "0.0.0.0" if host in ("0.0.0.0", "", None) else str(host)
    family = socket.AF_INET6 if ":" in bind_host else socket.AF_INET

    def _try_bind(port):
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            # On Windows this prevents a second process from appearing to
            # acquire a port that is already owned by another socket.
            if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind((bind_host, int(port)))
            return int(probe.getsockname()[1])

    if preferred_port == 0:
        return _try_bind(0)

    last_candidate = min(65535, preferred_port + max(1, int(search_limit)) - 1)
    for candidate in range(preferred_port, last_candidate + 1):
        try:
            return _try_bind(candidate)
        except OSError:
            continue

    return _try_bind(0)


def open_browser_when_ready(host, port, kiosk=False, delay_max_s=5.0):
    """Wait until the Flask server is accepting connections, then open it in the browser.
    With kiosk=True, try to launch Chrome/Edge in fullscreen kiosk mode."""
    target_host = "127.0.0.1" if host in ("0.0.0.0", "", None) else host
    url = f"http://{target_host}:{port}/"

    def _open():
        deadline = time.time() + delay_max_s
        while time.time() < deadline and not shutdown_event.is_set():
            try:
                with socket.create_connection((target_host, int(port)), timeout=0.3):
                    break
            except OSError:
                time.sleep(0.1)
        if shutdown_event.is_set():
            return
        if kiosk:
            browser = _find_chromium_browser()
            if browser:
                try:
                    global kiosk_browser_process
                    # --app=URL gives a chromeless window (no tabs / URL bar);
                    # --start-fullscreen launches fullscreen but still lets F11 / Esc toggle out.
                    kiosk_browser_process = subprocess.Popen([
                        browser, f"--app={url}", "--start-fullscreen"
                    ])
                    print("[Browser] fullscreen app mode — F11 or Esc to toggle, or use the on-screen Exit button")
                    return
                except Exception:
                    pass
            print("[Browser] kiosk requested but no Chrome/Edge found — falling back to default browser")
        # macOS: the `open` command is reliable inside frozen .app bundles,
        # where the webbrowser module's launcher detection can silently fail.
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

    threading.Thread(target=_open, daemon=True).start()


def init_camera(source):
    global camera, camera_source
    # If a camera is already open, detach it from `camera` first so the
    # capture loop stops touching it, give it a moment, then release.
    # camera_loop takes a snapshot at the top of each iteration, so by the
    # time we release here it has already moved on to seeing camera = None.
    previous = camera
    camera = None
    camera_source = ""
    if previous is not None:
        time.sleep(0.08)
        try:
            previous.release()
        except Exception:
            pass
    if source is None:
        return
    cap = cv2.VideoCapture(source)
    try:
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:
        pass
    if not cap.isOpened():
        print(f"[Camera] Could not open source: {source} — continuing without a camera")
        return
    camera = cap
    camera_source = str(source)


def snapshot_corners():
    with corners_lock:
        return [None if c is None else {"x": float(c["x"]), "y": float(c["y"])} for c in surface_corners]


def compute_surface_transform():
    corners = snapshot_corners()
    if not all(c is not None for c in corners):
        return corners, None

    src = np.array([[c["x"], c["y"]] for c in corners], dtype=np.float32)
    dst = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32)
    return corners, cv2.getPerspectiveTransform(src, dst)


def apply_tutorial_mask(gray):
    """If the tutorial mask is active, fill its uv rectangle (mapped through the surface
    corners into frame pixels) with flat gray in `gray`, so the AprilTags shown in the
    tutorial video can't be decoded. No-op if inactive or the surface isn't calibrated."""
    with tutorial_mask_lock:
        active = tutorial_mask["active"]
        rect = tutorial_mask["rect"]
    if not active or not rect:
        return
    corners = snapshot_corners()
    if not all(c is not None for c in corners):
        return
    try:
        # uv (unit square) -> frame px is the inverse of the frame->uv transform.
        dst = np.array([[c["x"], c["y"]] for c in corners], dtype=np.float32)  # frame px (TL,TR,BR,BL)
        src = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32)     # uv
        uv_to_frame = cv2.getPerspectiveTransform(src, dst)
        u0, v0, u1, v1 = rect["u0"], rect["v0"], rect["u1"], rect["v1"]
        quad_uv = np.array([[[u0, v0], [u1, v0], [u1, v1], [u0, v1]]], dtype=np.float32)
        quad_px = cv2.perspectiveTransform(quad_uv, uv_to_frame).reshape(-1, 2)
        cv2.fillConvexPoly(gray, quad_px.astype(np.int32), 127)   # flat mid-gray → no tag decodable
    except Exception as exc:
        print(f"[TutorialMask] failed: {exc}", flush=True)


def project_frame_point(x, y, H):
    if H is None:
        return None
    arr = np.array([[[float(x), float(y)]]], dtype=np.float32)
    out = cv2.perspectiveTransform(arr, H).reshape(-1, 2)
    if out.size < 2:
        return None
    return {"u": float(out[0][0]), "v": float(out[0][1])}


def extrapolate_full_tag_outer_corner(pts, surface_centroid):
    tag_center = pts.mean(axis=0)
    dists = np.linalg.norm(pts - surface_centroid, axis=1)
    detected_outer = pts[int(np.argmax(dists))]
    return tag_center + (detected_outer - tag_center) * APRILTAG_OUTER_CORNER_SCALE


def update_surface_corners_from_detections(detections):
    # Gather the visible corner tags (25-28) and their 4 image-space corners.
    corner_tags = {}
    for det in detections:
        tid = int(det.tag_id)
        if tid not in SURFACE_CORNER_TAGS:
            continue
        pts = np.array(det.corners, dtype=np.float32).reshape(-1, 2)
        if pts.shape[0] >= 4:
            corner_tags[tid] = pts

    if not corner_tags:
        return

    # Surface centre ≈ centroid of all visible corner-tag centres. For each tag
    # we then take whichever of its own corners is FARTHEST from that centre —
    # i.e. the outer corner. This is orientation-agnostic, so it stays correct
    # under rotation and rear projection (mirroring), where a fixed tag-corner
    # index would otherwise grab an inner corner.
    # The detector gives the black square corner; the stored surface corner is
    # the full SVG image corner outside the one-cell white quiet zone.
    centers = np.array([pts.mean(axis=0) for pts in corner_tags.values()], dtype=np.float32)
    centroid = centers.mean(axis=0)

    updates = {}
    for tid, pts in corner_tags.items():
        surface_corner_idx = SURFACE_CORNER_TAGS[tid][0]
        outer = extrapolate_full_tag_outer_corner(pts, centroid)
        updates[surface_corner_idx] = {"x": float(outer[0]), "y": float(outer[1])}

    with corners_lock:
        for corner_idx, point in updates.items():
            surface_corners[corner_idx] = point


def _canvas_bounds(canvas_size):
    w, h = canvas_size
    return np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])


def estimate_surface_corners_from_grid(detections):
    """Recover the 4 screen corners (camera px, TL/TR/BR/BL) from the projected
    calibration grid.

    Returns (corners | None, tags_found, reproj_error_px | None). corners is a
    list of [x, y]. Adapted from opencv_16h5_live.py:estimate_surface_corners:
    fit a camera->canvas homography over every detected grid tag's centre, gate
    on coverage / inliers / reprojection error, then map the canvas bounds back
    through the inverse to get the screen corners in the camera frame.
    """
    centers = CALIB_GRID_TARGET_CENTERS
    cam_pts, can_pts = [], []
    for det in detections:
        tid = int(det.tag_id)
        if tid not in centers:
            continue
        pts = np.array(det.corners, dtype=np.float32).reshape(-1, 2)
        if pts.shape != (4, 2) or not np.isfinite(pts).all():
            continue
        cam_pts.append(pts.mean(axis=0))
        can_pts.append(centers[tid])
    found = len(cam_pts)
    if found < CALIB_MIN_TAGS:
        return None, found, None

    cam = np.float32(cam_pts)
    can = np.float32(can_pts)
    w, h = CALIB_GRID_CANVAS
    if (float(np.ptp(can[:, 0])) / w < CALIB_MIN_COVERAGE
            or float(np.ptp(can[:, 1])) / h < CALIB_MIN_COVERAGE):
        return None, found, None

    homography, inliers = cv2.findHomography(cam, can, cv2.RANSAC, CALIB_RANSAC_PX)
    if homography is None or inliers is None:
        return None, found, None

    projected = cv2.perspectiveTransform(cam.reshape(1, -1, 2), homography).reshape(-1, 2)
    errors = np.linalg.norm(projected - can, axis=1)
    mask = inliers.ravel().astype(bool)
    if not mask.any():
        return None, found, None
    inlier_ratio = float(np.mean(mask))
    reproj = float(np.sqrt(np.mean(np.square(errors[mask]))))
    if inlier_ratio < CALIB_MIN_INLIER_RATIO or reproj > CALIB_MAX_REPROJ_PX:
        return None, found, reproj

    try:
        inverse = np.linalg.inv(homography)
    except np.linalg.LinAlgError:
        return None, found, reproj
    surface = cv2.perspectiveTransform(
        _canvas_bounds(CALIB_GRID_CANVAS).reshape(1, 4, 2), inverse
    ).reshape(4, 2)
    if not np.isfinite(surface).all() or abs(cv2.contourArea(surface.astype(np.float32))) < 100:
        return None, found, reproj
    return [[float(p[0]), float(p[1])] for p in surface], found, reproj


def process_grid_calibration(detections):
    """One calibration pass: update the live status and, once CALIB_CONFIRM_FRAMES
    stable estimates have accumulated, write surface_corners and stop the mode."""
    global grid_calib_enabled
    corners, found, err = estimate_surface_corners_from_grid(detections)
    with corners_lock:
        grid_calib_status["tags_found"] = found
        grid_calib_status["error"] = None if err is None else round(float(err), 2)
        if corners is None:
            return
        candidate = np.float32(corners)
        if grid_calib_candidates:
            reference = np.mean(grid_calib_candidates, axis=0)
            if float(np.max(np.linalg.norm(candidate - reference, axis=1))) > CALIB_CANDIDATE_SHIFT_PX:
                grid_calib_candidates.clear()
        grid_calib_candidates.append(candidate)
        grid_calib_status["stable"] = len(grid_calib_candidates)
        if len(grid_calib_candidates) >= CALIB_CONFIRM_FRAMES:
            averaged = np.mean(grid_calib_candidates, axis=0)
            for i in range(4):
                surface_corners[i] = {"x": float(averaged[i][0]), "y": float(averaged[i][1])}
            grid_calib_status["done"] = True
            grid_calib_status["active"] = False
            grid_calib_enabled = False
            grid_calib_candidates.clear()


def default_calibration_groups():
    groups = {}
    for key, spec in CALIBRATION_GROUP_SPECS.items():
        # Draw group starts at oy=0 (no vertical push under the tag);
        # legacy groups keep oy=20.
        entry = {"ox": 0.0, "oy": 0.0 if key == "draw" else 20.0}
        if spec["allow_comp"]:
            entry["compX"] = 0.0
            entry["compY"] = 0.0
        groups[key] = entry
    return groups


def normalize_offset(raw, allow_comp=True):
    if not isinstance(raw, dict):
        return None
    ox = raw.get("ox")
    oy = raw.get("oy")
    if not isinstance(ox, (int, float)) or not isinstance(oy, (int, float)):
        return None
    if not math.isfinite(float(ox)) or not math.isfinite(float(oy)):
        return None
    result = {"ox": float(ox), "oy": float(oy)}
    if allow_comp:
        cx = raw.get("compX")
        cy = raw.get("compY")
        if isinstance(cx, (int, float)) and math.isfinite(float(cx)):
            result["compX"] = float(cx)
        if isinstance(cy, (int, float)) and math.isfinite(float(cy)):
            result["compY"] = float(cy)
    return result


def normalize_calibration_payload(raw):
    if not isinstance(raw, dict):
        return None

    if "ox" in raw or "oy" in raw:
        legacy = normalize_offset(raw, allow_comp=True)
        if legacy is None:
            return None
        groups = default_calibration_groups()
        groups["draw"].update(legacy)
        return groups

    source = raw.get("groups") if "groups" in raw else raw
    if not isinstance(source, dict):
        return None

    groups = default_calibration_groups()
    saw_group = False
    for key, spec in CALIBRATION_GROUP_SPECS.items():
        if key not in source:
            continue
        normalized = normalize_offset(source.get(key), allow_comp=spec["allow_comp"])
        if normalized is None:
            return None
        groups[key].update(normalized)
        saw_group = True

    return groups if saw_group else None


def camera_loop():
    global latest_frame, latest_frame_seq, latest_frame_width, latest_frame_height, latest_camera_fps
    fps_prev_t = None
    while not shutdown_event.is_set():
        # Snapshot the camera reference so init_camera() swapping it out
        # mid-iteration can't make us read from a released capture.
        cap = camera
        if cap is None:
            time.sleep(0.01)
            continue
        try:
            ok, frame = cap.read()
        except cv2.error:
            # Camera was released or hit a transient backend error — back off
            # and pick up whatever's installed next loop.
            time.sleep(0.05)
            continue
        except Exception:
            time.sleep(0.05)
            continue
        if not ok:
            time.sleep(0.002)
            continue

        with frame_lock:
            latest_frame = frame
            latest_frame_seq += 1
            latest_frame_height = int(frame.shape[0])
            latest_frame_width = int(frame.shape[1])

        # Rolling capture FPS (EMA) for the camera-page overlay.
        now = time.monotonic()
        if fps_prev_t is not None:
            dt = now - fps_prev_t
            if dt > 0:
                inst = 1.0 / dt
                latest_camera_fps = inst if latest_camera_fps <= 0 else (latest_camera_fps * 0.9 + inst * 0.1)
        fps_prev_t = now


# ── auto-exposure (closed loop on the IP Webcam phone) ───────────────────────

class AutoExposure:
    """Highlight-metered closed-loop exposure for the IP Webcam phone.

    The phone's native auto-exposure meters the whole frame, so a bright
    projection drags the average down and the speculars clip to 255 -- which
    erases tag borders. This drives the highlights (p95) toward a target just
    below clipping so the projected area where the tags live stays in range,
    BUT it refuses to darken past the point where the bright *content* (p75)
    dips below a floor -- so a persistent emissive spot (screen UI, glare)
    can't spiral the whole scene to black. It converges in a few damped steps,
    then HOLDS (a rig's light is steady) and only re-checks every few seconds,
    so steady state sends no HTTP and never flickers. Control is multiplicative
    on exposure time (luminance ~ exposure away from saturation); ISO is pinned
    at the floor for low noise.
    """

    def __init__(self, iso=100, start_ms=8.0, exp_min_ms=0.5, exp_max_ms=40.0,
                 hi_pct=95.0, target_hi=205.0, mid_pct=75.0, mid_floor=90.0,
                 tol=6.0, gain=0.6, min_step=0.6, max_step=1.6,
                 settle_s=0.5, recheck_s=5.0):
        self.iso = int(iso)
        self.exp_ms = float(start_ms)
        self.exp_min_ms, self.exp_max_ms = float(exp_min_ms), float(exp_max_ms)
        self.hi_pct, self.target_hi = float(hi_pct), float(target_hi)
        self.mid_pct, self.mid_floor = float(mid_pct), float(mid_floor)
        self.tol, self.gain = float(tol), float(gain)
        self.min_step, self.max_step = float(min_step), float(max_step)
        self.settle_s, self.recheck_s = float(settle_s), float(recheck_s)
        self._base = None
        self._next_t = 0.0
        self._hold = False
        self._hold_t = 0.0

    def reset(self):
        self._base = None
        self._hold = False

    @staticmethod
    def _send(base, path):
        import urllib.request
        try:
            urllib.request.urlopen(f"{base}/{path}", timeout=2.0)
            return True
        except Exception as exc:
            print(f"[AutoExposure] {path} failed: {exc}", flush=True)
            return False

    def _apply(self, base):
        self.exp_ms = min(self.exp_max_ms, max(self.exp_min_ms, self.exp_ms))
        self._send(base, f"settings/exposure_ns?set={int(self.exp_ms * 1e6)}")
        self._next_t = time.time() + self.settle_s  # let the change settle first

    def update(self, base, frame):
        now = time.time()
        # (re)assert manual sensor + ISO whenever the camera/base changes
        if self._base != base:
            self._send(base, "settings/manual_sensor?set=on")
            self._send(base, f"settings/iso?set={self.iso}")
            self._base = base
            self._hold = False
            self._apply(base)
            return
        if now < self._next_t:               # wait for the last change to land
            return
        if self._hold and (now - self._hold_t) < self.recheck_s:
            return                           # converged: idle until next recheck

        gray = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        hi = float(np.percentile(gray, self.hi_pct))    # highlights
        mid = float(np.percentile(gray, self.mid_pct))  # bright content body

        if abs(hi - self.target_hi) <= self.tol:
            factor = 1.0                                    # highlights on target
        else:
            factor = (self.target_hi / max(hi, 1.0)) ** self.gain
        # Anti-over-darkening guard: never reduce exposure past the point where
        # the bright *content* (p75, not emissive UI/speculars/glare) dips below
        # the floor. This is what stops a persistent bright spot from spiralling
        # the whole scene to black -- the failure in the previous build.
        if factor < 1.0 and mid <= self.mid_floor:
            factor = 1.0
        factor = min(self.max_step, max(self.min_step, factor))  # damp each step

        new_exp = min(self.exp_max_ms, max(self.exp_min_ms, self.exp_ms * factor))
        if abs(new_exp - self.exp_ms) > 0.02 * self.exp_ms:
            self.exp_ms = new_exp
            self._hold = False
            self._apply(base)
        else:
            if not self._hold:
                print("[AutoExposure] settled hi=%.0f mid=%.0f exp=%.2f ms"
                      % (hi, mid, self.exp_ms), flush=True)
            self._hold = True
            self._hold_t = now


def auto_exposure_loop():
    """Background thread: meter latest_frame and drive the phone's exposure.

    Only active for an IP Webcam HTTP source (the one with a settings API) and
    while auto_exposure_enabled. Runs in its own thread so the blocking HTTP
    settings calls never stall capture or detection.
    """
    ctrl = AutoExposure(target_hi=auto_exposure_target, mid_floor=auto_exposure_floor)
    last_seq = -1
    while not shutdown_event.is_set():
        if not auto_exposure_enabled:
            ctrl.reset()
            time.sleep(0.3)
            continue
        base = _camera_base_url()
        if not base:
            ctrl.reset()
            time.sleep(0.5)                  # not an IP cam: nothing to control
            continue
        with frame_lock:
            seq = int(latest_frame_seq)
            frame = None if latest_frame is None else latest_frame.copy()
        if frame is None or seq == last_seq:
            time.sleep(0.05)
            continue
        last_seq = seq
        try:
            ctrl.update(base, frame)
        except Exception as exc:
            print(f"[AutoExposure] update failed: {exc}", flush=True)
        time.sleep(0.1)


def map_detection(det, H):
    corners_px_arr = np.array(det.corners, dtype=np.float32).reshape(-1, 2)
    corners_px = [{"x": float(pt[0]), "y": float(pt[1])} for pt in corners_px_arr]
    tag_id = int(det.tag_id)

    # Anchor all tag interactions to the marker's decoded bottom edge:
    # midpoint of tag-intrinsic corners 2 and 3. This follows the marker's
    # own orientation, so rotating the physical tag rotates the anchor edge
    # with it instead of snapping to the screen's visual bottom edge.
    anchor_px = corners_px_arr[[2, 3]].mean(axis=0)
    cx, cy = float(anchor_px[0]), float(anchor_px[1])

    uv = None
    uv_corners = None
    in_surface = False

    if H is not None:
        corner_uv_arr = cv2.perspectiveTransform(corners_px_arr.reshape(-1, 1, 2), H).reshape(-1, 2)
        uv_corners = [{"u": float(pt[0]), "v": float(pt[1])} for pt in corner_uv_arr]

        # Under a homography, midpoint(transform(A), transform(B)) != transform(midpoint(A, B)).
        # We use the true image-space anchor for interactions, so map that anchor directly.
        uv = project_frame_point(cx, cy, H)
        if uv is not None:
            in_surface = 0 <= uv["u"] <= 1 and 0 <= uv["v"] <= 1

    return {
        "id": tag_id,
        "center": {"x": cx, "y": cy},
        "corners": corners_px,
        "uv": uv,
        "uvCorners": uv_corners,
        "inSurface": in_surface,
    }


ARUCO_FAMILY_MAP = {
    "tag16h5":  cv2.aruco.DICT_APRILTAG_16h5,
    "tag25h9":  cv2.aruco.DICT_APRILTAG_25h9,
    "tag36h10": cv2.aruco.DICT_APRILTAG_36h10,
    "tag36h11": cv2.aruco.DICT_APRILTAG_36h11,
}

# Tuned ArUco DetectorParameters, ported from the better-detecting reference
# D:\IP2\Spacious\OpenCV\opencv_16h5_ipcam_roi.py run as:
#   --control "Win max=53" --control "Poly x1000=100"
#   --control "MinPerim x1000=10" --control "PixCell=8"
# Every other param in that script (and its default preprocessing: CLAHE off,
# blur off, gamma 1.0, threshold passthrough) already matches OpenCV's raw
# defaults, so only these four differ from cv2.aruco.DetectorParameters().
# Live-tunable ArUco DetectorParameters surfaced as sliders on the camera page.
# Values are kept in the reference script's integer "control" units and converted on
# apply (so they read the same as opencv_16h5_ipcam_roi.py's sliders). Defaults
# reproduce that script's better 16h5 setting; its other params already equal OpenCV's.
# "start" = the value applied by default (the better 16h5 tuning); "opencv" = the
# stock cv2.aruco.DetectorParameters() default, shown on each slider as a reference.
ARUCO_TUNING_CONTROLS = {
    "winMax":   {"param": "adaptiveThreshWinSizeMax",      "label": "Win max",        "min": 3,  "max": 181, "step": 2, "start": 53,  "opencv": 23, "scale": 1,     "odd": True},
    "poly":     {"param": "polygonalApproxAccuracyRate",   "label": "Poly ×1000",     "min": 10, "max": 120, "step": 1, "start": 100, "opencv": 30, "scale": 0.001},
    "minPerim": {"param": "minMarkerPerimeterRate",        "label": "MinPerim ×1000", "min": 1,  "max": 100, "step": 1, "start": 10,  "opencv": 30, "scale": 0.001},
    "pixCell":  {"param": "perspectiveRemovePixelPerCell", "label": "PixCell",        "min": 1,  "max": 20,  "step": 1, "start": 8,   "opencv": 4,  "scale": 1},
}
aruco_tuning_values = {key: meta["start"] for key, meta in ARUCO_TUNING_CONTROLS.items()}


def _apply_aruco_tuning(params):
    """Apply the current aruco_tuning_values to a DetectorParameters, converting each
    control to its real units and skipping fields this OpenCV build doesn't expose."""
    for key, meta in ARUCO_TUNING_CONTROLS.items():
        raw = aruco_tuning_values.get(key, meta["start"])
        if meta.get("odd") and raw % 2 == 0:
            raw += 1
        if hasattr(params, meta["param"]):
            setattr(params, meta["param"], raw * meta["scale"])
    return params


# ── second-pass adaptive upscale ─────────────────────────────────────────────
# Rescues small / under-resolved tags by upscaling tag-shaped REJECTED ROIs and
# re-detecting on the crop. Ported from D:\IP2\Spacious\OpenCV\opencv_16h5_ipcam_roi.py.
# Only square-ish, tag-sized rejected quads are upscaled (adaptive: smaller side →
# larger scale), so it does NOT upscale every ROI. Read live by ArucoDetector — a
# slider change applies on the next frame, no detector rebuild.
# Off by default: with a low --aruco-min-area it fires a CUBIC resize + full
# re-detectMarkers on every tag-shaped rejected ROI, which measured ~90ms/frame
# (9ms -> 100ms detect) on a 720p IP-cam scene. Re-enable via the camera-page
# slider when you actually need the extra range for small / distant tags.
aruco_upscale_enabled = False
ARUCO_UPSCALE_CONTROLS = {
    "upTarget":  {"label": "Upscale target px", "min": 100, "max": 300, "step": 5, "default": 190},
    "upMinSide": {"label": "Upscale min side",  "min": 6,   "max": 60,  "step": 1, "default": 12},
    "upMaxSide": {"label": "Upscale max side",  "min": 40,  "max": 200, "step": 5, "default": 110},
}
aruco_upscale_values = {key: meta["default"] for key, meta in ARUCO_UPSCALE_CONTROLS.items()}
ARUCO_UPSCALE_PAD = 1.0
ARUCO_UPSCALE_MAX_ASPECT = 1.7
ARUCO_UPSCALE_MERGE_TOL = 15.0


def _aruco_roi_tag_side(quad):
    """Mean side length if the quad is square-ish and tag-sized, else None."""
    edges = [float(np.linalg.norm(quad[(k + 1) % 4] - quad[k])) for k in range(4)]
    smin, smax = min(edges), max(edges)
    if smin < 1e-3 or smax / smin > ARUCO_UPSCALE_MAX_ASPECT:
        return None
    side = sum(edges) / 4.0
    if not (aruco_upscale_values["upMinSide"] <= side <= aruco_upscale_values["upMaxSide"]):
        return None
    return side


def _aruco_second_pass(gray, rejected, det):
    """Upscale each tag-shaped rejected ROI and re-run detection on the crop.

    Returns (corners_list, ids_list) in full-frame pixels. A hit is kept only if its
    centre lands inside the originating ROI (false-positive guard; the 16h5 dictionary
    is exact-match so this is safe)."""
    height, width = gray.shape[:2]
    target = float(aruco_upscale_values["upTarget"])
    out_c, out_i = [], []
    for quad in rejected:
        q = np.asarray(quad, np.float32).reshape(4, 2)
        side = _aruco_roi_tag_side(q)
        if side is None:
            continue
        x0, y0 = q.min(axis=0)
        x1, y1 = q.max(axis=0)
        px = int((x1 - x0) * ARUCO_UPSCALE_PAD) + 4
        py = int((y1 - y0) * ARUCO_UPSCALE_PAD) + 4
        cx0, cy0 = max(0, int(x0 - px)), max(0, int(y0 - py))
        cx1, cy1 = min(width, int(x1 + px)), min(height, int(y1 + py))
        sub = gray[cy0:cy1, cx0:cx1]
        if sub.size == 0 or min(sub.shape[:2]) < 8:
            continue
        scale = float(np.clip(target / side, 2.0, 10.0))
        up = cv2.resize(sub, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        c2, i2, _ = det.detectMarkers(up)
        if i2 is None:
            continue
        for corner, tag_id in zip(c2, i2.ravel()):
            qc = np.asarray(corner, np.float32).reshape(4, 2) / scale + [cx0, cy0]
            ctr = qc.mean(axis=0)
            if x0 - 2 <= ctr[0] <= x1 + 2 and y0 - 2 <= ctr[1] <= y1 + 2:
                out_c.append(qc)
                out_i.append(int(tag_id))
    return out_c, out_i


def aruco_tuning_payload():
    backend = detector_manager.snapshot().get("backend") if detector_manager else None
    controls = [{
        "key": key, "label": meta["label"], "min": meta["min"], "max": meta["max"],
        "step": meta["step"], "default": meta["opencv"], "value": aruco_tuning_values[key],
    } for key, meta in ARUCO_TUNING_CONTROLS.items()]
    upscale = [{
        "key": key, "label": meta["label"], "min": meta["min"], "max": meta["max"],
        "step": meta["step"], "default": meta["default"], "value": aruco_upscale_values[key],
    } for key, meta in ARUCO_UPSCALE_CONTROLS.items()]
    return {
        "controls": controls,
        "upscale": upscale,
        "upscaleEnabled": bool(aruco_upscale_enabled),
        "appliesTo": "aruco",
        "activeBackend": backend,
    }


def _tag_area_px(corners):
    """Shoelace area of a 4-corner polygon."""
    c = corners  # shape (4, 2)
    return 0.5 * abs(
        (c[0][0]*c[1][1] - c[1][0]*c[0][1]) +
        (c[1][0]*c[2][1] - c[2][0]*c[1][1]) +
        (c[2][0]*c[3][1] - c[3][0]*c[2][1]) +
        (c[3][0]*c[0][1] - c[0][0]*c[3][1])
    )


class _ArucoDetection:
    """Thin wrapper so ArUco results look like pupil_apriltags Detection objects.

    Used for any detector whose native output is just (id, 4x2 corner array).
    """
    __slots__ = ("tag_id", "corners")

    def __init__(self, tag_id, corners):
        self.tag_id = tag_id
        self.corners = corners   # shape (4, 2), float32, order TL TR BR BL


class ArucoDetector:
    """Drop-in replacement for pupil_apriltags.Detector using OpenCV ArUco.

    Supports one or more tag families; results from all dictionaries are merged.
    """

    def __init__(self, families="tag16h5", min_area_px=200):
        # Accept a string (single or comma-separated) or a list of strings.
        if isinstance(families, str):
            families = [f.strip() for f in families.replace(",", " ").split() if f.strip()]
        if not families:
            families = ["tag16h5"]

        self._detectors = []
        for family in families:
            dict_id = ARUCO_FAMILY_MAP.get(family)
            if dict_id is None:
                raise ValueError(f"Unsupported ArUco family '{family}'. Choose from: {list(ARUCO_FAMILY_MAP)}")
            aruco_dict = cv2.aruco.getPredefinedDictionary(dict_id)
            params = _apply_aruco_tuning(cv2.aruco.DetectorParameters())
            self._detectors.append(cv2.aruco.ArucoDetector(aruco_dict, params))

        self._min_area = float(min_area_px)
        self.families = families  # for logging

    def detect(self, gray, *_, **__):
        seen_ids = set()
        results = []
        for det in self._detectors:
            corners_list, ids, rejected = det.detectMarkers(gray)
            pass_corners = [np.asarray(c, np.float32).reshape(4, 2) for c in corners_list] if ids is not None else []
            pass_ids = [int(v) for v in ids.ravel()] if ids is not None else []

            # Second pass: upscale small tag-shaped rejected ROIs and re-detect,
            # merging recovered tags that aren't duplicates of a first-pass hit.
            if aruco_upscale_enabled and rejected is not None and len(rejected):
                extra_c, extra_i = _aruco_second_pass(gray, rejected, det)
                centers = [c.mean(axis=0) for c in pass_corners]
                for corner, tag_id in zip(extra_c, extra_i):
                    ctr = corner.mean(axis=0)
                    if any(j == tag_id and float(np.hypot(*(ctr - p))) < ARUCO_UPSCALE_MERGE_TOL
                           for j, p in zip(pass_ids, centers)):
                        continue
                    pass_corners.append(corner)
                    pass_ids.append(tag_id)
                    centers.append(ctr)

            for pts, tag_id in zip(pass_corners, pass_ids):
                if tag_id in seen_ids:
                    continue
                if _tag_area_px(pts) < self._min_area:
                    continue
                seen_ids.add(tag_id)
                results.append(_ArucoDetection(tag_id, pts))
        return results


def normalize_apriltag_families(raw):
    if raw is None:
        return []
    tokens = raw if isinstance(raw, (list, tuple)) else [raw]
    families = []
    for token in tokens:
        for part in str(token or "").replace(",", " ").split():
            family = part.strip()
            if family:
                families.append(family)
    return families


def marker_settings_family():
    settings = load_marker_settings()
    family = str(settings.get("family") or "").strip()
    return family or default_marker_settings()["family"]


def create_detector_from_args(args, families=None):
    families = normalize_apriltag_families(families)
    if not families:
        families = [marker_settings_family()]
    families_str = " ".join(families)

    if args.detector == "aruco":
        detector = ArucoDetector(
            families=families,
            min_area_px=args.aruco_min_area,
        )
        label = f"OpenCV ArUco  families={families}  min_area={args.aruco_min_area}px²"
    else:
        detector = Detector(
            families=families_str,
            nthreads=max(1, int(args.apriltag_threads)),
            quad_decimate=float(args.apriltag_quad_decimate),
            quad_sigma=float(args.apriltag_quad_sigma),
            refine_edges=bool(args.apriltag_refine_edges),
            decode_sharpening=float(args.apriltag_decode_sharpening),
        )
        label = f"pupil_apriltags  families={families}"

    return detector, families, label


class DetectorManager:
    def __init__(self, args, initial_families=None):
        self._args = args
        self._detector = None
        self._families = []
        self._label = ""
        self.configure(initial_families, force=True)

    def supports_marker_family(self):
        return self._args.detector in ("pupil", "aruco")

    def configure(self, families=None, force=False):
        families = normalize_apriltag_families(families)
        if not families:
            families = [marker_settings_family()]
        if not force and not self.supports_marker_family():
            return False
        with detector_lock:
            if not force and families == self._families:
                return False

        detector, normalized_families, label = create_detector_from_args(self._args, families)
        with detector_lock:
            self._detector = detector
            self._families = normalized_families
            self._label = label
        print(f"[Detector] {label}", flush=True)
        return True

    def configure_marker_family(self, family):
        if not self.supports_marker_family():
            return False
        family = str(family or "").strip()
        if not family:
            family = marker_settings_family()
        return self.configure([family])

    def rebuild(self):
        # Re-create the detector with the SAME families (used after a live tuning
        # change, e.g. /api/aruco-tuning). force=True bypasses the no-op guard.
        with detector_lock:
            families = list(self._families)
        return self.configure(families or None, force=True)

    def get_detector(self):
        with detector_lock:
            return self._detector

    def snapshot(self):
        with detector_lock:
            return {
                "backend": self._args.detector,
                "families": list(self._families),
                "label": self._label,
                "dynamicFamily": self.supports_marker_family(),
            }


def current_detector():
    manager = detector_manager
    return manager.get_detector() if manager else None


def sync_detector_with_marker_settings(settings=None):
    manager = detector_manager
    if manager is None:
        return False
    family = marker_settings_family() if settings is None else str(settings.get("family") or "").strip()
    try:
        return manager.configure_marker_family(family)
    except Exception as exc:
        print(f"[Detector] Could not apply marker family '{family}': {exc}", flush=True)
        return False


def detector_loop():
    global latest_tags, latest_tags_seq, latest_tags_updated_at

    # Per-stage timing, off unless DETECT_PERF=1. Logs rolling averages every ~2s.
    # "wait"  = time spent waiting for a NEW camera frame (camera-bound, not us).
    # "copy"  = frame_lock + latest_frame.copy() (2.6MB memcpy for 720p).
    # "skip"  = stale-frame polls per logged frame (high => camera is the cap).
    perf_enabled = os.environ.get("DETECT_PERF") in ("1", "true", "True")
    perf_acc = {"wait": 0.0, "copy": 0.0, "gray": 0.0, "detect": 0.0, "map": 0.0}
    perf_skips = 0
    perf_frames = 0
    perf_last = time.monotonic()
    prev_done = None

    last_frame_seq = -1
    while not shutdown_event.is_set():
        tw = time.perf_counter() if perf_enabled else 0.0
        with frame_lock:
            seq = int(latest_frame_seq)
            stale = (latest_frame is None or seq == last_frame_seq)
            frame = None if stale else latest_frame.copy()
        tc = time.perf_counter() if perf_enabled else 0.0

        if frame is None or seq == last_frame_seq:
            if perf_enabled:
                perf_skips += 1
            time.sleep(0.001)
            continue

        last_frame_seq = seq

        t0 = time.perf_counter() if perf_enabled else 0.0
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        apply_tutorial_mask(gray)   # blank the tutorial-video region (it shows AprilTags)
        t1 = time.perf_counter() if perf_enabled else 0.0
        detector = current_detector()
        if detector is None:
            time.sleep(0.01)
            continue
        try:
            detections = detector.detect(gray, estimate_tag_pose=False)
        except Exception as exc:
            print(f"[Detector] detect failed: {exc}", flush=True)
            time.sleep(0.05)
            continue
        t2 = time.perf_counter() if perf_enabled else 0.0

        if auto_corners_enabled:
            update_surface_corners_from_detections(detections)
        if grid_calib_enabled:
            process_grid_calibration(detections)

        _corners, H = compute_surface_transform()

        mapped = [map_detection(det, H) for det in detections]


        with tags_lock:
            latest_tags = mapped
            latest_tags_seq += 1
            latest_tags_updated_at = time.time()

        if perf_enabled:
            t3 = time.perf_counter()
            # "wait" = idle time since the previous productive frame finished,
            # up to the moment we acquired this fresh one (tc). It's all the
            # stale-poll spinning while the camera hadn't produced a new frame.
            if prev_done is not None:
                perf_acc["wait"] += (tc - prev_done) * 1000.0
            perf_acc["copy"] += (tc - tw) * 1000.0
            perf_acc["gray"] += (t1 - t0) * 1000.0
            perf_acc["detect"] += (t2 - t1) * 1000.0
            perf_acc["map"] += (t3 - t2) * 1000.0
            perf_frames += 1
            prev_done = time.perf_counter()
            now = time.monotonic()
            if now - perf_last >= 2.0 and perf_frames:
                avg = {k: round(v / perf_frames, 2) for k, v in perf_acc.items()}
                avg["skip/frame"] = round(perf_skips / perf_frames, 1)
                avg["tags"] = len(mapped)
                avg["fps"] = round(perf_frames / (now - perf_last), 1)
                print(f"[DETECT_PERF avg ms/frame] {avg}", flush=True)
                perf_acc = {"wait": 0.0, "copy": 0.0, "gray": 0.0, "detect": 0.0, "map": 0.0}
                perf_skips = 0
                perf_frames = 0
                perf_last = now


def build_tags_payload():
    with frame_lock:
        frame_info = {
            "width": int(latest_frame_width),
            "height": int(latest_frame_height),
            "seq": int(latest_frame_seq),
            "fps": round(float(latest_camera_fps), 1),
        }
    with tags_lock:
        tags = list(latest_tags)
        tags_seq = int(latest_tags_seq)
        updated_at = float(latest_tags_updated_at)
    corners = snapshot_corners()
    return {
        "tags": tags,
        "tagsSeq": tags_seq,
        "updatedAt": updated_at,
        "detector": detector_manager.snapshot() if detector_manager else None,
        "corners": corners,
        "frame": frame_info,
        "source": camera_source,
        "phoneControllers": snapshot_phone_controller_states(),
        "commentControllers": snapshot_comment_controller_states(),
    }


def _dxf_group_pairs(path):
    lines = path.read_text(errors="ignore").splitlines()
    limit = len(lines) - 1
    i = 0
    while i < limit:
        yield lines[i].strip(), lines[i + 1].strip()
        i += 2


def _dxf_entity_groups(path):
    in_entities = False
    current_type = None
    current_pairs = []

    for code, value in _dxf_group_pairs(path):
        if code == "0" and value == "SECTION":
            current_type = None
            current_pairs = []
            continue

        if code == "2" and value == "ENTITIES":
            in_entities = True
            continue

        if not in_entities:
            continue

        if code == "0":
            if current_type:
                yield current_type, current_pairs
            if value == "ENDSEC":
                break
            current_type = value
            current_pairs = []
        elif current_type:
            current_pairs.append((code, value))


def _float_or_none(value):
    try:
        out = float(value)
        return out if math.isfinite(out) else None
    except (TypeError, ValueError):
        return None


def _int_or_zero(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _read_repeated_xy(pairs):
    points = []
    pending_x = None
    for code, value in pairs:
        if code == "10":
            pending_x = _float_or_none(value)
        elif code == "20" and pending_x is not None:
            y = _float_or_none(value)
            if y is not None:
                points.append((pending_x, y))
            pending_x = None
    return points


def _arc_points(cx, cy, radius, start_deg, end_deg):
    if radius <= 0:
        return []
    sweep = (end_deg - start_deg) % 360.0
    if sweep <= 1e-9:
        sweep = 360.0
    steps = max(8, min(96, int(math.ceil(sweep / 8.0))))
    pts = []
    for i in range(steps + 1):
        a = math.radians(start_deg + sweep * (i / steps))
        pts.append((cx + math.cos(a) * radius, cy + math.sin(a) * radius))
    return pts


def _parse_floorplan_dxf(path):
    raw_features = []
    min_x = min_y = float("inf")
    max_x = max_y = float("-inf")

    def add_line(points, layer):
        nonlocal min_x, min_y, max_x, max_y
        clean = [(float(x), float(y)) for x, y in points if math.isfinite(float(x)) and math.isfinite(float(y))]
        if len(clean) < 2:
            return
        for x, y in clean:
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)
        raw_features.append({"points": clean, "layer": layer})

    for entity_type, pairs in _dxf_entity_groups(path):
        layer = ""
        values = {}
        for code, value in pairs:
            if code == "8" and not layer:
                layer = value
            if code not in values:
                values[code] = value

        if entity_type == "LINE":
            x1 = _float_or_none(values.get("10"))
            y1 = _float_or_none(values.get("20"))
            x2 = _float_or_none(values.get("11"))
            y2 = _float_or_none(values.get("21"))
            if None not in (x1, y1, x2, y2):
                add_line([(x1, y1), (x2, y2)], layer)
        elif entity_type == "LWPOLYLINE":
            pts = _read_repeated_xy(pairs)
            flags = _int_or_zero(values.get("70"))
            if pts and (flags & 1):
                pts = pts + [pts[0]]
            add_line(pts, layer)
        elif entity_type == "ARC":
            cx = _float_or_none(values.get("10"))
            cy = _float_or_none(values.get("20"))
            radius = _float_or_none(values.get("40"))
            start = _float_or_none(values.get("50"))
            end = _float_or_none(values.get("51"))
            if None not in (cx, cy, radius, start, end):
                add_line(_arc_points(cx, cy, radius, start, end), layer)

    if not raw_features or not all(math.isfinite(v) for v in (min_x, min_y, max_x, max_y)):
        raise ValueError("floorplan_has_no_supported_geometry")

    width = max_x - min_x
    height = max_y - min_y
    if width <= 0 or height <= 0:
        raise ValueError("floorplan_invalid_bounds")

    center_lng = 2.2085
    center_lat = 48.7116
    lat_span = 0.01
    lon_span = lat_span * (width / height) / max(0.2, math.cos(math.radians(center_lat)))
    west = center_lng - lon_span * 0.5
    east = center_lng + lon_span * 0.5
    south = center_lat - lat_span * 0.5
    north = center_lat + lat_span * 0.5

    def to_lnglat(pt):
        x, y = pt
        lng = west + ((x - min_x) / width) * (east - west)
        lat = south + ((y - min_y) / height) * (north - south)
        return [round(lng, 8), round(lat, 8)]

    features = []
    for idx, item in enumerate(raw_features):
        coords = [to_lnglat(pt) for pt in item["points"]]
        features.append({
            "type": "Feature",
            "properties": {"id": idx, "layer": item["layer"]},
            "geometry": {"type": "LineString", "coordinates": coords},
        })

    return {
        "type": "FeatureCollection",
        "features": features,
        "properties": {
            "source": path.name,
            "entityCount": len(features),
            "dxfBounds": [min_x, min_y, max_x, max_y],
        },
        "bounds": [[west, south], [east, north]],
    }


def get_floorplan_payload(plan_id=None):
    path = _floorplan_path_for_id(plan_id)
    if path is None or not path.exists():
        raise FileNotFoundError(str(plan_id or FLOORPLAN_DXF_FILE))
    key = str(path)
    mtime = path.stat().st_mtime
    with floorplan_lock:
        cached = FLOORPLAN_CACHE.get(key)
        if cached and cached.get("mtime") == mtime and cached.get("payload") is not None:
            return cached["payload"]
        payload = _parse_floorplan_dxf(path)
        FLOORPLAN_CACHE[key] = {"mtime": mtime, "payload": payload}
        return payload


@app.route("/")
def root():
    return send_from_directory(WEB_DIR, "launcher.html")


@app.route("/home")
def home_page():
    return send_from_directory(WEB_DIR, "home.html")


@app.route("/marker")
def marker_page():
    return send_from_directory(WEB_DIR, "marker.html")


@app.route("/map")
def map_page():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/digitize-map")
def digitize_map_page():
    """The digitiser: a numeric sheet ID retrieves geographic bounds and
    printed AprilTags recover the photographed paper homography.

    Served by imobyl.html, which started as a fork of the original digitise
    page for the IMOBYL exhibition and has since replaced it outright.
    """
    return send_from_directory(WEB_DIR, "imobyl.html")


@app.route("/paper-test")
def legacy_paper_test_page():
    return redirect("/digitize-map", code=302)


# Saved IMOBYL sessions. Plain JSON on disk rather than browser storage, so a
# session survives a different machine, a cleared cache or a kiosk reset — the
# expo is run from more than one browser.
IMOBYL_SESSIONS_DIR = ROOT / "data" / "imobyl_sessions"
IMOBYL_MAX_BYTES = 24 * 1024 * 1024


def _imobyl_session_path(session_id):
    clean = re.fullmatch(r"[A-Za-z0-9_-]{1,64}", str(session_id or ""))
    if not clean:
        return None
    return IMOBYL_SESSIONS_DIR / f"{session_id}.json"


def _imobyl_summary(path):
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    references = record.get("references") or []
    stickers = 0
    paths = 0
    for reference in references:
        for photo in reference.get("photos") or []:
            stickers += len(photo.get("markers") or [])
            paths += len(photo.get("paths") or [])
        manual = reference.get("manual") or {}
        stickers += len(manual.get("markers") or [])
        paths += len(manual.get("strokes") or [])
    return {
        "id": path.stem,
        "name": record.get("name") or path.stem,
        "savedAt": record.get("savedAt"),
        "sheets": [str(item.get("id")) for item in references],
        "references": len(references),
        "stickers": stickers,
        "paths": paths,
        "bytes": path.stat().st_size,
    }


@app.route("/api/imobyl/sessions", methods=["GET", "POST"])
def api_imobyl_sessions():
    if request.method == "GET":
        IMOBYL_SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        sessions = [
            summary for summary in (
                _imobyl_summary(path)
                for path in sorted(IMOBYL_SESSIONS_DIR.glob("*.json"))
            ) if summary
        ]
        sessions.sort(key=lambda item: item.get("savedAt") or "", reverse=True)
        return jsonify({"ok": True, "sessions": sessions})

    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()[:80]
    state = payload.get("state")
    if not isinstance(state, dict):
        return jsonify({"ok": False, "error": "invalid_state"}), 400
    record = {
        "name": name or time.strftime("%Y-%m-%d %H:%M"),
        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "version": 1,
    }
    record.update({key: value for key, value in state.items() if key != "name"})
    body = json.dumps(record, separators=(",", ":"))
    if len(body.encode("utf-8")) > IMOBYL_MAX_BYTES:
        return jsonify({"ok": False, "error": "session_too_large"}), 413
    # An explicit id overwrites that session instead of making another one:
    # the phone-capture flow keeps every photo of one reference map in a
    # single file, so a workshop ends with one session per sheet, not per shot.
    requested = str(payload.get("id") or "").strip()
    if requested:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", requested):
            return jsonify({"ok": False, "error": "invalid_session_id"}), 400
        session_id = requested
    else:
        session_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    try:
        IMOBYL_SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        (IMOBYL_SESSIONS_DIR / f"{session_id}.json").write_text(body, encoding="utf-8")
    except OSError:
        return jsonify({"ok": False, "error": "session_not_saved"}), 500
    return jsonify({"ok": True, "id": session_id, "name": record["name"]})


@app.route("/api/imobyl/sessions/<session_id>", methods=["GET", "DELETE"])
def api_imobyl_session(session_id):
    path = _imobyl_session_path(session_id)
    if path is None:
        return jsonify({"ok": False, "error": "invalid_session_id"}), 400
    if not path.exists():
        return jsonify({"ok": False, "error": "session_not_found"}), 404
    if request.method == "DELETE":
        try:
            path.unlink()
        except OSError:
            return jsonify({"ok": False, "error": "session_not_deleted"}), 500
        return jsonify({"ok": True, "id": session_id})
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return jsonify({"ok": False, "error": "session_unreadable"}), 500
    return jsonify({"ok": True, "id": session_id, "state": record})


ROADS_CACHE_DIR = ROOT / "data" / "roads_cache"
OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)


@app.route("/api/roads")
def api_roads():
    """Street network for a sheet bbox, proxied from Overpass and cached.

    The browser fetching Overpass directly proved flaky: the public endpoints
    intermittently return empty bodies, and a multi-megabyte cross-origin
    download is easy to lose. Server-side we can retry across mirrors and keep
    the result on disk, so every later request for the same sheet is instant
    and offline-safe.
    """
    bbox = str(request.args.get("bbox") or "")
    match = re.fullmatch(
        r"(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?),"
        r"(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)", bbox)
    if not match:
        return jsonify({"ok": False, "error": "invalid_bbox"}), 400
    south, west, north, east = (float(g) for g in match.groups())
    if not (-90 <= south < north <= 90 and -180 <= west < east <= 180):
        return jsonify({"ok": False, "error": "invalid_bbox"}), 400
    # A sheet is a neighbourhood; refuse anything past ~20 x 20 km.
    if (north - south) > 0.2 or (east - west) > 0.3:
        return jsonify({"ok": False, "error": "bbox_too_large"}), 400

    import hashlib
    cache_path = ROADS_CACHE_DIR / (
        hashlib.sha1(bbox.encode("utf-8")).hexdigest()[:16] + ".json")
    if cache_path.exists():
        try:
            return Response(cache_path.read_bytes(), mimetype="application/json")
        except OSError:
            pass

    query = (
        "[out:json][timeout:25];"
        'way["highway"]["highway"!~"construction|proposed|razed"]'
        '["footway"!~"sidewalk|crossing"]'
        f"({south},{west},{north},{east});out skel geom;"
    )
    payload = urllib.parse.urlencode({"data": query}).encode("utf-8")
    lines = None
    for endpoint in OVERPASS_ENDPOINTS:
        for _attempt in range(2):
            try:
                req = urllib.request.Request(
                    endpoint, data=payload,
                    headers={"User-Agent": "LowBarrierMapping/1.0"})
                with urllib.request.urlopen(req, timeout=45) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                lines = [
                    [[node["lon"], node["lat"]] for node in element["geometry"]]
                    for element in data.get("elements", [])
                    if element.get("type") == "way"
                    and len(element.get("geometry") or []) > 1
                ]
            except (OSError, ValueError, KeyError):
                continue
            if lines:
                break
        if lines:
            break
    if not lines:
        return jsonify({"ok": False, "error": "overpass_unreachable"}), 502

    body = json.dumps({"ok": True, "lines": lines}, separators=(",", ":"))
    try:
        ROADS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(body, encoding="utf-8")
    except OSError:
        pass  # caching is best-effort; the response still goes out
    return Response(body, mimetype="application/json")


BOUNDARIES_CACHE_DIR = ROOT / "data" / "boundaries_cache"


@app.route("/api/boundaries")
def api_boundaries():
    """Administrative outlines for a bbox, proxied from Overpass and cached.

    Only the member ways' geometry is returned, not assembled polygons: an
    outline is all the caller draws, and stitching relation members into rings
    is a pile of edge cases (reversed ways, multiple outers, enclaves) for no
    gain here. admin_level 9 is the arrondissement level in France; other
    levels are allowed so the same endpoint serves another city's districts.
    """
    bbox = str(request.args.get("bbox") or "")
    match = re.fullmatch(
        r"(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?),"
        r"(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)", bbox)
    if not match:
        return jsonify({"ok": False, "error": "invalid_bbox"}), 400
    south, west, north, east = (float(g) for g in match.groups())
    if not (-90 <= south < north <= 90 and -180 <= west < east <= 180):
        return jsonify({"ok": False, "error": "invalid_bbox"}), 400
    if (north - south) > 0.6 or (east - west) > 0.9:
        return jsonify({"ok": False, "error": "bbox_too_large"}), 400
    level = str(request.args.get("level") or "9")
    if not re.fullmatch(r"[0-9]{1,2}", level):
        return jsonify({"ok": False, "error": "invalid_level"}), 400

    import hashlib
    cache_path = BOUNDARIES_CACHE_DIR / (
        hashlib.sha1((bbox + "|" + level).encode("utf-8")).hexdigest()[:16] + ".json")
    if cache_path.exists():
        try:
            return Response(cache_path.read_bytes(), mimetype="application/json")
        except OSError:
            pass

    query = (
        "[out:json][timeout:25];"
        f'relation["boundary"="administrative"]["admin_level"="{level}"]'
        f"({south},{west},{north},{east});out geom;"
    )
    payload = urllib.parse.urlencode({"data": query}).encode("utf-8")
    areas = None
    for endpoint in OVERPASS_ENDPOINTS:
        for _attempt in range(2):
            try:
                req = urllib.request.Request(
                    endpoint, data=payload,
                    headers={"User-Agent": "LowBarrierMapping/1.0"})
                with urllib.request.urlopen(req, timeout=45) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                areas = []
                for element in data.get("elements", []):
                    if element.get("type") != "relation":
                        continue
                    tags = element.get("tags") or {}
                    lines = [
                        [[node["lon"], node["lat"]] for node in member["geometry"]]
                        for member in element.get("members") or []
                        if member.get("type") == "way"
                        and len(member.get("geometry") or []) > 1
                    ]
                    if not lines:
                        continue
                    name = tags.get("name") or ""
                    label = tags.get("ref") or ""
                    if not label:
                        # "Paris 20e Arrondissement" -> "20"
                        found = re.search(r"(\d{1,2})\s*(?:er|re|eme|e)(?![a-z])", name)
                        label = found.group(1) if found else name
                    points = [point for line in lines for point in line]
                    centre = [
                        sum(p[0] for p in points) / len(points),
                        sum(p[1] for p in points) / len(points),
                    ]
                    areas.append({"name": name, "label": label,
                                  "centre": centre, "lines": lines})
            except (OSError, ValueError, KeyError):
                areas = None
                continue
            if areas:
                break
        if areas:
            break
    if not areas:
        return jsonify({"ok": False, "error": "overpass_unreachable"}), 502

    body = json.dumps({"ok": True, "areas": areas}, separators=(",", ":"))
    try:
        BOUNDARIES_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(body, encoding="utf-8")
    except OSError:
        pass
    return Response(body, mimetype="application/json")


CAPTURES_DIR = ROOT / "data" / "captures"
CAPTURE_MAX_BYTES = 24 * 1024 * 1024
captures_lock = threading.Lock()


def _captures_index_path():
    return CAPTURES_DIR / "index.json"


def _load_captures():
    try:
        data = json.loads(_captures_index_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"seq": 0, "items": []}
    if not isinstance(data, dict):
        return {"seq": 0, "items": []}
    data.setdefault("seq", 0)
    data.setdefault("items", [])
    return data


def _save_captures(state):
    CAPTURES_DIR.mkdir(parents=True, exist_ok=True)
    _captures_index_path().write_text(
        json.dumps(state, separators=(",", ":")), encoding="utf-8")


@app.route("/phone-capture")
def phone_capture_page():
    """Camera page for a phone on the same network (or the quick tunnel).

    Kept deliberately dumb: type the map ID, take a photo, send. All alignment
    and detection happens on the laptop that is already holding the reference
    maps and the session, so the phone needs no state beyond the map ID it is
    currently shooting. Each photo is filed as a sheet of its own.
    """
    return send_from_directory(WEB_DIR, "phone_capture.html")


@app.route("/api/capture-target", methods=["GET"])
def api_capture_target():
    """Where a phone should point its browser.

    The tunnel is preferred when one is up -- it works off the local network
    and over mobile data -- otherwise the LAN addresses this machine answers
    on. localhost is useless to a phone, so it is never offered.
    """
    tunnel = snapshot_quick_tunnel_state()
    port = request.host.split(":")[-1] if ":" in request.host else "80"
    lan = [f"http://{ip}:{port}" for ip in get_ipv4_candidates()]
    return jsonify({
        "ok": True,
        "tunnel": tunnel.get("url") or "",
        # "starting" while cloudflared is still connecting: the page waits for
        # it rather than handing out a Wi-Fi-only address in the meantime.
        "tunnelStatus": tunnel.get("status") or "",
        "tunnelError": tunnel.get("error") or "",
        "lan": lan,
    })


@app.route("/api/captures", methods=["GET", "POST"])
def api_captures():
    if request.method == "GET":
        # The desktop polls with the highest sequence it has already taken, so
        # a reload never re-digitises work and two viewers cannot both claim
        # the same photo (whoever marks it done first wins).
        try:
            since = int(request.args.get("since") or 0)
        except ValueError:
            since = 0
        with captures_lock:
            state = _load_captures()
        # A capture queued before sheets were numbered here carries a typed
        # "7" or "7_3". Only its map is handed on, so the laptop numbers it
        # like any other page instead of filing it into an existing sheet.
        pending = [
            {**{k: item.get(k) for k in ("seq", "id", "receivedAt", "bytes")},
             "mapId": item.get("mapId") or _map_id_of(item.get("sheetId")),
             "sheetId": item.get("sheetId") if item.get("mapId") else ""}
            for item in state["items"]
            if item.get("seq", 0) > since and not item.get("consumed")
        ]
        return jsonify({"ok": True, "seq": state["seq"], "captures": pending})

    # The phone sends only the map ID. Each photo is a page of its own, so its
    # sheet ID is handed out here on arrival: the phone can show it at once and
    # the laptop files the photo under it. An older phone page posting
    # "sheetId" ("7" or "7_3") names its map the same way.
    map_id = _map_id_of(_clean_map_sheet_id(request.form.get("mapId") or request.form.get("sheetId")))
    if not map_id:
        return jsonify({"ok": False, "error": "invalid_map_id"}), 400
    # Refused here rather than on the laptop, so the person holding the phone
    # hears about a mistyped map ID straight away.
    if not _map_sheet_record_stem(map_id):
        return jsonify({"ok": False, "error": "map_sheet_not_found"}), 404
    photo = request.files.get("photo")
    if photo is None:
        return jsonify({"ok": False, "error": "no_photo"}), 400
    blob = photo.read()
    if not blob:
        return jsonify({"ok": False, "error": "empty_photo"}), 400
    if len(blob) > CAPTURE_MAX_BYTES:
        return jsonify({"ok": False, "error": "photo_too_large"}), 413

    capture_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    try:
        CAPTURES_DIR.mkdir(parents=True, exist_ok=True)
        (CAPTURES_DIR / f"{capture_id}.jpg").write_bytes(blob)
    except OSError:
        return jsonify({"ok": False, "error": "capture_not_saved"}), 500
    try:
        sheet_id = _allocate_digitized_sheet_id(map_id)
    except OSError:
        logging.exception("Could not number a sheet of map %s", map_id)
        return jsonify({"ok": False, "error": "sheet_id_not_saved"}), 500

    with captures_lock:
        state = _load_captures()
        state["seq"] += 1
        entry = {
            "seq": state["seq"],
            "id": capture_id,
            "mapId": map_id,
            "sheetId": sheet_id,
            "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "bytes": len(blob),
            "consumed": False,
        }
        state["items"].append(entry)
        # The index is a work queue, not an archive; the photos stay on disk.
        state["items"] = state["items"][-500:]
        _save_captures(state)
    return jsonify({"ok": True, "id": capture_id, "seq": entry["seq"],
                    "mapId": map_id, "sheetId": sheet_id,
                    "sheetNumber": int(sheet_id.split("_")[1])})


@app.route("/api/captures/<capture_id>/image", methods=["GET"])
def api_capture_image(capture_id):
    if not re.fullmatch(r"[0-9]{8}-[0-9]{6}-[0-9a-f]{6}", str(capture_id or "")):
        return ("", 404)
    path = CAPTURES_DIR / f"{capture_id}.jpg"
    if not path.exists():
        return ("", 404)
    return send_from_directory(CAPTURES_DIR, f"{capture_id}.jpg")


@app.route("/api/captures/<capture_id>/done", methods=["POST"])
def api_capture_done(capture_id):
    with captures_lock:
        state = _load_captures()
        found = False
        for item in state["items"]:
            if item.get("id") == capture_id:
                item["consumed"] = True
                found = True
        if found:
            _save_captures(state)
    return jsonify({"ok": True, "id": capture_id, "found": found})


@app.route("/imobyl")
def legacy_imobyl_page():
    """The exhibition page is now the digitiser itself; keep old links alive."""
    return redirect("/digitize-map", code=302)


@app.route("/maputnik/")
def maputnik_page():
    """Serve the checked-in production build; npm is only needed to rebuild it."""
    response = send_from_directory(MAPUTNIK_DIST_DIR, "index.html")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


@app.route("/maputnik/<path:filename>")
def maputnik_asset(filename):
    # MapLibre resolves sprite URLs with `new URL(url)` and NO base, so a
    # relative one throws -- and because it loads every sprite through one
    # Promise.all, that failure silently kills the basemap's sprite too and the
    # map renders with no icons at all. The style file therefore stores the
    # local sprite as a root-relative path and we make it absolute here, using
    # the host actually being served so a tunnel or a different port still work.
    if filename.endswith(".json") and "styles/" in filename.replace("\\", "/"):
        path = (MAPUTNIK_DIST_DIR / filename).resolve()
        try:
            path.relative_to(MAPUTNIK_DIST_DIR.resolve())
        except ValueError:
            return ("", 404)
        if path.exists():
            try:
                style = json.loads(path.read_text(encoding="utf-8-sig"))
                sprite = style.get("sprite")
                if isinstance(sprite, list):
                    base = request.host_url.rstrip("/")
                    for entry in sprite:
                        url = str(entry.get("url") or "")
                        if url.startswith("/"):
                            entry["url"] = base + url
                    response = jsonify(style)
                    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
                    return response
            except (OSError, ValueError):
                pass    # not JSON we understand; fall through to the raw file

    response = send_from_directory(MAPUTNIK_DIST_DIR, filename)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


def _clean_map_sheet_id(raw):
    """Accept a map ID ("7") or a digitised sheet ID ("7_3").

    A map ID names one printed map design, and any number of people may fill
    in copies of it. Every page digitised from it gets the next sheet number
    for that map ("7_1", "7_2", ...) from _allocate_digitized_sheet_id, so the
    scans are told apart without anyone typing a second number. Older data
    also holds "<map>_<n>" records exported as numbered copies; those keep
    resolving through _map_sheet_record_stem. Both halves reuse the plain-ID
    rules, so the value stays filename-safe.
    """
    value = str(raw or "").strip()
    return value if re.fullmatch(r"[1-9][0-9]{0,8}(?:_[1-9][0-9]{0,8})?", value) else ""


def _map_id_of(sheet_id):
    return str(sheet_id or "").split("_", 1)[0]


def _map_sheet_record_stem(sheet_id):
    """The stored record a map or sheet ID aligns against; "" when there is none.

    An exact record wins, so an older "<map>_<n>" copy stays tied to the print
    it was digitised from. A digitised sheet otherwise uses its map's record,
    and a map that was only ever exported as numbered copies falls back to the
    lowest of them -- every copy of a batch was the same map.
    """
    clean = _clean_map_sheet_id(sheet_id)
    if not clean:
        return ""
    if (MAP_SHEETS_DIR / f"{clean}.json").exists():
        return clean
    map_id = _map_id_of(clean)
    if (MAP_SHEETS_DIR / f"{map_id}.json").exists():
        return map_id
    copies = []
    for path in MAP_SHEETS_DIR.glob(f"{map_id}_*.json"):
        match = re.fullmatch(rf"{map_id}_([1-9][0-9]{{0,8}})", path.stem)
        if match:
            copies.append((int(match.group(1)), path.stem))
    return min(copies)[1] if copies else ""


# The last sheet number handed out per map. Kept outside both data folders that
# are read as collections (sessions, map sheets), where a stray JSON file would
# be listed as an entry.
DIGITIZED_SHEET_COUNTERS_PATH = ROOT / "data" / "digitized_sheet_counters.json"
digitized_sheet_lock = threading.Lock()


def _highest_sheet_number(map_id, full_scan):
    """The highest sheet number anything on disk already uses for a map."""
    pattern = re.compile(rf"{map_id}_([1-9][0-9]{{0,8}})")
    highest = 0

    def note(value):
        nonlocal highest
        match = pattern.fullmatch(str(value or ""))
        if match:
            highest = max(highest, int(match.group(1)))

    # Numbered copies from older exports: numbering past them means a new
    # sheet can never be mistaken for one of those prints.
    for path in MAP_SHEETS_DIR.glob(f"{map_id}_*.json"):
        note(path.stem)
    for path in IMOBYL_SESSIONS_DIR.glob(f"auto-map-{map_id}_*.json"):
        note(path.stem[len("auto-map-"):])
    for item in _load_captures().get("items", []):
        # Only numbers handed out here count. A capture queued before that
        # carries a typed "7_3" that never named a sheet.
        if item.get("mapId"):
            note(item.get("sheetId"))
    if full_scan:
        # Hand-saved sessions only name their sheets inside the file. Reading
        # them all is needed once per map, before its counter exists.
        for path in IMOBYL_SESSIONS_DIR.glob("*.json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            references = record.get("references") if isinstance(record, dict) else None
            for reference in references if isinstance(references, list) else []:
                if isinstance(reference, dict):
                    note(reference.get("id"))
    return highest


def _allocate_digitized_sheet_id(map_id):
    """Hand out the next sheet ID of a map: "7_1", then "7_2", ...

    Numbers are never reused -- a sheet abandoned before it held any work only
    leaves a gap -- so two digitisations of one map cannot share an ID, not
    across page reloads and not with the phone and the laptop working at once.
    Raises OSError when the counter cannot be saved.
    """
    with digitized_sheet_lock:
        try:
            counters = json.loads(DIGITIZED_SHEET_COUNTERS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            counters = {}
        if not isinstance(counters, dict):
            counters = {}
        stored = counters.get(map_id)
        trusted = isinstance(stored, int) and not isinstance(stored, bool) and stored >= 0
        number = max(stored if trusted else 0,
                     _highest_sheet_number(map_id, full_scan=not trusted)) + 1
        counters[map_id] = number
        DIGITIZED_SHEET_COUNTERS_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = DIGITIZED_SHEET_COUNTERS_PATH.with_name(
            f".{DIGITIZED_SHEET_COUNTERS_PATH.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(counters, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, DIGITIZED_SHEET_COUNTERS_PATH)
    return f"{map_id}_{number}"


def _clean_lnglat_corners(raw_corners):
    if not isinstance(raw_corners, list) or len(raw_corners) != 4:
        raise ValueError("invalid_corners")
    cleaned = []
    for point in raw_corners:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            raise ValueError("invalid_corners")
        try:
            lng, lat = float(point[0]), float(point[1])
        except (TypeError, ValueError):
            raise ValueError("invalid_corners") from None
        if not (math.isfinite(lng) and math.isfinite(lat) and -180 <= lng <= 180 and -90 <= lat <= 90):
            raise ValueError("invalid_corners")
        cleaned.append([round(lng, 10), round(lat, 10)])
    return cleaned


def _map_sheet_summary(record):
    return {
        "id": record.get("id"),
        "title": record.get("title") or "Reference map",
        "createdAt": record.get("createdAt"),
        "corners": record.get("corners"),
        "camera": record.get("camera"),
        "theme": record.get("theme") or "",
        "imageUrl": f"/api/map-sheets/{record.get('id')}/image",
        "pdfUrl": f"/api/map-sheets/{record.get('id')}/pdf",
        # Only while the Word copy exists: older sheets and failed builds have none.
        "docxUrl": (
            f"/api/map-sheets/{record.get('id')}/docx"
            if (MAP_SHEETS_DIR / f"{record.get('id')}.docx").exists() else None
        ),
    }


SHEET_PAGE_SIZES = ("A4", "A3")


def _clean_sheet_page_size(raw):
    value = str(raw or "").strip().upper()
    return value if value in SHEET_PAGE_SIZES else "A4"


def _clean_map_sheet_text_block(raw):
    source = raw if isinstance(raw, dict) else {}
    text = str(source.get("text") or "").replace("\x00", "").strip()
    return {
        "enabled": bool(source.get("enabled")),
        "text": text[:1200],
    }


def _clean_map_sheet_frame(raw, page_w, page_h, patch_size):
    margin = 12.0
    default = [margin, margin, page_w - margin * 2.0, page_h - margin * 2.0]
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return default
    try:
        frame = [float(value) for value in raw]
    except (TypeError, ValueError):
        return default
    if not all(math.isfinite(value) for value in frame):
        return default

    min_w = max(patch_size * 4.25, page_w * 0.28)
    min_h = max(patch_size * 3.25, page_h * 0.28)
    max_w = page_w - margin * 2.0
    max_h = page_h - margin * 2.0
    width = min(max_w, max(min_w, frame[2]))
    height = min(max_h, max(min_h, frame[3]))
    left = min(max(margin, frame[0]), page_w - margin - width)
    top = min(max(margin, frame[1]), page_h - margin - height)
    return [left, top, width, height]


# Side margins ("panels"): optional note columns to the left and/or right of the
# map frame, holding typed text. The page keeps the same outer margin; the frame
# gives up width to make room, so the panel geometry is whatever the frame
# leaves free -- there is no second width to disagree with.
MAP_SHEET_PAGE_MARGIN = 12.0
SIDE_PANEL_MIN_WIDTH = 20.0
SIDE_PANEL_PAD = 6.0
SIDE_PANEL_TEXT_LIMIT = 4000
SIDE_PANEL_SIDES = ("left", "right")


def _map_sheet_panel_font_size(layout):
    return 11.0 if layout["pageSize"] == "A4" else 13.0


def _map_sheet_panel_regions(layout):
    """Left/right panel rectangles [x, y, w, h] in points, top-left origin."""
    page_w, _page_h = layout["page"]
    map_x, map_y, map_w, map_h = layout["mapFrame"]
    margin = MAP_SHEET_PAGE_MARGIN
    return {
        "left": [margin, map_y, max(0.0, map_x - margin), map_h],
        "right": [map_x + map_w, map_y, max(0.0, page_w - margin - (map_x + map_w)), map_h],
    }


def _clean_map_sheet_side_panels(raw):
    """{"left": {"text": ...}|None, "right": {"text": ...}|None}.

    A panel with no text is still a panel: the user asked for a blank margin,
    and the frame has already been narrowed to leave it.
    """
    source = raw if isinstance(raw, dict) else {}
    panels = {}
    for side in SIDE_PANEL_SIDES:
        panel = source.get(side)
        if not isinstance(panel, dict):
            panels[side] = None
            continue
        text = str(panel.get("text") or "").replace("\x00", "")
        text = text.replace("\r\n", "\n").replace("\r", "\n").strip("\n")
        panels[side] = {"text": text[:SIDE_PANEL_TEXT_LIMIT]}
    return panels


def _map_sheet_side_panel_summary(layout, side_panels):
    """What the record keeps about the margins: geometry and text."""
    regions = _map_sheet_panel_regions(layout)
    summary = {}
    for side in SIDE_PANEL_SIDES:
        panel = side_panels.get(side) if side_panels else None
        summary[side] = None if not panel else {
            "regionPoints": [round(value, 3) for value in regions[side]],
            "text": panel["text"],
        }
    return summary


def map_sheet_layout(page_size="A4", customization=None):
    """Geometry of a printable sheet, in PDF points, origin at the page's
    TOP-LEFT (image convention — the browser preview and OpenCV both use it).

    This is the single source of truth for the layout: _draw_map_sheet_pdf()
    renders from it, and /api/map-sheet-layout serves it to the page so the
    on-screen preview shows the true export frame and tag placement instead of
    a hand-copied approximation that could silently drift out of sync.
    """
    # A4/A3 landscape in points (1 pt = 1/72 in), matching reportlab.
    page_w, page_h = (1190.55, 841.89) if _clean_sheet_page_size(page_size) == "A3" else (841.89, 595.28)
    tag_size = 20.0 if _clean_sheet_page_size(page_size) == "A4" else 28.0
    quiet = 3.0
    patch = tag_size + 2.0 * quiet
    custom = customization if isinstance(customization, dict) else {}
    map_x, map_y, map_w, map_h = _clean_map_sheet_frame(
        custom.get("mapFrame"), page_w, page_h, patch
    )
    # Eight tags: three across the top, one mid-left, one mid-right, three
    # across the bottom. All positions follow the adjustable map frame.
    patches = [
        (map_x, map_y),
        (map_x + (map_w - patch) * 0.5, map_y),
        (map_x + map_w - patch, map_y),
        (map_x, map_y + (map_h - patch) * 0.5),
        (map_x + map_w - patch, map_y + (map_h - patch) * 0.5),
        (map_x, map_y + map_h - patch),
        (map_x + (map_w - patch) * 0.5, map_y + map_h - patch),
        (map_x + map_w - patch, map_y + map_h - patch),
    ]
    # The ID plate sits in the top-left corner, just right of the first tag and
    # centred on it. It reads first, the way a sheet number should, and it is
    # nowhere near the bottom edge a hand rests on while drawing. Its rectangle
    # is added to mask_rects below, so it stays excluded from drawing detection.
    # A side margin wide enough to hold it takes it instead -- centred at the
    # foot of the margin, left before right -- where it covers no map at all.
    badge_w, badge_h = 70.0, 14.0
    badge_x = map_x + patch + 4.0
    badge_top = map_y + (patch - badge_h) * 0.5
    badge_panel = None
    side_panels = _clean_map_sheet_side_panels(custom.get("sidePanels"))
    margin = MAP_SHEET_PAGE_MARGIN
    spans = {
        "left": (margin, map_x - margin),
        "right": (map_x + map_w, page_w - margin - (map_x + map_w)),
    }
    for side in SIDE_PANEL_SIDES:
        span_left, span_width = spans[side]
        if side_panels[side] and span_width >= badge_w + SIDE_PANEL_PAD * 2.0:
            badge_panel = side
            badge_x = span_left + (span_width - badge_w) / 2
            badge_top = map_y + map_h - SIDE_PANEL_PAD - badge_h
            break
    return {
        "pageSize": _clean_sheet_page_size(page_size),
        "page": [page_w, page_h],
        "mapFrame": [
            round(map_x, 3), round(map_y, 3),
            round(map_w, 3), round(map_h, 3),
        ],
        "tagIds": list(range(21, 29)),
        "tagSize": tag_size,
        "quiet": quiet,
        "patchSize": patch,
        "patches": [[round(x, 3), round(y, 3)] for x, y in patches],
        "badge": [
            round(badge_x, 3),
            round(badge_top, 3),
            badge_w, badge_h,
        ],
        # The side margin holding the ID plate, or None when it is on the map.
        "badgePanel": badge_panel,
        # Absent means shown: /api/map-sheet-layout serves layouts with no
        # customization at all, and an unchecked-by-omission box would silently
        # drop the ID from every sheet exported by an older client.
        "showBadge": bool(custom.get("showBadge", True)),
        "header": _clean_map_sheet_text_block(custom.get("header")),
        "footer": _clean_map_sheet_text_block(custom.get("footer")),
    }


@app.route("/api/map-sheet-layout")
def api_map_sheet_layout():
    return jsonify({
        "ok": True,
        "sizes": list(SHEET_PAGE_SIZES),
        "layouts": {size: map_sheet_layout(size) for size in SHEET_PAGE_SIZES},
    })


def _draw_map_sheet_pdf(
    png_bytes, record, page_size="A4", customization=None,
    layout=None, side_panels=None,
):
    """Build an adjustable A4/A3 map with registration tags and text areas."""
    try:
        from reportlab.lib.utils import ImageReader
        from reportlab.pdfgen import canvas
    except ImportError as exc:
        raise RuntimeError("reportlab_not_installed") from exc

    if layout is None:
        layout = map_sheet_layout(page_size, customization)
    side_panels = side_panels or {side: None for side in SIDE_PANEL_SIDES}
    page_w, page_h = layout["page"]
    map_x, map_y, map_w, map_h = layout["mapFrame"]
    map_pdf_y = page_h - map_y - map_h

    # Dedicated high-numbered IDs avoid the low AprilTag IDs used elsewhere by
    # the project's tangible drawing tools. These tags register the paper only.
    tag_family = "DICT_APRILTAG_16h5"
    # IDs 21-28 stay outside the project's currently assigned tangible-tool
    # range (1-20) while fitting inside the compact 16h5 dictionary.
    tag_ids = layout["tagIds"]
    tag_size = layout["tagSize"]
    quiet = layout["quiet"]
    patch_size = layout["patchSize"]
    # layout["patches"] is top-left-origin; reportlab draws from bottom-left.
    tag_positions = [
        (px, page_h - py - patch_size) for px, py in layout["patches"]
    ]

    # Metadata uses image coordinates (origin at page top-left), matching
    # OpenCV and the browser. ReportLab itself uses a bottom-left origin.
    fiducials = []
    mask_rects = []
    for tag_id, (patch_x, patch_y) in zip(tag_ids, tag_positions):
        black_left = patch_x + quiet
        black_top = page_h - (patch_y + patch_size) + quiet
        black_right = black_left + tag_size
        black_bottom = black_top + tag_size
        patch_top = page_h - (patch_y + patch_size)
        fiducials.append({
            "id": tag_id,
            "cornersPagePoints": [
                [round(black_left, 3), round(black_top, 3)],
                [round(black_right, 3), round(black_top, 3)],
                [round(black_right, 3), round(black_bottom, 3)],
                [round(black_left, 3), round(black_bottom, 3)],
            ],
        })
        mask_rects.append([
            round((patch_x - map_x) / map_w, 6),
            round((patch_top - map_y) / map_h, 6),
            round((patch_x + patch_size - map_x) / map_w, 6),
            round((patch_top + patch_size - map_y) / map_h, 6),
        ])

    badge_x, badge_top, badge_w, badge_h = layout["badge"]
    badge_y = page_h - badge_top - badge_h
    show_badge = layout["showBadge"]
    # Nothing is printed there when the plate is hidden, so nothing needs
    # excluding from drawing detection -- masking it anyway would blind the
    # detector to a corner of the map the participant can now draw on. A plate
    # in a side margin is off the map, so there is nothing to mask either.
    if show_badge and not layout["badgePanel"]:
        mask_rects.append([
            round((badge_x - map_x) / map_w, 6),
            round((badge_top - map_y) / map_h, 6),
            round((badge_x + badge_w - map_x) / map_w, 6),
            round((badge_top + badge_h - map_y) / map_h, 6),
        ])

    record["print"] = {
        "paper": f"{layout['pageSize']} landscape",
        "pageSize": layout["pageSize"],
        "pagePoints": [round(page_w, 3), round(page_h, 3)],
        "mapFramePoints": [round(map_x, 3), round(map_y, 3), round(map_w, 3), round(map_h, 3)],
        "mapCornerPagePoints": [
            [round(map_x, 3), round(map_y, 3)],
            [round(map_x + map_w, 3), round(map_y, 3)],
            [round(map_x + map_w, 3), round(map_y + map_h, 3)],
            [round(map_x, 3), round(map_y + map_h, 3)],
        ],
        "fiducialFamily": tag_family,
        "fiducials": fiducials,
        "maskRectsNormalized": mask_rects,
        "header": layout["header"],
        "footer": layout["footer"],
        "sidePanels": _map_sheet_side_panel_summary(layout, side_panels),
    }

    out = io.BytesIO()
    pdf = canvas.Canvas(out, pagesize=(page_w, page_h), pageCompression=1)
    pdf.setTitle(f"Map sheet {record['id']}")
    pdf.setAuthor("Low-Barrier Digital Participatory Mapping")
    pdf.setSubject("Printable georeferenced reference map")

    pdf.setFillColorRGB(1, 1, 1)
    pdf.rect(0, 0, page_w, page_h, fill=1, stroke=0)
    pdf.drawImage(ImageReader(io.BytesIO(png_bytes)), map_x, map_pdf_y, map_w, map_h,
                  preserveAspectRatio=False, mask="auto")
    pdf.setStrokeColorRGB(0, 0, 0)
    pdf.setLineWidth(0.8)
    pdf.rect(map_x, map_pdf_y, map_w, map_h, fill=0, stroke=1)

    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_16h5)
    for tag_id, (patch_x, patch_y) in zip(tag_ids, tag_positions):
        marker = cv2.aruco.generateImageMarker(dictionary, tag_id, 600, borderBits=1)
        border_px = 90
        marker = cv2.copyMakeBorder(
            marker, border_px, border_px, border_px, border_px,
            cv2.BORDER_CONSTANT, value=255,
        )
        ok, encoded = cv2.imencode(".png", marker)
        if not ok:
            raise RuntimeError("fiducial_generation_failed")
        pdf.drawImage(
            ImageReader(io.BytesIO(encoded.tobytes())),
            patch_x, patch_y, patch_size, patch_size,
            preserveAspectRatio=False, mask="auto",
        )

    if show_badge:
        pdf.setFillColorRGB(1, 1, 1)
        pdf.rect(badge_x, badge_y, badge_w, badge_h, fill=1, stroke=0)
        pdf.setFillColorRGB(0, 0, 0)
        badge_text = f"MAP ID: {record['id']}"
        badge_font_size = 9.0
        while (
            badge_font_size > 5.0
            and pdf.stringWidth(badge_text, "Helvetica-Bold", badge_font_size) > badge_w - 4.0
        ):
            badge_font_size -= 0.5
        pdf.setFont("Helvetica-Bold", badge_font_size)
        pdf.drawCentredString(
            badge_x + badge_w * 0.5,
            badge_y + max(2.0, (badge_h - badge_font_size) * 0.45),
            badge_text,
        )

    def wrapped_lines(text, font_name, font_size, max_width):
        lines = []
        for paragraph in str(text or "").splitlines() or [""]:
            words = paragraph.split()
            if not words:
                lines.append("")
                continue
            current = ""
            for word in words:
                candidate = word if not current else f"{current} {word}"
                if pdf.stringWidth(candidate, font_name, font_size) <= max_width:
                    current = candidate
                    continue
                if current:
                    lines.append(current)
                    current = ""
                # Split a single unusually long token so it cannot escape the
                # printable text area.
                fragment = ""
                for character in word:
                    candidate = fragment + character
                    if fragment and pdf.stringWidth(candidate, font_name, font_size) > max_width:
                        lines.append(fragment)
                        fragment = character
                    else:
                        fragment = candidate
                current = fragment
            lines.append(current)
        return lines

    def draw_text_area(block, top, bottom):
        if not block.get("enabled") or not block.get("text"):
            return
        area_h = bottom - top
        # Tracks the 9pt floor below: a band thinner than this cannot hold a
        # line at the smallest size we are willing to print, and drawing anyway
        # would spill the text over the map frame.
        if area_h < 13.0:
            return
        font_name = "Helvetica"
        # A header is read at arm's length across a table, not held up close, so
        # it wants to be a few points larger than body copy would be.
        preferred_font_size = 15.0 if layout["pageSize"] == "A4" else 19.0
        font_size = min(preferred_font_size, max(9.0, (area_h - 2.0) / 1.45))
        leading = font_size * 1.2
        vertical_padding = max(
            1.0,
            min(font_size * 0.25, (area_h - font_size) * 0.5),
        )
        horizontal_padding = max(4.0, font_size * 0.55)
        max_width = max(1.0, map_w - horizontal_padding * 2.0)
        available_height = max(0.0, area_h - vertical_padding * 2.0)
        max_lines = max(
            1,
            int(max(0.0, available_height - font_size) // leading) + 1,
        )
        lines = wrapped_lines(block["text"], font_name, font_size, max_width)
        if len(lines) > max_lines:
            lines = lines[:max_lines]
            if lines:
                last = lines[-1]
                while last and pdf.stringWidth(last + "...", font_name, font_size) > max_width:
                    last = last[:-1]
                lines[-1] = last + "..."
        pdf.setFillColorRGB(0, 0, 0)
        pdf.setFont(font_name, font_size)
        baseline = page_h - top - vertical_padding - font_size
        minimum = page_h - bottom + vertical_padding
        for line in lines:
            if baseline < minimum:
                break
            pdf.drawString(map_x + horizontal_padding, baseline, line)
            baseline -= leading

    def draw_side_panel(side, panel, region):
        """Wrap the margin's text into its column, top-down. Lines that do not
        fit are left off -- the on-screen box is the same size, so the author
        has already seen it."""
        if not panel or not panel["text"]:
            return
        left, top, width, height = region
        if width < SIDE_PANEL_MIN_WIDTH or height < 13.0:
            return
        font_name = "Helvetica"
        font_size = _map_sheet_panel_font_size(layout)
        leading = font_size * 1.25
        pad = SIDE_PANEL_PAD
        inner_w = max(1.0, width - pad * 2.0)
        cursor = top + pad
        limit = top + height - pad
        if show_badge and layout["badgePanel"] == side:
            limit -= badge_h + pad   # the ID plate holds the foot of the column
        pdf.setFillColorRGB(0, 0, 0)
        pdf.setFont(font_name, font_size)
        for line in wrapped_lines(panel["text"], font_name, font_size, inner_w):
            if cursor + font_size > limit:
                break
            pdf.drawString(left + pad, page_h - (cursor + font_size * 0.85), line)
            cursor += leading

    page_margin = MAP_SHEET_PAGE_MARGIN
    draw_text_area(layout["header"], page_margin, map_y)
    draw_text_area(layout["footer"], map_y + map_h, page_h - page_margin)
    panel_regions = _map_sheet_panel_regions(layout)
    for side in SIDE_PANEL_SIDES:
        draw_side_panel(side, side_panels.get(side), panel_regions[side])
    pdf.showPage()
    pdf.save()
    return out.getvalue()


def _compose_map_sheet_frame_png(png_bytes, layout, sheet_id):
    """The map frame as ONE picture: map, border, AprilTags and ID plate.

    The .docx cannot place the tags as separately positioned objects with any
    guarantee of where Word will put them, so they are burnt into the map
    image at the same relative positions the PDF uses. Registration only ever
    relates the tags to the frame, so where Word lays the picture on the page
    does not matter.
    """
    image = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim < 2:
        raise RuntimeError("invalid_png")
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    elif image.shape[2] == 4:
        alpha = image[:, :, 3:4].astype(np.float32) / 255.0
        image = (image[:, :, :3].astype(np.float32) * alpha + 255.0 * (1.0 - alpha)).astype(np.uint8)
    else:
        image = np.ascontiguousarray(image[:, :, :3])
    map_x, map_y, map_w, map_h = layout["mapFrame"]
    height, width = image.shape[:2]
    # The capture already has the frame's aspect; resample only if it does not,
    # so the tags land exactly where the PDF puts them.
    wanted_h = max(1, int(round(width * map_h / map_w)))
    if abs(wanted_h - height) > 2:
        image = cv2.resize(image, (width, wanted_h), interpolation=cv2.INTER_AREA)
        height = wanted_h
    scale = width / map_w

    def to_px(value):
        return int(round(value * scale))

    cv2.rectangle(image, (0, 0), (width - 1, height - 1), (0, 0, 0), max(1, to_px(0.8)))

    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_16h5)
    patch_px = max(8, to_px(layout["patchSize"]))
    for tag_id, (patch_x, patch_y) in zip(layout["tagIds"], layout["patches"]):
        marker = cv2.aruco.generateImageMarker(dictionary, tag_id, 600, borderBits=1)
        marker = cv2.copyMakeBorder(
            marker, 90, 90, 90, 90, cv2.BORDER_CONSTANT, value=255,
        )
        marker = cv2.resize(marker, (patch_px, patch_px), interpolation=cv2.INTER_AREA)
        x0 = min(max(0, to_px(patch_x - map_x)), width - patch_px)
        y0 = min(max(0, to_px(patch_y - map_y)), height - patch_px)
        image[y0:y0 + patch_px, x0:x0 + patch_px] = cv2.cvtColor(marker, cv2.COLOR_GRAY2BGR)

    # A plate in a side margin is not on the map; the .docx places it there.
    if layout["showBadge"] and not layout["badgePanel"]:
        badge_x, badge_top, badge_w, badge_h = layout["badge"]
        x0 = to_px(badge_x - map_x)
        y0 = to_px(badge_top - map_y)
        x1 = min(width - 1, x0 + to_px(badge_w))
        y1 = min(height - 1, y0 + to_px(badge_h))
        _draw_map_sheet_badge(image, (x0, y0, x1, y1), sheet_id, scale)

    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError("frame_composite_failed")
    return encoded.tobytes()


def _draw_map_sheet_badge(image, box, sheet_id, scale):
    """Paint the ID plate into box (x0, y0, x1, y1), at `scale` px per point."""
    x0, y0, x1, y1 = box
    cv2.rectangle(image, (x0, y0), (x1, y1), (255, 255, 255), -1)
    text = f"MAP ID: {sheet_id}"
    font = cv2.FONT_HERSHEY_DUPLEX
    # Hershey glyphs are ~22px tall at scale 1; aim for the PDF's 9pt bold.
    font_scale = max(0.2, 9.0 * scale * 0.7 / 22.0)
    thickness = max(1, int(round(font_scale * 1.6)))
    while font_scale > 0.2:
        (text_w, _text_h), _baseline = cv2.getTextSize(text, font, font_scale, thickness)
        if text_w <= (x1 - x0) - int(round(4.0 * scale)):
            break
        font_scale -= 0.05
    (text_w, text_h), _baseline = cv2.getTextSize(text, font, font_scale, thickness)
    cv2.putText(
        image, text,
        (x0 + ((x1 - x0) - text_w) // 2, y1 - ((y1 - y0) - text_h) // 2),
        font, font_scale, (0, 0, 0), thickness, cv2.LINE_AA,
    )


def _render_map_sheet_badge_png(sheet_id, width_pt, height_pt, scale=8.0):
    """The ID plate as a picture of its own, for a plate in a side margin."""
    width = max(1, int(round(width_pt * scale)))
    height = max(1, int(round(height_pt * scale)))
    image = np.full((height, width, 3), 255, np.uint8)
    _draw_map_sheet_badge(image, (0, 0, width - 1, height - 1), sheet_id, scale)
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError("badge_render_failed")
    return encoded.tobytes()


def _xml_text(value):
    return (
        str(value)
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _build_map_sheet_docx(frame_png, layout, side_panels, record):
    """A Word (.docx) version of the sheet, written directly as OOXML.

    One landscape page, a fixed-layout table with the map picture in the
    middle column and the side margins as editable text in the outer columns.
    The row is exactly as wide as the printable area, so the map picture keeps
    its physical size and Word prints the tags at the size the PDF would.
    """
    page_w, page_h = layout["page"]
    _map_x, map_y, map_w, map_h = layout["mapFrame"]
    regions = _map_sheet_panel_regions(layout)
    margin = MAP_SHEET_PAGE_MARGIN
    font_size = _map_sheet_panel_font_size(layout)

    def twips(points):
        return int(round(points * 20.0))

    def emu(points):
        return int(round(points * 12700.0))

    media = []          # (file name, bytes)
    relationships = []  # (rId, file name)

    def picture(data, width_pt, height_pt):
        """Add a PNG to the package; returns the XML an inline and an anchored
        drawing share: extent through graphic, less the anchor's wrap element,
        which goes between effectExtent and docPr."""
        index = len(media) + 1
        name = f"image{index}.png"
        rid = f"rIdImage{index}"
        media.append((name, data))
        relationships.append((rid, name))
        cx, cy = emu(width_pt), emu(height_pt)
        extent = (
            f'<wp:extent cx="{cx}" cy="{cy}"/>'
            '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
        )
        graphic = (
            f'<wp:docPr id="{index}" name="Picture {index}"/>'
            '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            '<pic:pic>'
            f'<pic:nvPicPr><pic:cNvPr id="{index}" name="{name}"/><pic:cNvPicPr/></pic:nvPicPr>'
            f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
            '</pic:pic></a:graphicData></a:graphic>'
        )
        return extent, graphic

    def image_paragraph(data, width_pt, height_pt):
        extent, graphic = picture(data, width_pt, height_pt)
        return (
            '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
            '<w:r><w:drawing>'
            f'<wp:inline distT="0" distB="0" distL="0" distR="0">{extent}{graphic}</wp:inline>'
            '</w:drawing></w:r></w:p>'
        )

    def page_picture_run(data, x_pt, y_pt, width_pt, height_pt):
        """A picture pinned to page coordinates, floating over the table."""
        extent, graphic = picture(data, width_pt, height_pt)
        return (
            '<w:r><w:drawing>'
            '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" '
            'relativeHeight="251659264" behindDoc="0" locked="1" layoutInCell="1" allowOverlap="1">'
            '<wp:simplePos x="0" y="0"/>'
            f'<wp:positionH relativeFrom="page"><wp:posOffset>{emu(x_pt)}</wp:posOffset></wp:positionH>'
            f'<wp:positionV relativeFrom="page"><wp:posOffset>{emu(y_pt)}</wp:posOffset></wp:positionV>'
            f'{extent}<wp:wrapNone/>{graphic}'
            '</wp:anchor></w:drawing></w:r>'
        )

    def text_paragraphs(text):
        lines = text.split("\n") or [""]
        out = []
        for position, line in enumerate(lines):
            after = twips(font_size * 0.6) if position == len(lines) - 1 else 0
            out.append(
                f'<w:p><w:pPr><w:spacing w:before="0" w:after="{after}" w:line="300" w:lineRule="auto"/></w:pPr>'
                f'<w:r><w:rPr><w:sz w:val="{int(round(font_size * 2))}"/></w:rPr>'
                f'<w:t xml:space="preserve">{_xml_text(line)}</w:t></w:r></w:p>'
            )
        return "".join(out)

    def cell(width_pt, body, pad_pt):
        pad = twips(pad_pt)
        return (
            f'<w:tc><w:tcPr><w:tcW w:w="{twips(width_pt)}" w:type="dxa"/>'
            f'<w:tcMar><w:top w:w="{pad}" w:type="dxa"/><w:left w:w="{pad}" w:type="dxa"/>'
            f'<w:bottom w:w="0" w:type="dxa"/><w:right w:w="{pad}" w:type="dxa"/></w:tcMar>'
            f'<w:vAlign w:val="top"/></w:tcPr>{body or "<w:p/>"}</w:tc>'
        )

    def panel_body(panel):
        return text_paragraphs(panel["text"]) if panel["text"] else ""

    columns = []   # (width in points, body xml, cell padding)
    left_panel = side_panels.get("left") if side_panels else None
    right_panel = side_panels.get("right") if side_panels else None
    if left_panel and regions["left"][2] >= SIDE_PANEL_MIN_WIDTH:
        columns.append((regions["left"][2], panel_body(left_panel), SIDE_PANEL_PAD))
    columns.append((map_w, image_paragraph(frame_png, map_w, map_h), 0.0))
    if right_panel and regions["right"][2] >= SIDE_PANEL_MIN_WIDTH:
        columns.append((regions["right"][2], panel_body(right_panel), SIDE_PANEL_PAD))

    table_w = sum(width for width, _body, _pad in columns)
    grid = "".join(f'<w:gridCol w:w="{twips(width)}"/>' for width, _body, _pad in columns)
    cells = "".join(cell(width, body, pad) for width, body, pad in columns)
    table = (
        '<w:tbl><w:tblPr>'
        f'<w:tblW w:w="{twips(table_w)}" w:type="dxa"/>'
        '<w:tblInd w:w="0" w:type="dxa"/>'
        '<w:tblLayout w:type="fixed"/>'
        '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>'
        '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>'
        '<w:tblLook w:val="0000"/></w:tblPr>'
        f'<w:tblGrid>{grid}</w:tblGrid>'
        f'<w:tr><w:trPr><w:trHeight w:val="{twips(map_h)}" w:hRule="atLeast"/></w:trPr>{cells}</w:tr>'
        '</w:tbl>'
    )
    # An ID plate in a side margin is not part of the map picture. It floats at
    # the page position the PDF prints it at, anchored to the trailer below.
    badge_run = ""
    if layout["showBadge"] and layout["badgePanel"]:
        badge_x, badge_top, badge_w, badge_h = layout["badge"]
        badge_run = page_picture_run(
            _render_map_sheet_badge_png(record["id"], badge_w, badge_h),
            badge_x, badge_top, badge_w, badge_h,
        )
    # Word insists on a paragraph after a table. A 1pt one, with the bottom
    # margin trimmed to make room, keeps the sheet on a single page.
    trailer = (
        '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>'
        f'<w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>{badge_run}</w:p>'
    )
    section = (
        f'<w:sectPr><w:pgSz w:w="{twips(page_w)}" w:h="{twips(page_h)}" w:orient="landscape"/>'
        f'<w:pgMar w:top="{twips(map_y)}" w:right="{twips(margin)}" w:bottom="{twips(4.0)}" '
        f'w:left="{twips(margin)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>'
    )
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        f'<w:body>{table}{trailer}{section}</w:body></w:document>'
    )
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:docDefaults><w:rPrDefault><w:rPr>'
        '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/>'
        f'<w:sz w:val="{int(round(font_size * 2))}"/><w:szCs w:val="{int(round(font_size * 2))}"/>'
        '</w:rPr></w:rPrDefault>'
        '<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
        '</w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
        '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>'
        '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar>'
        '<w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>'
        '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/>'
        '</w:tblCellMar></w:tblPr></w:style></w:styles>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '</Types>'
    )
    package_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '</Relationships>'
    )
    document_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        + "".join(
            f'<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/{name}"/>'
            for rid, name in relationships
        )
        + '</Relationships>'
    )
    core_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        f'<dc:title>Map sheet {_xml_text(record["id"])}</dc:title>'
        '<dc:creator>Low-Barrier Digital Participatory Mapping</dc:creator>'
        '<dc:description>Printable georeferenced reference map</dc:description>'
        '</cp:coreProperties>'
    )

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", package_rels)
        archive.writestr("docProps/core.xml", core_xml)
        archive.writestr("word/document.xml", document_xml)
        archive.writestr("word/styles.xml", styles_xml)
        archive.writestr("word/_rels/document.xml.rels", document_rels)
        for name, data in media:
            # Already-compressed pictures: storing beats deflating them again.
            archive.writestr(f"word/media/{name}", data, compress_type=zipfile.ZIP_STORED)
    return out.getvalue()


@app.route("/api/map-sheets", methods=["GET", "POST"])
def api_map_sheets():
    if request.method == "GET":
        records = []
        if MAP_SHEETS_DIR.exists():
            for path in MAP_SHEETS_DIR.glob("*.json"):
                try:
                    record = json.loads(path.read_text(encoding="utf-8"))
                    if _clean_map_sheet_id(record.get("id")):
                        records.append(_map_sheet_summary(record))
                except (OSError, ValueError, TypeError):
                    continue
        records.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
        return jsonify({"ok": True, "items": records})

    payload = request.get_json(silent=True) or {}
    sheet_id = _clean_map_sheet_id(payload.get("id"))
    if not sheet_id:
        return jsonify({"ok": False, "error": "invalid_map_sheet_id"}), 400
    overwritten = (MAP_SHEETS_DIR / f"{sheet_id}.json").exists()
    try:
        corners = _clean_lnglat_corners(payload.get("corners"))
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    image_uri = str(payload.get("image") or "")
    match = re.fullmatch(r"data:image/png;base64,([A-Za-z0-9+/=\r\n]+)", image_uri)
    if not match:
        return jsonify({"ok": False, "error": "invalid_png"}), 400
    try:
        png_bytes = base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError):
        return jsonify({"ok": False, "error": "invalid_png"}), 400
    if not png_bytes.startswith(b"\x89PNG\r\n\x1a\n") or len(png_bytes) > 30 * 1024 * 1024:
        return jsonify({"ok": False, "error": "invalid_png"}), 400
    decoded = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    if decoded is None or decoded.ndim < 2 or decoded.shape[0] > 12000 or decoded.shape[1] > 12000:
        return jsonify({"ok": False, "error": "invalid_png"}), 400

    camera = payload.get("camera") if isinstance(payload.get("camera"), dict) else {}
    center = camera.get("center") if isinstance(camera.get("center"), list) else []
    try:
        clean_camera = {
            "center": [round(float(center[0]), 10), round(float(center[1]), 10)],
            "zoom": round(float(camera.get("zoom")), 6),
            "bearing": round(float(camera.get("bearing", 0)), 6),
            "pitch": round(float(camera.get("pitch", 0)), 6),
        }
        if not all(math.isfinite(value) for value in clean_camera["center"] + [clean_camera["zoom"], clean_camera["bearing"], clean_camera["pitch"]]):
            raise ValueError
    except (IndexError, TypeError, ValueError):
        return jsonify({"ok": False, "error": "invalid_camera"}), 400

    created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    record = {
        "version": 2,
        "id": sheet_id,
        "title": str(payload.get("title") or "Reference map").strip()[:80] or "Reference map",
        "createdAt": created_at,
        "coordinateSystem": "EPSG:4326",
        "cornerOrder": ["top-left", "top-right", "bottom-right", "bottom-left"],
        "corners": corners,
        "camera": clean_camera,
        "theme": str(payload.get("theme") or "")[:40],
        "imageSize": {"width": int(decoded.shape[1]), "height": int(decoded.shape[0])},
    }
    customization = payload.get("layout") if isinstance(payload.get("layout"), dict) else {}
    try:
        layout = map_sheet_layout(payload.get("pageSize"), customization)
        side_panels = _clean_map_sheet_side_panels(customization.get("sidePanels"))
        pdf_bytes = _draw_map_sheet_pdf(
            png_bytes, record, layout=layout, side_panels=side_panels,
        )
        # The Word file is a convenience copy of the same sheet. Losing it
        # must not lose the PDF, which is what registration is built around.
        try:
            docx_bytes = _build_map_sheet_docx(
                _compose_map_sheet_frame_png(png_bytes, layout, sheet_id),
                layout, side_panels, record,
            )
        except Exception:  # noqa: BLE001 - any failure here only costs the .docx
            logging.exception("Could not build the Word copy of map sheet %s", sheet_id)
            docx_bytes = None
        MAP_SHEETS_DIR.mkdir(parents=True, exist_ok=True)
        targets = {
            "png": MAP_SHEETS_DIR / f"{sheet_id}.png",
            "pdf": MAP_SHEETS_DIR / f"{sheet_id}.pdf",
            "json": MAP_SHEETS_DIR / f"{sheet_id}.json",
        }
        if docx_bytes:
            targets["docx"] = MAP_SHEETS_DIR / f"{sheet_id}.docx"
        temporary = {
            key: MAP_SHEETS_DIR / f".{sheet_id}.{os.getpid()}.{threading.get_ident()}.{key}.tmp"
            for key in targets
        }
        try:
            temporary["png"].write_bytes(png_bytes)
            temporary["pdf"].write_bytes(pdf_bytes)
            if docx_bytes:
                temporary["docx"].write_bytes(docx_bytes)
            else:
                # A re-export without a Word copy must not leave the previous
                # sheet's .docx behind under this ID.
                with contextlib.suppress(OSError):
                    (MAP_SHEETS_DIR / f"{sheet_id}.docx").unlink()
            temporary["json"].write_text(
                json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            # Replace the metadata last so readers never observe a new record
            # before its matching image and PDF have reached disk.
            os.replace(temporary["png"], targets["png"])
            os.replace(temporary["pdf"], targets["pdf"])
            if docx_bytes:
                os.replace(temporary["docx"], targets["docx"])
            os.replace(temporary["json"], targets["json"])
        finally:
            for path in temporary.values():
                with contextlib.suppress(OSError):
                    path.unlink()
    except RuntimeError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500
    except OSError:
        logging.exception("Could not save map sheet")
        return jsonify({"ok": False, "error": "map_sheet_save_failed"}), 500

    return jsonify({
        "ok": True,
        "overwritten": overwritten,
        **_map_sheet_summary(record),
    }), 200 if overwritten else 201


@app.route("/api/map-sheets/<sheet_id>", methods=["GET"])
def api_map_sheet(sheet_id):
    clean_id = _clean_map_sheet_id(sheet_id)
    if not clean_id:
        return jsonify({"ok": False, "error": "invalid_map_sheet_id"}), 400
    stem = _map_sheet_record_stem(clean_id)
    path = MAP_SHEETS_DIR / f"{stem}.json"
    if not stem or not path.exists():
        return jsonify({"ok": False, "error": "map_sheet_not_found"}), 404
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return jsonify({"ok": False, "error": "map_sheet_unreadable"}), 500
    return jsonify({"ok": True, **record, "mapId": _map_id_of(stem),
                    "pdfUrl": f"/api/map-sheets/{stem}/pdf"})


@app.route("/api/map-sheets/<map_id>/sheets", methods=["POST"])
def api_new_digitized_sheet(map_id):
    """Start digitising one more page of a map; returns its new sheet ID."""
    clean = str(map_id or "") if re.fullmatch(r"[1-9][0-9]{0,8}", str(map_id or "")) else ""
    if not clean:
        return jsonify({"ok": False, "error": "invalid_map_id"}), 400
    if not _map_sheet_record_stem(clean):
        return jsonify({"ok": False, "error": "map_sheet_not_found"}), 404
    try:
        sheet_id = _allocate_digitized_sheet_id(clean)
    except OSError:
        logging.exception("Could not number a sheet of map %s", clean)
        return jsonify({"ok": False, "error": "sheet_id_not_saved"}), 500
    return jsonify({"ok": True, "mapId": clean, "sheetId": sheet_id,
                    "sheetNumber": int(sheet_id.split("_")[1])}), 201


@app.route("/api/map-sheets/<sheet_id>/pdf", methods=["GET"])
def api_map_sheet_pdf(sheet_id):
    clean_id = _clean_map_sheet_id(sheet_id)
    if not clean_id or not (MAP_SHEETS_DIR / f"{clean_id}.pdf").exists():
        return jsonify({"ok": False, "error": "map_sheet_not_found"}), 404
    return send_from_directory(
        MAP_SHEETS_DIR, f"{clean_id}.pdf", as_attachment=True,
        download_name=f"map-sheet-{clean_id}.pdf", mimetype="application/pdf"
    )


@app.route("/api/map-sheets/<sheet_id>/docx", methods=["GET"])
def api_map_sheet_docx(sheet_id):
    clean_id = _clean_map_sheet_id(sheet_id)
    if not clean_id or not (MAP_SHEETS_DIR / f"{clean_id}.docx").exists():
        return jsonify({"ok": False, "error": "map_sheet_docx_not_found"}), 404
    return send_from_directory(
        MAP_SHEETS_DIR, f"{clean_id}.docx", as_attachment=True,
        download_name=f"map-sheet-{clean_id}.docx",
        mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )


@app.route("/api/map-sheets/<sheet_id>/image", methods=["GET"])
def api_map_sheet_image(sheet_id):
    clean_id = _clean_map_sheet_id(sheet_id)
    if not clean_id or not (MAP_SHEETS_DIR / f"{clean_id}.png").exists():
        return jsonify({"ok": False, "error": "map_sheet_not_found"}), 404
    response = send_from_directory(
        MAP_SHEETS_DIR, f"{clean_id}.png", mimetype="image/png"
    )
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


def _decode_map_sheet_camera_image(image_uri):
    match = re.fullmatch(r"data:image/(?:png|jpeg);base64,([A-Za-z0-9+/=\r\n]+)", str(image_uri or ""))
    if not match:
        raise ValueError("invalid_image")
    try:
        image_bytes = base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("invalid_image") from None
    if len(image_bytes) > 30 * 1024 * 1024:
        raise ValueError("invalid_image")
    decoded = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if decoded is None or decoded.shape[0] > 12000 or decoded.shape[1] > 12000:
        raise ValueError("invalid_image")
    return decoded


def _clean_camera_quad(raw_corners, frame_shape):
    try:
        corners = np.asarray(raw_corners, dtype=np.float32)
    except (TypeError, ValueError):
        raise ValueError("invalid_paper_corners") from None
    if corners.shape != (4, 2) or not np.isfinite(corners).all():
        raise ValueError("invalid_paper_corners")
    height, width = frame_shape[:2]
    # A projected page edge may land just outside a tightly cropped frame, but
    # reject wildly unrelated coordinates before passing them to OpenCV.
    if (np.abs(corners[:, 0]) > width * 3).any() or (np.abs(corners[:, 1]) > height * 3).any():
        raise ValueError("invalid_paper_corners")
    if abs(float(cv2.contourArea(corners))) < max(100.0, width * height * 0.02):
        raise ValueError("invalid_paper_corners")
    return corners


def _map_sheet_exclusion_mask(width, height, normalized_rects):
    valid = np.full((height, width), 255, dtype=np.uint8)
    for rect in normalized_rects if isinstance(normalized_rects, list) else []:
        try:
            x0, y0, x1, y1 = [float(value) for value in rect]
        except (TypeError, ValueError):
            continue
        x0 = max(0, min(width, int(math.floor(x0 * width))))
        y0 = max(0, min(height, int(math.floor(y0 * height))))
        x1 = max(0, min(width, int(math.ceil(x1 * width))))
        y1 = max(0, min(height, int(math.ceil(y1 * height))))
        if x1 > x0 and y1 > y0:
            valid[y0:y1, x0:x1] = 0
    edge = max(2, int(round(min(width, height) * 0.012)))
    valid[:edge, :] = 0
    valid[-edge:, :] = 0
    valid[:, :edge] = 0
    valid[:, -edge:] = 0
    return valid


def _fit_reference_colors(reference, observed, valid):
    """Robustly map clean digital-map BGR colours into photographed colours."""
    sample = valid[::5, ::5] > 0
    ref_sample = reference[::5, ::5][sample].astype(np.float32)
    obs_sample = observed[::5, ::5][sample].astype(np.float32)
    if len(ref_sample) < 100:
        identity = np.vstack([
            np.eye(3, dtype=np.float32),
            np.zeros((1, 3), dtype=np.float32),
        ])
        return reference.astype(np.float32), identity
    design = np.column_stack([ref_sample, np.ones(len(ref_sample), dtype=np.float32)])
    keep = np.ones(len(ref_sample), dtype=bool)
    coefficients = None
    for _ in range(4):
        coefficients, _, _, _ = np.linalg.lstsq(design[keep], obs_sample[keep], rcond=None)
        residual = np.linalg.norm(design @ coefficients - obs_sample, axis=1)
        cutoff = float(np.quantile(residual, 0.82))
        keep = residual <= max(4.0, cutoff)
    full_design = np.concatenate([
        reference.astype(np.float32),
        np.ones((*reference.shape[:2], 1), dtype=np.float32),
    ], axis=2)
    return np.clip(full_design @ coefficients, 0, 255), coefficients


# Calibrated against the sticker stock actually used in the workshops, by
# clustering the ink of a photographed sheet. The printed stickers are much
# lighter than ink-pen equivalents: the yellow measured L=242 against this
# table's former mustard at L=183, which put it 60 Lab units away and let it
# drift to white. Cyan had no entry at all and matched "white" from 58 away.
DRAWING_COLOR_PALETTE = (
    # Calibrated to the red marker, not to a saturated printer's red. Measured
    # against the old #d3302f the marker sat 45 Lab units away but only 22 from
    # pink, so the red path was filed as pink ink — and any pink sticker it ran
    # under merged into it and was lost.
    {"id": "red", "label": "Red", "color": "#eb6f73"},
    {"id": "orange", "label": "Orange", "color": "#f59a4a"},
    {"id": "yellow", "label": "Yellow", "color": "#f7ea55"},
    {"id": "green", "label": "Green", "color": "#5ba24f"},
    {"id": "cyan", "label": "Cyan", "color": "#4acfff"},
    {"id": "blue", "label": "Blue", "color": "#3478d4"},
    {"id": "purple", "label": "Purple", "color": "#8b58bd"},
    # The replacement pink sticker stock (2026-09-02) is so pale (#ffb7e0,
    # measured from a rectified capture) that putting it here as the matching
    # target poisoned segmentation: pale glare discs that used to be filed as
    # white surfaced as phantom pinks, components split along new seams (which
    # moved centroids -- seen as drift), and the extra splitting cost time. So
    # the SEGMENTATION target stays the old saturated pink via "match", the
    # displayed colour is the real stock, and the pale discs themselves are
    # re-labelled after detection in _vectorise_drawing, where changing a label
    # cannot move or invent geometry.
    {"id": "pink", "label": "Pink", "color": "#ffb7e0", "match": "#f05c8c"},
    {"id": "black", "label": "Black", "color": "#252525"},
    # White only ever reaches classification through the opaque-disc detector
    # below, since white ink on white paper has no colour difference to find.
    {"id": "white", "label": "White", "color": "#f0f0f0"},
)


def _drawing_hex_to_bgr(value):
    value = str(value or "").lstrip("#")
    return np.asarray([
        int(value[4:6], 16),
        int(value[2:4], 16),
        int(value[0:2], 16),
    ], dtype=np.uint8)


def _drawing_bgr_to_hex(value):
    blue, green, red = [int(round(float(channel))) for channel in value]
    return f"#{red:02x}{green:02x}{blue:02x}"


def _drawing_bgr_to_lab(value):
    pixel = np.asarray(value, dtype=np.uint8).reshape(1, 1, 3)
    return cv2.cvtColor(pixel, cv2.COLOR_BGR2LAB).reshape(3).astype(np.float32)


def _fit_channel_response(reference, observed, valid):
    """Per-channel gain and offset between the printed map and the photograph.

    The full 3x3 fit above models the camera well *inside* the printed map's own
    colour gamut, which is all it is asked to do. Inverting it to recover marker
    ink extrapolates far outside that gamut: a saturated red stroke on a map of
    greys and pale yellows came back as near-black, and every red mark was then
    classified as black ink.

    A per-channel gain through the origin predicts the reference less well but
    extrapolates safely, because a printed map samples only the pale end of each
    channel. Allowing the fit an intercept as well puts the line's slope at the
    mercy of that narrow range, and applying it to ink four times darker
    overshoots — enough to push half a blue circle into the purple class.
    """
    sample = valid[::5, ::5] > 0
    reference_sample = reference[::5, ::5][sample].astype(np.float32)
    observed_sample = observed[::5, ::5][sample].astype(np.float32)
    gains = np.ones(3, dtype=np.float32)
    if len(reference_sample) < 100:
        return gains
    for channel in range(3):
        source = reference_sample[:, channel]
        target = observed_sample[:, channel]
        keep = source > 8.0
        for _ in range(4):
            if int(np.count_nonzero(keep)) < 50:
                break
            gain = float(
                np.dot(source[keep], target[keep]) / max(1e-6, np.dot(source[keep], source[keep]))
            )
            residual = np.abs(source * gain - target)
            cutoff = float(np.quantile(residual[keep], 0.82))
            keep = (source > 8.0) & (residual <= max(3.0, cutoff))
            gains[channel] = gain
    return np.clip(gains, 0.35, 2.8)


def _correct_photographed_colors(observed, gains):
    """Map photographed BGR values back into the clean digital colour space."""
    return np.clip(observed.astype(np.float32) / gains, 0, 255).astype(np.uint8)


def _segment_map_sheet_drawing_colors(alpha, corrected_bgr):
    """Classify detected ink while retaining colours outside the known palette.

    Components made from one colour receive one stable class. If two recognised
    pen colours touch, confident core pixels split the component before it is
    vectorised. Colours too far from the named palette are grouped by perceptual
    Lab distance and retained as an ``Other`` colour instead of being forced
    into a wrong class.
    """
    palette = []
    for item in DRAWING_COLOR_PALETTE:
        bgr = _drawing_hex_to_bgr(item["color"])
        # "match" lets a class advertise one colour and classify by another:
        # pink displays the pale replacement stock but keeps matching the old
        # saturated pink, so pale pixels keep landing in white exactly as they
        # always did.
        match = _drawing_hex_to_bgr(item.get("match", item["color"]))
        palette.append({
            **item,
            "bgr": bgr,
            "lab": _drawing_bgr_to_lab(match),
            "named": True,
        })

    binary = np.where(alpha >= 24, 255, 0).astype(np.uint8)
    component_count, component_labels, component_stats, _ = (
        cv2.connectedComponentsWithStats(binary, 8)
    )
    label_map = np.full(alpha.shape, -1, dtype=np.int16)
    classes = list(palette)
    named_labs = np.asarray([item["lab"] for item in palette], dtype=np.float32)
    corrected_lab = cv2.cvtColor(corrected_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)

    named_limit = 58.0
    other_merge_limit = 28.0

    def add_or_find_other(representative_bgr, representative_lab):
        for index in range(len(palette), len(classes)):
            distance = float(np.linalg.norm(classes[index]["lab"] - representative_lab))
            if distance <= other_merge_limit:
                return index
        color = _drawing_bgr_to_hex(representative_bgr)
        other_number = len(classes) - len(palette) + 1
        classes.append({
            "id": f"other-{other_number}",
            "label": f"Other {color.upper()}",
            "color": color,
            "bgr": np.asarray(representative_bgr, dtype=np.uint8),
            "lab": np.asarray(representative_lab, dtype=np.float32),
            "named": False,
        })
        return len(classes) - 1

    for component in range(1, component_count):
        if int(component_stats[component, cv2.CC_STAT_AREA]) < 14:
            continue
        component_mask = component_labels == component
        component_alpha = alpha[component_mask]
        if not component_alpha.size:
            continue
        core_cutoff = max(48.0, float(np.quantile(component_alpha, 0.58)))
        core_mask = component_mask & (alpha >= core_cutoff)
        if int(np.count_nonzero(core_mask)) < 6:
            core_mask = component_mask

        core_labs = corrected_lab[core_mask]
        core_bgrs = corrected_bgr[core_mask]
        distances = np.linalg.norm(
            core_labs[:, None, :] - named_labs[None, :, :], axis=2
        )
        nearest = np.argmin(distances, axis=1)
        nearest_distance = distances[np.arange(len(nearest)), nearest]
        confident = nearest_distance <= named_limit

        # Dark, nearly neutral ink is reliably black even when its Lab distance
        # is enlarged by paper glare or JPEG compression.
        black_index = next(
            index for index, item in enumerate(palette) if item["id"] == "black"
        )
        dark = (core_labs[:, 0] <= 108) & (
            np.linalg.norm(core_labs[:, 1:] - 128.0, axis=1) <= 38
        )
        nearest[dark] = black_index
        confident[dark] = True

        counts = np.bincount(nearest[confident], minlength=len(palette))
        # Split readily. Stickers are placed in overlapping clusters and each one
        # is a flat colour, so the seam between two of them is a colour change
        # and this split is the only thing that tells them apart. Paths used to
        # need the opposite — a warm marker scatters across red, orange and pink,
        # and splitting shattered it — but paths are now grouped without
        # reference to colour at all, so there is nothing left to protect.
        significant_minimum = max(10, int(round(len(core_labs) * 0.10)))
        significant = np.flatnonzero(counts >= significant_minimum)

        if len(significant) >= 2:
            # Two distinct colours meet here. Split every component
            # pixel by the recognised centres instead of collapsing the
            # crossing into one colour.
            component_labs = corrected_lab[component_mask]
            split_distances = np.linalg.norm(
                component_labs[:, None, :] - named_labs[significant][None, :, :],
                axis=2,
            )
            split_labels = significant[np.argmin(split_distances, axis=1)]
            label_map[component_mask] = split_labels.astype(np.int16)
            continue

        if np.any(confident):
            dominant = int(np.argmax(counts))
            confidence_ratio = float(counts[dominant]) / max(1.0, float(len(core_labs)))
            if confidence_ratio >= 0.34:
                label_map[component_mask] = dominant
                continue

        representative_bgr = np.median(core_bgrs, axis=0).astype(np.uint8)
        representative_lab = _drawing_bgr_to_lab(representative_bgr)
        other_index = add_or_find_other(representative_bgr, representative_lab)
        label_map[component_mask] = other_index

    coloured_mask = np.zeros((*alpha.shape, 4), dtype=np.uint8)
    public_classes = []
    for index, item in enumerate(classes):
        pixels = (label_map == index) & (alpha > 0)
        pixel_count = int(np.count_nonzero(pixels))
        if not pixel_count:
            continue
        coloured_mask[pixels, :3] = item["bgr"]
        coloured_mask[pixels, 3] = alpha[pixels]
        public_classes.append({
            "id": item["id"],
            "label": item["label"],
            "color": item["color"],
            "pixels": pixel_count,
            "named": bool(item["named"]),
            # Published so the page can decode the per-pixel class mask, which
            # carries this index rather than the colour itself.
            "index": index,
            "_index": index,
        })

    # Paths are only ever red or black, and are snapped to one of the two later.
    # Both entries have to exist for that snap to have somewhere to land, even
    # when no pixel was classified into them — a red path whose ink drifted into
    # the pink bin still has to come out labelled red.
    present = {item["id"] for item in public_classes}
    # Pink joins red and black: the sticker pass re-labels pale warm discs into
    # it after the fact, so the class has to exist even with zero ink pixels.
    for index, item in enumerate(palette):
        if item["id"] in ("red", "black", "pink") and item["id"] not in present:
            public_classes.append({
                "id": item["id"],
                "label": item["label"],
                "color": item["color"],
                "pixels": 0,
                "named": True,
                "index": index,
                "_index": index,
            })

    return {
        "mask": coloured_mask,
        "labelMap": label_map,
        "classes": public_classes,
    }


# The rectified working image used to be a fixed 1000x707. That threw away half
# of the saved reference's own resolution and left a fine pen line only one or
# two pixels wide, which is why thin strokes kept dropping out. Working at the
# reference's native size keeps the printed detail the subtraction compares
# against and avoids resampling the reference at all.
MAP_SHEET_RECTIFIED_MIN_PX = 1000
MAP_SHEET_RECTIFIED_MAX_PX = 2400

# A misregistered printed label differs from the reference almost entirely in
# luminance; marker ink differs in chroma. Weighting the Lab axes accordingly
# suppresses registration ghosts without losing coloured strokes, and black ink
# still passes easily because its luminance delta is enormous to begin with.
MAP_SHEET_LUMINANCE_WEIGHT = 0.42
MAP_SHEET_CHROMA_WEIGHT = 1.25

# Printed sticker diameter as a fraction of the sheet width. Used as a size
# prior when telling a filled disc apart from a pen stroke.
MAP_SHEET_STICKER_DIAMETER_FRACTION = 0.019

# Kinds a blob of ink can be, and the value each one is stamped with in the
# per-pixel class mask the page uses to filter the overlay.
MAP_SHEET_KIND_CODES = {"sticker": 1, "line": 2, "area": 3}


def _rectified_output_size(reference):
    """Rectify at the reference's own resolution, clamped to a sane range."""
    height, width = reference.shape[:2]
    if width <= 0 or height <= 0:
        return 1000, 707
    output_width = int(min(
        MAP_SHEET_RECTIFIED_MAX_PX, max(MAP_SHEET_RECTIFIED_MIN_PX, width)
    ))
    output_height = int(max(2, round(output_width * height / float(width))))
    return output_width, output_height


def _refine_rectified_alignment(observed, predicted, valid):
    """Sub-pixel homography touch-up after the AprilTag registration.

    Three or four tags recover the page pose, but on a street map dense with
    printed text a two- to five-pixel residual is normal, and every misregistered
    label edge then reads as fresh ink. Aligning the whole rectified image
    against the reference render is what lets the neighbourhood search below
    shrink from 5x5 to 3x3 and keeps the difference threshold low enough for
    thin strokes to survive.
    """
    height, width = observed.shape[:2]
    scale = min(1.0, 900.0 / float(max(width, height)))
    small = (max(32, int(round(width * scale))), max(32, int(round(height * scale))))

    def prepare(image):
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, small, interpolation=cv2.INTER_AREA)
        return cv2.GaussianBlur(gray.astype(np.float32), (0, 0), 1.2)

    template = prepare(np.clip(predicted, 0, 255).astype(np.uint8))
    moving = prepare(observed)
    mask_small = cv2.resize(valid, small, interpolation=cv2.INTER_NEAREST)

    warp = np.eye(3, dtype=np.float32)
    try:
        cv2.findTransformECC(
            template, moving, warp, cv2.MOTION_HOMOGRAPHY,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-6),
            mask_small, 5,
        )
    except cv2.error:
        return observed, False
    if not np.isfinite(warp).all():
        return observed, False

    # Undo the downscale: with S the scale matrix, the full-size warp is S^-1.W.S
    to_small = np.asarray([
        [small[0] / float(width), 0.0, 0.0],
        [0.0, small[1] / float(height), 0.0],
        [0.0, 0.0, 1.0],
    ], dtype=np.float32)
    try:
        full_warp = np.linalg.inv(to_small) @ warp @ to_small
    except np.linalg.LinAlgError:
        return observed, False

    # A refinement is a nudge. Anything that moves a corner by more than a small
    # fraction of the page means ECC locked onto the wrong minimum, and warping
    # by it would be far worse than leaving the tag registration alone.
    probe = np.asarray([
        [[0, 0]], [[width - 1, 0]], [[width - 1, height - 1]], [[0, height - 1]],
    ], dtype=np.float32)
    moved = cv2.perspectiveTransform(probe, full_warp).reshape(-1, 2)
    shift = float(np.max(np.linalg.norm(moved - probe.reshape(-1, 2), axis=1)))
    if not math.isfinite(shift) or shift > max(6.0, width * 0.02):
        return observed, False

    aligned = cv2.warpPerspective(
        observed, full_warp, (width, height),
        flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
        borderMode=cv2.BORDER_REPLICATE,
    )
    return aligned, True


def _local_stddev(gray, ksize):
    mean = cv2.blur(gray, (ksize, ksize))
    mean_square = cv2.blur(gray * gray, (ksize, ksize))
    return np.sqrt(np.clip(mean_square - mean * mean, 0.0, None))


def _opaque_disc_mask(observed, predicted, valid, sticker_radius):
    """Find opaque round stickers that colour subtraction cannot see.

    A white sticker on white paper produces almost no Lab difference, yet it
    still hides whatever the reference printed underneath. Detecting that loss
    of printed detail — high local contrast in the reference, flat in the photo
    — finds it whatever its colour. The result is deliberately restricted to
    disc-shaped blobs of roughly the printed sticker size, so a blurry or badly
    shadowed photo cannot turn this into a second, noisy ink channel.
    """
    empty = np.zeros(observed.shape[:2], dtype=np.uint8)
    if sticker_radius < 3.0:
        return empty
    observed_gray = cv2.cvtColor(observed, cv2.COLOR_BGR2GRAY).astype(np.float32)
    predicted_gray = cv2.cvtColor(
        np.clip(predicted, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY
    ).astype(np.float32)

    window = max(5, (int(round(sticker_radius * 0.75)) | 1))
    predicted_std = _local_stddev(predicted_gray, window)
    observed_std = _local_stddev(observed_gray, window)

    detail = predicted_std >= 14.0                  # the reference printed something here
    flattened = observed_std <= predicted_std * 0.42
    candidate = ((detail & flattened) & (valid > 0)).astype(np.uint8) * 255
    if not np.count_nonzero(candidate):
        return empty

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (window, window))
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_CLOSE, kernel)
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_OPEN, kernel)

    keep = np.zeros_like(candidate)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(candidate, 8)
    minimum_area = math.pi * (sticker_radius * 0.45) ** 2
    maximum_area = math.pi * (sticker_radius * 2.2) ** 2
    for label in range(1, count):
        area = float(stats[label, cv2.CC_STAT_AREA])
        if not minimum_area <= area <= maximum_area:
            continue
        blob = (labels == label).astype(np.uint8)
        contours, _ = cv2.findContours(blob, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        perimeter = float(cv2.arcLength(contour, True))
        if perimeter <= 0:
            continue
        circularity = 4.0 * math.pi * area / (perimeter * perimeter)
        hull_area = abs(float(cv2.contourArea(cv2.convexHull(contour))))
        fill = area / hull_area if hull_area > 0 else 0.0
        if circularity >= 0.68 and fill >= 0.82:
            keep[labels == label] = 255
    return keep


# Paths are accepted at this fraction of the sticker threshold, because the two
# are not equally visible against the printed map.
MAP_SHEET_PATH_THRESHOLD_RATIO = 0.62


def _path_ink_masks(corrected_bgr, score, valid, threshold, speckle_area):
    """One mask per pen colour: the black paths, and the red paths.

    Kept apart rather than merged. Where a red route and a black route run
    alongside each other — which participants do constantly — a single combined
    mask joins them into one blob, and whichever colour has fewer pixels loses
    its identity to a majority vote. Traced separately, each is simply itself,
    and no vote is needed at all.

    Splitting also lets the threshold drop below the sticker-grade one: a path
    is only ever black or red, so the extra sensitivity cannot pull in ink of
    any other hue.
    """
    lab = cv2.cvtColor(corrected_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    lightness = lab[:, :, 0]
    green_red = lab[:, :, 1] - 128.0
    blue_yellow = lab[:, :, 2] - 128.0
    chroma = np.sqrt(green_red * green_red + blue_yellow * blue_yellow)
    hue = (np.degrees(np.arctan2(blue_yellow, green_red)) + 360.0) % 360.0

    path_threshold = max(6.0, float(threshold) * MAP_SHEET_PATH_THRESHOLD_RATIO)
    strong = (score.astype(np.float32) >= path_threshold) & (valid > 0)

    def cleaned(mask):
        alpha = np.where(mask & strong, 255, 0).astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(alpha, 8)
        if count <= 1:
            return np.zeros_like(alpha)
        keep = np.flatnonzero(stats[1:, cv2.CC_STAT_AREA] >= speckle_area) + 1
        alpha[~np.isin(labels, keep)] = 0
        return alpha

    return {
        "black": cleaned((chroma < 26.0) & (lightness < 170.0)),
        "red": cleaned((chroma >= 26.0) & ((hue >= 340.0) | (hue <= 45.0))),
    }


def _extract_map_sheet_drawing(
    frame, reference, paper_corners, normalized_rects, threshold,
    sticker_fraction=None,
):
    """Return an alpha mask for ink that is absent from the saved clean map."""
    output_width, output_height = _rectified_output_size(reference)
    destination = np.asarray([
        [0, 0], [output_width - 1, 0],
        [output_width - 1, output_height - 1], [0, output_height - 1],
    ], dtype=np.float32)
    camera_to_map = cv2.getPerspectiveTransform(paper_corners, destination)
    observed = cv2.warpPerspective(
        frame, camera_to_map, (output_width, output_height),
        flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE,
    )
    if reference.shape[:2] == (output_height, output_width):
        clean = reference
    else:
        clean = cv2.resize(
            reference, (output_width, output_height), interpolation=cv2.INTER_AREA
        )
    valid = _map_sheet_exclusion_mask(output_width, output_height, normalized_rects)

    predicted, _ = _fit_reference_colors(clean, observed, valid)
    observed, refined = _refine_rectified_alignment(observed, predicted, valid)
    if refined:
        # Re-fit the colours on the corrected geometry; the first fit only
        # existed to give ECC a photometrically comparable template.
        predicted, _ = _fit_reference_colors(clean, observed, valid)

    resolution_scale = output_width / 1000.0
    observed_float = observed.astype(np.float32)
    # Remove slow lighting/shadow changes while retaining narrow pen strokes.
    illumination = cv2.GaussianBlur(
        observed_float - predicted, (0, 0), 28.0 * resolution_scale
    )
    normalized_observed = np.clip(observed_float - illumination, 0, 255).astype(np.uint8)
    predicted_u8 = np.clip(predicted, 0, 255).astype(np.uint8)

    observed_lab = cv2.cvtColor(
        cv2.GaussianBlur(normalized_observed, (3, 3), 0), cv2.COLOR_BGR2LAB
    ).astype(np.float32)
    predicted_lab = cv2.cvtColor(
        cv2.GaussianBlur(predicted_u8, (3, 3), 0), cv2.COLOR_BGR2LAB
    ).astype(np.float32)

    # Score each pixel by how far it falls outside the range of colours the
    # reference has nearby, rather than against the single colour underneath it.
    # Printed edges soften differently in a photograph than in the reference
    # render, and the resulting halo is always a blend of colours already
    # present around it — so it lands inside the local range and scores zero,
    # while ink introduces a colour that simply is not there. Erode/dilate give
    # that range in constant time, which is what makes a generous radius
    # affordable; the previous shift search cost forty times as much and found
    # more false edges. A wider radius covers the leftover registration error
    # when ECC could not refine the alignment.
    radius = int(min(8, max(2, round((2.0 if refined else 3.5) * resolution_scale))))
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1)
    )
    lowest = cv2.erode(predicted_lab, kernel)
    highest = cv2.dilate(predicted_lab, kernel)
    outside = (
        np.maximum(observed_lab - highest, 0.0) + np.maximum(lowest - observed_lab, 0.0)
    ) * np.asarray([
        MAP_SHEET_LUMINANCE_WEIGHT, MAP_SHEET_CHROMA_WEIGHT, MAP_SHEET_CHROMA_WEIGHT,
    ], dtype=np.float32)
    best_distance = np.sqrt(np.einsum("ijk,ijk->ij", outside, outside))

    best_distance[valid == 0] = 0
    score = np.clip(best_distance, 0, 255).astype(np.uint8)
    score = cv2.medianBlur(score, 3 if output_width <= 1200 else 5)
    threshold = max(5.0, min(100.0, float(threshold)))
    alpha = np.clip((score.astype(np.float32) - threshold) * (255.0 / 18.0), 0, 255).astype(np.uint8)

    # Eliminate isolated JPEG/halftone speckles but retain connected pen lines.
    # The area floor tracks resolution so it stays the same physical size.
    speckle_area = max(14, int(round(14.0 * resolution_scale * resolution_scale)))
    binary = np.where(alpha >= 24, 255, 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    if count > 1:
        areas = stats[1:, cv2.CC_STAT_AREA].astype(np.float32)
        # A misregistered printed label leaves a weak echo just over the
        # threshold; real ink clears it by a wide margin. Requiring a small blob
        # to contain a confident core removes those ghosts without touching a
        # faint-but-large stroke, which a higher global threshold would erase.
        confident = np.bincount(
            labels[alpha >= 250].ravel(), minlength=count
        )[1:].astype(np.float32)
        strong_enough = confident >= np.maximum(6.0, areas * 0.18)
        obviously_real = areas >= speckle_area * 24.0
        keep_labels = np.flatnonzero(
            (areas >= speckle_area) & (strong_enough | obviously_real)
        ) + 1
        alpha[~np.isin(labels, keep_labels)] = 0
    else:
        alpha[:] = 0

    sticker_diameter = max(6.0, float(
        sticker_fraction if sticker_fraction else MAP_SHEET_STICKER_DIAMETER_FRACTION
    ) * output_width)
    occluded = _opaque_disc_mask(
        normalized_observed, predicted, valid, sticker_diameter / 2.0
    )
    if np.count_nonzero(occluded):
        alpha = np.maximum(alpha, occluded)

    alpha[valid == 0] = 0
    corrected_bgr = _correct_photographed_colors(
        normalized_observed, _fit_channel_response(clean, normalized_observed, valid)
    )

    # A sticker is opaque and saturated; a path is a marker stroke that can be
    # thin, or drawn lightly enough to let the map show through. Measured on a
    # real sheet the two sit well apart — stickers score a median of 58 against
    # the reference, paths 42, blank paper 1 — so one threshold serves them
    # badly: set for stickers it clips the faint end of every stroke.
    #
    # Paths get their own, lower threshold, made safe by the fact that only two
    # pen colours exist. Requiring a pixel to be near-neutral dark or in the red
    # band keeps the extra sensitivity from turning into map noise.
    path_masks = _path_ink_masks(
        corrected_bgr, score, valid, threshold, speckle_area
    )

    info = {
        "width": output_width,
        "height": output_height,
        "eccRefined": bool(refined),
        "searchRadius": radius,
        "stickerDiameterPx": round(sticker_diameter, 2),
        "occludedPixels": int(np.count_nonzero(occluded)),
        "pathThreshold": round(max(6.0, threshold * MAP_SHEET_PATH_THRESHOLD_RATIO), 1),
        "pathPixels": {k: int(np.count_nonzero(v)) for k, v in path_masks.items()},
    }
    return alpha, corrected_bgr, path_masks, info


@app.route("/api/map-sheet-registration", methods=["POST"])
def api_map_sheet_registration():
    payload = request.get_json(silent=True) or {}
    sheet_id = _clean_map_sheet_id(payload.get("id"))
    if not sheet_id:
        return jsonify({"ok": False, "error": "invalid_map_sheet_id"}), 400
    stem = _map_sheet_record_stem(sheet_id)
    record_path = MAP_SHEETS_DIR / f"{stem}.json"
    if not stem or not record_path.exists():
        return jsonify({"ok": False, "error": "map_sheet_reference_not_found"}), 404
    try:
        frame = _decode_map_sheet_camera_image(payload.get("image"))
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
        print_info = record.get("print") or {}
        page_size = np.asarray(print_info["pagePoints"], dtype=np.float32)
        map_page_points = np.asarray(print_info["mapCornerPagePoints"], dtype=np.float32)
        fiducials = print_info["fiducials"]
    except (OSError, ValueError, TypeError, KeyError):
        return jsonify({"ok": False, "error": "map_sheet_reference_incomplete"}), 409
    if page_size.shape != (2,) or map_page_points.shape != (4, 2) or not isinstance(fiducials, list):
        return jsonify({"ok": False, "error": "map_sheet_reference_incomplete"}), 409

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_16h5)
    parameters = cv2.aruco.DetectorParameters()
    parameters.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    detected_corners, detected_ids, _ = cv2.aruco.ArucoDetector(
        dictionary, parameters
    ).detectMarkers(gray)
    by_id = {}
    if detected_ids is not None:
        for corners, tag_id in zip(detected_corners, detected_ids.flatten().tolist()):
            by_id[int(tag_id)] = np.asarray(corners, dtype=np.float32).reshape(4, 2)

    page_samples = []
    camera_samples = []
    matched_ids = []
    matched_page_centers = []
    try:
        for item in fiducials:
            tag_id = int(item["id"])
            if tag_id not in by_id:
                continue
            page_tag_corners = np.asarray(item["cornersPagePoints"], dtype=np.float32)
            if page_tag_corners.shape != (4, 2):
                continue
            page_samples.extend(page_tag_corners.tolist())
            camera_samples.extend(by_id[tag_id].tolist())
            matched_ids.append(tag_id)
            matched_page_centers.append(np.mean(page_tag_corners, axis=0))
    except (TypeError, ValueError, KeyError):
        return jsonify({"ok": False, "error": "map_sheet_reference_incomplete"}), 409

    spread_area = 0.0
    if len(matched_page_centers) >= 3:
        spread_area = abs(float(cv2.contourArea(cv2.convexHull(
            np.asarray(matched_page_centers, dtype=np.float32)
        ))))
    minimum_spread = float(page_size[0] * page_size[1]) * 0.02
    if len(matched_ids) < 3 or spread_area < minimum_spread:
        return jsonify({
            "ok": False,
            "error": "map_sheet_tags_not_found",
            "tagsDetected": matched_ids,
            "tagsRequired": 3,
            "tagsSpread": spread_area >= minimum_spread,
        }), 409

    page_to_camera, inliers = cv2.findHomography(
        np.asarray(page_samples, dtype=np.float32),
        np.asarray(camera_samples, dtype=np.float32),
        cv2.RANSAC, 5.0,
    )
    if page_to_camera is None:
        return jsonify({"ok": False, "error": "map_sheet_alignment_failed"}), 409
    projected = cv2.perspectiveTransform(
        map_page_points.reshape(1, -1, 2), page_to_camera
    ).reshape(-1, 2)
    paper_corners = [[round(float(x), 3), round(float(y), 3)] for x, y in projected]
    return jsonify({
        "ok": True,
        "sheetId": sheet_id,
        "corners": record.get("corners"),
        "camera": record.get("camera"),
        "theme": record.get("theme") or "streets",
        "paperCorners": paper_corners,
        "maskRects": print_info.get("maskRectsNormalized") or [],
        "tagsDetected": matched_ids,
        "tagsExpected": len(fiducials),
        "inlierCorners": int(np.count_nonzero(inliers)) if inliers is not None else 0,
        "method": "manual-id+apriltags",
    })


@app.route("/api/map-sheet-drawing", methods=["POST"])
def api_map_sheet_drawing():
    payload = request.get_json(silent=True) or {}
    sheet_id = _clean_map_sheet_id(payload.get("id"))
    if not sheet_id:
        return jsonify({"ok": False, "error": "invalid_map_sheet_id"}), 400
    stem = _map_sheet_record_stem(sheet_id)
    record_path = MAP_SHEETS_DIR / f"{stem}.json"
    image_path = MAP_SHEETS_DIR / f"{stem}.png"
    if not stem or not record_path.exists() or not image_path.exists():
        return jsonify({"ok": False, "error": "map_sheet_reference_not_found"}), 404
    try:
        frame = _decode_map_sheet_camera_image(payload.get("image"))
        paper_corners = _clean_camera_quad(payload.get("paperCorners"), frame.shape)
        threshold = float(payload.get("threshold", 28))
        sticker_fraction = _clean_sticker_fraction(payload.get("stickerFraction"))
        if not math.isfinite(threshold):
            raise ValueError("invalid_threshold")
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    want_semantics = bool(payload.get("semantics", True))
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
        normalized_rects = (record.get("print") or {}).get("maskRectsNormalized") or []
        corners = _clean_lnglat_corners(record.get("corners"))
        reference = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    except (OSError, ValueError, TypeError):
        return jsonify({"ok": False, "error": "map_sheet_reference_unreadable"}), 500
    if reference is None:
        return jsonify({"ok": False, "error": "map_sheet_reference_unreadable"}), 500
    semantics = None
    try:
        alpha, corrected_bgr, path_masks, info = _extract_map_sheet_drawing(
            frame, reference, paper_corners, normalized_rects, threshold,
            sticker_fraction=sticker_fraction,
        )
        segmentation = _segment_map_sheet_drawing_colors(alpha, corrected_bgr)
        if want_semantics:
            semantics = _vectorise_drawing(
                alpha, corners, 0.002, segmentation=segmentation,
                corrected_bgr=corrected_bgr,
                sticker_diameter=info["stickerDiameterPx"],
                path_masks=path_masks,
            )
        mask = np.full((*alpha.shape, 4), 255, dtype=np.uint8)
        mask[:, :, 3] = alpha
        encoded_ok, encoded = cv2.imencode(".png", mask)
        if not encoded_ok:
            raise RuntimeError("drawing_mask_encode_failed")
        colour_encoded_ok, colour_encoded = cv2.imencode(
            ".png", segmentation["mask"]
        )
        if not colour_encoded_ok:
            raise RuntimeError("drawing_colour_mask_encode_failed")
        class_mask_uri = None
        if semantics is not None:
            class_ok, class_encoded = cv2.imencode(".png", semantics["classMask"])
            if not class_ok:
                raise RuntimeError("drawing_class_mask_encode_failed")
            class_mask_uri = (
                "data:image/png;base64,"
                + base64.b64encode(class_encoded.tobytes()).decode("ascii")
            )
    except (cv2.error, np.linalg.LinAlgError, RuntimeError, ValueError):
        logging.exception("Could not subtract the printable map reference")
        return jsonify({"ok": False, "error": "drawing_detection_failed"}), 500
    return jsonify({
        "ok": True,
        "sheetId": sheet_id,
        "width": int(alpha.shape[1]),
        "height": int(alpha.shape[0]),
        "inkPixels": int(np.count_nonzero(alpha)),
        "mask": "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode("ascii"),
        "colorMask": (
            "data:image/png;base64,"
            + base64.b64encode(colour_encoded.tobytes()).decode("ascii")
        ),
        "colors": [
            {key: value for key, value in item.items() if not key.startswith("_")}
            for item in segmentation["classes"]
        ],
        "alignment": info,
        "counts": semantics["counts"] if semantics else None,
        "stickerColors": semantics["stickerColors"] if semantics else [],
        "markers": semantics["markers"] if semantics else [],
        "paths": semantics["paths"] if semantics else [],
        "classMask": class_mask_uri,
        "kindCodes": MAP_SHEET_KIND_CODES,
        "method": "ecc-refined-reference-subtraction+shape-typed-segmentation",
    })


def _rectified_pixel_to_lnglat(corners, width, height):
    """Build a pixel -> [lng, lat] mapper for the rectified drawing space.

    `corners` are the sheet's geographic corners in TL, TR, BR, BL order, and the
    rectified mask is an axis-aligned `width` x `height` image of that same page,
    so a bilinear blend of the four corners is the exact inverse mapping.
    """
    (tl_lng, tl_lat), (tr_lng, tr_lat), (br_lng, br_lat), (bl_lng, bl_lat) = corners
    span_x = max(1.0, float(width - 1))
    span_y = max(1.0, float(height - 1))

    def to_lnglat(x, y):
        u = min(1.0, max(0.0, float(x) / span_x))
        v = min(1.0, max(0.0, float(y) / span_y))
        top_lng = tl_lng + (tr_lng - tl_lng) * u
        top_lat = tl_lat + (tr_lat - tl_lat) * u
        bottom_lng = bl_lng + (br_lng - bl_lng) * u
        bottom_lat = bl_lat + (br_lat - bl_lat) * u
        return [
            round(top_lng + (bottom_lng - top_lng) * v, 8),
            round(top_lat + (bottom_lat - top_lat) * v, 8),
        ]

    return to_lnglat


# ---------------------------------------------------------------------------
# Drawing semantics: deciding what each blob of ink actually is
# ---------------------------------------------------------------------------
#
# Two things are looked for: the drawn path, and the stickers placed on it.
# Colour cannot make that call — the path is drawn in whatever dark marker came
# to hand and its ink drifts between grey, brown and black along a single
# stroke, so grouping by colour only ever tore one path into pieces. Shape makes
# it instead. Three descriptors carry almost all the signal: how much of its own
# convex hull a blob fills (a sticker is solid, a stroke and a ring are not),
# how thin it is, and how long its skeleton is relative to that width. Colour is
# then read off each finished sticker, which is where it genuinely means
# something. It stays deterministic throughout — no model is involved.
#
# Pen annotations are deliberately not detected. They are thin enough that
# separating them from the printed map is unreliable, and guessing produced
# worse results than leaving them out.

def _skeleton_crossing_number(skeleton):
    """Count how many separate strands meet at each skeleton pixel.

    Simply counting the eight neighbours does not work: where a one-pixel-wide
    line steps diagonally it touches three of them, and a plain circle was
    arriving with thirty-two "junctions" that were only staircase steps. Walking
    the ring of neighbours and counting 0->1 transitions gives 1 at a loose end,
    2 along a line — staircase or not — and 3 or more only where strands really
    branch.
    """
    padded = np.pad(skeleton.astype(np.uint8), 1)
    height, width = skeleton.shape

    def shifted(offset_y, offset_x):
        return padded[1 + offset_y:1 + offset_y + height,
                      1 + offset_x:1 + offset_x + width]

    ring = [
        shifted(-1, 0), shifted(-1, 1), shifted(0, 1), shifted(1, 1),
        shifted(1, 0), shifted(1, -1), shifted(0, -1), shifted(-1, -1),
    ]
    crossings = np.zeros((height, width), dtype=np.uint8)
    for index in range(8):
        crossings += (
            (ring[index] == 0) & (ring[(index + 1) % 8] == 1)
        ).astype(np.uint8)
    return crossings * skeleton


def _skeletonize(binary):
    """Thin a 0/255 mask down to a single-pixel-wide skeleton."""
    if hasattr(cv2, "ximgproc"):
        try:
            thinned = cv2.ximgproc.thinning(
                binary, thinningType=cv2.ximgproc.THINNING_ZHANGSUEN
            )
            return thinned > 0
        except (cv2.error, AttributeError):
            pass
    try:
        from skimage.morphology import skeletonize as _skimage_skeletonize
    except ImportError:
        return binary > 0
    return np.asarray(_skimage_skeletonize(binary > 0), dtype=bool)




def _path_length(path):
    if len(path) < 2:
        return 0.0
    points = np.asarray(path, dtype=np.float32)
    return float(np.sum(np.linalg.norm(np.diff(points, axis=0), axis=1)))


def _trace_skeleton_edges(skeleton):
    """Split a skeleton into ordered pixel runs between endpoints/junctions.

    Points are kept in (row, column) order throughout and only flipped to (x, y)
    at emission time.
    """
    crossings = _skeleton_crossing_number(skeleton)
    points = {(int(y), int(x)) for y, x in zip(*np.nonzero(skeleton))}
    if not points:
        return []

    def neighbours(point):
        y, x = point
        found = []
        for offset_y in (-1, 0, 1):
            for offset_x in (-1, 0, 1):
                if offset_y == 0 and offset_x == 0:
                    continue
                candidate = (y + offset_y, x + offset_x)
                if candidate in points:
                    found.append(candidate)
        return found

    nodes = {point for point in points if int(crossings[point]) != 2}
    edges = []
    walked = set()
    # A pixel along a strand belongs to exactly one edge. Consuming it as the
    # walk passes stops a diagonal step, whose two pixels are neighbours of each
    # other, from sending the walk back down the strand it just came along.
    consumed = set()

    def follow(first, second):
        path = [first]
        previous, current = first, second
        while True:
            path.append(current)
            if current in nodes:
                break
            consumed.add(current)
            onward = [
                point for point in neighbours(current)
                if point != previous and (point in nodes or point not in consumed)
            ]
            if not onward:
                break
            previous, current = current, onward[0]
        return path

    for node in nodes:
        for start in neighbours(node):
            if (node, start) in walked or (start not in nodes and start in consumed):
                continue
            walked.add((node, start))
            path = follow(node, start)
            if len(path) >= 2:
                walked.add((path[-1], path[-2]))
                edges.append(path)

    # A closed loop has no loose end or branch at all, so the walk above never
    # starts on one. Pick any pixel it did not reach and go round.
    for point in points:
        if point in consumed or point in nodes:
            continue
        neighbourhood = neighbours(point)
        if not neighbourhood:
            continue
        consumed.add(point)
        path = follow(point, neighbourhood[0])
        if len(path) >= 3:
            if math.dist(path[-1], point) <= 1.5:
                path.append(point)      # it came back round: close the ring
            edges.append(path)

    return edges


def _edge_direction(path, at_end):
    """Unit vector pointing outwards from the requested end of a path."""
    points = np.asarray(path, dtype=np.float32)
    sample = min(len(points) - 1, 8)
    if sample < 1:
        return np.zeros(2, dtype=np.float32)
    vector = points[-1] - points[-1 - sample] if at_end else points[0] - points[sample]
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 1e-6 else np.zeros(2, dtype=np.float32)


def _resample_path(points, spacing):
    """Even out a traced centre-line to one point every `spacing` pixels.

    A raw skeleton walk is a staircase of single-pixel steps, and its bridges
    are long straight jumps, so the exported line has wildly uneven vertex
    density. Sampling at a fixed interval gives a polyline that reads the same
    everywhere and is far smaller.
    """
    if len(points) < 2:
        return list(points)
    walk = np.asarray(points, dtype=np.float64)
    steps = np.linalg.norm(np.diff(walk, axis=0), axis=1)
    total = float(steps.sum())
    if total <= spacing:
        return [points[0], points[-1]]
    milestones = np.concatenate([[0.0], np.cumsum(steps)])
    wanted = np.arange(0.0, total, spacing)
    wanted = np.append(wanted, total)
    segment = np.clip(np.searchsorted(milestones, wanted, side="right") - 1,
                      0, len(steps) - 1)
    along = (wanted - milestones[segment]) / np.maximum(steps[segment], 1e-9)
    sampled = walk[segment] + (walk[segment + 1] - walk[segment]) * along[:, None]
    return [(float(p[0]), float(p[1])) for p in sampled]


def _bridge_over_occlusion(chains, blocked, sticker_diameter, straightness=0.45):
    """Rejoin path chains whose gap is explained by something lying on top.

    Stickers are masked out before paths are traced, and participants put them
    straight onto their routes, so each one punches a hole roughly its own
    diameter wide. Measured on a real sheet, 47% of all path endpoints sat
    against a removed sticker — they were not ends of anything, just holes.

    Two loose ends are joined when the straight run between them is mostly
    covered by whatever was removed and the two strokes are heading the same
    way. Both conditions matter: distance alone would staple together lines
    that merely stop near each other.
    """
    if blocked is None or len(chains) < 2:
        return chains
    # Two allowances, because breaks have two causes. A stroke that simply went
    # faint leaves a short gap over blank map, so that one is kept tight. A gap
    # explained by something lying on the route may be long — participants place
    # stickers in overlapping clusters, and the measured gaps on a real sheet
    # ran 75 to 110px against a single sticker's 33px.
    near_reach = sticker_diameter * 1.3
    far_reach = sticker_diameter * 4.5
    height, width = blocked.shape[:2]

    def covered(a, b):
        span = math.dist(a, b)
        if span <= 1e-6:
            return 1.0
        steps = max(2, int(span))
        hits = 0
        for index in range(steps + 1):
            t = index / steps
            y = int(round(a[0] + (b[0] - a[0]) * t))
            x = int(round(a[1] + (b[1] - a[1]) * t))
            if 0 <= y < height and 0 <= x < width and blocked[y, x]:
                hits += 1
        return hits / (steps + 1)

    working = [list(chain) for chain in chains]
    merged = True
    while merged:
        merged = False
        for i in range(len(working)):
            if merged:
                break
            for j in range(len(working)):
                if i == j:
                    continue
                for i_end in (True, False):
                    for j_end in (True, False):
                        a = working[i][-1] if i_end else working[i][0]
                        b = working[j][-1] if j_end else working[j][0]
                        span = math.dist(a, b)
                        if span > far_reach:
                            continue
                        blocking = covered(a, b)
                        if span > near_reach and blocking < 0.35:
                            continue
                        # A long bridge has to be better justified than a short
                        # one, since it is asserting more about ink nobody can
                        # see. Direction is what carries that justification:
                        # the two strokes must genuinely continue each other.
                        needed = straightness if span <= near_reach else 0.60
                        heading = _edge_direction(working[i], i_end)
                        entering = -_edge_direction(working[j], j_end)
                        if float(np.dot(heading, entering)) < needed:
                            continue
                        first = working[i] if i_end else working[i][::-1]
                        second = working[j] if not j_end else working[j][::-1]
                        working[i] = first + second
                        working.pop(j)
                        merged = True
                        break
                    if merged:
                        break
                if merged:
                    break
    return working


def _chain_skeleton_edges(edges, min_branch_px, straightness=0.55, bridge_px=None):
    """Drop thinning spurs, then reconnect edges through junctions.

    A route that crosses itself is cut into four stubs by the junction; joining
    the pair that continues straight through puts it back together as one line.
    Where a junction has only two edges the join is unconditional, so a sharp
    corner in a route survives instead of being split at the bend.

    Ends that merely land near each other are treated as meeting, because a
    detected stroke is rarely unbroken: a two-pixel break at the top of a drawn
    circle otherwise leaves two arcs that never rejoin, and the shape is read as
    a line instead of the region the participant meant to enclose.
    """
    if not edges:
        return []
    if bridge_px is None:
        bridge_px = min_branch_px
    lengths = [_path_length(path) for path in edges]

    terminal_cluster = {}
    centres = []
    for index, path in enumerate(edges):
        for at_end, point in ((False, path[0]), (True, path[-1])):
            assigned = None
            for cluster, centre in enumerate(centres):
                if math.dist(point, centre) <= bridge_px:
                    assigned = cluster
                    break
            if assigned is None:
                centres.append(point)
                assigned = len(centres) - 1
            terminal_cluster[(index, at_end)] = assigned

    def build_incident(excluded):
        incident = {}
        for index in range(len(edges)):
            if index in excluded:
                continue
            for at_end in (False, True):
                incident.setdefault(
                    terminal_cluster[(index, at_end)], []
                ).append((index, at_end))
        return incident

    incident = build_incident(set())
    dropped = {
        index for index in range(len(edges))
        if lengths[index] < min_branch_px and any(
            len(incident.get(terminal_cluster[(index, at_end)], [])) <= 1
            for at_end in (False, True)
        )
    }
    incident = build_incident(dropped)

    used = set()
    chains = []
    for index in range(len(edges)):
        if index in dropped or index in used:
            continue
        used.add(index)
        chain = list(edges[index])
        tail = (index, True)
        for pass_number in (0, 1):
            if pass_number:
                chain.reverse()
                tail = (index, False)
            while True:
                attached = incident.get(terminal_cluster[tail], [])
                options = [item for item in attached if item[0] not in used]
                if not options:
                    break
                heading = _edge_direction(chain, True)
                best, best_score = None, -2.0
                for other, other_end in options:
                    entering = -_edge_direction(edges[other], other_end)
                    score = float(np.dot(heading, entering))
                    if score > best_score:
                        best, best_score = (other, other_end), score
                if best is None:
                    break
                # Only a real junction has to justify the join by staying
                # straight; a plain two-edge meeting is the same line either way.
                if len(attached) > 2 and best_score < straightness:
                    break
                other, other_end = best
                used.add(other)
                extension = list(edges[other])
                if other_end:
                    extension.reverse()
                if extension and extension[0] == chain[-1]:
                    extension = extension[1:]
                chain.extend(extension)
                tail = (other, not other_end)
        chains.append(chain)
    return chains


def _component_metrics(component, sticker_diameter, minimum_branch=None):
    """Measure one connected blob of ink."""
    if minimum_branch is None:
        minimum_branch = max(4.0, sticker_diameter * 0.45)
    if not np.count_nonzero(component):
        return None

    # Detection leaves ragged, pitted edges. Every pit becomes a skeleton spur
    # and a false junction — a plain circle was arriving with thirty-two of them
    # — and small gaps break a closed shape into an open arc. Closing the blob
    # by roughly a pen-width fixes both before anything is measured.
    bridge = max(3, int(round(sticker_diameter * 0.12)) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (bridge, bridge))
    smooth = cv2.morphologyEx(component, cv2.MORPH_CLOSE, kernel)
    smooth = cv2.medianBlur(smooth, 3)
    if not np.count_nonzero(smooth):
        smooth = component

    area = float(np.count_nonzero(smooth))
    contours, _ = cv2.findContours(smooth, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours or area <= 0:
        return None
    contour = max(contours, key=cv2.contourArea)
    perimeter = float(cv2.arcLength(contour, True))
    hull_area = abs(float(cv2.contourArea(cv2.convexHull(contour))))
    circularity = (
        4.0 * math.pi * area / (perimeter * perimeter) if perimeter > 0 else 0.0
    )
    fill = area / hull_area if hull_area > 0 else 0.0

    # Enclosed background, found by flooding inwards from outside the blob.
    # Filling the outer contour instead reports nothing at all for a ring whose
    # trace doubles back along the stroke.
    bordered = cv2.copyMakeBorder(smooth, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    flooded = bordered.copy()
    cv2.floodFill(
        flooded,
        np.zeros((bordered.shape[0] + 2, bordered.shape[1] + 2), dtype=np.uint8),
        (0, 0), 255,
    )
    hole_area = float(np.count_nonzero(flooded == 0))
    filled_area = area + hole_area

    distance = cv2.distanceTransform(smooth, cv2.DIST_L2, 5)
    skeleton = _skeletonize(smooth)
    ridge = distance[skeleton]
    # The distance transform on the skeleton is half the local stroke width.
    stroke_width = 2.0 * float(np.median(ridge)) if ridge.size else 1.0
    stroke_width = max(1.0, stroke_width)
    inscribed_radius = float(distance.max()) if distance.size else 0.0
    # How disc-like the blob is, without involving its perimeter: a digital
    # circle's staircased outline inflates the perimeter enough to drag the
    # usual 4*pi*A/P^2 circularity of a clean sticker down to 0.39.
    equivalent_radius = math.sqrt(area / math.pi)
    roundness = inscribed_radius / equivalent_radius if equivalent_radius > 0 else 0.0

    crossings = _skeleton_crossing_number(skeleton)
    endpoints = int(np.count_nonzero(crossings == 1))
    junction_mask = (crossings >= 3).astype(np.uint8)
    junction_clusters = 0
    if np.count_nonzero(junction_mask):
        junction_clusters = int(cv2.connectedComponents(junction_mask, 8)[0]) - 1
    skeleton_length = float(np.count_nonzero(skeleton))

    # Chains are needed for classification, not just for emission: a hand-drawn
    # circle almost always sprouts a thinning spur, and counting raw skeleton
    # endpoints would then report loose ends on a shape that is plainly closed.
    chains = _chain_skeleton_edges(
        _trace_skeleton_edges(skeleton), minimum_branch,
        bridge_px=max(3.0, stroke_width * 2.0),
    )
    longest = max(chains, key=_path_length) if chains else None
    longest_length = _path_length(longest) if longest else 0.0
    # A hand-drawn ring rarely meets itself exactly, and detection can drop a
    # stretch of it. A gap of a few percent of the way round still reads as
    # closed to whoever drew it, so the tolerance scales with the loop.
    closed_loop = bool(
        longest is not None
        and len(longest) > 2
        and longest_length >= skeleton_length * 0.7
        and math.dist(longest[0], longest[-1])
        <= max(4.0, stroke_width * 2.0, longest_length * 0.06)
    )
    if closed_loop:
        # Flood filling finds nothing enclosed while that gap is open, so take
        # the enclosed area from the ring the pen actually traced.
        ring = np.asarray(longest, dtype=np.int32).reshape(-1, 1, 2)
        hole_area = max(hole_area, abs(float(cv2.contourArea(ring))) - area)
        filled_area = area + hole_area

    height, width = component.shape[:2]
    diagonal = math.hypot(width, height)

    return {
        "area": area,
        "perimeter": perimeter,
        "circularity": circularity,
        "roundness": roundness,
        "fill": fill,
        "filledArea": filled_area,
        "holeArea": hole_area,
        "strokeWidth": stroke_width,
        "inscribedRadius": inscribed_radius,
        "skeletonLength": skeleton_length,
        "elongation": skeleton_length / stroke_width,
        "endpoints": endpoints,
        "junctions": junction_clusters,
        "bboxDiagonal": diagonal,
        "bboxMax": float(max(width, height)),
        "contour": contour,
        "stickerShape": _sticker_shape(contour, area),
        "skeleton": skeleton,
        "chains": chains,
        "longestChain": longest,
        "closedLoop": closed_loop,
    }


def _sticker_shape(contour, area):
    """Name a solid blob's shape, or return None if it is not a sticker shape.

    The stickers are printed circles and triangles, so shape alone decides what
    counts — colour cannot, because a path and a sticker may well be the same
    colour. Comparing the blob's area against its minimum-area rectangle
    separates the three cases without reference to anything else: a triangle
    covers about half of that rectangle, a disc covers pi/4 of it, and a
    rectangle covers nearly all of it.

    The bands are measured, not derived. Smoothing the blob rounds a triangle's
    corners and lifts it from a theoretical 0.50 to about 0.63, so the windows
    sit where the real values fall: triangles 0.63, round stickers 0.82-0.86,
    and ruled highlighter blocks 0.90-1.02, which no longer pass as stickers
    however neatly they fill their own hull.
    """
    # Measure the convex hull rather than the blob. Stickers are placed in
    # overlapping clusters, so many are only partly visible; what a neighbour
    # hides is a bite out of one side, and the hull fills that bite back in with
    # a chord, leaving the original outline to measure. Counting corners was
    # tried as a second opinion and dropped — a rounded-off or torn triangle
    # reports six or more, which sent every solid triangle in a cluster to None.
    hull = cv2.convexHull(contour)
    hull_area = abs(float(cv2.contourArea(hull)))
    if hull_area <= 0:
        return None
    centre, radius = cv2.minEnclosingCircle(hull)
    radius = float(radius)
    enclosing = math.pi * radius ** 2
    if enclosing <= 0 or radius <= 0:
        return None

    # Does the outline actually lie on a circle? A whole disc puts all of its
    # boundary on one, and a disc with a neighbour sitting on top still puts the
    # visible arc there, while a polygon only touches at its corners. This is
    # what tells a partly-hidden disc from a triangle or a ruled block — the
    # area ratios below cannot, once a bite has been taken out of the shape.
    #
    # The boundary has to be walked at even steps rather than measured at the
    # hull's own vertices: those are precisely the corners, which sit on the
    # enclosing circle for every convex shape, so sampling them called a
    # triangle and a square circles too.
    polygon = hull.reshape(-1, 2).astype(np.float32)
    if len(polygon) < 3:
        return None
    closed = np.concatenate([polygon, polygon[:1]], axis=0)
    edges = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    span = float(edges.sum())
    if span <= 0:
        return None
    steps = int(min(1500, max(96, span)))
    walk = np.linspace(0.0, span, steps, endpoint=False)
    milestones = np.concatenate([[0.0], np.cumsum(edges)])
    segment = np.clip(np.searchsorted(milestones, walk, side="right") - 1, 0, len(edges) - 1)
    along = (walk - milestones[segment]) / np.maximum(edges[segment], 1e-6)
    sampled = closed[segment] + (closed[segment + 1] - closed[segment]) * along[:, None]
    offsets = np.linalg.norm(sampled - np.asarray(centre, dtype=np.float32), axis=1)
    on_circle = float(np.mean(np.abs(offsets - radius) <= radius * 0.16))
    if on_circle >= 0.55:
        return "circle"

    # Otherwise fall back on how much of that enclosing circle the outline
    # fills. The values are fixed by geometry — a square covers 2/pi = 0.64, an
    # equilateral triangle 0.41 — so a block lands above the triangle band and
    # is rejected rather than being read as a sticker.
    filled = hull_area / enclosing
    if 0.30 <= filled <= 0.56:
        return "triangle"
    return None


def _classify_component(metrics, sticker_diameter):
    """Decide which kind of map feature a measured blob represents.

    Only two things are looked for: the drawn path, and the stickers placed on
    it. Pen annotations are deliberately not classified — they are too thin to
    separate from the printed map with any confidence, so anything that is not a
    solid sticker-sized blob is treated as drawing.
    """
    sticker_radius = sticker_diameter / 2.0

    # A sticker is a solid blob of about the printed size whose outline is a
    # circle or a triangle. Both conditions are needed: convexity alone lets a
    # ruled-in block through, and the printed stickers only come in those two
    # shapes, so anything else solid is part of the drawing.
    if (
        # How much of its own hull the blob fills. A whole sticker is near 1.0;
        # one with a neighbour sitting on it measured 0.63, so the old 0.80 gate
        # threw away exactly the crowded ones this is meant to recover. A stroke
        # stays far below — the traced paths on these sheets sit around 0.15.
        metrics["fill"] >= 0.58
        and metrics["stickerShape"] is not None
        and metrics["inscribedRadius"] >= sticker_radius * 0.55
        and metrics["elongation"] <= 8.0
    ):
        return "sticker"

    # Anything that is not a sticker has to hold a deliberate amount of pen
    # travel. A printed map icon that survives subtraction — a metro roundel, a
    # pin — is a stubby ring a few pixels across, and used to fall through to
    # "line" and land in the exported paths, where averaging many sheets would
    # quietly turn printed furniture into drawn routes.
    if metrics["skeletonLength"] < sticker_diameter * 2.0:
        return None

    # A closed loop with empty paper inside is an area the participant ringed;
    # everything else drawn is path.
    if (
        metrics["closedLoop"]
        and metrics["holeArea"] >= metrics["filledArea"] * 0.45
        and metrics["holeArea"] >= math.pi * sticker_radius * sticker_radius
    ):
        return "area"

    if metrics["elongation"] >= 5.0:
        return "line"

    return "area"


def _vectorise_drawing(
    alpha, corners, simplify, segmentation=None, allowed_sticker_colors=None,
    corrected_bgr=None, sticker_diameter=None, path_masks=None,
):
    """Turn the ink mask into typed geographic features.

    Every connected blob is measured and classified first, so a sticker leaves a
    Point carrying its colour and shape, a traced path leaves a LineString along
    the pen's centre line, and a ringed region leaves a Polygon. Douglas-Peucker
    runs in pixel space before projecting, so the tolerance stays a predictable
    fraction of each shape's own size rather than varying with the sheet's
    geographic extent.
    """
    height, width = alpha.shape[:2]
    to_lnglat = _rectified_pixel_to_lnglat(corners, width, height)
    if not sticker_diameter:
        sticker_diameter = MAP_SHEET_STICKER_DIAMETER_FRACTION * width

    resolution_scale = width / 1000.0
    # The floor is a physical size, not a pixel count: a quarter of a sticker's
    # area is a mark about 4mm across, and nobody draws smaller than that on
    # purpose. A fixed pixel floor let every misregistered printed metro icon
    # through as its own "area" feature.
    sticker_area = math.pi * (sticker_diameter / 2.0) ** 2
    minimum_area = max(24.0 * resolution_scale * resolution_scale, sticker_area * 0.25)
    minimum_branch = max(4.0, sticker_diameter * 0.45)

    # Stickers and paths want opposite treatment, so they get a pass each.
    #
    # Stickers are found first, one colour class at a time. Participants place
    # them in clusters and they overlap constantly; grouped by shape alone a row
    # of five touching circles is one blob that is not a circle at all, and the
    # whole cluster is lost. Each sticker is a single flat colour, though, so the
    # boundary between two overlapping ones is a colour change, and splitting by
    # colour recovers them individually.
    #
    # Paths are then traced over whatever ink the sticker pass did not claim,
    # with colour ignored, because a dark marker drifts between grey, brown and
    # black along one stroke and grouping by colour tore single paths apart.
    label_map = segmentation["labelMap"] if segmentation else None
    class_by_index = (
        {item["_index"]: item for item in segmentation["classes"]}
        if segmentation else {}
    )
    ink = (label_map >= 0) & (alpha >= 24) if label_map is not None else alpha >= 24

    features = []
    counts = {"sticker": 0, "line": 0, "area": 0}
    sticker_colors = {}
    markers = []
    path_chains = []
    path_lines = []

    # A per-pixel record of what each blob was decided to be, so the page can
    # show only routes, or only the green stickers, without re-running
    # detection. Encoded as a PNG the browser reads directly: red carries the
    # kind, green the colour class, alpha the original ink strength.
    class_mask = np.zeros((height, width, 4), dtype=np.uint8)

    def stamp(kind, color_class, selected, x0, y0, y1, x1):
        region = class_mask[y0:y1, x0:x1]
        region[..., 2][selected] = MAP_SHEET_KIND_CODES[kind]
        region[..., 1][selected] = (
            min(255, int(color_class["index"]) + 1) if color_class else 0
        )
        region[..., 3][selected] = alpha[y0:y1, x0:x1][selected]

    def base_properties(color_class, kind, metrics):
        properties = {
            "kind": kind,
            "areaPx": int(round(metrics["area"])),
            "strokeWidthPx": round(metrics["strokeWidth"], 2),
        }
        if color_class:
            properties.update({
                "color": color_class["color"],
                "colorClass": color_class["id"],
                "colorLabel": color_class["label"],
                "namedColor": bool(color_class["named"]),
            })
        return properties

    def components_of(mask):
        """Yield (crop bounds, boolean selection) for each blob worth measuring."""
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        for label in range(1, count):
            if float(stats[label, cv2.CC_STAT_AREA]) < minimum_area:
                continue
            left = int(stats[label, cv2.CC_STAT_LEFT])
            top = int(stats[label, cv2.CC_STAT_TOP])
            pad = 3
            x0 = max(0, left - pad)
            y0 = max(0, top - pad)
            x1 = min(width, left + int(stats[label, cv2.CC_STAT_WIDTH]) + pad)
            y1 = min(height, top + int(stats[label, cv2.CC_STAT_HEIGHT]) + pad)
            yield x0, y0, x1, y1, labels[y0:y1, x0:x1] == label

    def majority_colour(selected, x0, y0, x1, y1):
        if label_map is None:
            return None
        votes = label_map[y0:y1, x0:x1][selected]
        votes = votes[votes >= 0]
        if not votes.size:
            return None
        return class_by_index.get(int(np.bincount(votes).argmax()))

    # ---- pass one: stickers, split by colour so overlaps come apart ----------
    # The pale pink sticker stock classifies as white (it is nearly white); a
    # disc that made it through detection as "white" but carries a clearly warm
    # cast is one of them. Re-labelling here touches nothing but the class on an
    # already-measured blob: positions, splitting and timing stay exactly as
    # they were. Measured stock reads Lab a+30 b-10 (chroma ~32); true white
    # discs measure chroma <= ~3, so the gate sits well clear of both.
    pink_class = None
    if segmentation:
        pink_class = next(
            (c for c in segmentation["classes"] if c["id"] == "pink"), None
        )

    def resolve_sticker_class(color_class, selected, x0, y0, x1, y1):
        if color_class["id"] != "white" or pink_class is None or corrected_bgr is None:
            return color_class
        pixels = corrected_bgr[y0:y1, x0:x1][selected]
        if not pixels.size:
            return color_class
        lab = _drawing_bgr_to_lab(
            np.clip(pixels.mean(axis=0), 0, 255).astype(np.uint8)
        )
        a_shift = float(lab[1]) - 128.0
        b_shift = float(lab[2]) - 128.0
        if math.hypot(a_shift, b_shift) >= 12.0 and a_shift >= 8.0:
            return pink_class
        return color_class

    claimed = np.zeros((height, width), dtype=bool)
    sticker_jobs = []
    if label_map is not None:
        for item in segmentation["classes"]:
            colour_mask = np.where(
                (label_map == item["_index"]) & ink, 255, 0
            ).astype(np.uint8)
            if not np.count_nonzero(colour_mask):
                continue
            for x0, y0, x1, y1, selected in components_of(colour_mask):
                component = np.where(selected, 255, 0).astype(np.uint8)
                metrics = _component_metrics(
                    component, sticker_diameter, minimum_branch
                )
                if metrics is None or metrics["area"] < minimum_area:
                    continue
                if _classify_component(metrics, sticker_diameter) != "sticker":
                    continue
                claimed[y0:y1, x0:x1] |= selected
                sticker_jobs.append((
                    x0, y0, x1, y1, selected, component, metrics,
                    resolve_sticker_class(item, selected, x0, y0, x1, y1),
                ))

    # ---- pass two: paths over the ink no sticker claimed ---------------------
    # The path channel is detected at its own, lower threshold, so a thin or
    # lightly drawn stroke survives that the sticker-grade threshold clips.
    # One pass per pen colour, over ink no sticker claimed. Each channel already
    # knows its own colour, so nothing has to be inferred afterwards.
    channels = path_masks or {}
    if not channels:
        channels = {None: np.where(ink, 255, 0).astype(np.uint8)}
    path_jobs = []
    for pen, pen_mask in channels.items():
        pen_class = next(
            (item for item in class_by_index.values() if item["id"] == pen), None
        )
        residual = np.where((pen_mask >= 24) & ~claimed, 255, 0).astype(np.uint8)
        for x0, y0, x1, y1, selected in components_of(residual):
            component = np.where(selected, 255, 0).astype(np.uint8)
            metrics = _component_metrics(component, sticker_diameter, minimum_branch)
            # Smoothing dissolves ragged detection noise, so re-check the floor
            # against what actually survived rather than the raw blob.
            if metrics is None or metrics["area"] < minimum_area:
                continue
            kind = _classify_component(metrics, sticker_diameter)
            if kind is None:        # not a deliberate mark; leave it off the map
                continue
            path_jobs.append(
                (kind, x0, y0, x1, y1, selected, component, metrics, pen_class)
            )

    jobs = [
        ("sticker", x0, y0, x1, y1, selected, component, metrics, item)
        for x0, y0, x1, y1, selected, component, metrics, item in sticker_jobs
    ] + path_jobs

    for job_index, (
        kind, x0, y0, x1, y1, selected, component, metrics, forced_colour
    ) in enumerate(jobs, start=1):
        color_class = forced_colour or majority_colour(selected, x0, y0, x1, y1)
        stamp(kind, color_class, selected, x0, y0, y1, x1)

        if kind == "sticker":
            shape = metrics["stickerShape"]
            # Every sticker colour is tallied even when it is filtered out, so
            # the page can offer it as something to switch back on.
            colour_id = color_class["id"] if color_class else "unknown"
            tally = sticker_colors.setdefault(colour_id, {
                "id": colour_id,
                "label": color_class["label"] if color_class else "Unknown",
                "color": color_class["color"] if color_class else "#8f8f8f",
                "count": 0,
            })
            tally["count"] += 1
            tally[shape] = tally.get(shape, 0) + 1
            if (
                allowed_sticker_colors is not None
                and colour_id not in allowed_sticker_colors
            ):
                continue
            moments = cv2.moments(component, binaryImage=True)
            centre_x = x0 + moments["m10"] / moments["m00"]
            centre_y = y0 + moments["m01"] / moments["m00"]
            properties = base_properties(color_class, kind, metrics)
            properties["shape"] = shape
            properties["radiusPx"] = round(metrics["inscribedRadius"], 2)
            properties["roundness"] = round(metrics["roundness"], 3)
            properties["circularity"] = round(metrics["circularity"], 3)
            features.append({
                "type": "Feature",
                "properties": properties,
                "geometry": {
                    "type": "Point",
                    "coordinates": to_lnglat(centre_x, centre_y),
                },
            })
            # The same point in rectified pixels, so the page can draw a mark at
            # it rather than painting the sticker's own pixels. A cluster of
            # overlapping discs is unreadable as ink but perfectly legible as a
            # handful of small symbols.
            markers.append({
                "x": round(float(centre_x), 1),
                "y": round(float(centre_y), 1),
                "shape": shape,
                "color": color_class["color"] if color_class else "#8f8f8f",
                "colorClass": colour_id,
                "colorLabel": color_class["label"] if color_class else "Unknown",
            })
            counts["sticker"] += 1
            continue

        chains = metrics["chains"]

        if kind == "area":
            # The loop the classifier accepted, not merely a chain that
            # happens to end on the pixel it started from — a stray
            # three-pixel ring would otherwise be preferred over the shape.
            ring_source = metrics["longestChain"] if metrics["closedLoop"] else None
            if ring_source is not None:
                # The pen's centre line is the boundary the participant meant,
                # not the outer edge of the stroke they drew it with.
                pixels = np.asarray(
                    [[point[1] + x0, point[0] + y0] for point in ring_source],
                    dtype=np.int32,
                ).reshape(-1, 1, 2)
            else:
                pixels = metrics["contour"] + np.asarray([x0, y0], dtype=np.int32)
            perimeter = float(cv2.arcLength(pixels, True))
            epsilon = max(0.75, simplify * perimeter)
            reduced = cv2.approxPolyDP(pixels, epsilon, True).reshape(-1, 2)
            if reduced.shape[0] < 3:
                continue
            ring = [to_lnglat(point[0], point[1]) for point in reduced]
            if ring[0] != ring[-1]:
                ring.append(list(ring[0]))
            properties = base_properties(color_class, kind, metrics)
            properties["enclosedAreaPx"] = int(round(metrics["holeArea"]))
            properties["vertices"] = int(reduced.shape[0])
            features.append({
                "type": "Feature",
                "properties": properties,
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            })
            counts["area"] += 1
            continue

        # A traced route. Emission is deferred: a sticker sitting on a route
        # splits it into separate connected components, so the pieces that need
        # rejoining live in different components and can only be matched up once
        # every component has been traced.
        for chain in chains:
            path_chains.append({
                "points": [(point[0] + y0, point[1] + x0) for point in chain],
                "color": color_class,
                "metrics": metrics,
            })

    # ---- rejoin and emit the routes -----------------------------------------
    # Bridging happens across the whole sheet and only between chains of the
    # same pen colour, so a red route is never stapled onto a black one.
    by_colour = {}
    for entry in path_chains:
        key = (entry["color"] or {}).get("id", "ink")
        by_colour.setdefault(key, []).append(entry)
    for key, entries in by_colour.items():
        joined = _bridge_over_occlusion(
            [entry["points"] for entry in entries], claimed, sticker_diameter
        )
        colour = entries[0]["color"]
        metrics = entries[0]["metrics"]
        for index, chain in enumerate(joined, start=1):
            length_px = _path_length(chain)
            if length_px < minimum_branch * 2.0:
                continue
            even = _resample_path(chain, max(3.0, sticker_diameter * 0.25))
            pixels = np.asarray(
                [[point[1], point[0]] for point in even], dtype=np.int32
            ).reshape(-1, 1, 2)
            epsilon = max(0.75, simplify * length_px)
            reduced = cv2.approxPolyDP(pixels, epsilon, False).reshape(-1, 2)
            if reduced.shape[0] < 2:
                continue
            properties = base_properties(colour, "line", metrics)
            properties.update({
                "componentId": f"{key}-{index}",
                "lengthPx": int(round(length_px)),
                "vertices": int(reduced.shape[0]),
            })
            # The same simplified line in mask pixels, so the page can draw the
            # vector it is about to export instead of the raw ink behind it.
            path_lines.append({
                "color": (colour or {}).get("color", "#252525"),
                "colorClass": key,
                "widthPx": round(metrics["strokeWidth"], 2),
                "lengthPx": int(round(length_px)),
                "points": [[int(p[0]), int(p[1])] for p in reduced],
            })
            features.append({
                "type": "Feature",
                "properties": properties,
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        to_lnglat(point[0], point[1]) for point in reduced
                    ],
                },
            })
            counts["line"] += 1

    features.sort(
        key=lambda feature: feature["properties"].get("areaPx", 0), reverse=True
    )
    return {
        "features": features,
        "counts": counts,
        "markers": markers,
        "paths": path_lines,
        "classMask": class_mask,
        "stickerColors": sorted(
            sticker_colors.values(),
            key=lambda item: (-item["count"], item["label"]),
        ),
    }


@app.route("/api/map-sheet-geojson", methods=["POST"])
def api_map_sheet_geojson():
    """Vectorise the detected drawing into simplified GeoJSON polygons."""
    payload = request.get_json(silent=True) or {}
    sheet_id = _clean_map_sheet_id(payload.get("id"))
    if not sheet_id:
        return jsonify({"ok": False, "error": "invalid_map_sheet_id"}), 400
    stem = _map_sheet_record_stem(sheet_id)
    record_path = MAP_SHEETS_DIR / f"{stem}.json"
    image_path = MAP_SHEETS_DIR / f"{stem}.png"
    if not stem or not record_path.exists() or not image_path.exists():
        return jsonify({"ok": False, "error": "map_sheet_reference_not_found"}), 404
    try:
        frame = _decode_map_sheet_camera_image(payload.get("image"))
        paper_corners = _clean_camera_quad(payload.get("paperCorners"), frame.shape)
        threshold = float(payload.get("threshold", 28))
        simplify = float(payload.get("simplify", 0.002))
        sticker_fraction = _clean_sticker_fraction(payload.get("stickerFraction"))
        raw_kinds = payload.get("kinds")
        if raw_kinds is not None and not isinstance(raw_kinds, list):
            raise ValueError("invalid_kinds")
        allowed_kinds = (
            {str(value) for value in raw_kinds} & set(MAP_SHEET_KIND_CODES)
            if raw_kinds is not None
            else None
        )
        raw_colors = payload.get("stickerColors")
        if raw_colors is not None and not isinstance(raw_colors, list):
            raise ValueError("invalid_sticker_colors")
        allowed_sticker_colors = (
            {str(value) for value in raw_colors}
            if raw_colors is not None
            else None
        )
        if not math.isfinite(threshold) or not math.isfinite(simplify):
            raise ValueError("invalid_threshold")
        simplify = max(0.0, min(0.05, simplify))
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
        corners = _clean_lnglat_corners(record.get("corners"))
        normalized_rects = (record.get("print") or {}).get("maskRectsNormalized") or []
        reference = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    except (OSError, ValueError, TypeError):
        return jsonify({"ok": False, "error": "map_sheet_reference_unreadable"}), 500
    if reference is None:
        return jsonify({"ok": False, "error": "map_sheet_reference_unreadable"}), 500
    try:
        alpha, corrected_bgr, path_masks, info = _extract_map_sheet_drawing(
            frame, reference, paper_corners, normalized_rects, threshold,
            sticker_fraction=sticker_fraction,
        )
        segmentation = _segment_map_sheet_drawing_colors(alpha, corrected_bgr)
        vectorised = _vectorise_drawing(
            alpha,
            corners,
            simplify,
            segmentation=segmentation,
            allowed_sticker_colors=allowed_sticker_colors,
            corrected_bgr=corrected_bgr,
            sticker_diameter=info["stickerDiameterPx"],
            path_masks=path_masks,
        )
        if allowed_kinds is not None:
            vectorised["features"] = [
                feature for feature in vectorised["features"]
                if feature["properties"].get("kind") in allowed_kinds
            ]
            vectorised["counts"] = {
                kind: (total if allowed_kinds and kind in allowed_kinds else 0)
                for kind, total in vectorised["counts"].items()
            }
    except (cv2.error, np.linalg.LinAlgError, RuntimeError, ValueError):
        logging.exception("Could not vectorise the detected drawing")
        return jsonify({"ok": False, "error": "drawing_vectorisation_failed"}), 500
    return jsonify({
        "ok": True,
        "sheetId": sheet_id,
        "counts": vectorised["counts"],
        "geojson": {
            "type": "FeatureCollection",
            "properties": {
                "sheetId": sheet_id,
                "threshold": threshold,
                "simplify": simplify,
                "alignment": info,
                "counts": vectorised["counts"],
                "stickerColors": vectorised["stickerColors"],
                "colors": [
                    {
                        key: value
                        for key, value in item.items()
                        if not key.startswith("_")
                    }
                    for item in segmentation["classes"]
                ],
                "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            "features": vectorised["features"],
        },
    })


def _clean_sticker_fraction(raw):
    """Printed sticker diameter as a fraction of the sheet width."""
    if raw in (None, ""):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError("invalid_sticker_fraction") from None
    if not math.isfinite(value) or not 0.002 <= value <= 0.12:
        raise ValueError("invalid_sticker_fraction")
    return value


@app.route("/floorplan")
def floorplan_page():
    return send_from_directory(WEB_DIR, "index.html")


# Expo (tag-driven cognitive-mapping scenario). Served same-origin so it can
# reach /api/tags and /api/marker-settings. Intentionally not linked from home.
EXPO_DIR = ROOT / "Expo" / "school-scenario"


@app.route("/expo/")
def expo_page():
    return send_from_directory(EXPO_DIR, "index.html")


# Télécom-hall public-display expo (its own page under the expo prefix).
TELECOM_EXPO_DIR = ROOT / "Expo" / "telecom-hall"


@app.route("/expo/telecom/")
def telecom_expo_page():
    return send_from_directory(TELECOM_EXPO_DIR, "campus-3d.html")


@app.route("/expo/telecom/<path:filename>")
def telecom_expo_asset(filename):
    return send_from_directory(TELECOM_EXPO_DIR, filename)


@app.route("/expo/<path:filename>")
def expo_asset(filename):
    return send_from_directory(EXPO_DIR, filename)


@app.route("/api/floorplan")
def api_floorplan():
    plan_id = request.args.get("id") or None
    try:
        payload = get_floorplan_payload(plan_id)
    except FileNotFoundError:
        return jsonify({"ok": False, "error": "floorplan_missing"}), 404
    except Exception as exc:
        return jsonify({"ok": False, "error": "floorplan_parse_failed", "detail": str(exc)}), 500
    return jsonify({"ok": True, "floorplan": payload})


@app.route("/api/floorplans", methods=["GET"])
def api_floorplans_list():
    return jsonify({"ok": True, "floorplans": list_floorplans()})


@app.route("/api/floorplans", methods=["POST"])
def api_floorplans_upload():
    file_storage = request.files.get("file") or request.files.get("dxf")
    if file_storage is None or not (file_storage.filename or "").strip():
        return jsonify({"ok": False, "error": "no_file"}), 400
    if not file_storage.filename.lower().endswith(".dxf"):
        return jsonify({"ok": False, "error": "not_a_dxf"}), 400
    FLOORPLAN_DIR.mkdir(parents=True, exist_ok=True)
    name = _safe_dxf_name(file_storage.filename)
    dest = FLOORPLAN_DIR / name
    # Avoid clobbering an existing file: suffix " (2)", " (3)", …
    if dest.exists():
        stem, ext = os.path.splitext(name)
        n = 2
        while (FLOORPLAN_DIR / (stem + " (" + str(n) + ")" + ext)).exists():
            n += 1
        name = stem + " (" + str(n) + ")" + ext
        dest = FLOORPLAN_DIR / name
    try:
        file_storage.save(str(dest))
    except Exception as exc:
        return jsonify({"ok": False, "error": "save_failed", "detail": str(exc)}), 500
    # Validate it actually parses; if not, remove it and report.
    try:
        _parse_floorplan_dxf(dest)
    except Exception as exc:
        try:
            dest.unlink()
        except Exception:
            pass
        return jsonify({"ok": False, "error": "parse_failed", "detail": str(exc)}), 400
    return jsonify({"ok": True, "id": name, "name": dest.stem, "floorplans": list_floorplans()})


@app.route("/api/floorplans/<path:plan_id>", methods=["DELETE"])
def api_floorplans_delete(plan_id):
    path = _floorplan_path_for_id(plan_id)
    if path is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    try:
        path.unlink()
    except Exception as exc:
        return jsonify({"ok": False, "error": "delete_failed", "detail": str(exc)}), 500
    with floorplan_lock:
        FLOORPLAN_CACHE.pop(str(path), None)
    return jsonify({"ok": True, "floorplans": list_floorplans()})


@app.route("/phone-audio")
def phone_audio_page():
    return send_from_directory(WEB_DIR, "phone_audio.html")


@app.route("/comment")
def comment_page():
    return send_from_directory(WEB_DIR, "comment.html")


@app.route("/results")
def results_page():
    return send_from_directory(WEB_DIR, "results.html")


@app.route("/heatmap")
def heatmap_page():
    return redirect("/results", code=302)


# data/ lives outside the static web/ root (it mixes shipped datasets with
# app-written state), so serve it explicitly to keep /data/... URLs working.
@app.route("/data/<path:filename>")
def data_asset(filename):
    return send_from_directory(ROOT / "data", filename)


@app.route("/api/camera/status")
def api_camera_status():
    return jsonify({
        "ok": True,
        "connected": camera is not None,
        "source": camera_source,
    })


@app.route("/api/camera/connect", methods=["POST"])
def api_camera_connect():
    """Switch the live camera at runtime. Body:
       {"kind": "webcam", "index": 0}            → cv2.VideoCapture(0)
       {"kind": "smartphone"}                    → auto-discover IP camera on :8080
       {"kind": "url", "url": "http://..."}      → open a custom URL"""
    payload = request.get_json(silent=True) or {}
    kind = str(payload.get("kind") or "").strip().lower()

    if kind == "webcam":
        try:
            index = int(payload.get("index", 0))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "invalid_index"}), 400
        init_camera(index)
        return jsonify({"ok": camera is not None, "source": camera_source})

    if kind == "smartphone":
        source = discover_camera_source_on_port(port=8080, path="/video")
        if source is None:
            return jsonify({"ok": False, "error": "ip_camera_not_found"}), 404
        init_camera(source)
        return jsonify({"ok": camera is not None, "source": camera_source})

    if kind == "url":
        url = str(payload.get("url") or "").strip()
        if not url:
            return jsonify({"ok": False, "error": "missing_url"}), 400
        init_camera(url)
        return jsonify({"ok": camera is not None, "source": camera_source})

    return jsonify({"ok": False, "error": "invalid_kind"}), 400


@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    """Triggered by the home-page Exit button. Closes the kiosk browser (if any)
    and stops the backend process."""
    def _exit_soon():
        time.sleep(0.2)
        shutdown_event.set()
        global kiosk_browser_process
        if kiosk_browser_process is not None:
            try:
                kiosk_browser_process.terminate()
            except Exception:
                pass
        stop_quick_tunnel()
        os._exit(0)

    threading.Thread(target=_exit_soon, daemon=True).start()
    return jsonify({"ok": True})


# src/config.js is committed with a placeholder instead of the real Mapbox
# token (the secret lives only in gitignored token.txt). Serve it with the
# placeholder substituted so the browser still gets the token synchronously
# and no app restructuring is needed. This route shadows Flask's static
# handler for this one path.
@app.route("/src/config.js")
def serve_config_js():
    config_path = WEB_DIR / "src" / "config.js"
    try:
        text = config_path.read_text(encoding="utf-8")
    except Exception:
        return Response("// config.js not found", status=404,
                        mimetype="application/javascript")
    token = load_mapbox_token() or ""
    text = text.replace("__MAPBOX_TOKEN__", token)
    text = text.replace("markerSettings: null,", "markerSettings: " + json.dumps(load_marker_settings(), ensure_ascii=True) + ",")
    return Response(text, mimetype="application/javascript",
                    headers={"Cache-Control": "no-store"})


@app.route("/video_feed")
def video_feed():
    quality = max(40, min(95, int(request.args.get("q", "75"))))
    encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), quality]

    def stream():
        last_seq = -1
        while not shutdown_event.is_set():
            with frame_lock:
                seq = int(latest_frame_seq)
                have_frame = latest_frame is not None

            if not have_frame or seq == last_seq:
                time.sleep(0.005)
                continue
            last_seq = seq

            # Encode this frame's JPEG once and share it across all connected
            # clients. The first client to reach a new seq encodes it under the
            # cache lock; others on the same seq/quality reuse the bytes.
            with video_feed_lock:
                if video_feed_cache["seq"] == seq and video_feed_cache["quality"] == quality:
                    data = video_feed_cache["data"]
                else:
                    with frame_lock:
                        frame = None if latest_frame is None else latest_frame.copy()
                    if frame is None:
                        continue
                    ok, jpg = cv2.imencode(".jpg", frame, encode_params)
                    if not ok:
                        continue
                    data = jpg.tobytes()
                    video_feed_cache.update({"seq": seq, "quality": quality, "data": data})

            if data is None:
                continue

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Cache-Control: no-store\r\n\r\n" + data + b"\r\n"
            )

    return Response(
        stream_with_context(stream()),
        mimetype="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache"},
    )


class RecordingIndicator:
    def __init__(self, size=18, margin=18):
        self.size = int(size)
        self.margin = int(margin)
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        if os.name != "nt":
            return
        if self.thread is not None and self.thread.is_alive():
            if self.stop_event.is_set():
                self.thread.join(timeout=0.3)
            if self.thread is not None and self.thread.is_alive():
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
        canvas = None
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
            y = max(0, self.margin)
            root.geometry(f"{self.size}x{self.size}+{x}+{y}")

            canvas = tk.Canvas(root, width=self.size, height=self.size, bg="black", highlightthickness=0, bd=0)
            canvas.pack(fill="both", expand=True)
            inset = 2
            canvas.create_oval(inset, inset, self.size - inset, self.size - inset, fill="#e11d2f", outline="#8a0d19")

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
            # Tear down Tk on the same thread that created it so the Tcl
            # interpreter and its async handlers are released here, not later
            # on the main thread during GC. Python 3.13 raises
            # "Tcl_AsyncDelete: async handler deleted by the wrong thread"
            # when the interpreter is finalised off-thread.
            if root is not None:
                try:
                    root.destroy()
                except Exception:
                    pass
            del canvas
            del root


class CameraVoiceRecorder:
    def __init__(
        self,
        fps=20.0,
        audio_device=None,
        output_format="mp4",
        keep_raw=False,
        segment_seconds=300.0,
        show_indicator=True,
    ):
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
        self.mp4_path = None
        self.metadata_path = None
        self.segments = []
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
        # Screen capture (the whole monitor) recorded alongside the camera, via mss.
        self.screen_thread = None
        self.screen_path = None
        self.screen_mp4_path = None
        self.screen_frames = 0
        self.screen_width = 0
        self.screen_height = 0
        self.screen_error = ""
        self.screen_started_at = 0.0   # wall-clock span of the capture loop, so we can
        self.screen_ended_at = 0.0     # re-encode at the REAL achieved fps (stays in sync)
        self.screen_real_fps = 0.0

    def is_recording(self):
        with self.lock:
            return bool(self.recording)

    def start(self):
        with self.lock:
            if self.recording:
                return False, "already_recording"

            with frame_lock:
                frame = None if latest_frame is None else latest_frame.copy()
            if frame is None:
                return False, "no_camera_frame"

            height, width = frame.shape[:2]
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            session_dir = BACKEND_RECORDINGS_DIR / f"recording_{timestamp}"
            suffix = 1
            while session_dir.exists():
                suffix += 1
                session_dir = BACKEND_RECORDINGS_DIR / f"recording_{timestamp}_{suffix}"
            session_dir.mkdir(parents=True, exist_ok=False)

            self.stop_event = threading.Event()
            self.session_dir = session_dir
            self.video_path = session_dir / "segment_0001_camera_feed.avi"
            self.audio_path = session_dir / "segment_0001_microphone.wav"
            self.mp4_path = session_dir / f"{session_dir.name}_part001.mp4"
            self.metadata_path = session_dir / "metadata.json"
            self.screen_path = session_dir / "screen_feed.avi"
            self.screen_mp4_path = session_dir / f"{session_dir.name}_screen.mp4"
            self.segments = []
            self.video_segment_frames = {}
            self.audio_segment_bytes = {}
            self.started_at = time.time()
            self.started_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.started_at))
            self.video_frames = 0
            self.video_width = int(width)
            self.video_height = int(height)
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
            self._start_audio_locked()
            if self.show_indicator:
                self.indicator.start()

            print(f"[Recorder] Started camera+voice recording: {session_dir}", flush=True)
            return True, str(session_dir)

    def _segment_index_for_time(self, timestamp):
        elapsed = max(0.0, float(timestamp) - float(self.started_at or timestamp))
        return int(elapsed // self.segment_seconds) + 1

    def _segment_name(self, segment_index):
        return f"segment_{int(segment_index):04d}"

    def _segment_paths(self, segment_index):
        if self.session_dir is None:
            return None, None, None
        name = self._segment_name(segment_index)
        return (
            self.session_dir / f"{name}_camera_feed.avi",
            self.session_dir / f"{name}_microphone.wav",
            self.session_dir / f"{name}.mp4",
        )

    def _start_audio_locked(self):
        try:
            import sounddevice as sd

            device = sd.query_devices(self.audio_device, kind="input")
            channels = int(min(2, max(1, int(device.get("max_input_channels") or 1))))
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
            self.audio_stream = sd.InputStream(
                device=self.audio_device,
                samplerate=samplerate,
                channels=channels,
                dtype="int16",
                callback=self._audio_callback,
            )
            self.audio_stream.start()
            print(
                f"[Recorder] Microphone: {self.audio_device_info['name']} "
                f"({channels} ch, {samplerate} Hz)",
                flush=True,
            )
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
        if self.session_dir is None:
            return
        wav = None
        active_segment = None
        try:
            while self.stop_event is not None and (not self.stop_event.is_set() or not self.audio_queue.empty()):
                try:
                    captured_at, chunk = self.audio_queue.get(timeout=0.1)
                except queue.Empty:
                    continue

                segment_index = self._segment_index_for_time(captured_at)
                if active_segment != segment_index:
                    if wav is not None:
                        wav.close()
                        wav = None
                    _video_path, audio_path, _mp4_path = self._segment_paths(segment_index)
                    if audio_path is None:
                        continue
                    wav = wave.open(str(audio_path), "wb")
                    wav.setnchannels(int(self.audio_channels or 1))
                    wav.setsampwidth(2)
                    wav.setframerate(int(self.audio_samplerate or 44100))
                    active_segment = segment_index

                wav.writeframes(chunk)
                self.audio_bytes += len(chunk)
                self.audio_segment_bytes[segment_index] = self.audio_segment_bytes.get(segment_index, 0) + len(chunk)
                samples = np.frombuffer(chunk, dtype=np.int16)
                if samples.size:
                    sample_values = samples.astype(np.int64)
                    self.audio_peak = max(self.audio_peak, int(np.max(np.abs(sample_values))))
                    self.audio_square_sum += int(np.sum(sample_values * sample_values))
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
            frame_index = 0
            next_frame_at = time.time()
            frame_interval = 1.0 / self.fps
            while self.stop_event is not None and not self.stop_event.is_set():
                captured_at = time.time()
                segment_index = self._segment_index_for_time(captured_at)
                if active_segment != segment_index:
                    if writer is not None:
                        writer.release()
                        writer = None
                    video_path, _audio_path, _mp4_path = self._segment_paths(segment_index)
                    if video_path is None:
                        raise RuntimeError("missing_video_segment_path")
                    writer = cv2.VideoWriter(
                        str(video_path),
                        fourcc,
                        self.fps,
                        (int(self.video_width), int(self.video_height)),
                    )
                    if not writer.isOpened():
                        raise RuntimeError("video_writer_open_failed")
                    active_segment = segment_index

                with frame_lock:
                    frame = None if latest_frame is None else latest_frame.copy()
                if frame is not None:
                    if frame.shape[1] != self.video_width or frame.shape[0] != self.video_height:
                        frame = cv2.resize(frame, (self.video_width, self.video_height), interpolation=cv2.INTER_AREA)
                    writer.write(frame)
                    frame_index += 1
                    self.video_frames = frame_index
                    self.video_segment_frames[segment_index] = self.video_segment_frames.get(segment_index, 0) + 1

                next_frame_at += frame_interval
                time.sleep(max(0.001, next_frame_at - time.time()))
        except Exception as exc:
            print(f"[Recorder] Video recording failed: {exc}", flush=True)
        finally:
            if writer is not None:
                writer.release()

    def _screen_loop(self):
        """Capture the whole monitor alongside the camera (no browser prompt). Writes a
        true CONSTANT-rate MJPG .avi at the recorder fps, anchored to wall-clock: each
        time-slot gets a frame and slow grabs duplicate the latest frame to fill the
        gap. This keeps the screen video genuinely real-time so it stays in sync with
        the camera + audio everywhere (no fast playback / mid-drift). Best-effort — if
        screen grab isn't available it just records nothing and notes the error."""
        try:
            import mss  # captures the primary monitor
        except Exception as exc:
            self.screen_error = "mss_unavailable: " + str(exc)
            print(f"[Recorder] Screen capture disabled: {exc}", flush=True)
            return
        writer = None
        try:
            mss_open = getattr(mss, "MSS", None) or mss.mss   # newer API is mss.MSS
            with mss_open() as sct:
                monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
                self.screen_width = int(monitor["width"])
                self.screen_height = int(monitor["height"])
                fourcc = cv2.VideoWriter_fourcc(*"MJPG")
                writer = cv2.VideoWriter(str(self.screen_path), fourcc, self.fps,
                                         (self.screen_width, self.screen_height))
                if not writer.isOpened():
                    raise RuntimeError("screen_writer_open_failed")
                start = time.time()
                self.screen_started_at = start
                written = 0                                   # frames written so far
                while self.stop_event is not None and not self.stop_event.is_set():
                    shot = sct.grab(monitor)
                    frame = np.array(shot)[:, :, :3]          # BGRA → BGR (cv2 order)
                    if frame.shape[1] != self.screen_width or frame.shape[0] != self.screen_height:
                        frame = cv2.resize(frame, (self.screen_width, self.screen_height), interpolation=cv2.INTER_AREA)
                    # Fill every time-slot that is due by now with the latest grab. Slow
                    # grabs duplicate it (holds the image) so frame N always lands at
                    # wall-clock N/fps — the stream stays exactly real-time.
                    target = int((time.time() - start) * self.fps)
                    if target <= written:
                        target = written + 1                  # always advance ≥1 slot
                    while written < target:
                        writer.write(frame)
                        written += 1
                    self.screen_frames = written
                    # pace to the next slot boundary so we re-grab fresh, not busy-spin
                    sleep = (start + written / self.fps) - time.time()
                    if sleep > 0:
                        time.sleep(min(sleep, 1.0 / self.fps))
        except Exception as exc:
            self.screen_error = str(exc)
            print(f"[Recorder] Screen recording failed: {exc}", flush=True)
        finally:
            self.screen_ended_at = time.time()
            if writer is not None:
                writer.release()

    def _find_ffmpeg(self):
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            return ffmpeg
        try:
            import imageio_ffmpeg  # type: ignore
        except ImportError:
            return None
        return imageio_ffmpeg.get_ffmpeg_exe()

    def _write_mp4(self, video_path, audio_path, output_path, input_fps=None):
        if video_path is None or not video_path.exists() or output_path is None:
            return False, "missing_video"

        ffmpeg = self._find_ffmpeg()
        if not ffmpeg:
            return False, "ffmpeg_not_found"

        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostats",
            "-nostdin",
            "-y",
        ]
        # input_fps re-times the source frames to the REAL captured rate (used for the
        # screen video, whose grab loop can't always hit the nominal fps) so playback
        # duration matches wall-clock and stays in sync with the camera.
        if input_fps and float(input_fps) > 0:
            command.extend(["-r", f"{float(input_fps):.4f}"])
        command.extend(["-i", str(video_path)])
        has_audio = audio_path is not None and audio_path.exists() and audio_path.stat().st_size > 44
        if has_audio:
            command.extend(["-i", str(audio_path), "-map", "0:v:0", "-map", "1:a:0", "-shortest"])
        else:
            command.extend(["-map", "0:v:0"])

        command.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
            ]
        )
        if has_audio:
            command.extend(["-c:a", "aac", "-b:a", "128k"])
        command.extend(["-movflags", "+faststart", str(output_path)])

        result = subprocess.run(command, text=True, capture_output=True)
        if result.returncode != 0:
            if output_path.exists():
                try:
                    output_path.unlink()
                except Exception:
                    pass
            detail = (result.stderr or result.stdout or "").strip().splitlines()
            return False, detail[-1] if detail else f"ffmpeg_exit_{result.returncode}"
        return True, ""

    def _remove_raw_streams(self, video_path, audio_path):
        for path in (video_path, audio_path):
            if path is None or not path.exists():
                continue
            try:
                path.unlink()
            except Exception as exc:
                print(f"[Recorder] Could not remove raw stream {path}: {exc}", flush=True)

    def _discover_segments(self):
        if self.session_dir is None:
            return []
        segment_indexes = set()
        pattern = re.compile(r"^segment_(\d{4})_(?:camera_feed\.avi|microphone\.wav)$")
        for path in self.session_dir.iterdir():
            match = pattern.match(path.name)
            if match:
                segment_indexes.add(int(match.group(1)))

        segments = []
        for segment_index in sorted(segment_indexes):
            video_path, audio_path, mp4_path = self._segment_paths(segment_index)
            if video_path is None or audio_path is None or mp4_path is None:
                continue
            has_video = video_path.exists() and video_path.stat().st_size > 0
            has_audio = audio_path.exists() and audio_path.stat().st_size > 44
            segments.append(
                {
                    "index": segment_index,
                    "videoPath": video_path,
                    "audioPath": audio_path,
                    "mp4Path": mp4_path,
                    "hasVideo": has_video,
                    "hasAudio": has_audio,
                    "videoFrames": int(self.video_segment_frames.get(segment_index, 0)),
                    "audioBytes": int(self.audio_segment_bytes.get(segment_index, 0)),
                }
            )
        return segments

    def _finalize_segments(self, segments, output_format, keep_raw):
        finalized = []
        for segment in segments:
            video_path = segment["videoPath"]
            audio_path = segment["audioPath"]
            mp4_path = segment["mp4Path"]
            output_file = ""
            output_error = ""

            if output_format == "mp4" and segment["hasVideo"]:
                ok, output_error = self._write_mp4(video_path, audio_path if segment["hasAudio"] else None, mp4_path)
                if ok:
                    output_file = mp4_path.name
                    print(f"[Recorder] Created MP4 segment: {mp4_path}", flush=True)
                    if not keep_raw:
                        self._remove_raw_streams(video_path, audio_path)
                else:
                    print(f"[Recorder] MP4 segment creation failed: {output_error}", flush=True)

            finalized.append(
                {
                    "index": int(segment["index"]),
                    "video": str(video_path.name if video_path.exists() else ""),
                    "audio": str(audio_path.name if audio_path.exists() else ""),
                    "mp4": output_file,
                    "frames": int(segment["videoFrames"]),
                    "audioBytes": int(segment["audioBytes"]),
                    "error": output_error,
                }
            )
        return finalized

    def stop(self):
        with self.lock:
            if not self.recording:
                return None, "not_recording"
            stop_event = self.stop_event
            video_thread = self.video_thread
            audio_thread = self.audio_thread
            audio_stream = self.audio_stream
            session_dir = self.session_dir
            started_at = self.started_at
            started_iso = self.started_iso
            metadata_path = self.metadata_path
            video_path = self.video_path
            audio_path = self.audio_path
            mp4_path = self.mp4_path
            screen_thread = self.screen_thread
            screen_path = self.screen_path
            screen_mp4_path = self.screen_mp4_path
            output_format = self.output_format
            keep_raw = self.keep_raw
            stop_event.set()

        if audio_stream is not None:
            try:
                audio_stream.stop()
                audio_stream.close()
            except Exception as exc:
                self.audio_error = str(exc)

        if video_thread is not None:
            video_thread.join(timeout=3.0)
        if audio_thread is not None:
            audio_thread.join(timeout=3.0)
        if screen_thread is not None:
            screen_thread.join(timeout=3.0)
        self.indicator.stop()

        # Convert the screen .avi → .mp4 (video-only). The loop already wrote a true
        # real-time CFR stream at self.fps (slow grabs were filled by duplication), so
        # encode at the nominal fps — no rate guessing needed.
        screen_mp4 = ""
        self.screen_real_fps = float(self.fps)
        if screen_path is not None and screen_path.exists() and self.screen_frames > 0:
            ok, err = self._write_mp4(screen_path, None, screen_mp4_path)
            if ok:
                screen_mp4 = str(screen_mp4_path)
                if not keep_raw:
                    try:
                        screen_path.unlink()
                    except Exception:
                        pass
            elif not self.screen_error:
                self.screen_error = err

        stopped_at = time.time()
        stopped_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stopped_at))
        audio_rms = math.sqrt(self.audio_square_sum / self.audio_sample_count) if self.audio_sample_count else 0.0
        audio_silent = self.audio_bytes > 0 and self.audio_peak <= 1 and audio_rms < 1.0
        discovered_segments = self._discover_segments()
        finalized_segments = self._finalize_segments(discovered_segments, output_format, keep_raw)
        mp4_files = [segment["mp4"] for segment in finalized_segments if segment.get("mp4")]
        output_errors = [segment["error"] for segment in finalized_segments if segment.get("error")]

        metadata = {
            "startedAt": started_iso,
            "stoppedAt": stopped_iso,
            "durationSeconds": round(max(0.0, stopped_at - started_at), 3),
            "source": camera_source,
            "output": {
                "format": "mp4_segments" if mp4_files else "raw_segments",
                "file": str(mp4_files[0] if len(mp4_files) == 1 else ""),
                "files": mp4_files,
                "segmentSeconds": round(float(self.segment_seconds), 3),
                "error": "; ".join(output_errors),
            },
            "video": {
                "file": str(video_path.name if video_path and video_path.exists() else ""),
                "fps": self.fps,
                "frames": int(self.video_frames),
                "width": int(self.video_width),
                "height": int(self.video_height),
            },
            "screen": {
                "file": (Path(screen_mp4).name if screen_mp4 else ""),
                "captured": bool(self.screen_frames > 0),
                "fps": round(float(self.screen_real_fps), 3),     # the REAL encoded rate (sync)
                "nominalFps": self.fps,
                "frames": int(self.screen_frames),
                "width": int(self.screen_width),
                "height": int(self.screen_height),
                "error": self.screen_error,
            },
            "audio": {
                "file": str(audio_path.name if audio_path and audio_path.exists() else ""),
                "captured": bool(self.audio_bytes > 0),
                "channels": int(self.audio_channels),
                "sampleRate": int(self.audio_samplerate),
                "bytes": int(self.audio_bytes),
                "device": self.audio_device_info,
                "peak": int(self.audio_peak),
                "rms": round(float(audio_rms), 3),
                "silent": bool(audio_silent),
                "error": self.audio_error,
            },
            "segments": finalized_segments,
        }
        try:
            metadata_path.write_text(json.dumps(metadata, ensure_ascii=True, indent=2), encoding="utf-8")
        except Exception as exc:
            print(f"[Recorder] Metadata write failed: {exc}", flush=True)

        with self.lock:
            self.recording = False
            self.stop_event = None
            self.video_thread = None
            self.audio_thread = None
            self.screen_thread = None
            self.audio_stream = None
            self.audio_queue = None

        if audio_silent:
            print(
                "[Recorder] Warning: microphone file contains near-silence. "
                "Check the selected input device or microphone mute/level.",
                flush=True,
            )
        print(f"[Recorder] Saved recording: {session_dir}", flush=True)
        return {"directory": str(session_dir), **metadata}, None


def _message_box(title, message, flags):
    if os.name != "nt":
        print(f"[Recorder] {title}: {message}", flush=True)
        return 1
    return ctypes.windll.user32.MessageBoxW(None, str(message), str(title), int(flags))


def _show_recorder_info(message):
    # Show on a background thread so the hotkey message pump stays responsive.
    # Otherwise the modal MessageBoxW blocks WM_HOTKEY delivery and the next
    # Ctrl+Shift+R press is silently swallowed.
    threading.Thread(
        target=_message_box,
        args=("Camera Recorder", message, 0x40),
        daemon=True,
    ).start()
    print(f"[Recorder] {message}", flush=True)


def _handle_recording_hotkey(recorder):
    if recorder.is_recording():
        # Toggle directly — no confirmation dialog. A blocking confirmation
        # would freeze the hotkey thread and make the toggle feel unreliable.
        result, error = recorder.stop()
        if error:
            _show_recorder_info(f"Recording could not stop: {error}")
            return
        output = result.get("output") or {}
        saved_files = output.get("files") or []
        saved_file = output.get("file") or (saved_files[0] if len(saved_files) == 1 else "")
        if len(saved_files) > 1:
            _show_recorder_info(f"Recording saved:\n{result.get('directory')}\n{len(saved_files)} MP4 parts")
        elif saved_file:
            _show_recorder_info(f"Recording saved:\n{result.get('directory')}\\{saved_file}")
        else:
            detail = output.get("error") or result.get("directory")
            _show_recorder_info(f"Recording saved as raw streams:\n{detail}")
        return

    ok, detail = recorder.start()
    if ok:
        _show_recorder_info("Camera and microphone recording started.\nPress Ctrl+Shift+R again to stop and save.")
    else:
        _show_recorder_info(f"Recording could not start: {detail}")


def start_recording_hotkey(recorder):
    if os.name != "nt":
        print("[Recorder] Ctrl+Shift+R hotkey is only enabled on Windows.", flush=True)
        return None

    def hotkey_loop():
        user32 = ctypes.windll.user32
        hotkey_id = 0x524543
        mod_control = 0x0002
        mod_shift = 0x0004
        mod_norepeat = 0x4000
        vk_r = 0x52
        wm_hotkey = 0x0312
        if not user32.RegisterHotKey(None, hotkey_id, mod_control | mod_shift | mod_norepeat, vk_r):
            print("[Recorder] Could not register Ctrl+Shift+R hotkey.", flush=True)
            return
        print("[Recorder] Ctrl+Shift+R starts/stops backend camera+voice recording.", flush=True)
        msg = ctypes.wintypes.MSG()
        try:
            while not shutdown_event.is_set():
                result = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if result in (0, -1):
                    break
                if msg.message == wm_hotkey and msg.wParam == hotkey_id:
                    _handle_recording_hotkey(recorder)
        finally:
            user32.UnregisterHotKey(None, hotkey_id)

    thread = threading.Thread(target=hotkey_loop, daemon=True)
    thread.start()
    return thread


@app.route("/api/tags")
def api_tags():
    return jsonify(build_tags_payload())


def _camera_base_url():
    src = camera_source or ""
    if not src.startswith("http"):
        return None
    from urllib.parse import urlparse
    p = urlparse(src)
    if not p.scheme or not p.netloc:
        return None
    return f"{p.scheme}://{p.netloc}"


# Candidate IP Webcam endpoints. We GET each one without a ?set= query and
# treat HTTP 200 as "this build exposes the knob". The body snippet helps the
# user see which return live values vs. just an HTML form.
_CAMERA_PROBE_ENDPOINTS = [
    "settings/manual_sensor",
    "settings/iso",
    "settings/exposure",        # EV bias (-3..+3) on most builds
    "settings/exposure_ns",     # manual exposure time, requires manual_sensor=on
    "settings/contrast",
    "settings/brightness",
    "settings/saturation",
    "settings/whitebalance",
    "settings/wb_temperature",
    "settings/scenemode",
    "settings/focusmode",
    "settings/focus_distance",
    "settings/zoom",
    "settings/quality",
    "settings/torch",
    "sensor.json",
    "status.json",
]


_UVC_PROBE_PROPS = [
    ("brightness",      "CAP_PROP_BRIGHTNESS"),
    ("contrast",        "CAP_PROP_CONTRAST"),
    ("saturation",      "CAP_PROP_SATURATION"),
    ("hue",             "CAP_PROP_HUE"),
    ("gain",            "CAP_PROP_GAIN"),
    ("exposure",        "CAP_PROP_EXPOSURE"),
    ("auto_exposure",   "CAP_PROP_AUTO_EXPOSURE"),
    ("gamma",           "CAP_PROP_GAMMA"),
    ("sharpness",       "CAP_PROP_SHARPNESS"),
    ("backlight",       "CAP_PROP_BACKLIGHT"),
    ("wb_temperature",  "CAP_PROP_WB_TEMPERATURE"),
    ("auto_wb",         "CAP_PROP_AUTO_WB"),
    ("focus",           "CAP_PROP_FOCUS"),
    ("autofocus",       "CAP_PROP_AUTOFOCUS"),
    ("zoom",            "CAP_PROP_ZOOM"),
    ("pan",             "CAP_PROP_PAN"),
    ("tilt",            "CAP_PROP_TILT"),
    ("iris",            "CAP_PROP_IRIS"),
]


def _probe_uvc_camera():
    cap = camera
    if cap is None:
        return {"ok": False, "error": "camera_not_initialized"}

    backend = ""
    try:
        backend = str(cap.getBackendName())
    except Exception:
        pass

    props = {}
    supported = []
    for friendly, attr in _UVC_PROBE_PROPS:
        prop_id = getattr(cv2, attr, None)
        if prop_id is None:
            props[friendly] = {"status": "missing_in_cv2", "value": None}
            continue
        try:
            value = float(cap.get(prop_id))
        except Exception as e:
            props[friendly] = {"status": "error", "value": None, "error": str(e)}
            continue
        # OpenCV returns -1.0 for unsupported on most backends; some return 0
        # for "supported but currently zero", which is ambiguous. We surface
        # the raw value and flag negatives as likely-unsupported.
        likely_supported = value > -0.5
        props[friendly] = {
            "status": "supported" if likely_supported else "unsupported",
            "value": value,
            "prop": attr,
        }
        if likely_supported:
            supported.append(friendly)

    return {
        "ok": True,
        "kind": "uvc",
        "source": camera_source,
        "backend": backend,
        "supported": sorted(supported),
        "props": props,
    }


@app.route("/api/camera/probe")
def api_camera_probe():
    base = _camera_base_url()
    if not base:
        return jsonify(_probe_uvc_camera())

    import urllib.request
    import urllib.error

    def hit(name):
        url = f"{base}/{name}"
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                body = resp.read(400)
                try:
                    text = body.decode("utf-8", errors="replace")
                except Exception:
                    text = repr(body)
                return name, {"status": resp.status, "ok": 200 <= resp.status < 300, "body": text}
        except urllib.error.HTTPError as e:
            return name, {"status": e.code, "ok": False, "body": str(e)}
        except Exception as e:
            return name, {"status": None, "ok": False, "error": str(e)}

    results = {}
    with ThreadPoolExecutor(max_workers=min(8, len(_CAMERA_PROBE_ENDPOINTS))) as pool:
        futures = [pool.submit(hit, name) for name in _CAMERA_PROBE_ENDPOINTS]
        for fut in as_completed(futures):
            name, info = fut.result()
            results[name] = info

    supported = sorted([n for n, info in results.items() if info.get("ok")])
    return jsonify({
        "ok": True,
        "kind": "ip_webcam",
        "base": base,
        "supported": supported,
        "endpoints": results,
    })


# ── live camera controls (focus / zoom / exposure / resolution) ──────────────
# IP Webcam: GET {base}/settings/<name>?set=<value>. UVC webcam: cap.set(CAP_PROP).
# Ranges are best-effort defaults — the IP Webcam app clamps to what the device
# supports. Resolution reconnects the stream so OpenCV picks up the new size.
CAMERA_MANUAL_ISO = 100                      # ISO pinned during manual exposure
CAMERA_FOCUS_AF_MODE = "continuous-video"    # focusmode value that restores autofocus
CAMERA_CONTROLS = {
    "exposureAuto": {"label": "Auto exposure", "type": "toggle", "default": 1},
    # step 1 / min 1 so the short exposures the tag detector likes are reachable:
    # 8 ms looks near-black to the eye but gives the decoder crisp, motion-free
    # tag edges under a projector, which is why it's the default.
    "exposure":     {"label": "Exposure (ms)", "type": "range", "min": 1, "max": 300, "step": 1, "default": 8, "uvc": "CAP_PROP_EXPOSURE"},
    "focusAuto":    {"label": "Autofocus",     "type": "toggle", "default": 1},
    "focus":        {"label": "Focus", "type": "range", "min": 0.5, "max": 3, "step": 0.1, "default": 1, "ip": "focus_distance", "uvc": "CAP_PROP_FOCUS"},
    "resolution":   {"label": "Resolution",    "type": "select", "default": "1920x1080",
                     "options": ["640x480", "1280x720", "1920x1080"], "ip": "video_size"},
}
camera_control_values = {key: meta.get("default") for key, meta in CAMERA_CONTROLS.items()}


def _ip_cam_set(query):
    """GET {base}/{query} and report what happened (status) so camera-control
    requests are diagnosable instead of silent. Returns a dict."""
    base = _camera_base_url()
    if not base:
        return {"url": query, "ok": False, "error": "no_ip_base"}
    import urllib.request
    import urllib.error
    url = f"{base}/{query}"
    try:
        with urllib.request.urlopen(url, timeout=2.0) as resp:
            status = int(resp.status)
            print(f"[Camera] GET {url} -> {status}", flush=True)
            return {"url": url, "ok": 200 <= status < 300, "status": status}
    except urllib.error.HTTPError as exc:
        print(f"[Camera] GET {url} -> HTTP {exc.code}", flush=True)
        return {"url": url, "ok": False, "status": int(exc.code)}
    except Exception as exc:
        print(f"[Camera] GET {url} failed: {exc}", flush=True)
        return {"url": url, "ok": False, "error": str(exc)}


def _ip_cam_status():
    """Fetch the IP Webcam /status.json 'curvals' (current device settings), or None."""
    base = _camera_base_url()
    if not base:
        return None
    import urllib.request
    try:
        with urllib.request.urlopen(f"{base}/status.json", timeout=2.0) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
        cur = data.get("curvals") if isinstance(data, dict) else None
        return cur if isinstance(cur, dict) else None
    except Exception:
        return None


def apply_camera_control(name, value):
    """Returns (ok, result, requests) — requests is the list of IP-cam GETs made,
    each with its URL + HTTP status, for diagnosis."""
    meta = CAMERA_CONTROLS.get(name)
    if not meta:
        return False, "unknown_control", []
    base = _camera_base_url()
    reqs = []

    if name == "resolution":
        size = str(value or "").lower().replace(" ", "")
        if "x" not in size:
            return False, "invalid_value", reqs
        if base:
            reqs.append(_ip_cam_set(f"settings/{meta['ip']}?set={size}"))
            if camera_source:
                init_camera(camera_source)   # reconnect so the new size takes effect
        elif camera is not None:
            try:
                w, h = (int(v) for v in size.split("x"))
                camera.set(cv2.CAP_PROP_FRAME_WIDTH, w)
                camera.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
            except Exception:
                return False, "set_failed", reqs
        else:
            return False, "no_camera", reqs
        camera_control_values[name] = size
        return True, size, reqs

    try:
        num = float(value)
    except (TypeError, ValueError):
        return False, "invalid_value", reqs

    def set_manual_exposure(ms):
        ns = int(ms * 1e6)
        reqs.append(_ip_cam_set("settings/manual_sensor?set=on"))
        reqs.append(_ip_cam_set(f"settings/iso?set={CAMERA_MANUAL_ISO}"))
        reqs.append(_ip_cam_set(f"settings/exposure_ns?set={ns}"))
        # frame_duration caps exposure: at 30 fps it's 33 ms, so a longer exposure_ns
        # never takes effect (why 40 ms looked dark). Lengthen it to match — this also
        # drops FPS for very long exposures.
        reqs.append(_ip_cam_set(f"settings/frame_duration?set={ns}"))

    if name == "exposureAuto":
        # Auto = native metering (manual_sensor off, the recovery path); manual =
        # re-assert ISO + the current exposure ms.
        auto = int(round(num)) != 0
        if base:
            if auto:
                reqs.append(_ip_cam_set("settings/manual_sensor?set=off"))
            else:
                set_manual_exposure(float(camera_control_values["exposure"]))
        camera_control_values[name] = 1 if auto else 0
        return True, (1 if auto else 0), reqs

    if name == "exposure":
        if base:
            set_manual_exposure(num)
            camera_control_values["exposureAuto"] = 0   # moving the slider implies manual
        elif camera is not None:
            prop = getattr(cv2, "CAP_PROP_EXPOSURE", None)
            if prop is not None:
                try:
                    camera.set(prop, num)
                except Exception:
                    return False, "set_failed", reqs
        else:
            return False, "no_camera", reqs
        camera_control_values[name] = num
        return True, num, reqs

    if name == "focusAuto":
        auto = int(round(num)) != 0
        if base:
            if auto:
                reqs.append(_ip_cam_set(f"settings/focusmode?set={CAMERA_FOCUS_AF_MODE}"))
            else:
                reqs.append(_ip_cam_set("settings/focusmode?set=off"))
                reqs.append(_ip_cam_set(f"settings/focus_distance?set={float(camera_control_values['focus'])}"))
        camera_control_values[name] = 1 if auto else 0
        return True, (1 if auto else 0), reqs

    if name == "focus":
        # focus_distance (diopters; 0 = infinity) only applies with autofocus OFF.
        if base:
            reqs.append(_ip_cam_set("settings/focusmode?set=off"))
            reqs.append(_ip_cam_set(f"settings/focus_distance?set={num}"))
            camera_control_values["focusAuto"] = 0   # moving the slider implies manual
        elif camera is not None:
            prop = getattr(cv2, "CAP_PROP_FOCUS", None)
            if prop is not None:
                try:
                    camera.set(prop, num)
                except Exception:
                    return False, "set_failed", reqs
        else:
            return False, "no_camera", reqs
        camera_control_values[name] = num
        return True, num, reqs

    # zoom (and any other generic numeric IP setting)
    if base:
        sval = int(num) if float(num).is_integer() else num
        reqs.append(_ip_cam_set(f"settings/{meta['ip']}?set={sval}"))
    elif camera is not None and meta.get("uvc"):
        prop = getattr(cv2, meta["uvc"], None)
        if prop is None:
            return False, "unsupported", reqs
        try:
            camera.set(prop, num)
        except Exception:
            return False, "set_failed", reqs
    else:
        return False, "no_camera", reqs
    camera_control_values[name] = num
    return True, num, reqs


@app.route("/api/camera/controls", methods=["GET"])
def api_camera_controls_get():
    base = _camera_base_url()
    kind = "ip" if base else ("uvc" if camera is not None else "none")

    # Reflect the IP cam's actual current state so the sliders/toggles aren't stale.
    if base:
        cur = _ip_cam_status()
        if cur:
            try:
                if "exposure_ns" in cur:
                    camera_control_values["exposure"] = max(1, min(300, int(round(float(cur["exposure_ns"]) / 1e6))))
                if "manual_sensor" in cur:
                    camera_control_values["exposureAuto"] = 0 if str(cur["manual_sensor"]).lower() == "on" else 1
                if "focus_distance" in cur:
                    camera_control_values["focus"] = max(0.5, min(3.0, float(cur["focus_distance"])))
                if "focusmode" in cur:
                    camera_control_values["focusAuto"] = 0 if str(cur["focusmode"]).lower() == "off" else 1
                if "video_size" in cur:
                    camera_control_values["resolution"] = str(cur["video_size"])
            except (TypeError, ValueError):
                pass

    controls = []
    for key, meta in CAMERA_CONTROLS.items():
        c = {"key": key, "label": meta["label"], "type": meta["type"],
             "value": camera_control_values.get(key, meta.get("default")),
             "default": meta.get("default")}
        if meta["type"] == "range":
            c.update({"min": meta["min"], "max": meta["max"], "step": meta["step"]})
        elif meta["type"] == "select":
            opts = list(meta.get("options", []))
            cur_res = camera_control_values.get(key)
            if cur_res and cur_res not in opts:   # include the device's current size
                opts = [cur_res] + opts
            c["options"] = opts
        controls.append(c)
    return jsonify({"ok": True, "kind": kind, "controls": controls})


@app.route("/api/camera/control", methods=["POST"])
def api_camera_control_set():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "")
    if name not in CAMERA_CONTROLS:
        return jsonify({"ok": False, "error": "unknown_control"}), 400
    ok, result, reqs = apply_camera_control(name, payload.get("value"))
    # Always 200 so the `requests` list (URLs + statuses) is inspectable in DevTools.
    return jsonify({"ok": bool(ok), "name": name,
                    "value": result if ok else None,
                    "error": None if ok else result,
                    "requests": reqs})


@app.route("/api/tutorial-mask", methods=["POST"])
def api_tutorial_mask_set():
    """The expo tutorial posts the video's on-screen rect (uv, 0..1) + active flag so
    the detection loop can blank that region (the clip contains AprilTags). POST with
    active:false (or no rect) clears it."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    active = bool(payload.get("active"))
    rect = payload.get("rect")
    parsed = None
    if active and isinstance(rect, dict):
        try:
            u0 = max(0.0, min(1.0, float(rect["u0"])))
            v0 = max(0.0, min(1.0, float(rect["v0"])))
            u1 = max(0.0, min(1.0, float(rect["u1"])))
            v1 = max(0.0, min(1.0, float(rect["v1"])))
            if u1 > u0 and v1 > v0:
                parsed = {"u0": u0, "v0": v0, "u1": u1, "v1": v1}
        except (KeyError, TypeError, ValueError):
            parsed = None
    with tutorial_mask_lock:
        tutorial_mask["active"] = bool(active and parsed is not None)
        tutorial_mask["rect"] = parsed
    return jsonify({"ok": True, "active": tutorial_mask["active"], "rect": tutorial_mask["rect"]})


@app.route("/api/tutorial-mask", methods=["DELETE"])
def api_tutorial_mask_clear():
    with tutorial_mask_lock:
        tutorial_mask["active"] = False
        tutorial_mask["rect"] = None
    return jsonify({"ok": True})


@app.route("/api/corners", methods=["GET"])
def api_corners_get():
    return jsonify({"corners": snapshot_corners()})


@app.route("/api/corners", methods=["DELETE"])
def api_corners_reset():
    global surface_corners
    with corners_lock:
        surface_corners = [None, None, None, None]
    return jsonify({"ok": True, "corners": snapshot_corners()})


@app.route("/api/corners", methods=["POST"])
def api_corners_set():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_json"}), 400

    idx = payload.get("index")
    x = payload.get("x")
    y = payload.get("y")
    if not isinstance(idx, int) or idx < 0 or idx > 3:
        return jsonify({"ok": False, "error": "invalid_index"}), 400
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return jsonify({"ok": False, "error": "invalid_point"}), 400

    with frame_lock:
        fw = int(latest_frame_width)
        fh = int(latest_frame_height)
    if fw > 0 and fh > 0:
        x = float(max(0, min(fw - 1, float(x))))
        y = float(max(0, min(fh - 1, float(y))))
    else:
        x = float(x)
        y = float(y)

    with corners_lock:
        surface_corners[idx] = {"x": x, "y": y}

    return jsonify({"ok": True, "corners": snapshot_corners()})


@app.route("/api/auto-corners", methods=["GET"])
def api_auto_corners_get():
    return jsonify({"ok": True, "enabled": bool(auto_corners_enabled)})


@app.route("/api/auto-corners", methods=["POST"])
def api_auto_corners_set():
    global auto_corners_enabled
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or "enabled" not in payload:
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    auto_corners_enabled = bool(payload.get("enabled"))
    return jsonify({"ok": True, "enabled": auto_corners_enabled})


@app.route("/api/auto-calibrate/layout", methods=["GET"])
def api_auto_calibrate_layout():
    # Single source of truth for the projected grid: the frontend renders each
    # tag box at (cx, cy) +/- size/2 in this same canvas space, so detected and
    # target geometry stay in lock-step. Tags use the active marker family so
    # the running detector can decode them.
    w, h = CALIB_GRID_CANVAS
    tags = [
        {"id": int(tid), "cx": float(xf), "cy": float(yf)}
        for tid, xf, yf in CALIB_GRID_LAYOUT
    ]
    return jsonify({
        "ok": True,
        "canvas": [w, h],
        "tag_size": int(CALIB_GRID_TAG_SIZE),
        "family": marker_settings_family(),
        "tags": tags,
    })


@app.route("/api/auto-calibrate", methods=["GET"])
def api_auto_calibrate_get():
    with corners_lock:
        status = dict(grid_calib_status)
    status["corners"] = snapshot_corners()
    return jsonify({"ok": True, **status})


@app.route("/api/auto-calibrate", methods=["POST"])
def api_auto_calibrate_set():
    global grid_calib_enabled, grid_calib_candidates
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or "enabled" not in payload:
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    enabled = bool(payload.get("enabled"))
    with corners_lock:
        grid_calib_enabled = enabled
        grid_calib_candidates = []
        grid_calib_status.update({
            "active": enabled, "tags_found": 0, "stable": 0,
            "error": None, "done": False,
        })
    return jsonify({"ok": True, "enabled": enabled})


@app.route("/api/calibration", methods=["GET"])
def api_calibration_get():
    if not CALIBRATION_FILE.exists():
        return jsonify({"ok": False, "error": "not_found"}), 404
    try:
        parsed = json.loads(CALIBRATION_FILE.read_text(encoding="utf-8"))
        groups = normalize_calibration_payload(parsed)
        if groups is None:
            return jsonify({"ok": False, "error": "invalid_file"}), 400
        return jsonify({"ok": True, "groups": groups})
    except Exception:
        return jsonify({"ok": False, "error": "read_failed"}), 500


@app.route("/api/calibration", methods=["POST"])
def api_calibration_set():
    payload = request.get_json(silent=True)
    groups = normalize_calibration_payload(payload)
    if groups is None:
        return jsonify({"ok": False, "error": "invalid_offsets"}), 400
    try:
        CALIBRATION_FILE.write_text(
            json.dumps({"groups": groups}, ensure_ascii=True, indent=2),
            encoding="utf-8",
        )
        return jsonify({"ok": True, "path": CALIBRATION_FILE.name})
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500


@app.route("/api/session", methods=["POST"])
def api_session_save():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    SESSIONS_DIR.mkdir(exist_ok=True)
    # If the client passes a stable sessionId, reuse the same filename across
    # autosaves so a long-running session overwrites itself instead of
    # producing one snapshot file per autosave tick.
    session_id = sanitize_storage_name(payload.get("sessionId"), "")
    if session_id:
        filename = f"session_{session_id}.json"
    else:
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"session_{timestamp}.json"
    filepath = SESSIONS_DIR / filename
    try:
        filepath.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return jsonify({"ok": True, "filename": filename})
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500


@app.route("/api/expo-session", methods=["POST"])
def api_expo_session_save():
    """Record a telecom-hall expo session (one participant run) as JSON in
    sessions/expo/. The client passes a stable sessionId so autosaves (after each
    input) overwrite the same file in place rather than spawning one per tick."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    EXPO_SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    session_id = sanitize_storage_name(payload.get("sessionId"), "")
    if session_id:
        filename = f"expo_{session_id}.json"
    else:
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"expo_{timestamp}.json"
    filepath = EXPO_SESSIONS_DIR / filename
    try:
        filepath.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return jsonify({"ok": True, "filename": filename})
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500


@app.route("/api/timeline-session", methods=["POST"])
def api_timeline_session_save():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    TIMELINE_SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    # If the client passes a stable sessionId, reuse the same file across
    # autosaves so an in-progress timeline updates in place rather than
    # accumulating duplicate snapshots.
    session_id = sanitize_storage_name(payload.get("sessionId"), "")
    if session_id:
        filename = f"timeline_{session_id}.json"
    else:
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"timeline_{timestamp}.json"
    filepath = TIMELINE_SESSIONS_DIR / filename
    try:
        filepath.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return jsonify({"ok": True, "filename": filename})
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500


@app.route("/api/record", methods=["GET"])
def api_record_status():
    rec = camera_recorder
    return jsonify({"ok": True, "available": rec is not None,
                    "recording": bool(rec.is_recording()) if rec else False})


@app.route("/api/record", methods=["POST"])
def api_record_control():
    """Start/stop/toggle the backend camera+mic recorder (same instance the
    Ctrl+Shift+R hotkey uses). Lets the map page's Record button capture video."""
    rec = camera_recorder
    if rec is None:
        return jsonify({"ok": False, "error": "recorder_unavailable"}), 503
    action = str((request.get_json(silent=True) or {}).get("action", "toggle")).lower()
    if action == "toggle":
        action = "stop" if rec.is_recording() else "start"
    if action == "start":
        ok, detail = rec.start()
        if not ok:
            return jsonify({"ok": False, "recording": rec.is_recording(), "error": detail}), 409
        return jsonify({"ok": True, "recording": True, "directory": detail})
    if action == "stop":
        result, error = rec.stop()
        if error:
            return jsonify({"ok": False, "recording": rec.is_recording(), "error": error}), 409
        output = (result or {}).get("output") or {}
        files = output.get("files") or ([output["file"]] if output.get("file") else [])
        return jsonify({"ok": True, "recording": False,
                        "directory": (result or {}).get("directory", ""), "files": files})
    return jsonify({"ok": False, "error": "bad_action"}), 400


@app.route("/api/audio-chunk", methods=["POST"])
def api_audio_chunk_save():
    file_storage = request.files.get("audio")
    if file_storage is not None:
        blob = file_storage.read()
        content_type = str(file_storage.mimetype or request.content_type or "")
        original_name = str(file_storage.filename or "")
    else:
        blob = request.get_data(cache=False)
        content_type = str(request.content_type or "")
        original_name = ""

    if not blob:
        return jsonify({"ok": False, "error": "empty_audio"}), 400

    form = request.form if request.form else {}
    fallback_session = time.strftime("%Y%m%d_%H%M%S")
    controller_id = sanitize_storage_name(form.get("controllerId"), "")
    session_id = sanitize_storage_name(form.get("sessionId"), fallback_session)
    tool_mode = sanitize_storage_name(form.get("toolMode"), "")
    sequence_text = str(form.get("sequence") or "").strip()
    sequence_part = ""
    if sequence_text.isdigit():
        sequence_part = "_%06d" % int(sequence_text)

    recorded_at = str(form.get("recordedAt") or "")
    mime_type = str(form.get("mimeType") or content_type or "")
    ext = infer_audio_extension(mime_type, original_name)

    AUDIO_CHUNKS_DIR.mkdir(exist_ok=True)
    session_dir = AUDIO_CHUNKS_DIR / session_id
    session_dir.mkdir(exist_ok=True)

    base_name = "chunk_%d%s" % (int(time.time() * 1000), sequence_part)
    chunk_filename = base_name + ext
    chunk_path = session_dir / chunk_filename
    metadata_path = session_dir / (base_name + ".json")

    metadata = {
        "sessionId": session_id,
        "filename": chunk_filename,
        "bytes": len(blob),
        "mimeType": mime_type,
        "controllerId": controller_id or None,
        "toolMode": tool_mode or None,
        "recordedAt": recorded_at,
        "sequence": int(sequence_text) if sequence_text.isdigit() else None,
        "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    try:
        chunk_path.write_bytes(blob)
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=True, indent=2), encoding="utf-8")
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500

    return jsonify({"ok": True, **metadata})


@app.route("/api/phone-controller", methods=["GET", "POST"])
def api_phone_controller():
    if request.method == "GET":
        return jsonify({"ok": True, "controllers": snapshot_phone_controller_states()})

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = request.form if request.form else {}
    state = update_phone_controller_state(payload)
    if state is None:
        return jsonify({"ok": False, "error": "invalid_controller"}), 400
    return jsonify({"ok": True, "controller": state, "controllers": snapshot_phone_controller_states()})


@app.route("/api/comment-controller", methods=["GET", "POST"])
def api_comment_controller():
    if request.method == "GET":
        return jsonify({"ok": True, "controllers": snapshot_comment_controller_states()})

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = request.form if request.form else {}
    state = update_comment_controller_state(payload)
    if state is None:
        return jsonify({"ok": False, "error": "invalid_controller"}), 400
    return jsonify({"ok": True, "controller": state, "controllers": snapshot_comment_controller_states()})


@app.route("/api/phone-controller-session", methods=["POST"])
def api_phone_controller_session():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = request.form if request.form else {}
    result, error = update_phone_controller_session(payload)
    if error:
        status = 409 if error == "no_available_controller" else 400
        return jsonify({"ok": False, "error": error, **(result or {})}), status
    return jsonify({"ok": True, **(result or {})})


@app.route("/api/mapbox-token", methods=["GET"])
def api_mapbox_token():
    return jsonify({"ok": True, "token": load_mapbox_token()})


@app.route("/api/google-maps-key", methods=["GET"])
def api_google_maps_key():
    return jsonify({"ok": True, "key": load_google_maps_key()})


@app.route("/api/mapillary/near", methods=["GET"])
def api_mapillary_near():
    """Nearest Mapillary street-level images around lng/lat (Street View fallback).
    Proxied so the token stays server-side and CORS isn't an issue. Returns
    {ok, images:[{id,url,lng,lat,angle}]}. If no token is configured the fallback
    is simply inactive (ok True, empty list)."""
    token = load_mapillary_token()
    if not token:
        return jsonify({"ok": True, "images": [], "reason": "no_token"})
    try:
        lng = float(request.args.get("lng"))
        lat = float(request.args.get("lat"))
    except Exception:
        return jsonify({"ok": False, "error": "bad_coords"}), 400
    try:
        radius_m = float(request.args.get("radius") or 100.0)
    except Exception:
        radius_m = 100.0
    limit = max(1, min(10, int(request.args.get("limit") or 5)))

    # small bbox of ~radius around the point
    import urllib.request
    import urllib.parse
    dlat = radius_m / 111320.0
    dlng = radius_m / (111320.0 * max(0.05, math.cos(math.radians(lat))))
    bbox = f"{lng - dlng},{lat - dlat},{lng + dlng},{lat + dlat}"
    params = urllib.parse.urlencode({
        "access_token": token,
        "fields": "id,thumb_1024_url,computed_geometry,compass_angle",
        "bbox": bbox,
        "limit": str(limit),
    })
    url = f"https://graph.mapillary.com/images?{params}"
    try:
        with urllib.request.urlopen(url, timeout=6.0) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        return jsonify({"ok": False, "error": f"mapillary_request_failed: {exc}"}), 502

    images = []
    for item in (payload.get("data") or []):
        thumb = item.get("thumb_1024_url")
        if not thumb:
            continue
        geom = (item.get("computed_geometry") or {}).get("coordinates") or [None, None]
        images.append({
            "id": item.get("id"),
            "url": thumb,
            "lng": geom[0],
            "lat": geom[1],
            "angle": item.get("compass_angle"),
        })
    return jsonify({"ok": True, "images": images})


@app.route("/api/surface-lnglat", methods=["GET", "POST"])
def api_surface_lnglat():
    global surface_lnglat_corners
    if request.method == "GET":
        with surface_lnglat_lock:
            return jsonify({"ok": True, **surface_lnglat_corners})

    payload = request.get_json(silent=True) or {}
    raw_corners = payload.get("corners")
    if not isinstance(raw_corners, list) or len(raw_corners) != 4:
        return jsonify({"ok": False, "error": "invalid_corners"}), 400
    cleaned = []
    for pt in raw_corners:
        if not isinstance(pt, dict):
            return jsonify({"ok": False, "error": "invalid_corners"}), 400
        try:
            lng = float(pt.get("lng"))
            lat = float(pt.get("lat"))
        except Exception:
            return jsonify({"ok": False, "error": "invalid_corners"}), 400
        if not (math.isfinite(lng) and math.isfinite(lat)):
            return jsonify({"ok": False, "error": "invalid_corners"}), 400
        cleaned.append({"lng": lng, "lat": lat})

    with surface_lnglat_lock:
        surface_lnglat_corners = {"corners": cleaned, "updatedAt": time.time()}
    return jsonify({"ok": True})


def _bilinear_interp_lnglat(u, v, corners):
    # corners: [TL, TR, BR, BL] in {lng,lat}
    tl, tr, br, bl = corners[0], corners[1], corners[2], corners[3]
    top_lng = tl["lng"] * (1 - u) + tr["lng"] * u
    top_lat = tl["lat"] * (1 - u) + tr["lat"] * u
    bot_lng = bl["lng"] * (1 - u) + br["lng"] * u
    bot_lat = bl["lat"] * (1 - u) + br["lat"] * u
    lng = top_lng * (1 - v) + bot_lng * v
    lat = top_lat * (1 - v) + bot_lat * v
    return {"lng": lng, "lat": lat}


def _find_tag_in_snapshot(tags, tag_id):
    for t in tags:
        if int(t.get("id", -1)) == int(tag_id):
            return t
    return None


@app.route("/api/phone-street-view/<controller_id>", methods=["GET"])
def api_phone_street_view(controller_id):
    cid = str(controller_id or "").strip()
    if cid not in PHONE_CONTROLLER_TAG_MAP:
        return jsonify({"ok": False, "error": "invalid_controller"}), 400
    paired_tag_id = PHONE_CONTROLLER_TAG_MAP[cid]

    with tags_lock:
        tags = list(latest_tags)
    live_tag = _find_tag_in_snapshot(tags, paired_tag_id)
    if not live_tag:
        return jsonify({"ok": False, "error": "live_tag_not_visible"}), 409

    uv = live_tag.get("uv") or {}
    try:
        u = float(uv.get("u"))
        v = float(uv.get("v"))
    except Exception:
        return jsonify({"ok": False, "error": "live_tag_uv_unavailable"}), 409
    if not (math.isfinite(u) and math.isfinite(v)):
        return jsonify({"ok": False, "error": "live_tag_uv_unavailable"}), 409
    if not (0.0 <= u <= 1.0 and 0.0 <= v <= 1.0):
        return jsonify({"ok": False, "error": "live_tag_outside_surface"}), 409

    with surface_lnglat_lock:
        ll_snapshot = dict(surface_lnglat_corners)
    ll_corners = ll_snapshot.get("corners")
    if not isinstance(ll_corners, list) or len(ll_corners) != 4:
        return jsonify({"ok": False, "error": "map_lnglat_unavailable"}), 409

    lnglat = _bilinear_interp_lnglat(u, v, ll_corners)
    return jsonify({
        "ok": True,
        "controllerId": cid,
        "pairedTagId": paired_tag_id,
        "lngLat": lnglat,
        "updatedAt": time.time(),
    })


@app.route("/api/tunnel-status", methods=["GET"])
def api_tunnel_status():
    return jsonify({"ok": True, **snapshot_quick_tunnel_state()})


@app.route("/api/sessions", methods=["GET"])
def api_sessions_list():
    if not SESSIONS_DIR.exists():
        return jsonify({"ok": True, "sessions": [], "workshopCounts": {}})
    files = sorted(
        [f.name for f in SESSIONS_DIR.glob("session_*.json")],
        reverse=True,
    )
    payload = {"ok": True, "sessions": files}
    if request.args.get("workshopCounts") == "1":
        counts = {}
        for filename in files:
            try:
                data = json.loads((SESSIONS_DIR / filename).read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError):
                continue
            if not isinstance(data, dict):
                continue
            workshop_id = str(data.get("workshopId") or "").strip()
            if workshop_id:
                counts[workshop_id] = counts.get(workshop_id, 0) + 1
        payload["workshopCounts"] = counts
    return jsonify(payload)


@app.route("/api/timeline-sessions", methods=["GET"])
def api_timeline_sessions_list():
    if not TIMELINE_SESSIONS_DIR.exists():
        return jsonify({"ok": True, "timelines": []})
    files = sorted(
        [f.name for f in TIMELINE_SESSIONS_DIR.glob("timeline_*.json")],
        reverse=True,
    )
    return jsonify({"ok": True, "timelines": files})


@app.route("/api/expo-sessions", methods=["GET"])
def api_expo_sessions_list():
    if not EXPO_SESSIONS_DIR.exists():
        return jsonify({"ok": True, "expoSessions": []})
    files = sorted(
        [f.name for f in EXPO_SESSIONS_DIR.glob("expo_*.json")],
        reverse=True,
    )
    return jsonify({"ok": True, "expoSessions": files})


# ---- persistent region-feeling totals (street-view questions 9-13) ----
# The accumulated counts live in ONE json file. It is seeded once from all the
# already-captured session files, then grows via /api/expo-region-commit, which
# the expo page calls when a participant EXITS each street-view question (and on
# mouse +1/-1 corrections). Delete the file to re-seed from the session history.
REGION_TOTALS_FILE = EXPO_SESSIONS_DIR / "region_totals.json"


def _region_totals_from_sessions():
    totals = {}
    if EXPO_SESSIONS_DIR.exists():
        for f in EXPO_SESSIONS_DIR.glob("expo_*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            for rf in data.get("regionFeelings") or []:
                try:
                    rid = int(rf.get("region"))
                except (TypeError, ValueError):
                    continue
                totals[rid] = totals.get(rid, 0) + 1
            for ra in data.get("regionAdjusts") or []:
                try:
                    rid = int(ra.get("region"))
                    delta = int(ra.get("delta"))
                except (TypeError, ValueError):
                    continue
                totals[rid] = totals.get(rid, 0) + delta
    return totals


def _region_totals_write(totals):
    EXPO_SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    REGION_TOTALS_FILE.write_text(
        json.dumps({
            "totals": {str(k): max(0, int(v)) for k, v in sorted(totals.items())},
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _region_totals_load():
    if REGION_TOTALS_FILE.exists():
        try:
            data = json.loads(REGION_TOTALS_FILE.read_text(encoding="utf-8"))
            raw = data.get("totals") or {}
            return {int(k): int(v) for k, v in raw.items()}
        except Exception:
            pass
    totals = _region_totals_from_sessions()   # first run: seed from session history
    _region_totals_write(totals)
    return totals


@app.route("/api/expo-region-totals", methods=["GET"])
def api_expo_region_totals():
    totals = _region_totals_load()
    return jsonify({"ok": True, "totals": {str(k): max(0, v) for k, v in totals.items()}})


@app.route("/api/expo-region-commit", methods=["POST"])
def api_expo_region_commit():
    """Apply {counts: {regionId: delta}} onto the persistent totals json and
    return the new totals. Called on street-view question exit and on mouse
    corrections, so the accumulated numbers survive reloads and restarts."""
    payload = request.get_json(silent=True)
    counts = (payload or {}).get("counts")
    if not isinstance(counts, dict):
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    totals = _region_totals_load()
    for k, v in counts.items():
        try:
            rid = int(k)
            delta = int(v)
        except (TypeError, ValueError):
            continue
        if abs(delta) > 10:            # sanity: commits are tiny (+/-1 per question)
            continue
        totals[rid] = max(0, totals.get(rid, 0) + delta)
    _region_totals_write(totals)
    return jsonify({"ok": True, "totals": {str(k): max(0, v) for k, v in totals.items()}})


# Step-14 painting area (same as the client's PALAISEAU_BBOX) + the Télécom spot.
_FEEL_BBOX = (2.1955, 48.7086, 2.2185, 48.7166)   # W, S, E, N
_FEEL_TELECOM = (2.2016, 48.7130)
_FEEL_PLEASANT = {1, 3, 5}                        # green feeling ids; 2/4/6 = reds


def _feel_synth_point(seed_text, region):
    """Deterministic synthetic location for an answer captured WITHOUT image
    coordinates (all pre-2026-07-03 sessions): randomly distributed over the
    grid, but biased so the Télécom surroundings read pleasant — greens cluster
    near Télécom, reds keep their distance."""
    rng = random.Random(seed_text)
    w, s, e, n = _FEEL_BBOX
    tlng, tlat = _FEEL_TELECOM
    if int(region) in _FEEL_PLEASANT and rng.random() < 0.72:
        # gaussian cloud around Télécom (~sigma 300 m)
        lng = tlng + rng.gauss(0, 0.0040)
        lat = tlat + rng.gauss(0, 0.0027)
    else:
        for _ in range(12):                        # uniform, but reds avoid Télécom
            lng = rng.uniform(w, e)
            lat = rng.uniform(s, n)
            if int(region) in _FEEL_PLEASANT:
                break
            d2 = ((lng - tlng) * 0.66) ** 2 + (lat - tlat) ** 2   # ~lng shrink at 48.7°
            if d2 > 0.0045 ** 2:                   # keep reds ≥ ~500 m from Télécom
                break
    return (min(max(lng, w), e), min(max(lat, s), n))


@app.route("/api/expo-feeling-points", methods=["GET"])
def api_expo_feeling_points():
    """All street-view answers across every captured session as located points
    [{lng, lat, region}]. Answers that recorded the shown image's coordinates
    use them; historical answers without coordinates get a stable synthetic
    spot (random over the grid, pleasant-biased around Télécom) so the step-14
    painting includes the whole collected history."""
    pts = []
    if EXPO_SESSIONS_DIR.exists():
        for f in EXPO_SESSIONS_DIR.glob("expo_*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            for rf in data.get("regionFeelings") or []:
                if not isinstance(rf, dict):
                    continue
                try:
                    rid = int(rf.get("region"))
                except (TypeError, ValueError):
                    continue
                img = rf.get("image")
                lng = lat = None
                if isinstance(img, dict):
                    try:
                        lng = float(img.get("lng"))
                        lat = float(img.get("lat"))
                    except (TypeError, ValueError):
                        lng = lat = None
                if lng is None or lat is None or not (math.isfinite(lng) and math.isfinite(lat)):
                    lng, lat = _feel_synth_point(f"{f.name}:{rf.get('step')}:{rid}", rid)
                    pts.append({"lng": lng, "lat": lat, "region": rid, "synthetic": True})
                else:
                    pts.append({"lng": lng, "lat": lat, "region": rid})
    return jsonify({"ok": True, "points": pts})


@app.route("/api/expo-session/<filename>", methods=["GET"])
def api_expo_session_load(filename):
    safe_name = str(filename or "")
    if not safe_name.startswith("expo_") or not safe_name.endswith(".json"):
        return jsonify({"ok": False, "error": "invalid_filename"}), 400
    if "/" in safe_name or "\\" in safe_name:
        return jsonify({"ok": False, "error": "invalid_filename"}), 400
    filepath = EXPO_SESSIONS_DIR / safe_name
    if not filepath.exists() or not filepath.is_file():
        return jsonify({"ok": False, "error": "not_found"}), 404
    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
        return jsonify(data)
    except Exception:
        return jsonify({"ok": False, "error": "read_failed"}), 500


@app.route("/api/session/<filename>", methods=["GET"])
def api_session_load(filename):
    filepath = SESSIONS_DIR / filename
    if not filepath.exists() or not filepath.is_file():
        return jsonify({"ok": False, "error": "not_found"}), 404
    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
        return jsonify(data)
    except Exception:
        return jsonify({"ok": False, "error": "read_failed"}), 500


@app.route("/api/timeline-session/<filename>", methods=["GET"])
def api_timeline_session_load(filename):
    safe_name = str(filename or "")
    if not safe_name.startswith("timeline_") or not safe_name.endswith(".json"):
        return jsonify({"ok": False, "error": "invalid_filename"}), 400
    if "/" in safe_name or "\\" in safe_name:
        return jsonify({"ok": False, "error": "invalid_filename"}), 400
    filepath = TIMELINE_SESSIONS_DIR / safe_name
    if not filepath.exists() or not filepath.is_file():
        return jsonify({"ok": False, "error": "not_found"}), 404
    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
        return jsonify(data)
    except Exception:
        return jsonify({"ok": False, "error": "read_failed"}), 500


@app.route("/api/session/<filename>", methods=["PUT"])
def api_session_update(filename):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    safe_name = str(filename or "")
    if not safe_name.startswith("session_") or not safe_name.endswith(".json"):
        return jsonify({"ok": False, "error": "invalid_filename"}), 400
    if "/" in safe_name or "\\" in safe_name:
        return jsonify({"ok": False, "error": "invalid_filename"}), 400
    SESSIONS_DIR.mkdir(exist_ok=True)
    filepath = SESSIONS_DIR / safe_name
    try:
        filepath.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return jsonify({"ok": True, "filename": safe_name})
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500


@app.route("/api/custom-objects", methods=["GET"])
def api_custom_objects_load():
    if not CUSTOM_OBJECTS_FILE.exists():
        return jsonify(empty_feature_collection())
    try:
        data = json.loads(CUSTOM_OBJECTS_FILE.read_text(encoding="utf-8"))
        normalized = normalize_custom_objects_payload(data)
        if normalized is None:
            return jsonify(empty_feature_collection())
        return jsonify(normalized)
    except Exception:
        return jsonify({"ok": False, "error": "read_failed"}), 500


@app.route("/api/custom-objects", methods=["PUT"])
def api_custom_objects_save():
    payload = request.get_json(silent=True)
    normalized = normalize_custom_objects_payload(payload)
    if normalized is None:
        return jsonify({"ok": False, "error": "invalid_geojson"}), 400
    try:
        CUSTOM_OBJECTS_FILE.parent.mkdir(exist_ok=True)
        CUSTOM_OBJECTS_FILE.write_text(
            json.dumps(normalized, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return jsonify({"ok": True, "path": CUSTOM_OBJECTS_FILE.name})
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500


# ---- Custom data layers (facilitator-uploaded GeoJSON, data/custom_layers/).
# Selectable per workshop step next to the built-in roads/network/objects
# layers; may contain points, lines and/or areas.

CUSTOM_LAYER_MAX_BYTES = 60 * 1024 * 1024
WORKSHOP_IMAGE_MAX_BYTES = 8 * 1024 * 1024
BUILTIN_DATA_LAYERS = (
    {"id": "roads", "name": "Roads"},
    {"id": "network", "name": "Street network (OSMnx)"},
    {"id": "objects", "name": "Custom objects"},
)


def _load_hidden_data_layers():
    """Layer ids removed from the global catalog; source files stay intact."""
    if not DATA_LAYER_CATALOG_FILE.exists():
        return set()
    try:
        payload = json.loads(DATA_LAYER_CATALOG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return set()
    hidden = payload.get("hidden") if isinstance(payload, dict) else None
    return {str(layer_id) for layer_id in hidden} if isinstance(hidden, list) else set()


def _save_hidden_data_layers(hidden):
    DATA_LAYER_CATALOG_FILE.parent.mkdir(exist_ok=True)
    DATA_LAYER_CATALOG_FILE.write_text(
        json.dumps({"hidden": sorted(set(hidden))}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _hide_data_layer(layer_id):
    hidden = _load_hidden_data_layers()
    hidden.add(str(layer_id))
    _save_hidden_data_layers(hidden)


def _show_data_layer(layer_id):
    hidden = _load_hidden_data_layers()
    hidden.discard(str(layer_id))
    _save_hidden_data_layers(hidden)


def _safe_layer_name(name):
    """Sanitize an uploaded filename to a bare, safe .geojson basename."""
    base = os.path.basename(str(name or "")).strip()
    base = re.sub(r"[^A-Za-z0-9 ._-]", "_", base)
    base = base.lstrip(".")
    stem, _ext = os.path.splitext(base)
    stem = stem.strip() or "layer"
    return stem + ".geojson"


def _custom_layer_path_for_id(layer_id):
    """Resolve a custom-layer id (filename) to a path inside CUSTOM_LAYERS_DIR,
    or None if it isn't a real .geojson within that directory (no traversal)."""
    name = os.path.basename(str(layer_id or ""))
    if not name.lower().endswith(".geojson"):
        return None
    candidate = (CUSTOM_LAYERS_DIR / name).resolve()
    try:
        candidate.relative_to(CUSTOM_LAYERS_DIR.resolve())
    except ValueError:
        return None
    return candidate if candidate.exists() else None


def list_custom_layers(include_hidden=False):
    """Uploaded .geojson catalog entries as [{id, name}], newest first."""
    if not CUSTOM_LAYERS_DIR.exists():
        return []
    hidden = set() if include_hidden else _load_hidden_data_layers()
    files = sorted(CUSTOM_LAYERS_DIR.glob("*.geojson"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [
        {"id": f.name, "name": f.stem}
        for f in files
        if "custom:" + f.name not in hidden
    ]


def list_data_layers():
    """The global catalog used by every workshop; hidden files are retained."""
    hidden = _load_hidden_data_layers()
    layers = [dict(layer) for layer in BUILTIN_DATA_LAYERS if layer["id"] not in hidden]
    layers.extend({"id": "custom:" + layer["id"], "name": layer["name"]}
                  for layer in list_custom_layers())
    return layers


def _as_feature_collection(data):
    """Normalize an uploaded GeoJSON or uMap backup to a FeatureCollection."""
    if not isinstance(data, dict):
        return None
    kind = data.get("type")
    if kind == "umap":
        layers = data.get("layers")
        if not isinstance(layers, list) or not layers:
            return None
        features = []
        manifest_layers = []
        # uMap backups store data layers in the inverse of the order displayed
        # by the caption/browser. Reverse both the manifest and flattened
        # features so our editor matches the visible uMap layer list.
        for index, layer in enumerate(reversed(layers)):
            if not isinstance(layer, dict) or layer.get("type") != "FeatureCollection":
                return None
            layer_features = layer.get("features")
            if not isinstance(layer_features, list):
                return None
            if any(not isinstance(feature, dict) for feature in layer_features):
                return None
            layer_properties = layer.get("properties")
            layer_options = layer.get("_umap_options")
            options = {}
            if isinstance(layer_properties, dict):
                options.update(layer_properties)
            if isinstance(layer_options, dict):
                options.update(layer_options)
            name = str(options.get("name") or "Layer " + str(index + 1)).strip()
            layer_id = str(options.get("id") or layer.get("id") or "layer-" + str(index + 1))
            manifest_layers.append({
                "id": layer_id,
                "name": name,
                "count": len(layer_features),
                "options": options,
            })
            features.extend(layer_features)
        map_properties = data.get("properties") if isinstance(data.get("properties"), dict) else {}
        return {
            "type": "FeatureCollection",
            "features": features,
            "properties": {
                "name": map_properties.get("name") or "uMap import",
                "_compact_workshop_layers": {
                    "source": "uMap backup",
                    "featureCount": len(features),
                    "layers": manifest_layers,
                },
            },
        }
    if kind == "FeatureCollection":
        feats = data.get("features")
        if not isinstance(feats, list):
            return None
        normalized = {"type": "FeatureCollection", "features": feats}
        # Keep collection-level metadata. uMap and similar editors use it for
        # data-layer definitions and inherited styling.
        if isinstance(data.get("properties"), dict):
            normalized["properties"] = data["properties"]
        return normalized
    if kind == "Feature":
        if not isinstance(data.get("geometry"), dict):
            return None
        return {"type": "FeatureCollection", "features": [data]}
    if kind in ("Point", "MultiPoint", "LineString", "MultiLineString",
                "Polygon", "MultiPolygon", "GeometryCollection"):
        return {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {}, "geometry": data}
        ]}
    return None


@app.route("/api/custom-layers", methods=["GET"])
def api_custom_layers_list():
    return jsonify({"ok": True, "layers": list_custom_layers()})


@app.route("/api/data-layers", methods=["GET"])
def api_data_layers_list():
    return jsonify({"ok": True, "layers": list_data_layers()})


@app.route("/api/custom-layers", methods=["POST"])
def api_custom_layers_upload():
    file_storage = request.files.get("file")
    if file_storage is None or not (file_storage.filename or "").strip():
        return jsonify({"ok": False, "error": "no_file"}), 400
    if not file_storage.filename.lower().endswith((".geojson", ".json", ".umap")):
        return jsonify({"ok": False, "error": "not_geojson"}), 400
    raw = file_storage.read(CUSTOM_LAYER_MAX_BYTES + 1)
    if len(raw) > CUSTOM_LAYER_MAX_BYTES:
        return jsonify({"ok": False, "error": "too_large"}), 400
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except Exception:
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    normalized = _as_feature_collection(data)
    if normalized is None:
        return jsonify({"ok": False, "error": "not_geojson"}), 400
    CUSTOM_LAYERS_DIR.mkdir(parents=True, exist_ok=True)
    name = _safe_layer_name(file_storage.filename)
    dest = CUSTOM_LAYERS_DIR / name
    # Avoid clobbering a visible layer. Re-uploading a hidden file with the
    # same name intentionally replaces it and makes its catalog entry visible.
    hidden = _load_hidden_data_layers()
    if dest.exists() and "custom:" + name not in hidden:
        stem, ext = os.path.splitext(name)
        n = 2
        while (CUSTOM_LAYERS_DIR / (stem + " (" + str(n) + ")" + ext)).exists():
            n += 1
        name = stem + " (" + str(n) + ")" + ext
        dest = CUSTOM_LAYERS_DIR / name
    try:
        dest.write_text(json.dumps(normalized, ensure_ascii=False), encoding="utf-8")
        _show_data_layer("custom:" + name)
    except Exception as exc:
        return jsonify({"ok": False, "error": "save_failed", "detail": str(exc)}), 500
    return jsonify({"ok": True, "id": name, "name": dest.stem, "layers": list_custom_layers()})


@app.route("/api/custom-layers/<path:layer_id>", methods=["GET"])
def api_custom_layers_get(layer_id):
    # Served here (not via /data/) so it works in the frozen bundle too, where
    # uploads land in the user data dir rather than the bundled resources.
    path = _custom_layer_path_for_id(layer_id)
    if path is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    # A flattened uMap export can be accompanied by a tiny .layers.json
    # manifest. Attach it as collection metadata without rewriting or
    # duplicating the potentially large GeoJSON file.
    manifest_path = path.with_suffix(".layers.json")
    if manifest_path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
            manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
            if isinstance(payload, dict) and isinstance(manifest, dict):
                properties = payload.get("properties")
                if not isinstance(properties, dict):
                    properties = {}
                    payload["properties"] = properties
                properties["_compact_workshop_layers"] = manifest
                return jsonify(payload)
        except Exception:
            # A bad optional manifest must not make the uploaded GeoJSON
            # unavailable; serve the original file as the safe fallback.
            pass
    return send_from_directory(CUSTOM_LAYERS_DIR, path.name, mimetype="application/geo+json")


@app.route("/api/custom-layers/<path:layer_id>", methods=["DELETE"])
def api_custom_layers_delete(layer_id):
    path = _custom_layer_path_for_id(layer_id)
    if path is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    try:
        _hide_data_layer("custom:" + path.name)
    except Exception as exc:
        return jsonify({"ok": False, "error": "delete_failed", "detail": str(exc)}), 500
    return jsonify({"ok": True, "layers": list_custom_layers()})


@app.route("/api/data-layers/<path:layer_id>", methods=["DELETE"])
def api_data_layers_delete(layer_id):
    layer_id = str(layer_id or "")
    builtin_ids = {layer["id"] for layer in BUILTIN_DATA_LAYERS}
    if layer_id in builtin_ids:
        valid = True
    elif layer_id.startswith("custom:"):
        valid = _custom_layer_path_for_id(layer_id[len("custom:"):]) is not None
    else:
        valid = False
    if not valid:
        return jsonify({"ok": False, "error": "not_found"}), 404
    try:
        _hide_data_layer(layer_id)
    except Exception as exc:
        return jsonify({"ok": False, "error": "delete_failed", "detail": str(exc)}), 500
    return jsonify({"ok": True, "layers": list_data_layers()})



@app.route("/api/workshops", methods=["GET"])
def api_workshops_load():
    if not WORKSHOPS_FILE.exists():
        return jsonify({"workshops": []})
    try:
        data = json.loads(WORKSHOPS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("workshops"), list):
            return jsonify({"workshops": []})
        return jsonify(data)
    except Exception:
        return jsonify({"ok": False, "error": "read_failed"}), 500


@app.route("/api/workshops", methods=["PUT"])
def api_workshops_save():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get("workshops"), list):
        return jsonify({"ok": False, "error": "invalid_payload"}), 400
    try:
        WORKSHOPS_FILE.parent.mkdir(exist_ok=True)
        WORKSHOPS_FILE.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return jsonify({"ok": True, "path": WORKSHOPS_FILE.name})
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500


@app.route("/api/workshop-assets", methods=["POST"])
def api_workshop_asset_upload():
    file_storage = request.files.get("file")
    if file_storage is None or not (file_storage.filename or "").strip():
        return jsonify({"ok": False, "error": "no_file"}), 400
    original_name = os.path.basename(file_storage.filename)
    stem, ext = os.path.splitext(original_name)
    ext = ext.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        return jsonify({"ok": False, "error": "unsupported_image"}), 400
    raw = file_storage.read(WORKSHOP_IMAGE_MAX_BYTES + 1)
    if len(raw) > WORKSHOP_IMAGE_MAX_BYTES:
        return jsonify({"ok": False, "error": "too_large"}), 400
    # Decode once server-side so a renamed/non-image file cannot enter the
    # workshop asset directory. IMREAD_UNCHANGED preserves alpha validation.
    try:
        decoded = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    except Exception:
        decoded = None
    if decoded is None or decoded.size == 0:
        return jsonify({"ok": False, "error": "invalid_image"}), 400
    safe_stem = re.sub(r"[^A-Za-z0-9_-]", "_", stem).strip("_") or "image"
    if ext == ".jpeg":
        ext = ".jpg"
    WORKSHOP_ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = str(int(time.time() * 1000))
    filename = f"{safe_stem}_{stamp}{ext}"
    suffix = 2
    while (WORKSHOP_ASSETS_DIR / filename).exists():
        filename = f"{safe_stem}_{stamp}_{suffix}{ext}"
        suffix += 1
    try:
        (WORKSHOP_ASSETS_DIR / filename).write_bytes(raw)
    except Exception as exc:
        return jsonify({"ok": False, "error": "save_failed", "detail": str(exc)}), 500
    return jsonify({
        "ok": True,
        "name": original_name,
        "url": "/api/workshop-assets/" + urllib.parse.quote(filename),
    })


@app.route("/api/workshop-assets/<path:asset_id>", methods=["GET"])
def api_workshop_asset_get(asset_id):
    filename = os.path.basename(str(asset_id or ""))
    if filename != str(asset_id or ""):
        return jsonify({"ok": False, "error": "not_found"}), 404
    path = (WORKSHOP_ASSETS_DIR / filename).resolve()
    try:
        path.relative_to(WORKSHOP_ASSETS_DIR.resolve())
    except ValueError:
        return jsonify({"ok": False, "error": "not_found"}), 404
    if not path.is_file():
        return jsonify({"ok": False, "error": "not_found"}), 404
    return send_from_directory(WORKSHOP_ASSETS_DIR, filename)


@app.route("/api/marker-settings", methods=["GET"])
def api_marker_settings_load():
    return jsonify({"ok": True, **marker_settings_payload()})


@app.route("/api/marker-settings", methods=["PUT"])
def api_marker_settings_save():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_payload"}), 400
    try:
        settings = save_marker_settings(payload)
        return jsonify({"ok": True, **settings, "availableFamilies": available_marker_families()})
    except Exception as _e:
        import traceback
        traceback.print_exc()
        return jsonify({"ok": False, "error": "write_failed", "detail": str(_e)}), 500


# ==================== IMOBYL paper window ====================
# A sheet of A3 with AprilTags in its border, laid on the projected table, is
# a window onto the street: the exhibition page fits the sheet's pose from the
# tags the camera sees and projects a street-level view into the white inside.
# The layout is served as JSON and drawn into the PDF from the SAME numbers,
# so what the page fits against cannot drift from what was printed.
#
# Seven tags by default, the top-centre slot left free, and all of them in a
# contiguous run of tag16h5 ids the workshop does not use: 0-1 and 9-14 are
# the marker slots, 19-23 the selectors, pans and its own street view, 25-28
# the surface corners, 0-15 the calibration grid while it runs. The pointer
# that says WHERE to look is 24, the one id left free between them, so it
# cannot be confused with the workshop's street-view tag (23).
IMOBYL_FRAME_PAGE_MM = (420.0, 297.0)          # A3 landscape
IMOBYL_FRAME_SLOT_IDS = {
    "tl": 2, "tr": 3, "br": 4, "bl": 5,          # corners, clockwise from top-left
    "rm": 6, "bm": 7, "lm": 8,                   # middles of the right, bottom, left edges
    "tm": 16,                                    # top middle, only with topCentre=1
}
IMOBYL_POINTER_TAG_ID = 24
IMOBYL_FRAME_EDGE_MM = 3.0     # left unprinted: most printers cannot reach the edge
IMOBYL_FRAME_QUIET_MM = 3.0    # white kept round the black square inside its cell
IMOBYL_FRAME_LABEL = "VUE DE LA RUE"   # what the window shows, said on its top edge

# The second window: the same A3 sheet, showing the hexagon the pointer is
# standing in rather than the street at its feet. It needs its own border ids,
# or the two sheets on the table cannot be told apart.
#
# It needs seven of them, the same ring the street window gets. The pose is
# fitted from tag CORNERS, so two tags already over-determine a homography and
# three would function -- but a full ring is what survives a sheet being half
# covered by a hand, and keeps the fit from leaning on one end of the page.
# See IMOBYL_ZOOM_ID_POOL for which ids are free and why.
IMOBYL_ZOOM_LABEL = "VUE RAPPROCHEE"
IMOBYL_ZOOM_SLOT_ORDER = ("tl", "tr", "bl", "br", "rm", "lm", "bm")
# Seven ids, so this sheet gets the same full ring as the street window.
#
# An earlier pool reached past 29 for the larger families, but tag16h5 -- what
# the workshop actually runs -- stops at 29, so those ids were filtered out and
# the sheet printed with three tags. Every id below exists in all four
# families, so the ring is complete whichever one is selected.
#
# What the ids avoid, in the order it matters:
#   11-14  the drawing pointers -- the one range that must stay clear
#   2-8    the street window's own ring (16 is its optional top-middle)
#   0, 1   post-it and keyboard location      9, 10  route start and end
#   19, 20 the draw-1 selectors               21, 22 map pan
#   23     street-view trigger                24     this scenario's pointer
# That leaves 15, 17, 18 and 29 genuinely unassigned. The last three come from
# the surface corner tags, which are PROJECTED during calibration and never
# printed, so a sheet carrying them collides only if someone re-runs the corner
# calibration with the sheet on the table. 25 is kept out of the pool even so:
# driftMonitor.js reads it as its reference tag.
IMOBYL_ZOOM_ID_POOL = (17, 18, 29, 15, 26, 27, 28)
IMOBYL_ZOOM_MIN_TAGS = 3


def imobyl_zoom_slot_ids(family):
    """As many of the zoom window's ids as this family actually has, paired
    with corners first so a three-tag sheet still pins all four of position,
    scale, rotation and shear."""
    have = marker_family_ids(family)
    usable = [tag_id for tag_id in IMOBYL_ZOOM_ID_POOL if tag_id in have]
    return dict(zip(IMOBYL_ZOOM_SLOT_ORDER, usable))


IMOBYL_FRAME_KINDS = ("street", "zoom")


def imobyl_frame_layout(border_mm=24.0, tag_mm=32.0, top_centre=False, kind="street"):
    """The tag cells are bigger than the band and stand proud of it into the
    white inside, like rivets on a frame: their outer edge sits on the page
    margin and the band runs behind them. The inside the page projects into
    is the rectangle the band leaves, and the page masks the cells that
    intrude on it so no projected light lands on a tag.

    kind picks which window this sheet is: "street" shows the view from the
    pointer, "zoom" the hexagon it is standing in. They differ only in their
    border ids and the word on the top edge -- everything a sheet needs to be
    told apart by the camera and by the person carrying it."""
    if kind not in IMOBYL_FRAME_KINDS:
        raise ValueError("invalid_kind")
    family = marker_settings_family()
    if kind == "zoom":
        slot_ids = imobyl_zoom_slot_ids(family)
        if len(slot_ids) < IMOBYL_ZOOM_MIN_TAGS:
            # Better to say so than to print tags this family cannot encode.
            raise ValueError("zoom_ids_unavailable")
        label_text = IMOBYL_ZOOM_LABEL
        top_centre = False          # the pool never reaches a top-middle tag
    else:
        slot_ids = dict(IMOBYL_FRAME_SLOT_IDS)
        label_text = IMOBYL_FRAME_LABEL
    width, height = IMOBYL_FRAME_PAGE_MM
    edge = IMOBYL_FRAME_EDGE_MM
    cell = tag_mm + 2.0 * IMOBYL_FRAME_QUIET_MM
    near = edge + cell / 2.0                  # a cell centre's distance from the page edge
    every = [
        ("tl", near, near), ("tr", width - near, near),
        ("br", width - near, height - near), ("bl", near, height - near),
        ("rm", width - near, height / 2.0), ("bm", width / 2.0, height - near),
        ("lm", near, height / 2.0),
    ]
    if top_centre:
        every.append(("tm", width / 2.0, near))
    slots = [item for item in every if item[0] in slot_ids]
    # The label sits in the top band, centred when that slot is free and
    # pulled to the left-hand stretch when a tag takes the centre.
    label_w = 120.0 if top_centre else 150.0
    label_cx = width * 0.27 if top_centre else width / 2.0
    label = [label_cx - label_w / 2.0, edge + 2.0, label_cx + label_w / 2.0, edge + border_mm - 2.0]
    tags = []
    for slot, cx, cy in slots:
        s = tag_mm / 2.0
        tags.append({
            "id": slot_ids[slot], "slot": slot, "cx": cx, "cy": cy,
            # The black square's corners in the order OpenCV reports a marker
            # printed upright: clockwise from its top-left, y down the page.
            "corners": [[cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s]],
        })
    return {
        "pageMm": [width, height],
        "edgeMm": edge,
        "borderMm": border_mm,
        "tagMm": tag_mm,
        "quietMm": IMOBYL_FRAME_QUIET_MM,
        "cellMm": cell,
        "topCentre": bool(top_centre),
        "interiorMm": [edge + border_mm, edge + border_mm,
                       width - edge - border_mm, height - edge - border_mm],
        "labelMm": label,
        "labelText": label_text,
        "kind": kind,
        "tags": tags,
        # Both sheets read the same pointer: one hand moves it, and each
        # window answers about wherever it was put.
        "pointerTagId": IMOBYL_POINTER_TAG_ID,
        "family": family,
    }


def _imobyl_frame_args():
    """Border and tag sizes from the query string, bounded to what can print
    and still decode. The tag may be bigger than the band -- its cell then
    stands proud of it -- but two cells must still leave the middle of the
    short side free."""
    try:
        border = float(request.args.get("borderMm", 24.0))
        tag = float(request.args.get("tagMm", 32.0))
        seed = int(request.args.get("seed", 7))
    except (TypeError, ValueError):
        raise ValueError("invalid_size")
    if not (10.0 <= border <= 60.0) or not (8.0 <= tag <= 60.0):
        raise ValueError("invalid_size")
    top_centre = str(request.args.get("topCentre", "0")).lower() in ("1", "true", "yes")
    kind = str(request.args.get("kind", "street")).strip().lower() or "street"
    if kind not in IMOBYL_FRAME_KINDS:
        raise ValueError("invalid_kind")
    return border, tag, top_centre, seed, kind


def _marker_bitmap(family, tag_id):
    """The marker's cells, black border included, as a 0/255 array."""
    dictionary = cv2.aruco.getPredefinedDictionary(APRILTAG_GENERATOR_FAMILY_MAP[family])
    cells = int(getattr(dictionary, "markerSize", 4)) + 2
    return cv2.aruco.generateImageMarker(dictionary, int(tag_id), cells), cells


def imobyl_frame_mosaic(layout, seed=7, density=0.5, moat_modules=1):
    """The border as a scatter of black squares on the tags' own module grid,
    so the whole band reads as one big AprilTag. Returned as rectangles in
    millimetres, clipped to the band, so the PDF and any test draw the same
    thing.

    Around every real tag a moat of one module is left white beyond its cell:
    the detector needs the tag's black border to sit in white, and a black
    square landing against the cell would fuse with it in the camera.

    Deliberately random rather than a repeat. A regular pattern lines up with
    the detector's grid sampling and can fake a code; noise does not."""
    import random

    width, height = layout["pageMm"]
    edge = layout.get("edgeMm", 0.0)
    border = layout["borderMm"]
    tag_mm = layout["tagMm"]
    cell_mm = layout.get("cellMm", border)
    cells = _marker_bitmap(layout["family"], layout["tags"][0]["id"])[1]
    module = tag_mm / cells
    rng = random.Random(int(seed))
    keep_out = []
    half = cell_mm / 2.0 + moat_modules * module
    for tag in layout["tags"]:
        keep_out.append((tag["cx"] - half, tag["cy"] - half, tag["cx"] + half, tag["cy"] + half))
    label = layout.get("labelMm")
    if label:
        pad = moat_modules * module
        keep_out.append((label[0] - pad, label[1] - pad, label[2] + pad, label[3] + pad))
    bands = [
        (edge, edge, width - edge, edge + border),
        (edge, height - edge - border, width - edge, height - edge),
        (edge, edge, edge + border, height - edge),
        (width - edge - border, edge, width - edge, height - edge),
    ]
    squares = []
    columns = int((width - 2 * edge) / module) + 1
    rows = int((height - 2 * edge) / module) + 1
    for row in range(rows):
        for column in range(columns):
            x0, y0 = edge + column * module, edge + row * module
            x1, y1 = x0 + module, y0 + module
            # The draw is taken for every module whether or not it lands, so
            # the pattern for a given seed does not shift with the tag layout.
            black = rng.random() < density
            if not black:
                continue
            for bx0, by0, bx1, by1 in bands:
                cx0, cy0 = max(x0, bx0), max(y0, by0)
                cx1, cy1 = min(x1, bx1), min(y1, by1)
                if cx1 - cx0 < 0.05 or cy1 - cy0 < 0.05:
                    continue
                if any(cx0 < k[2] and cx1 > k[0] and cy0 < k[3] and cy1 > k[1] for k in keep_out):
                    continue
                squares.append((cx0, cy0, cx1 - cx0, cy1 - cy0))
                break
    return squares


def _draw_imobyl_frame_pdf(layout, pointer_size_cm, seed=7):
    try:
        from reportlab.lib.pagesizes import A3, landscape
        from reportlab.lib.units import mm
        from reportlab.pdfgen import canvas
    except ImportError as exc:
        raise RuntimeError("reportlab_not_installed") from exc

    page = landscape(A3)
    page_w, page_h = page
    width, height = layout["pageMm"]
    border = layout["borderMm"]
    tag_mm = layout["tagMm"]
    family = layout["family"]

    # Layout coordinates are millimetres from the top-left corner, y down;
    # reportlab's are points from the bottom-left, y up.
    def px(x_mm):
        return x_mm * mm

    def py(y_mm):
        return page_h - y_mm * mm

    out = io.BytesIO()
    pdf = canvas.Canvas(out, pagesize=page, pageCompression=1)
    zoom = layout.get("kind") == "zoom"
    pdf.setTitle("IMOBYL paper window - "
                 + ("close-up view" if zoom else "street view"))
    pdf.setAuthor("Low-Barrier Digital Participatory Mapping")

    def draw_marker(cx, cy, size_mm, tag_id):
        bitmap, cells = _marker_bitmap(family, tag_id)
        cell = size_mm / cells
        left = cx - size_mm / 2.0
        top = cy - size_mm / 2.0
        pdf.setFillColorRGB(0, 0, 0)
        for row in range(cells):
            for column in range(cells):
                if int(bitmap[row, column]) < 128:
                    pdf.rect(px(left + column * cell), py(top + (row + 1) * cell),
                             cell * mm, cell * mm, fill=1, stroke=0)

    # ---- page 1: the frame ---------------------------------------------
    pdf.setFillColorRGB(0, 0, 0)
    for x, y, w, h in imobyl_frame_mosaic(layout, seed):
        pdf.rect(px(x), py(y + h), w * mm, h * mm, fill=1, stroke=0)
    cell = layout.get("cellMm", border)
    for tag in layout["tags"]:
        cx, cy = tag["cx"], tag["cy"]
        pdf.setFillColorRGB(1, 1, 1)
        pdf.rect(px(cx - cell / 2.0), py(cy + cell / 2.0), cell * mm, cell * mm, fill=1, stroke=0)
        draw_marker(cx, cy, tag_mm, tag["id"])

    label = layout.get("labelMm")
    text = layout.get("labelText") or ""
    if label and text:
        x0, y0, x1, y1 = label
        pdf.setFillColorRGB(1, 1, 1)
        pdf.roundRect(px(x0), py(y1), (x1 - x0) * mm, (y1 - y0) * mm, 2.5 * mm, fill=1, stroke=0)
        # As large as fits the plate with a margin, whichever of width and
        # height binds first; Helvetica's capitals stand about 0.72 em.
        font = "Helvetica-Bold"
        size = min(((y1 - y0) - 6.0) * mm / 0.72, 200.0)
        while size > 6 and pdf.stringWidth(text, font, size) > (x1 - x0 - 16.0) * mm:
            size -= 0.5
        pdf.setFillColorRGB(0, 0, 0)
        pdf.setFont(font, size)
        baseline = (y0 + y1) / 2.0 + (size * 0.72 / mm) / 2.0
        pdf.drawCentredString(px((x0 + x1) / 2.0), py(baseline), text)
    pdf.showPage()

    # ---- page 2: the pointer, twice, at the workshop's own tag size ------
    pointer = float(pointer_size_cm) * 10.0
    card_w, card_h = pointer + 40.0, pointer + 58.0
    gap = 24.0
    left0 = (width - 2 * card_w - gap) / 2.0
    top0 = (height - card_h) / 2.0
    bitmap_cells = _marker_bitmap(family, layout["pointerTagId"])[1]
    for k in range(2):
        left = left0 + k * (card_w + gap)
        pdf.setStrokeColorRGB(0.5, 0.5, 0.5)
        pdf.setLineWidth(0.5)
        pdf.setDash(3, 3)
        pdf.rect(px(left), py(top0 + card_h), card_w * mm, card_h * mm, fill=0, stroke=1)
        pdf.setDash()
        cx = left + card_w / 2.0
        cy = top0 + 24.0 + pointer / 2.0
        draw_marker(cx, cy, pointer, layout["pointerTagId"])
        # The tag's up is where the view looks. Drawn as an arrow so the
        # direction survives being cut out and handed round.
        pdf.setStrokeColorRGB(0.1, 0.1, 0.1)
        pdf.setFillColorRGB(0.1, 0.1, 0.1)
        pdf.setLineWidth(1.2)
        ay = top0 + 20.0 - pointer / 2.0 + pointer / 2.0
        pdf.line(px(cx), py(ay), px(cx), py(ay - 11.0))
        pdf.line(px(cx), py(ay - 11.0), px(cx - 3.0), py(ay - 7.5))
        pdf.line(px(cx), py(ay - 11.0), px(cx + 3.0), py(ay - 7.5))
        pdf.setFont("Helvetica-Bold", 10)
        pdf.drawCentredString(px(cx), py(cy + pointer / 2.0 + 9.0),
                              ("Vue rapprochee" if zoom else "Vue de rue")
                              + "  -  ID " + str(layout["pointerTagId"]))
        pdf.setFont("Helvetica", 7.5)
        pdf.drawCentredString(px(cx), py(cy + pointer / 2.0 + 15.0),
                              "Poser sur la carte ; la case sous le pointeur est agrandie"
                              if zoom else
                              "Poser sur la carte ; la fleche est la direction du regard")
        pdf.drawCentredString(px(cx), py(cy + pointer / 2.0 + 20.5),
                              "%s, %d modules, %.0f mm" % (family, bitmap_cells, pointer))
    pdf.showPage()
    pdf.save()
    return out.getvalue()


@app.route("/api/imobyl/frame", methods=["GET"])
def api_imobyl_frame():
    try:
        border, tag, top_centre, _seed, kind = _imobyl_frame_args()
        layout = imobyl_frame_layout(border, tag, top_centre, kind)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True, **layout})


@app.route("/api/imobyl/frame.pdf", methods=["GET"])
def api_imobyl_frame_pdf():
    try:
        border, tag, top_centre, seed, kind = _imobyl_frame_args()
        layout = imobyl_frame_layout(border, tag, top_centre, kind)
        pointer_cm = float(load_marker_settings().get("tagSizeCm") or 3.0)
        pdf_bytes = _draw_imobyl_frame_pdf(layout, pointer_cm, seed)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500
    except Exception:
        logging.exception("Failed to create the IMOBYL frame PDF")
        return jsonify({"ok": False, "error": "frame_export_failed"}), 500
    name = "imobyl-zoom-frame-A3.pdf" if kind == "zoom" else "imobyl-frame-A3.pdf"
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="%s"' % name},
    )


@app.route("/api/marker-sheet.pdf", methods=["GET"])
def api_marker_sheet_pdf():
    family = str(request.args.get("family") or "").strip()
    if family not in APRILTAG_GENERATOR_FAMILY_MAP:
        return jsonify({"ok": False, "error": "invalid_marker_family"}), 400
    try:
        size_cm = float(request.args.get("sizeCm"))
        if not math.isfinite(size_cm) or size_cm < 1 or size_cm > 20:
            raise ValueError("invalid_marker_size")
        entries = _marker_sheet_entries(request.args.get("entries"), family)
        pdf_bytes, page_name = _draw_marker_sheet_pdf(family, size_cm, entries)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500
    except Exception:
        logging.exception("Failed to create the marker-sheet PDF")
        return jsonify({"ok": False, "error": "marker_sheet_export_failed"}), 500

    size_label = f"{size_cm:g}".replace(".", "_")
    filename = f"markers_{family}_{size_label}cm_{page_name}.pdf"
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@app.route("/api/aruco-tuning", methods=["GET"])
def api_aruco_tuning_get():
    return jsonify({"ok": True, **aruco_tuning_payload()})


@app.route("/api/aruco-tuning", methods=["PUT"])
def api_aruco_tuning_set():
    global aruco_upscale_enabled
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_payload"}), 400
    changed = False
    # DetectorParameters controls — these are baked into the detector, so a change
    # requires a rebuild.
    for key, meta in ARUCO_TUNING_CONTROLS.items():
        if key not in payload:
            continue
        try:
            raw = int(round(float(payload[key])))
        except (TypeError, ValueError):
            continue
        raw = max(meta["min"], min(meta["max"], raw))
        if aruco_tuning_values[key] != raw:
            aruco_tuning_values[key] = raw
            changed = True
    # Second-pass upscale controls — read live by the detector, no rebuild needed.
    for key, meta in ARUCO_UPSCALE_CONTROLS.items():
        if key not in payload:
            continue
        try:
            raw = int(round(float(payload[key])))
        except (TypeError, ValueError):
            continue
        aruco_upscale_values[key] = max(meta["min"], min(meta["max"], raw))
    if "upEnabled" in payload:
        aruco_upscale_enabled = bool(payload["upEnabled"])
    if changed and detector_manager is not None:
        try:
            detector_manager.rebuild()
        except Exception as exc:
            print(f"[Detector] aruco-tuning rebuild failed: {exc}", flush=True)
    return jsonify({"ok": True, "changed": changed, **aruco_tuning_payload()})


@app.route("/api/apriltag-svg/<family>/<int:tag_id>.svg", methods=["GET"])
def api_apriltag_svg(family, tag_id):
    svg = generated_apriltag_svg(family, tag_id)
    if not svg:
        return Response("AprilTag not found", status=404, mimetype="text/plain")
    return Response(svg, mimetype="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@app.route("/api/renderer-config", methods=["GET"])
def api_renderer_config_load():
    renderer = "maplibre"
    if RENDERER_CONFIG_FILE.exists():
        try:
            data = json.loads(RENDERER_CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("renderer") in ("maplibre", "mapbox"):
                renderer = data["renderer"]
        except Exception:
            pass
    # Never return the token itself, only whether one is configured.
    return jsonify({"renderer": renderer, "hasMapboxToken": bool(load_mapbox_token())})


@app.route("/api/renderer-config", methods=["PUT"])
def api_renderer_config_save():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_payload"}), 400
    renderer = payload.get("renderer")
    if renderer not in ("maplibre", "mapbox"):
        return jsonify({"ok": False, "error": "invalid_renderer"}), 400
    try:
        # A non-empty mapboxToken (when provided) updates token.txt line 0.
        if "mapboxToken" in payload:
            token = str(payload.get("mapboxToken") or "").strip()
            if token:
                save_mapbox_token(token)
        RENDERER_CONFIG_FILE.parent.mkdir(exist_ok=True)
        RENDERER_CONFIG_FILE.write_text(
            json.dumps({"renderer": renderer}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return jsonify({"ok": True, "renderer": renderer, "hasMapboxToken": bool(load_mapbox_token())})
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500


@app.route("/api/calibration", methods=["DELETE"])
def api_calibration_clear():
    try:
        if CALIBRATION_FILE.exists():
            CALIBRATION_FILE.unlink()
    except Exception:
        return jsonify({"ok": False, "error": "delete_failed"}), 500
    return jsonify({"ok": True})


def _save_osmnx_network(geojson, bbox, network_type="walk"):
    """Persist the network plus the bbox that was REQUESTED.

    The saved geometry's own extent is always slightly tighter than the window
    that was asked for (streets rarely touch every edge), so inferring the bbox
    from the features on reload made the cache look like it did not cover the
    original request — and the next startup re-downloaded the same area. Storing
    the requested bbox explicitly is what makes the cache reusable.
    """
    try:
        payload = dict(geojson)
        payload["bbox"] = [float(v) for v in bbox]
        payload["networkType"] = str(network_type or "walk")
        OSMNX_NETWORK_FILE.parent.mkdir(exist_ok=True)
        OSMNX_NETWORK_FILE.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def _load_cached_osmnx_network():
    """Rebuild a networkx graph from a previously saved GeoJSON so the walking
    reach and shortest-path work after a restart without re-fetching."""
    if not OSMNX_NETWORK_FILE.exists():
        return
    try:
        import networkx as nx
        from shapely.geometry import LineString
    except Exception:
        return
    try:
        raw = json.loads(OSMNX_NETWORK_FILE.read_text(encoding="utf-8"))
    except Exception:
        return
    features = raw.get("features") if isinstance(raw, dict) else None
    if not isinstance(features, list) or not features:
        return

    graph = nx.MultiDiGraph(crs="EPSG:4326")
    nodes = {}
    min_lng = min_lat = float("inf")
    max_lng = max_lat = float("-inf")
    for feat in features:
        props = feat.get("properties") or {}
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if len(coords) < 2:
            continue
        try:
            u = int(props.get("u"))
            v = int(props.get("v"))
        except Exception:
            continue
        start = coords[0]
        end = coords[-1]
        nodes[u] = (float(start[0]), float(start[1]))
        nodes[v] = (float(end[0]), float(end[1]))
        for x, y in coords:
            fx, fy = float(x), float(y)
            if fx < min_lng: min_lng = fx
            if fx > max_lng: max_lng = fx
            if fy < min_lat: min_lat = fy
            if fy > max_lat: max_lat = fy
        length = props.get("length")
        if not isinstance(length, (int, float)):
            length = 0.0
            for i in range(len(coords) - 1):
                dx = coords[i + 1][0] - coords[i][0]
                dy = coords[i + 1][1] - coords[i][1]
                length += math.hypot(dx, dy) * 111000.0
        graph.add_edge(u, v, length=float(length), geometry=LineString(coords))

    for nid, (x, y) in nodes.items():
        graph.add_node(nid, x=x, y=y)

    if not math.isfinite(min_lng):
        return

    # Prefer the requested bbox saved alongside the features; fall back to the
    # geometry's own extent for files written before that was recorded.
    stored = raw.get("bbox") if isinstance(raw, dict) else None
    bbox = (min_lng, min_lat, max_lng, max_lat)
    if isinstance(stored, list) and len(stored) == 4:
        try:
            candidate = tuple(float(v) for v in stored)
            if all(math.isfinite(v) for v in candidate) and candidate[0] < candidate[2] and candidate[1] < candidate[3]:
                bbox = candidate
        except (TypeError, ValueError):
            pass
    network_type = str(raw.get("networkType") or "walk") if isinstance(raw, dict) else "walk"
    with osmnx_lock:
        OSMNX_GRAPH_CACHE["graph"] = graph
        OSMNX_GRAPH_CACHE["bbox"] = bbox
        OSMNX_GRAPH_CACHE["loadedAt"] = time.time()
        # Also register it in the multi-graph store, or /api/osmnx-ensure would
        # not see this graph and would re-download the same area on the first
        # request after every restart.
        OSMNX_GRAPH_STORE[_osmnx_bbox_key(*bbox, network_type)] = {"graph": graph, "bbox": bbox}
    print(f"[OSMnx] Loaded cached network: {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges")

    # Build the undirected view now, in the background, rather than making the
    # first walking-reach request pay for it (~4 s on a 27k-node network).
    def _warm_undirected():
        try:
            graph._reach_undirected = graph.to_undirected()
            # ox.distance.nearest_nodes() builds a spatial index on first use
            # (~1.8 s here). Trigger it now with a throwaway query so the first
            # real request does not pay for it either.
            try:
                import osmnx as ox
                ox.distance.nearest_nodes(graph, (bbox[0] + bbox[2]) / 2.0,
                                          (bbox[1] + bbox[3]) / 2.0)
            except Exception:
                pass
            print("[OSMnx] Reach index ready", flush=True)
        except Exception:
            pass

    threading.Thread(target=_warm_undirected, daemon=True).start()


def _bbox_contains(outer, point, margin=0.0):
    if not outer:
        return False
    min_lng, min_lat, max_lng, max_lat = outer
    lng, lat = point
    return (
        (min_lng - margin) <= lng <= (max_lng + margin)
        and (min_lat - margin) <= lat <= (max_lat + margin)
    )


def _graph_to_geojson(graph):
    import networkx as nx

    features = []
    for u, v, data in graph.edges(data=True):
        geom = data.get("geometry")
        if geom is not None:
            coords = [[float(x), float(y)] for x, y in geom.coords]
        else:
            nu = graph.nodes[u]
            nv = graph.nodes[v]
            coords = [[float(nu["x"]), float(nu["y"])], [float(nv["x"]), float(nv["y"])]]
        length = data.get("length")
        try:
            length_val = float(length) if length is not None else None
        except Exception:
            length_val = None
        features.append({
            "type": "Feature",
            "properties": {
                "u": int(u),
                "v": int(v),
                "length": length_val,
                "highway": data.get("highway") if isinstance(data.get("highway"), str) else None,
            },
            "geometry": {"type": "LineString", "coordinates": coords},
        })
    return {"type": "FeatureCollection", "features": features}


@app.route("/api/osmnx-fetch", methods=["POST"])
def api_osmnx_fetch():
    try:
        import osmnx as ox
    except Exception as exc:
        return jsonify({"ok": False, "error": "osmnx_unavailable", "detail": str(exc)}), 500

    payload = request.get_json(silent=True) or {}
    try:
        min_lng = float(payload["minLng"])
        min_lat = float(payload["minLat"])
        max_lng = float(payload["maxLng"])
        max_lat = float(payload["maxLat"])
    except Exception:
        return jsonify({"ok": False, "error": "invalid_bbox"}), 400
    if not all(math.isfinite(v) for v in (min_lng, min_lat, max_lng, max_lat)):
        return jsonify({"ok": False, "error": "invalid_bbox"}), 400
    if min_lng >= max_lng or min_lat >= max_lat:
        return jsonify({"ok": False, "error": "invalid_bbox"}), 400

    network_type = str(payload.get("networkType") or "walk").strip() or "walk"

    try:
        # osmnx 2.x uses (left, bottom, right, top); older versions use (north, south, east, west).
        try:
            graph = ox.graph_from_bbox(
                bbox=(min_lng, min_lat, max_lng, max_lat),
                network_type=network_type,
                simplify=True,
            )
        except TypeError:
            graph = ox.graph_from_bbox(
                north=max_lat, south=min_lat, east=max_lng, west=min_lng,
                network_type=network_type, simplify=True,
            )
    except Exception as exc:
        return jsonify({"ok": False, "error": "osmnx_fetch_failed", "detail": str(exc)}), 502

    geojson = _graph_to_geojson(graph)
    _save_osmnx_network(geojson, (min_lng, min_lat, max_lng, max_lat), network_type)

    _osmnx_remember_graph(
        _osmnx_bbox_key(min_lng, min_lat, max_lng, max_lat, network_type),
        graph, (min_lng, min_lat, max_lng, max_lat),
    )

    return jsonify({
        "ok": True,
        "bbox": [min_lng, min_lat, max_lng, max_lat],
        "nodes": int(graph.number_of_nodes()),
        "edges": int(graph.number_of_edges()),
        "geojson": geojson,
    })


def _osmnx_bbox_key(min_lng, min_lat, max_lng, max_lat, network_type):
    return f"{network_type}|{min_lng:.6f},{min_lat:.6f},{max_lng:.6f},{max_lat:.6f}"


def _osmnx_remember_graph(key, graph, bbox):
    """Keep recently built graphs in memory, most-recent last.

    OSMnx's own cache stores the raw Overpass JSON, which still has to be
    re-parsed into a graph on every call (~4.5 s for a 3.6k-node walk network,
    even on a cache hit). Holding the built graph avoids repeating that, so
    returning to a bbox already visited this session is instant.
    """
    with osmnx_lock:
        OSMNX_GRAPH_STORE.pop(key, None)
        OSMNX_GRAPH_STORE[key] = {"graph": graph, "bbox": bbox}
        while len(OSMNX_GRAPH_STORE) > OSMNX_GRAPH_STORE_MAX:
            OSMNX_GRAPH_STORE.pop(next(iter(OSMNX_GRAPH_STORE)))
        OSMNX_GRAPH_CACHE["graph"] = graph
        OSMNX_GRAPH_CACHE["bbox"] = bbox
        OSMNX_GRAPH_CACHE["loadedAt"] = time.time()


def _osmnx_find_cached_graph(min_lng, min_lat, max_lng, max_lat, network_type):
    """Return a cached graph whose bbox fully CONTAINS the requested one.

    A larger window is a valid substitute for a smaller one, so panning inside
    an area already fetched needs no work at all.
    """
    exact = _osmnx_bbox_key(min_lng, min_lat, max_lng, max_lat, network_type)
    with osmnx_lock:
        entry = OSMNX_GRAPH_STORE.get(exact)
        if entry:
            return entry, exact
        for key, value in reversed(list(OSMNX_GRAPH_STORE.items())):
            if not key.startswith(network_type + "|"):
                continue
            b = value.get("bbox")
            if not b:
                continue
            if b[0] <= min_lng and b[1] <= min_lat and b[2] >= max_lng and b[3] >= max_lat:
                return value, key
    return None, exact


@app.route("/api/osmnx-ensure", methods=["POST"])
def api_osmnx_ensure():
    """Make a walking graph available for the given bbox, reusing any cached one.

    Unlike /api/osmnx-fetch this never serialises the network to GeoJSON — the
    isochrone caller only needs the graph to exist server-side, and skipping
    that step is most of the saving on a repeat request.
    """
    payload = request.get_json(silent=True) or {}
    try:
        min_lng = float(payload["minLng"]); min_lat = float(payload["minLat"])
        max_lng = float(payload["maxLng"]); max_lat = float(payload["maxLat"])
    except Exception:
        return jsonify({"ok": False, "error": "invalid_bbox"}), 400
    if not all(math.isfinite(v) for v in (min_lng, min_lat, max_lng, max_lat)):
        return jsonify({"ok": False, "error": "invalid_bbox"}), 400
    if min_lng >= max_lng or min_lat >= max_lat:
        return jsonify({"ok": False, "error": "invalid_bbox"}), 400
    network_type = str(payload.get("networkType") or "walk").strip() or "walk"

    entry, key = _osmnx_find_cached_graph(min_lng, min_lat, max_lng, max_lat, network_type)
    if entry is not None:
        with osmnx_lock:
            OSMNX_GRAPH_CACHE["graph"] = entry["graph"]
            OSMNX_GRAPH_CACHE["bbox"] = entry["bbox"]
            OSMNX_GRAPH_CACHE["loadedAt"] = time.time()
        return jsonify({
            "ok": True, "cached": True, "bbox": list(entry["bbox"]),
            "nodes": int(entry["graph"].number_of_nodes()),
        })

    try:
        import osmnx as ox
    except Exception as exc:
        return jsonify({"ok": False, "error": "osmnx_unavailable", "detail": str(exc)}), 500
    try:
        try:
            graph = ox.graph_from_bbox(
                bbox=(min_lng, min_lat, max_lng, max_lat),
                network_type=network_type, simplify=True,
            )
        except TypeError:
            graph = ox.graph_from_bbox(
                north=max_lat, south=min_lat, east=max_lng, west=min_lng,
                network_type=network_type, simplify=True,
            )
    except Exception as exc:
        return jsonify({"ok": False, "error": "osmnx_fetch_failed", "detail": str(exc)}), 502

    bbox = (min_lng, min_lat, max_lng, max_lat)
    _osmnx_remember_graph(key, graph, bbox)
    # Persist so the next server start reuses this instead of re-downloading.
    # Only widen the on-disk copy: a larger saved window serves more requests.
    try:
        existing = None
        if OSMNX_NETWORK_FILE.exists():
            try:
                previous = json.loads(OSMNX_NETWORK_FILE.read_text(encoding="utf-8"))
                existing = previous.get("bbox") if isinstance(previous, dict) else None
            except (OSError, ValueError):
                existing = None
        area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
        keep = False
        if isinstance(existing, list) and len(existing) == 4:
            old = [float(v) for v in existing]
            keep = (old[0] <= bbox[0] and old[1] <= bbox[1]
                    and old[2] >= bbox[2] and old[3] >= bbox[3]
                    and (old[2] - old[0]) * (old[3] - old[1]) >= area)
        if not keep:
            _save_osmnx_network(_graph_to_geojson(graph), bbox, network_type)
    except Exception:
        pass
    return jsonify({
        "ok": True, "cached": False, "bbox": list(bbox),
        "nodes": int(graph.number_of_nodes()),
    })


@app.route("/api/walk-reach", methods=["POST"])
def api_walk_reach():
    """n-minute walking reach, preferring Mapbox and falling back to OSMnx.

    Mapbox answers in ~0.1 s with no local street network, which avoids the
    multi-second Overpass download the OSMnx path needs the first time it sees
    an area. The request is proxied here rather than called from the browser so
    the token stays server-side.

    Falls back to the OSMnx implementation whenever Mapbox is unavailable (no
    token, offline, quota) so the feature still works on a workshop machine
    with no internet.
    """
    payload = request.get_json(silent=True) or {}
    origin = payload.get("origin") or {}
    try:
        lng = float(origin["lng"])
        lat = float(origin["lat"])
    except Exception:
        return jsonify({"ok": False, "error": "invalid_origin"}), 400
    if not (math.isfinite(lng) and math.isfinite(lat)):
        return jsonify({"ok": False, "error": "invalid_origin"}), 400
    try:
        minutes = int(round(float(payload.get("minutes", 10))))
    except Exception:
        minutes = 10
    # Mapbox accepts 1..60 minutes; clamp rather than error so the slider's own
    # range is the only thing the user has to respect.
    minutes = max(1, min(60, minutes))
    profile = "walking"

    token = load_mapbox_token()
    if token and not payload.get("forceOsmnx"):
        query = urllib.parse.urlencode({
            "contours_minutes": str(minutes),
            "polygons": "true",
            "denoise": "1",
            "access_token": token,
        })
        url = (f"https://api.mapbox.com/isochrone/v1/mapbox/{profile}/"
               f"{lng:.6f},{lat:.6f}?{query}")
        try:
            with urllib.request.urlopen(url, timeout=12) as response:
                data = json.loads(response.read().decode("utf-8"))
            if isinstance(data, dict) and data.get("features"):
                return jsonify({
                    "ok": True, "source": "mapbox", "minutes": minutes,
                    "geojson": {"type": "FeatureCollection", "features": data["features"]},
                })
            mapbox_error = "empty_response"
        except urllib.error.HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode("utf-8", "replace")[:200]
            except Exception:
                pass
            mapbox_error = f"http_{exc.code}: {body}"
        except Exception as exc:
            mapbox_error = f"{type(exc).__name__}: {exc}"
        print(f"[Reach] Mapbox failed ({mapbox_error}); falling back to OSMnx", flush=True)
    else:
        mapbox_error = "no_token" if not token else "forced_osmnx"

    # ---- fallback: local OSMnx graph -----------------------------------
    with osmnx_lock:
        graph = OSMNX_GRAPH_CACHE.get("graph")
        bbox = OSMNX_GRAPH_CACHE.get("bbox")
    if graph is None or not _bbox_contains(bbox, (lng, lat), 0.0005):
        return jsonify({
            "ok": False, "error": "no_local_network",
            "mapboxError": mapbox_error,
        }), 409

    try:
        with app.test_request_context(
            "/api/osmnx-isochrone", method="POST",
            json={"origin": {"lng": lng, "lat": lat}, "minutes": minutes},
        ):
            response = api_osmnx_isochrone()
        body = response[0] if isinstance(response, tuple) else response
        data = body.get_json()
        if not data.get("ok"):
            return jsonify({"ok": False, "error": data.get("error") or "reach_failed",
                            "mapboxError": mapbox_error}), 502
        return jsonify({
            "ok": True, "source": "osmnx", "minutes": minutes,
            "geojson": data["geojson"], "reachableNodes": data.get("reachableNodes"),
            "mapboxError": mapbox_error,
        })
    except Exception as exc:
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}",
                        "mapboxError": mapbox_error}), 500


@app.route("/api/osmnx-shortest-path", methods=["POST"])
def api_osmnx_shortest_path():
    payload = request.get_json(silent=True) or {}
    a = payload.get("a") or {}
    b = payload.get("b") or {}
    try:
        a_lng = float(a["lng"]); a_lat = float(a["lat"])
        b_lng = float(b["lng"]); b_lat = float(b["lat"])
    except Exception:
        return jsonify({"ok": False, "error": "invalid_points"}), 400
    if not all(math.isfinite(v) for v in (a_lng, a_lat, b_lng, b_lat)):
        return jsonify({"ok": False, "error": "invalid_points"}), 400

    with osmnx_lock:
        graph = OSMNX_GRAPH_CACHE.get("graph")
        bbox = OSMNX_GRAPH_CACHE.get("bbox")

    if graph is None:
        return jsonify({"ok": False, "error": "no_graph_cached"}), 409

    # Require both endpoints to fall inside the fetched bbox (with small margin)
    # so the frontend can cleanly fall back to the external API otherwise.
    margin = 0.0005
    if not (_bbox_contains(bbox, (a_lng, a_lat), margin) and _bbox_contains(bbox, (b_lng, b_lat), margin)):
        return jsonify({"ok": False, "error": "out_of_bounds"}), 404

    try:
        import osmnx as ox
        import networkx as nx
    except Exception as exc:
        return jsonify({"ok": False, "error": "osmnx_unavailable", "detail": str(exc)}), 500

    try:
        node_a = ox.distance.nearest_nodes(graph, a_lng, a_lat)
        node_b = ox.distance.nearest_nodes(graph, b_lng, b_lat)
    except Exception as exc:
        return jsonify({"ok": False, "error": "nearest_node_failed", "detail": str(exc)}), 500

    try:
        path_nodes = nx.shortest_path(graph, node_a, node_b, weight="length")
    except nx.NetworkXNoPath:
        return jsonify({"ok": False, "error": "no_path"}), 404
    except Exception as exc:
        return jsonify({"ok": False, "error": "shortest_path_failed", "detail": str(exc)}), 500

    coords = [[a_lng, a_lat]]
    for i in range(len(path_nodes) - 1):
        u = path_nodes[i]
        v = path_nodes[i + 1]
        data = graph.get_edge_data(u, v)
        if not data:
            continue
        # MultiDiGraph: pick the edge with the shortest length
        best = min(data.values(), key=lambda d: d.get("length", float("inf")))
        geom = best.get("geometry")
        if geom is not None:
            seg = [[float(x), float(y)] for x, y in geom.coords]
        else:
            nu = graph.nodes[u]; nv = graph.nodes[v]
            seg = [[float(nu["x"]), float(nu["y"])], [float(nv["x"]), float(nv["y"])]]
        # Avoid duplicating the joining vertex
        if coords and seg and coords[-1] == seg[0]:
            coords.extend(seg[1:])
        else:
            coords.extend(seg)
    coords.append([b_lng, b_lat])

    total_length = 0.0
    for i in range(len(path_nodes) - 1):
        data = graph.get_edge_data(path_nodes[i], path_nodes[i + 1]) or {}
        if data:
            best = min(data.values(), key=lambda d: d.get("length", float("inf")))
            length = best.get("length")
            if isinstance(length, (int, float)) and math.isfinite(length):
                total_length += float(length)

    return jsonify({
        "ok": True,
        "geometry": {"type": "LineString", "coordinates": coords},
        "distanceMeters": total_length,
        "nodes": len(path_nodes),
    })


@app.route("/api/osmnx-isochrone", methods=["POST"])
def api_osmnx_isochrone():
    payload = request.get_json(silent=True) or {}
    origin = payload.get("origin") or {}
    try:
        lng = float(origin["lng"])
        lat = float(origin["lat"])
    except Exception:
        return jsonify({"ok": False, "error": "invalid_origin"}), 400
    if not (math.isfinite(lng) and math.isfinite(lat)):
        return jsonify({"ok": False, "error": "invalid_origin"}), 400

    try:
        minutes = float(payload.get("minutes", 15))
    except Exception:
        minutes = 15.0
    if minutes <= 0 or minutes > 180:
        return jsonify({"ok": False, "error": "invalid_minutes"}), 400

    try:
        walking_speed_mps = float(payload.get("walkingSpeedMps", 1.4))  # ~5 km/h
    except Exception:
        walking_speed_mps = 1.4
    if walking_speed_mps <= 0:
        walking_speed_mps = 1.4

    with osmnx_lock:
        graph = OSMNX_GRAPH_CACHE.get("graph")
        bbox = OSMNX_GRAPH_CACHE.get("bbox")

    if graph is None:
        return jsonify({"ok": False, "error": "no_graph_cached"}), 409

    # Require origin to be inside the fetched bbox so the reachable area is not
    # truncated by the fetch window; otherwise the frontend falls back to the API.
    margin = 0.0005
    if not _bbox_contains(bbox, (lng, lat), margin):
        return jsonify({"ok": False, "error": "out_of_bounds"}), 404

    # Also guarantee that the 15-min reach fits inside the fetched bbox. A rough
    # radius estimate keeps this cheap: minutes * 60s * speed m/s, converted to
    # degrees. If the ball extends past the bbox, the polygon would be clipped.
    max_radius_m = minutes * 60.0 * walking_speed_mps
    deg_lat = max_radius_m / 111000.0
    deg_lng = max_radius_m / (111000.0 * max(0.1, math.cos(math.radians(lat))))
    if bbox is not None:
        min_lng, min_lat, max_lng, max_lat = bbox
        if (lng - deg_lng) < min_lng or (lng + deg_lng) > max_lng \
                or (lat - deg_lat) < min_lat or (lat + deg_lat) > max_lat:
            return jsonify({"ok": False, "error": "out_of_bounds"}), 404

    try:
        import osmnx as ox
        import networkx as nx
        from shapely.geometry import Point, MultiPoint, mapping
        try:
            from shapely import concave_hull as _concave_hull
        except Exception:
            _concave_hull = None
    except Exception as exc:
        return jsonify({"ok": False, "error": "osmnx_unavailable", "detail": str(exc)}), 500

    try:
        origin_node = ox.distance.nearest_nodes(graph, lng, lat)
    except Exception as exc:
        return jsonify({"ok": False, "error": "nearest_node_failed", "detail": str(exc)}), 500

    budget_seconds = minutes * 60.0

    # Use an undirected view for reach so one-way edges don't cut off the area
    # unnaturally for a pedestrian walking budget.
    # to_undirected() deep-copies the whole graph, which on a large cached
    # network costs seconds on EVERY request. The undirected view depends only
    # on the graph, so memoise it on the object itself.
    ug = getattr(graph, "_reach_undirected", None)
    if ug is None:
        ug = graph.to_undirected() if graph.is_multigraph() or graph.is_directed() else graph
        try:
            graph._reach_undirected = ug
        except Exception:
            pass

    # Weight function: travel time in seconds from edge length.
    def _time_weight(u, v, data):
        # MultiGraph: data is a dict keyed by parallel edges
        if isinstance(data, dict) and data and all(isinstance(k, int) for k in data.keys()):
            lengths = [d.get("length") for d in data.values() if isinstance(d.get("length"), (int, float))]
            if not lengths:
                return None
            return min(lengths) / walking_speed_mps
        length = data.get("length") if isinstance(data, dict) else None
        if not isinstance(length, (int, float)):
            return None
        return length / walking_speed_mps

    try:
        costs = nx.single_source_dijkstra_path_length(
            ug, origin_node, cutoff=budget_seconds, weight=_time_weight
        )
    except Exception as exc:
        return jsonify({"ok": False, "error": "dijkstra_failed", "detail": str(exc)}), 500

    points = []
    for node_id in costs.keys():
        node_data = graph.nodes.get(node_id)
        if not node_data:
            continue
        try:
            points.append(Point(float(node_data["x"]), float(node_data["y"])))
        except Exception:
            continue

    if len(points) < 3:
        return jsonify({"ok": False, "error": "insufficient_coverage"}), 404

    multipoint = MultiPoint(points)
    polygon = None
    if _concave_hull is not None:
        try:
            polygon = _concave_hull(multipoint, ratio=0.35)
        except Exception:
            polygon = None
    if polygon is None or polygon.is_empty or polygon.geom_type not in ("Polygon", "MultiPolygon"):
        polygon = multipoint.convex_hull
    if polygon.geom_type == "LineString":
        polygon = polygon.buffer(1e-6)

    geojson = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"contour": minutes, "metric": "time"},
            "geometry": mapping(polygon),
        }],
    }
    return jsonify({
        "ok": True,
        "minutes": minutes,
        "walkingSpeedMps": walking_speed_mps,
        "reachableNodes": len(points),
        "geojson": geojson,
    })


def start_workers():
    threads = [
        threading.Thread(target=camera_loop, daemon=True),
        threading.Thread(target=detector_loop, daemon=True),
        threading.Thread(target=auto_exposure_loop, daemon=True),
    ]
    for t in threads:
        t.start()
    return threads


def _parse_audio_device_selector(value):
    if value is None:
        return None
    text = str(value).strip()
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

    devices = sd.query_devices()
    hostapis = sd.query_hostapis()
    for index, device in enumerate(devices):
        if int(device.get("max_input_channels") or 0) <= 0:
            continue
        hostapi = hostapis[int(device.get("hostapi") or 0)].get("name", "unknown")
        print(
            f"{index}: {device.get('name')} | {hostapi} "
            f"inputs={int(device.get('max_input_channels') or 0)} "
            f"default_samplerate={int(float(device.get('default_samplerate') or 0))}"
        )


def main():
    detected_cores = os.cpu_count() or 2
    default_apriltag_threads = max(1, int(round(detected_cores / 2.0)))
    
    parser = argparse.ArgumentParser(description="Digital Mapping Workshop AprilTag backend")
    parser.add_argument("--source", default=None, help="Camera source (0, 1, or URL). If omitted, auto-discovers :8080/video")
    parser.add_argument("--auto-exposure", dest="auto_exposure", action="store_true", default=False,
                        help="Closed-loop highlight-metered exposure for an IP Webcam source: keeps the "
                             "bright projection just below clipping so tag borders stay readable (off by "
                             "default; pass this flag to enable; overrides manual exposure while active; "
                             "no-op for non-IP sources)")
    parser.add_argument("--no-auto-exposure", dest="auto_exposure", action="store_false",
                        help="Disable automatic exposure control (already the default)")
    parser.add_argument("--auto-exposure-target", type=float, default=205.0,
                        help="Auto-exposure highlight target (p95 luminance 0-255). Lower = darker / safer against clipping")
    parser.add_argument("--auto-exposure-floor", type=float, default=100.0,
                        help="Auto-exposure anti-darkening floor (p75 luminance): never darken below this, so bright UI/glare can't spiral the scene to black")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument(
        "--port",
        type=int,
        default=5000,
        help="Preferred local port. If occupied, the app automatically uses the next available port.",
    )
    parser.add_argument("--detector", choices=["pupil", "aruco"], default="aruco",
                        help="Detection backend: 'aruco' (default, OpenCV ArUco) or 'pupil' (pupil_apriltags)")
    parser.add_argument(
        "--apriltag-family",
        default=None,
        nargs="+",
        help="Initial AprilTag family/families. Defaults to marker settings; marker settings changes update pupil/aruco detectors live.",
    )
    parser.add_argument("--apriltag-threads", type=int, default=default_apriltag_threads + 5)
    parser.add_argument("--apriltag-quad-decimate", type=float, default=1.0)
    parser.add_argument("--apriltag-quad-sigma", type=float, default=0.0)
    parser.add_argument("--apriltag-refine-edges", dest="apriltag_refine_edges", action="store_true")
    parser.add_argument("--no-apriltag-refine-edges", dest="apriltag_refine_edges", action="store_false")
    parser.set_defaults(apriltag_refine_edges=True)
    parser.add_argument("--apriltag-decode-sharpening", type=float, default=0.25)
    parser.add_argument("--aruco-min-area", type=float, default=200,
                        help="Minimum tag area in px² for ArUco backend (filters small false positives)")
    parser.add_argument("--no-browser", action="store_true",
                        help="Don't auto-open the camera page in a browser when the server starts")
    parser.add_argument("--kiosk", dest="kiosk", action="store_true",
                        help="Open in Chrome/Edge fullscreen app mode (already the default; kept for compatibility)")
    parser.add_argument("--windowed", "--no-kiosk", dest="kiosk", action="store_false",
                        help="Open in a normal browser window instead of the default fullscreen app mode")
    parser.set_defaults(kiosk=True)
    parser.add_argument("--cloudflare-tunnel", dest="cloudflare_tunnel", action="store_true",
                        help="Start a public Cloudflare Quick Tunnel for phone access (off by default)")
    parser.add_argument("--no-cloudflare-tunnel", dest="cloudflare_tunnel", action="store_false",
                        help="Disable the Cloudflare Quick Tunnel (already the default; kept for compatibility)")
    parser.set_defaults(cloudflare_tunnel=False)
    parser.add_argument("--no-recording-hotkey", action="store_true",
                        help="Disable Ctrl+Shift+R backend camera+voice recording hotkey")
    parser.add_argument("--recording-fps", type=float, default=20.0,
                        help="FPS for backend camera recordings")
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
    args = parser.parse_args()

    if args.list_audio_devices:
        print_audio_devices()
        return

    recording_audio_device = _parse_audio_device_selector(args.recording_audio_device)

    source = parse_source(args.source)
    if source is None:
        source = discover_camera_source_on_port(port=8080, path="/video")
        if source is None:
            print("[Camera] No IP camera found on :8080/video — starting without a camera. Pass --source 0/1/URL to attach one.")

    init_camera(source)

    global auto_exposure_enabled, auto_exposure_target, auto_exposure_floor
    auto_exposure_enabled = bool(args.auto_exposure)
    auto_exposure_target = float(args.auto_exposure_target)
    auto_exposure_floor = float(args.auto_exposure_floor)

    global detector_manager
    initial_families = normalize_apriltag_families(args.apriltag_family)
    if not initial_families:
        initial_families = [marker_settings_family()]
    detector_manager = DetectorManager(args, initial_families)

    _load_cached_osmnx_network()

    start_workers()
    # One shared recorder instance, driven by BOTH the Ctrl+Shift+R hotkey and the
    # /api/record endpoint (so the map page's Record button can control it too).
    global camera_recorder
    camera_recorder = CameraVoiceRecorder(
        fps=args.recording_fps,
        audio_device=recording_audio_device,
        output_format=args.recording_output,
        keep_raw=args.keep_recording_raw,
        segment_seconds=max(10.0, float(args.recording_segment_minutes) * 60.0),
        show_indicator=not args.no_recording_indicator,
    )
    if not args.no_recording_hotkey:
        start_recording_hotkey(camera_recorder)

    selected_port = find_available_port(args.host, args.port)
    if selected_port != args.port:
        print(f"[Backend] port {args.port} is unavailable; using {selected_port}")
    display_host = "127.0.0.1" if args.host in ("0.0.0.0", "", None) else args.host
    print(f"[Backend] http://{display_host}:{selected_port}")
    print(f"[Camera] source: {source if source is not None else '(none)'}")

    # The tunnel is started before any page can open, so a page that asks
    # straight away sees "starting" and waits, never a "disabled" that is
    # about to stop being true.
    if args.cloudflare_tunnel:
        start_quick_tunnel(selected_port)
    else:
        update_quick_tunnel_state(status="disabled", enabled=False)
    if not args.no_browser:
        open_browser_when_ready(args.host, selected_port, kiosk=args.kiosk)

    # Silence per-request access logs from the Flask dev server.
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    try:
        app.run(host=args.host, port=selected_port, debug=False, use_reloader=False, threaded=True)
    finally:
        shutdown_event.set()
        stop_quick_tunnel()


if __name__ == "__main__":
    main()
