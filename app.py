import argparse
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
import wave
import webbrowser
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, Response, jsonify, redirect, request, send_from_directory, stream_with_context
from pupil_apriltags import Detector

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"   # all browser-served files (HTML pages, src/, images/, vendor/)
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
RENDERER_CONFIG_FILE = ROOT / "data" / "renderer_config.json"
MARKER_SETTINGS_FILE = ROOT / "data" / "marker_settings.json"
AUDIO_CHUNKS_DIR = ROOT / "audio_chunks"
BACKEND_RECORDINGS_DIR = ROOT / "backend_recordings"
camera_recorder = None   # CameraVoiceRecorder instance (created in main); shared by the Ctrl+Shift+R hotkey and /api/record
OSMNX_NETWORK_FILE = ROOT / "data" / "osmnx_network.geojson"
OSMNX_GRAPH_CACHE = {"graph": None, "bbox": None, "loadedAt": 0.0}
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
    {"key": "draw-1", "group": "Drawing", "tool": "draw", "label": "Drawing 1", "tagId": 11, "color": "#ff5b5b", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "draw-2", "group": "Drawing", "tool": "draw", "label": "Drawing 2", "tagId": 12, "color": "#3b82f6", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "draw-3", "group": "Drawing", "tool": "draw", "label": "Drawing 3", "tagId": 13, "color": "#22cc66", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "draw-4", "group": "Drawing", "tool": "draw", "label": "Drawing 4", "tagId": 14, "color": "#111111", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "eraser-1", "group": "Tools", "tool": "eraser", "label": "Eraser", "tagId": 20, "tagId2": 19, "color": "", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "route-origin", "group": "Shortest-path", "tool": "route-origin", "label": "Route start", "tagId": 9, "color": ""},
    {"key": "route-dest", "group": "Shortest-path", "tool": "route-dest", "label": "Route end", "tagId": 10, "color": ""},
    {"key": "isochrone-5", "group": "Analysis", "tool": "isochrone", "label": "Isochrone 5 min", "tagId": 38, "color": "", "minutes": 5},
    {"key": "isochrone-15", "group": "Analysis", "tool": "isochrone", "label": "Isochrone 15 min", "tagId": 37, "color": "", "minutes": 15},
    {"key": "isovist-1", "group": "Analysis", "tool": "isovist", "label": "Isovist", "tagId": 39, "color": ""},
    {"key": "drag-1", "group": "Tools", "tool": "drag", "label": "Dragging", "tagId": 24, "color": ""},
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
MARKER_MULTI_TAG_TOOLS = {"draw", "eraser"}
MARKER_OFFSET_TOOLS = {"draw", "eraser"}
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
        default_label = "Drawing" if tool == "draw" else "Post-it"
        tag_id = sanitize_marker_tag_id(src.get("tagId"), allowed_ids)
        color = sanitize_marker_color(src.get("color"), "#ff5b5b") if tool in MARKER_COLOR_TOOLS else ""
        label = str(src.get("label") or default_label).strip()[:80]
        extra = {"key": key, "group": group, "tool": tool, "label": label, "tagId": tag_id, "color": color}
        if tool in MARKER_MULTI_TAG_TOOLS:
            tag_id2 = sanitize_marker_tag_id(src.get("tagId2"), allowed_ids)
            extra["tagId2"] = tag_id2 if tag_id2 != tag_id else None
        if tool in MARKER_OFFSET_TOOLS:
            extra["offsetCm"] = sanitize_marker_offset_cm(src.get("offsetCm"), DEFAULT_DRAW_OFFSET_CM)
        slots.append(extra)

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
    return send_from_directory(WEB_DIR, "home.html")


@app.route("/home")
def home_page():
    return send_from_directory(WEB_DIR, "home.html")


@app.route("/settings")
def settings_page():
    return send_from_directory(WEB_DIR, "settings.html")


@app.route("/marker")
def marker_page():
    return send_from_directory(WEB_DIR, "marker.html")


@app.route("/map")
def map_page():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/paper-test")
def paper_test_page():
    # Standalone experiment: digitize paths drawn on a blank paper via two
    # 4-corner picks (map quad + camera paper quad) and a homography.
    return send_from_directory(WEB_DIR, "paper-test.html")


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
    "exposure":     {"label": "Exposure (ms)", "type": "range", "min": 5, "max": 300, "step": 5, "default": 50, "uvc": "CAP_PROP_EXPOSURE"},
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
                    camera_control_values["exposure"] = max(5, min(300, int(round(float(cur["exposure_ns"]) / 1e6))))
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
        return jsonify({"ok": True, "sessions": []})
    files = sorted(
        [f.name for f in SESSIONS_DIR.glob("session_*.json")],
        reverse=True,
    )
    return jsonify({"ok": True, "sessions": files})


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


def _load_cached_osmnx_network():
    """Rebuild a networkx graph from a previously saved GeoJSON so shortest-path
    works after a restart without re-fetching from Overpass."""
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

    with osmnx_lock:
        OSMNX_GRAPH_CACHE["graph"] = graph
        OSMNX_GRAPH_CACHE["bbox"] = (min_lng, min_lat, max_lng, max_lat)
        OSMNX_GRAPH_CACHE["loadedAt"] = time.time()
    print(f"[OSMnx] Loaded cached network: {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges")


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
    try:
        OSMNX_NETWORK_FILE.parent.mkdir(exist_ok=True)
        OSMNX_NETWORK_FILE.write_text(
            json.dumps(geojson, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        pass

    with osmnx_lock:
        OSMNX_GRAPH_CACHE["graph"] = graph
        OSMNX_GRAPH_CACHE["bbox"] = (min_lng, min_lat, max_lng, max_lat)
        OSMNX_GRAPH_CACHE["loadedAt"] = time.time()

    return jsonify({
        "ok": True,
        "bbox": [min_lng, min_lat, max_lng, max_lat],
        "nodes": int(graph.number_of_nodes()),
        "edges": int(graph.number_of_edges()),
        "geojson": geojson,
    })


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
    ug = graph.to_undirected() if graph.is_multigraph() or graph.is_directed() else graph

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
    parser.add_argument("--port", type=int, default=5000)
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
    parser.add_argument("--kiosk", action="store_true",
                        help="Open in Chrome/Edge kiosk mode (fullscreen, no browser chrome). Exit with Alt+F4.")
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

    print(f"[Backend] http://{args.host}:{args.port}")
    print(f"[Camera] source: {source if source is not None else '(none)'}")

    if not args.no_browser:
        open_browser_when_ready(args.host, args.port, kiosk=args.kiosk)
    if args.cloudflare_tunnel:
        start_quick_tunnel(args.port)
    else:
        update_quick_tunnel_state(status="disabled", enabled=False)

    # Silence per-request access logs from the Flask dev server.
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    try:
        app.run(host=args.host, port=args.port, debug=False, use_reloader=False, threaded=True)
    finally:
        shutdown_event.set()
        stop_quick_tunnel()


if __name__ == "__main__":
    main()
