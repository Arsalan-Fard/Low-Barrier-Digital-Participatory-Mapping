"""Saved workshop sessions (read by the Results page), timelines, expo sessions and custom map objects."""
import json
import math
import time

from flask import Blueprint, jsonify, request

from . import config
from .helpers import sanitize_storage_name

bp = Blueprint("sessions", __name__)


def _save_session_file(folder, prefix, payload):
    """Write `payload` as <prefix>_<sessionId>.json; a stable sessionId makes autosaves overwrite one file."""
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    folder.mkdir(parents=True, exist_ok=True)
    session_id = sanitize_storage_name(payload.get("sessionId"), "") or time.strftime("%Y%m%d_%H%M%S")
    filename = f"{prefix}_{session_id}.json"
    try:
        (folder / filename).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500
    return jsonify({"ok": True, "filename": filename})


def _valid_session_name(prefix, filename):
    return filename.startswith(prefix + "_") and filename.endswith(".json") and "/" not in filename and "\\" not in filename


def _load_session_file(folder, prefix, filename):
    if not _valid_session_name(prefix, filename):
        return jsonify({"ok": False, "error": "invalid_filename"}), 400
    path = folder / filename
    if not path.is_file():
        return jsonify({"ok": False, "error": "not_found"}), 404
    try:
        return jsonify(json.loads(path.read_text(encoding="utf-8")))
    except Exception:
        return jsonify({"ok": False, "error": "read_failed"}), 500


def _list_session_files(folder, prefix):
    if not folder.exists():
        return []
    return sorted((path.name for path in folder.glob(f"{prefix}_*.json")), reverse=True)


@bp.route("/api/session", methods=["POST"])
def api_session_save():
    return _save_session_file(config.SESSIONS_DIR, "session", request.get_json(silent=True))


@bp.route("/api/session/<filename>", methods=["GET"])
def api_session_load(filename):
    return _load_session_file(config.SESSIONS_DIR, "session", filename)


@bp.route("/api/session/<filename>", methods=["PUT"])
def api_session_update(filename):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    if not _valid_session_name("session", filename):
        return jsonify({"ok": False, "error": "invalid_filename"}), 400
    config.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        (config.SESSIONS_DIR / filename).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500
    return jsonify({"ok": True, "filename": filename})


@bp.route("/api/sessions", methods=["GET"])
def api_sessions_list():
    files = _list_session_files(config.SESSIONS_DIR, "session")
    payload = {"ok": True, "sessions": files}
    if request.args.get("workshopCounts") == "1":
        counts = {}
        for filename in files:
            try:
                data = json.loads((config.SESSIONS_DIR / filename).read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError):
                continue
            workshop_id = str(data.get("workshopId") or "").strip() if isinstance(data, dict) else ""
            if workshop_id:
                counts[workshop_id] = counts.get(workshop_id, 0) + 1
        payload["workshopCounts"] = counts
    return jsonify(payload)


@bp.route("/api/timeline-session", methods=["POST"])
def api_timeline_session_save():
    return _save_session_file(config.TIMELINE_SESSIONS_DIR, "timeline", request.get_json(silent=True))


@bp.route("/api/timeline-session/<filename>", methods=["GET"])
def api_timeline_session_load(filename):
    return _load_session_file(config.TIMELINE_SESSIONS_DIR, "timeline", filename)


@bp.route("/api/timeline-sessions", methods=["GET"])
def api_timeline_sessions_list():
    return jsonify({"ok": True, "timelines": _list_session_files(config.TIMELINE_SESSIONS_DIR, "timeline")})


@bp.route("/api/expo-session/<filename>", methods=["GET"])
def api_expo_session_load(filename):
    return _load_session_file(config.EXPO_SESSIONS_DIR, "expo", filename)


@bp.route("/api/expo-sessions", methods=["GET"])
def api_expo_sessions_list():
    return jsonify({"ok": True, "expoSessions": _list_session_files(config.EXPO_SESSIONS_DIR, "expo")})


def normalize_custom_objects(payload):
    """A FeatureCollection of the valid labelled points (id, text, mode, color), or None."""
    if not isinstance(payload, dict) or payload.get("type") != "FeatureCollection":
        return None
    raw_features = payload.get("features")
    if not isinstance(raw_features, list):
        return None
    features = []
    for feature in raw_features:
        if not isinstance(feature, dict):
            continue
        geometry = feature.get("geometry")
        properties = feature.get("properties")
        if not isinstance(geometry, dict) or geometry.get("type") != "Point" or not isinstance(properties, dict):
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
        clean = {key: str(properties.get(key) or "").strip() for key in ("id", "text", "mode", "color")}
        if not all(clean.values()):
            continue
        features.append({"type": "Feature", "properties": clean, "geometry": {"type": "Point", "coordinates": [lng, lat]}})
    return {"type": "FeatureCollection", "features": features}


@bp.route("/api/custom-objects", methods=["GET"])
def api_custom_objects_load():
    empty = {"type": "FeatureCollection", "features": []}
    if not config.CUSTOM_OBJECTS_FILE.exists():
        return jsonify(empty)
    try:
        data = json.loads(config.CUSTOM_OBJECTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return jsonify({"ok": False, "error": "read_failed"}), 500
    return jsonify(normalize_custom_objects(data) or empty)


@bp.route("/api/custom-objects", methods=["PUT"])
def api_custom_objects_save():
    normalized = normalize_custom_objects(request.get_json(silent=True))
    if normalized is None:
        return jsonify({"ok": False, "error": "invalid_geojson"}), 400
    try:
        config.CUSTOM_OBJECTS_FILE.parent.mkdir(exist_ok=True)
        config.CUSTOM_OBJECTS_FILE.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500
    return jsonify({"ok": True, "path": config.CUSTOM_OBJECTS_FILE.name})
