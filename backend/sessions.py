"""Results (saved workshop sessions, timelines, expo sessions, GeoJSON) for the map page's Project panel,
and the custom map objects."""
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

from flask import Blueprint, jsonify, request

from . import config, projects
from .helpers import sanitize_storage_name

bp = Blueprint("sessions", __name__)


def _result_folders():
    """The kinds of result file and where each is kept (read at call time, as the standalone
    launcher moves them): session_ / timeline_ / expo_ .json by their prefix, and any .geojson in the
    results folder -- the Digitizer's sheets (written there on each save) and uploaded GeoJSON."""
    return {"session": config.SESSIONS_DIR, "timeline": config.TIMELINE_SESSIONS_DIR,
            "expo": config.EXPO_SESSIONS_DIR, "geojson": config.SESSIONS_DIR}


def _valid_result_name(kind, filename):
    if kind == "geojson":
        return (filename.endswith(".geojson") and not filename.startswith(".")
                and "/" not in filename and "\\" not in filename)
    return _valid_session_name(kind, filename)


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


def _list_session_files(folder, prefix):
    if not folder.exists():
        return []
    return sorted((path.name for path in folder.glob(f"{prefix}_*.json")), reverse=True)


@bp.route("/api/session", methods=["POST"])
def api_session_save():
    return _save_session_file(config.SESSIONS_DIR, "session", request.get_json(silent=True))


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


@bp.route("/api/results/locations", methods=["GET"])
def api_results_locations():
    """Where the result files are kept, so a row in the Project panel can say where its file is."""
    return jsonify({"ok": True, "separator": os.sep,
                    "folders": {kind: str(folder.resolve()) for kind, folder in _result_folders().items()}})


@bp.route("/api/results/reveal", methods=["POST"])
def api_results_reveal():
    """Show a result's file selected in Explorer (Finder on a Mac). Only for the computer the app runs
    on: a phone or tablet on the network must not open windows on it."""
    if request.remote_addr not in ("127.0.0.1", "::1"):
        return jsonify({"ok": False, "error": "this_computer_only"}), 403
    payload = request.get_json(silent=True) or {}
    kind, filename = str(payload.get("kind") or ""), str(payload.get("filename") or "")
    folder = _result_folders().get(kind)
    if folder is None or not _valid_result_name(kind, filename):
        return jsonify({"ok": False, "error": "invalid_filename"}), 400
    path = (folder / filename).resolve()
    if not path.is_file():
        return jsonify({"ok": False, "error": "not_found"}), 404
    try:
        if sys.platform == "win32":
            subprocess.Popen(f'explorer /select,"{path}"')   # Explorer's own form, safe with spaces
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path.parent)])
    except OSError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500
    return jsonify({"ok": True, "path": str(path)})


def _geojson_to_session(data, label):
    """A GeoJSON file as a results session: its points become stickers, its lines (and the outlines of
    its areas) drawings, each keeping its properties -- its ``color`` colours it on the page. A point
    that is a handwritten text (the Digitizer's ``kind: "text"``) becomes a comment.
    Returns (session, number of points, number of lines)."""
    features = data.get("features") if data.get("type") == "FeatureCollection" else [data]
    points, lines, notes = [], [], []

    def add(target, geometry_type, coordinates, properties):
        target.append({"type": "Feature", "geometry": {"type": geometry_type, "coordinates": coordinates},
                       "properties": dict(properties)})

    for feature in features if isinstance(features, list) else []:
        if not isinstance(feature, dict):
            continue
        geometry = feature.get("geometry") or {}
        kind, coordinates = geometry.get("type"), geometry.get("coordinates")
        properties = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
        if not isinstance(coordinates, list):
            continue
        if kind == "Point" and properties.get("kind") == "text" and properties.get("text"):
            add(notes, "Point", coordinates, properties)
        elif kind == "Point":
            add(points, "Point", coordinates, properties)
        elif kind == "MultiPoint":
            for point in coordinates:
                add(points, "Point", point, properties)
        elif kind == "LineString":
            add(lines, "LineString", coordinates, properties)
        elif kind == "MultiLineString":
            for line in coordinates:
                add(lines, "LineString", line, properties)
        elif kind == "Polygon" and coordinates:
            add(lines, "LineString", coordinates[0], properties)
        elif kind == "MultiPolygon":
            for polygon in coordinates:
                if polygon:
                    add(lines, "LineString", polygon[0], properties)
    empty = {"type": "FeatureCollection", "features": []}
    session = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "geojson", "sheet": data.get("sheet") or label, "basemap": "mapbox",
        "stickers": {"type": "FeatureCollection", "features": points},
        "drawings": {"type": "FeatureCollection", "features": lines},
        "annotations": {"type": "FeatureCollection", "features": notes},
        "keyboardAnnotations": empty, "generalAnnotations": [],
    }
    return session, len(points), len(lines)


@bp.route("/api/results/all", methods=["GET"])
def api_results_all():
    """Every result file, read in one request, with the id of the project it belongs to ("" for none):
    {results: [{kind, filename, project, data}], projects: [{id, name, known}]}. `projects` is every project
    in workshops.json (known), then the other project ids the results name (a workshop from another
    computer, a deleted project). The .geojson files come as sessions (points as stickers, lines as
    drawings). A file that cannot be read is left out."""
    projects.ensure_result_projects()
    items, other_names, map_cache = [], {}, {}
    for kind, folder in _result_folders().items():
        if kind == "geojson":
            names = sorted(p.name for p in folder.glob("*.geojson")) if folder.exists() else []
        else:
            names = _list_session_files(folder, kind)
        for name in names:
            try:
                data = json.loads((folder / name).read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict):
                continue
            project = projects.project_of_result(kind, name, data, map_cache)
            if project and data.get("workshopName"):
                other_names.setdefault(project, str(data["workshopName"]))
            if kind == "geojson":
                data = _geojson_to_session(data, Path(name).stem)[0]
            items.append({"kind": kind, "filename": name, "project": project, "data": data})
    known = projects.all_projects()
    known_ids = {str(p["id"]) for p in known}
    listed = [{"id": str(p["id"]), "name": str(p.get("name") or ""), "known": True} for p in known]
    for project in dict.fromkeys(item["project"] for item in items):
        if project and project not in known_ids:
            listed.append({"id": project, "name": other_names.get(project) or "Unknown project", "known": False})
    return jsonify({"ok": True, "results": items, "projects": listed})


@bp.route("/api/results/delete", methods=["POST"])
def api_results_delete():
    """Delete results: their files move into the results folder's "deleted" folder, from where they can
    be put back, and they leave the steps that showed them. Only from the computer the app runs on. A
    Digitizer sheet's file comes back the next time the sheet is saved in the Digitizer."""
    if request.remote_addr not in ("127.0.0.1", "::1"):
        return jsonify({"ok": False, "error": "this_computer_only"}), 403
    payload = request.get_json(silent=True) or {}
    bin_folder = config.SESSIONS_DIR / "deleted"
    moved, failed = [], []
    for item in payload.get("items") or []:
        kind = str((item or {}).get("kind") or "")
        filename = str((item or {}).get("filename") or "")
        folder = _result_folders().get(kind)
        if folder is None or not _valid_result_name(kind, filename) or not (folder / filename).is_file():
            failed.append({"filename": filename, "error": "not_found"})
            continue
        bin_folder.mkdir(parents=True, exist_ok=True)
        target = bin_folder / filename
        number = 2
        while target.exists():
            target = bin_folder / f"{Path(filename).stem}-{number}{Path(filename).suffix}"
            number += 1
        try:
            (folder / filename).replace(target)
        except OSError as exc:
            failed.append({"filename": filename, "error": str(exc)})
            continue
        moved.append({"kind": kind, "filename": filename, "to": str(target.resolve())})
    projects.remove_data_layers(f"result:{item['kind']}:{item['filename']}" for item in moved)
    return jsonify({"ok": bool(moved), "moved": moved, "failed": failed, "folder": str(bin_folder.resolve())})


def _store_upload(folder, base, body, extension=".json"):
    """Write ``body`` as <base><extension>, or <base>-2<extension>, ... when that name is taken by another
    file. The same file uploaded again is not stored twice. Returns (file name, whether it was new)."""
    folder.mkdir(parents=True, exist_ok=True)
    text = json.dumps(body, ensure_ascii=False, indent=2)
    for number in range(1, 1000):
        filename = f"{base}{extension}" if number == 1 else f"{base}-{number}{extension}"
        path = folder / filename
        if not path.exists():
            path.write_text(text, encoding="utf-8")
            return filename, True
        try:
            if json.loads(path.read_text(encoding="utf-8")) == body:
                return filename, False
        except (OSError, ValueError):
            pass
    raise OSError("too many files with this name")


@bp.route("/api/results/upload", methods=["POST"])
def api_results_upload():
    """Results files saved on another computer (session_ / timeline_ / expo_ .json), and GeoJSON with
    points and lines (a Digitizer export, a GIS file), kept as a .geojson in the results folder. With a
    `project` (a project id), sessions, timelines and GeoJSON are marked as that project's; expo
    sessions always belong to the expo project."""
    project_id = str(request.form.get("project") or "").strip()
    project_name = projects.project_names().get(project_id) if project_id else None
    stored, failed = [], []
    for upload in request.files.getlist("files"):
        name = upload.filename or "upload"
        stem = Path(name).stem
        try:
            data = json.loads(upload.read().decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError):
            failed.append({"file": name, "error": "not a JSON or GeoJSON file"})
            continue
        if not isinstance(data, dict):
            failed.append({"file": name, "error": "not a results or GeoJSON file"})
            continue
        if data.get("type") in ("FeatureCollection", "Feature"):
            _session, n_points, n_lines = _geojson_to_session(data, stem)
            if not n_points and not n_lines:
                failed.append({"file": name, "error": "no points or lines in it"})
                continue
            kind, base, extension = "geojson", sanitize_storage_name(stem, "upload"), ".geojson"
            if project_name is not None:
                data["projectId"] = project_id
        else:
            kind = next((k for k in ("timeline", "expo", "session") if stem.startswith(k + "_")), "session")
            label = sanitize_storage_name(stem[len(kind) + 1:] if stem.startswith(kind + "_") else stem, "upload")
            base, extension = f"{kind}_{label}", ".json"
            if project_name is not None and kind != "expo":
                data["workshopId"] = project_id
                data["workshopName"] = project_name
        try:
            filename, new = _store_upload(_result_folders()[kind], base, data, extension)
        except OSError as exc:
            failed.append({"file": name, "error": str(exc)})
            continue
        stored.append({"file": name, "kind": kind, "filename": filename, "new": new})
    return jsonify({"ok": bool(stored), "stored": stored, "failed": failed})


@bp.route("/api/timeline-session", methods=["POST"])
def api_timeline_session_save():
    return _save_session_file(config.TIMELINE_SESSIONS_DIR, "timeline", request.get_json(silent=True))


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
