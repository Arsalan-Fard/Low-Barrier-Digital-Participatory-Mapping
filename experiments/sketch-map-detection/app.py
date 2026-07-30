from __future__ import annotations

import base64
import importlib.util
import json
import os
import time
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, jsonify, request, send_from_directory

EXPERIMENT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = EXPERIMENT_DIR.parents[1]
MAP_SHEETS_DIR = PROJECT_DIR / "data" / "map_sheets"
WEIGHTS_DIR = EXPERIMENT_DIR / "weights"
os.environ.setdefault("YOLO_CONFIG_DIR", str(EXPERIMENT_DIR / ".runtime" / "ultralytics"))

from detector import SketchMapDetector, masks_to_geojson, masks_to_geotiff, masks_to_rgba

app = Flask(__name__, static_folder="static", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 40 * 1024 * 1024
detector = SketchMapDetector(WEIGHTS_DIR)


def read_sheet(sheet_id: str) -> dict:
    if not sheet_id or not sheet_id.replace("-", "").replace("_", "").isalnum():
        raise ValueError("Invalid map ID")
    metadata_path = MAP_SHEETS_DIR / f"{sheet_id}.json"
    image_path = MAP_SHEETS_DIR / f"{sheet_id}.png"
    if not metadata_path.is_file() or not image_path.is_file():
        raise FileNotFoundError(f"Stored map ID {sheet_id!r} was not found")
    return json.loads(metadata_path.read_text(encoding="utf-8"))


def encode_image(image, extension: str) -> str:
    ok, encoded = cv2.imencode(extension, image)
    if not ok:
        raise ValueError("Could not encode result image")
    mime = "image/png" if extension == ".png" else "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(encoded).decode("ascii")


def encode_bytes(value: bytes, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(value).decode("ascii")


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/sheets")
def sheets():
    result = []
    if MAP_SHEETS_DIR.is_dir():
        for path in sorted(MAP_SHEETS_DIR.glob("*.json"), key=lambda item: item.stem):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                if len(record.get("corners", [])) != 4:
                    continue
                result.append(
                    {
                        "id": str(record.get("id", path.stem)),
                        "title": record.get("title", f"Map {path.stem}"),
                        "theme": record.get("theme", "streets"),
                        "corners": record["corners"],
                    }
                )
            except (OSError, ValueError, KeyError):
                continue
    return jsonify({"sheets": result})


@app.get("/api/health")
def health():
    modules = {
        name: importlib.util.find_spec(name) is not None
        for name in ("torch", "ultralytics", "ultralytics_MB", "sam2")
    }
    return jsonify(
        {
            "ok": all(modules.values()),
            "modules": modules,
            "weights": {
                layer: detector.missing_weights(layer) for layer in ("osm", "esri")
            },
        }
    )


@app.post("/api/detect")
def detect():
    try:
        sheet_id = request.form.get("sheetId", "").strip()
        record = read_sheet(sheet_id)
        upload = request.files.get("photo")
        if upload is None or not upload.filename:
            raise ValueError("Choose a photographed or scanned marked map")

        photo_bytes = upload.read()
        photo = cv2.imdecode(
            np.frombuffer(photo_bytes, dtype=np.uint8),
            cv2.IMREAD_COLOR,
        )
        reference = cv2.imread(str(MAP_SHEETS_DIR / f"{sheet_id}.png"), cv2.IMREAD_COLOR)
        if photo is None:
            raise ValueError("The uploaded file is not a readable image")
        if reference is None:
            raise ValueError("The stored clean reference image is unreadable")

        layer = "esri" if record.get("theme") == "satellite" else "osm"
        detection_started = time.perf_counter()
        result = detector.detect(photo, reference, layer)
        detection_seconds = time.perf_counter() - detection_started

        export_started = time.perf_counter()
        processed_rgba = masks_to_rgba(result.masks, reference.shape[:2])
        raw_rgba = masks_to_rgba(result.raw_masks, reference.shape[:2])
        raw_geotiff = masks_to_geotiff(
            result.raw_masks,
            reference.shape[:2],
            record["corners"],
        )
        geojson = masks_to_geojson(result.masks, record["corners"])
        export_seconds = time.perf_counter() - export_started
        return jsonify(
            {
                "ok": True,
                "sheetId": sheet_id,
                "layerModel": layer,
                "corners": record["corners"],
                "detections": len(result.masks),
                "features": len(geojson["features"]),
                "alignment": {
                    "matches": result.alignment_matches,
                    "inliers": result.alignment_inliers,
                },
                "mask": encode_image(processed_rgba, ".png"),
                "rawMask": encode_image(raw_rgba, ".png"),
                "rawMaskGeoTiff": encode_bytes(raw_geotiff, "image/tiff"),
                "aligned": encode_image(result.aligned_bgr, ".jpg"),
                "geojson": geojson,
                "timing": {
                    "detectionSeconds": round(detection_seconds, 3),
                    "exportSeconds": round(export_seconds, 3),
                    "totalSeconds": round(detection_seconds + export_seconds, 3),
                },
            }
        )
    except (ValueError, FileNotFoundError) as error:
        return jsonify({"ok": False, "error": str(error)}), 400
    except Exception as error:
        app.logger.exception("Sketch Map Tool detection failed")
        return jsonify({"ok": False, "error": f"Detection failed: {error}"}), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5055, debug=False)
