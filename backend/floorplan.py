"""Indoor floor plans: uploaded DXF files turned into GeoJSON lines placed on the map."""
import math
import os
import re
import threading

from flask import Blueprint, jsonify, request

from . import config

bp = Blueprint("floorplan", __name__)

floorplan_lock = threading.Lock()
floorplan_cache = {}  # path -> {"mtime", "payload"}


def _floorplan_path(plan_id):
    """The .dxf in FLOORPLAN_DIR that `plan_id` names (the default plan when empty), or None."""
    if not plan_id:
        return config.FLOORPLAN_DXF_FILE if config.FLOORPLAN_DXF_FILE.exists() else None
    name = os.path.basename(str(plan_id))
    if not name.lower().endswith(".dxf"):
        return None
    candidate = (config.FLOORPLAN_DIR / name).resolve()
    try:
        candidate.relative_to(config.FLOORPLAN_DIR.resolve())
    except ValueError:
        return None
    return candidate if candidate.exists() else None


def list_floorplans():
    """All .dxf files in FLOORPLAN_DIR as [{id, name}], newest first."""
    if not config.FLOORPLAN_DIR.exists():
        return []
    files = sorted(config.FLOORPLAN_DIR.glob("*.dxf"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [{"id": f.name, "name": f.stem} for f in files]


def _entities(path):
    """(entity type, [(group code, value)]) for each entity in the DXF's ENTITIES section."""
    lines = path.read_text(errors="ignore").splitlines()
    in_entities = False
    current_type = None
    pairs = []
    for i in range(0, len(lines) - 1, 2):
        code = lines[i].strip()
        value = lines[i + 1].strip()
        if code == "0" and value == "SECTION":
            current_type = None
            pairs = []
        elif code == "2" and value == "ENTITIES":
            in_entities = True
        elif not in_entities:
            continue
        elif code == "0":
            if current_type:
                yield current_type, pairs
            if value == "ENDSEC":
                return
            current_type = value
            pairs = []
        elif current_type:
            pairs.append((code, value))


def _float_or_none(value):
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _polyline_points(pairs):
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
    points = []
    for i in range(steps + 1):
        angle = math.radians(start_deg + sweep * (i / steps))
        points.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius))
    return points


def _entity_lines(entity_type, pairs):
    """The polyline points of a LINE, LWPOLYLINE or ARC entity; [] for anything else."""
    values = {}
    for code, value in pairs:
        values.setdefault(code, value)
    number = {code: _float_or_none(values.get(code)) for code in ("10", "20", "11", "21", "40", "50", "51")}
    if entity_type == "LINE":
        ends = [number["10"], number["20"], number["11"], number["21"]]
        if None in ends:
            return []
        return [(ends[0], ends[1]), (ends[2], ends[3])]
    if entity_type == "LWPOLYLINE":
        points = _polyline_points(pairs)
        try:
            closed = int(float(values.get("70"))) & 1
        except (TypeError, ValueError):
            closed = 0
        if points and closed:
            points.append(points[0])
        return points
    if entity_type == "ARC":
        arc = [number["10"], number["20"], number["40"], number["50"], number["51"]]
        if None in arc:
            return []
        return _arc_points(*arc)
    return []


def parse_floorplan_dxf(path):
    """The plan as a GeoJSON FeatureCollection of lines, scaled into a 0.01° tall box near the campus."""
    lines = []
    min_x = min_y = float("inf")
    max_x = max_y = float("-inf")
    for entity_type, pairs in _entities(path):
        layer = next((value for code, value in pairs if code == "8" and value), "")
        points = [(float(x), float(y)) for x, y in _entity_lines(entity_type, pairs)]
        points = [(x, y) for x, y in points if math.isfinite(x) and math.isfinite(y)]
        if len(points) < 2:
            continue
        for x, y in points:
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)
        lines.append({"points": points, "layer": layer})

    if not lines:
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

    def to_lnglat(x, y):
        lng = west + ((x - min_x) / width) * (east - west)
        lat = south + ((y - min_y) / height) * (north - south)
        return [round(lng, 8), round(lat, 8)]

    features = []
    for index, line in enumerate(lines):
        features.append({
            "type": "Feature",
            "properties": {"id": index, "layer": line["layer"]},
            "geometry": {"type": "LineString", "coordinates": [to_lnglat(x, y) for x, y in line["points"]]},
        })
    return {
        "type": "FeatureCollection",
        "features": features,
        "properties": {"source": path.name, "entityCount": len(features), "dxfBounds": [min_x, min_y, max_x, max_y]},
        "bounds": [[west, south], [east, north]],
    }


def floorplan_payload(plan_id=None):
    path = _floorplan_path(plan_id)
    if path is None:
        raise FileNotFoundError(str(plan_id or config.FLOORPLAN_DXF_FILE))
    mtime = path.stat().st_mtime
    with floorplan_lock:
        cached = floorplan_cache.get(str(path))
        if cached and cached["mtime"] == mtime:
            return cached["payload"]
        payload = parse_floorplan_dxf(path)
        floorplan_cache[str(path)] = {"mtime": mtime, "payload": payload}
        return payload


@bp.route("/api/floorplan")
def api_floorplan():
    try:
        payload = floorplan_payload(request.args.get("id") or None)
    except FileNotFoundError:
        return jsonify({"ok": False, "error": "floorplan_missing"}), 404
    except Exception as exc:
        return jsonify({"ok": False, "error": "floorplan_parse_failed", "detail": str(exc)}), 500
    return jsonify({"ok": True, "floorplan": payload})


@bp.route("/api/floorplans", methods=["GET"])
def api_floorplans_list():
    return jsonify({"ok": True, "floorplans": list_floorplans()})


@bp.route("/api/floorplans", methods=["POST"])
def api_floorplans_upload():
    upload = request.files.get("file") or request.files.get("dxf")
    if upload is None or not (upload.filename or "").strip():
        return jsonify({"ok": False, "error": "no_file"}), 400
    if not upload.filename.lower().endswith(".dxf"):
        return jsonify({"ok": False, "error": "not_a_dxf"}), 400
    config.FLOORPLAN_DIR.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^A-Za-z0-9 ._-]", "_", os.path.basename(upload.filename).strip()).lstrip(".") or "floorplan"
    if not name.lower().endswith(".dxf"):
        name += ".dxf"
    stem, ext = os.path.splitext(name)
    dest = config.FLOORPLAN_DIR / name
    n = 2
    while dest.exists():  # never overwrite: "plan (2).dxf", "plan (3).dxf", ...
        dest = config.FLOORPLAN_DIR / f"{stem} ({n}){ext}"
        n += 1
    try:
        upload.save(str(dest))
    except Exception as exc:
        return jsonify({"ok": False, "error": "save_failed", "detail": str(exc)}), 500
    try:
        parse_floorplan_dxf(dest)
    except Exception as exc:
        try:
            dest.unlink()
        except Exception:
            pass
        return jsonify({"ok": False, "error": "parse_failed", "detail": str(exc)}), 400
    return jsonify({"ok": True, "id": dest.name, "name": dest.stem, "floorplans": list_floorplans()})


@bp.route("/api/floorplans/<path:plan_id>", methods=["DELETE"])
def api_floorplans_delete(plan_id):
    path = _floorplan_path(plan_id)
    if path is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    try:
        path.unlink()
    except Exception as exc:
        return jsonify({"ok": False, "error": "delete_failed", "detail": str(exc)}), 500
    with floorplan_lock:
        floorplan_cache.pop(str(path), None)
    return jsonify({"ok": True, "floorplans": list_floorplans()})
