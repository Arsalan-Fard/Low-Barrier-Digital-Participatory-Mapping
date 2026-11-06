"""Projects (the workshop definitions in data/workshops.json), their uploaded images, and the data
layers a step can show: built-in layers plus uploaded GeoJSON / uMap files in data/custom_layers/."""
import json
import os
import re
import time
import urllib.parse

import cv2
import numpy as np
from flask import Blueprint, jsonify, request, send_from_directory

from . import config, projects

bp = Blueprint("workshops", __name__)

CUSTOM_LAYER_MAX_BYTES = 60 * 1024 * 1024
WORKSHOP_IMAGE_MAX_BYTES = 8 * 1024 * 1024
BUILTIN_DATA_LAYERS = (
    {"id": "roads", "name": "Roads"},
    {"id": "network", "name": "Street network (OSMnx)"},
    {"id": "objects", "name": "Custom objects"},
)
GEOMETRY_TYPES = ("Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection")


def _hidden_data_layers():
    """Layer ids removed from the catalog; their files stay on disk."""
    try:
        payload = json.loads(config.DATA_LAYER_CATALOG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return set()
    hidden = payload.get("hidden") if isinstance(payload, dict) else None
    return {str(layer_id) for layer_id in hidden} if isinstance(hidden, list) else set()


def _set_layer_hidden(layer_id, hidden):
    ids = _hidden_data_layers()
    if hidden:
        ids.add(layer_id)
    else:
        ids.discard(layer_id)
    config.DATA_LAYER_CATALOG_FILE.parent.mkdir(exist_ok=True)
    config.DATA_LAYER_CATALOG_FILE.write_text(json.dumps({"hidden": sorted(ids)}, ensure_ascii=False, indent=2), encoding="utf-8")


def _unique_path(folder, name):
    """folder/name, or "stem (2).ext", "stem (3).ext"... if that is taken."""
    stem, ext = os.path.splitext(name)
    n = 2
    while (folder / name).exists():
        name = f"{stem} ({n}){ext}"
        n += 1
    return folder / name


def _custom_layer_path(layer_id):
    """The .geojson file inside CUSTOM_LAYERS_DIR a layer id names, or None."""
    name = os.path.basename(str(layer_id or ""))
    if not name.lower().endswith(".geojson"):
        return None
    candidate = (config.CUSTOM_LAYERS_DIR / name).resolve()
    try:
        candidate.relative_to(config.CUSTOM_LAYERS_DIR.resolve())
    except ValueError:
        return None
    return candidate if candidate.exists() else None


def list_custom_layers():
    """Visible uploaded layers as [{id, name}], newest first."""
    if not config.CUSTOM_LAYERS_DIR.exists():
        return []
    hidden = _hidden_data_layers()
    files = sorted(config.CUSTOM_LAYERS_DIR.glob("*.geojson"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [{"id": f.name, "name": f.stem} for f in files if "custom:" + f.name not in hidden]


def list_data_layers():
    hidden = _hidden_data_layers()
    layers = [dict(layer) for layer in BUILTIN_DATA_LAYERS if layer["id"] not in hidden]
    layers += [{"id": "custom:" + layer["id"], "name": layer["name"]} for layer in list_custom_layers()]
    return layers


def _umap_to_feature_collection(data):
    """A uMap backup flattened to one FeatureCollection, its layers listed in the collection properties."""
    layers = data.get("layers")
    if not isinstance(layers, list) or not layers:
        return None
    features = []
    manifest = []
    # uMap stores its layers in the reverse of the order it shows them.
    for index, layer in enumerate(reversed(layers)):
        if not isinstance(layer, dict) or layer.get("type") != "FeatureCollection":
            return None
        layer_features = layer.get("features")
        if not isinstance(layer_features, list) or any(not isinstance(f, dict) for f in layer_features):
            return None
        options = {}
        for extra in (layer.get("properties"), layer.get("_umap_options")):
            if isinstance(extra, dict):
                options.update(extra)
        manifest.append({
            "id": str(options.get("id") or layer.get("id") or "layer-" + str(index + 1)),
            "name": str(options.get("name") or "Layer " + str(index + 1)).strip(),
            "count": len(layer_features),
            "options": options,
        })
        features.extend(layer_features)
    properties = data.get("properties") if isinstance(data.get("properties"), dict) else {}
    return {
        "type": "FeatureCollection",
        "features": features,
        "properties": {
            "name": properties.get("name") or "uMap import",
            "_compact_workshop_layers": {"source": "uMap backup", "featureCount": len(features), "layers": manifest},
        },
    }


def as_feature_collection(data):
    """An uploaded GeoJSON object or uMap backup as a FeatureCollection, or None."""
    if not isinstance(data, dict):
        return None
    kind = data.get("type")
    if kind == "umap":
        return _umap_to_feature_collection(data)
    if kind == "FeatureCollection":
        if not isinstance(data.get("features"), list):
            return None
        collection = {"type": "FeatureCollection", "features": data["features"]}
        # Collection properties carry uMap-style layer definitions and inherited styling.
        if isinstance(data.get("properties"), dict):
            collection["properties"] = data["properties"]
        return collection
    if kind == "Feature":
        if not isinstance(data.get("geometry"), dict):
            return None
        return {"type": "FeatureCollection", "features": [data]}
    if kind in GEOMETRY_TYPES:
        return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": data}]}
    return None


@bp.route("/api/custom-layers", methods=["GET"])
def api_custom_layers_list():
    return jsonify({"ok": True, "layers": list_custom_layers()})


@bp.route("/api/data-layers", methods=["GET"])
def api_data_layers_list():
    return jsonify({"ok": True, "layers": list_data_layers()})


@bp.route("/api/custom-layers", methods=["POST"])
def api_custom_layers_upload():
    upload = request.files.get("file")
    if upload is None or not (upload.filename or "").strip():
        return jsonify({"ok": False, "error": "no_file"}), 400
    if not upload.filename.lower().endswith((".geojson", ".json", ".umap")):
        return jsonify({"ok": False, "error": "not_geojson"}), 400
    raw = upload.read(CUSTOM_LAYER_MAX_BYTES + 1)
    if len(raw) > CUSTOM_LAYER_MAX_BYTES:
        return jsonify({"ok": False, "error": "too_large"}), 400
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except Exception:
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    collection = as_feature_collection(data)
    if collection is None:
        return jsonify({"ok": False, "error": "not_geojson"}), 400

    config.CUSTOM_LAYERS_DIR.mkdir(parents=True, exist_ok=True)
    base = re.sub(r"[^A-Za-z0-9 ._-]", "_", os.path.basename(upload.filename).strip()).lstrip(".")
    name = (os.path.splitext(base)[0].strip() or "layer") + ".geojson"
    dest = config.CUSTOM_LAYERS_DIR / name
    # Re-uploading a hidden layer's file name replaces it and shows it again; a visible one is kept.
    if dest.exists() and "custom:" + name not in _hidden_data_layers():
        dest = _unique_path(config.CUSTOM_LAYERS_DIR, name)
    try:
        dest.write_text(json.dumps(collection, ensure_ascii=False), encoding="utf-8")
        _set_layer_hidden("custom:" + dest.name, False)
    except Exception as exc:
        return jsonify({"ok": False, "error": "save_failed", "detail": str(exc)}), 500
    return jsonify({"ok": True, "id": dest.name, "name": dest.stem, "layers": list_custom_layers()})


@bp.route("/api/custom-layers/<path:layer_id>", methods=["GET"])
def api_custom_layers_get(layer_id):
    path = _custom_layer_path(layer_id)
    if path is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    # A flattened uMap export may come with a small .layers.json manifest; attach it as collection
    # metadata. A bad manifest must not make the layer unavailable, so fall back to the file itself.
    manifest_path = path.with_suffix(".layers.json")
    if manifest_path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
            manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
            if isinstance(payload, dict) and isinstance(manifest, dict):
                if not isinstance(payload.get("properties"), dict):
                    payload["properties"] = {}
                payload["properties"]["_compact_workshop_layers"] = manifest
                return jsonify(payload)
        except Exception:
            pass
    return send_from_directory(config.CUSTOM_LAYERS_DIR, path.name, mimetype="application/geo+json")


@bp.route("/api/custom-layers/<path:layer_id>", methods=["DELETE"])
def api_custom_layers_delete(layer_id):
    path = _custom_layer_path(layer_id)
    if path is None:
        return jsonify({"ok": False, "error": "not_found"}), 404
    try:
        _set_layer_hidden("custom:" + path.name, True)
    except Exception as exc:
        return jsonify({"ok": False, "error": "delete_failed", "detail": str(exc)}), 500
    return jsonify({"ok": True, "layers": list_custom_layers()})


@bp.route("/api/data-layers/<path:layer_id>", methods=["DELETE"])
def api_data_layers_delete(layer_id):
    if layer_id.startswith("custom:"):
        valid = _custom_layer_path(layer_id[len("custom:"):]) is not None
    else:
        valid = any(layer["id"] == layer_id for layer in BUILTIN_DATA_LAYERS)
    if not valid:
        return jsonify({"ok": False, "error": "not_found"}), 404
    try:
        _set_layer_hidden(layer_id, True)
    except Exception as exc:
        return jsonify({"ok": False, "error": "delete_failed", "detail": str(exc)}), 500
    return jsonify({"ok": True, "layers": list_data_layers()})


@bp.route("/api/workshops", methods=["GET"])
def api_workshops_load():
    """The projects (workshops.json). Paper maps with digitised results and the expo get theirs first."""
    projects.ensure_result_projects()
    data = projects.load()
    if data is None:
        return jsonify({"ok": False, "error": "read_failed"}), 500
    return jsonify(data)


@bp.route("/api/workshops", methods=["PUT"])
def api_workshops_save():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get("workshops"), list):
        return jsonify({"ok": False, "error": "invalid_payload"}), 400
    try:
        with projects.lock:
            projects.save(payload)
    except Exception:
        return jsonify({"ok": False, "error": "write_failed"}), 500
    return jsonify({"ok": True, "path": config.WORKSHOPS_FILE.name})


@bp.route("/api/workshop-assets", methods=["POST"])
def api_workshop_asset_upload():
    upload = request.files.get("file")
    if upload is None or not (upload.filename or "").strip():
        return jsonify({"ok": False, "error": "no_file"}), 400
    original_name = os.path.basename(upload.filename)
    stem, ext = os.path.splitext(original_name)
    ext = ext.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        return jsonify({"ok": False, "error": "unsupported_image"}), 400
    raw = upload.read(WORKSHOP_IMAGE_MAX_BYTES + 1)
    if len(raw) > WORKSHOP_IMAGE_MAX_BYTES:
        return jsonify({"ok": False, "error": "too_large"}), 400
    # Decoding it keeps a renamed non-image file out of the asset folder.
    try:
        decoded = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    except Exception:
        decoded = None
    if decoded is None or decoded.size == 0:
        return jsonify({"ok": False, "error": "invalid_image"}), 400
    if ext == ".jpeg":
        ext = ".jpg"
    safe_stem = re.sub(r"[^A-Za-z0-9_-]", "_", stem).strip("_") or "image"
    stamp = str(int(time.time() * 1000))
    config.WORKSHOP_ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{safe_stem}_{stamp}{ext}"
    suffix = 2
    while (config.WORKSHOP_ASSETS_DIR / filename).exists():
        filename = f"{safe_stem}_{stamp}_{suffix}{ext}"
        suffix += 1
    try:
        (config.WORKSHOP_ASSETS_DIR / filename).write_bytes(raw)
    except Exception as exc:
        return jsonify({"ok": False, "error": "save_failed", "detail": str(exc)}), 500
    return jsonify({"ok": True, "name": original_name, "url": "/api/workshop-assets/" + urllib.parse.quote(filename)})


@bp.route("/api/workshop-assets/<path:asset_id>", methods=["GET"])
def api_workshop_asset_get(asset_id):
    filename = os.path.basename(asset_id)
    path = (config.WORKSHOP_ASSETS_DIR / filename).resolve()
    if filename != asset_id or path.parent != config.WORKSHOP_ASSETS_DIR.resolve() or not path.is_file():
        return jsonify({"ok": False, "error": "not_found"}), 404
    return send_from_directory(config.WORKSHOP_ASSETS_DIR, filename)
