"""AprilTag detection on the camera frames and the /api/tags feed the pages poll."""
import threading
import time

import cv2
import numpy as np
from flask import Blueprint, jsonify, request

from . import camera, paper_watch, shutdown_event, surface
from .marker_settings import APRILTAG_DICTS, marker_settings_family

bp = Blueprint("detection", __name__)

tags_lock = threading.Lock()
latest_tags = []
latest_tags_updated_at = 0.0

detector_lock = threading.Lock()
detector_manager = None

# ArUco detector parameters shown as sliders on the setup page, in the integer units of the
# reference tuning script. "start" is the tuning applied by default (better for 16h5);
# "opencv" is OpenCV's own default, shown as the reference. "hint" says which way helps, beside the name.
ARUCO_TUNING_CONTROLS = {
    "winMax": {"param": "adaptiveThreshWinSizeMax", "label": "Win max", "min": 3, "max": 181, "step": 2, "start": 53, "opencv": 23, "scale": 1, "odd": True,
               "hint": "higher = more tags in uneven light, slower"},
    "poly": {"param": "polygonalApproxAccuracyRate", "label": "Poly ×1000", "min": 10, "max": 120, "step": 1, "start": 100, "opencv": 30, "scale": 0.001,
             "hint": "higher = accepts blurred or bent tags, more false ones"},
    "minPerim": {"param": "minMarkerPerimeterRate", "label": "MinPerim ×1000", "min": 1, "max": 100, "step": 1, "start": 10, "opencv": 30, "scale": 0.001,
                 "hint": "lower = smaller, farther tags, more noise"},
    "pixCell": {"param": "perspectiveRemovePixelPerCell", "label": "PixCell", "min": 1, "max": 20, "step": 1, "start": 8, "opencv": 4, "scale": 1,
                "hint": "higher = reads tags more reliably, slower"},
}
aruco_tuning_values = {key: meta["start"] for key, meta in ARUCO_TUNING_CONTROLS.items()}

# Second pass: tag-shaped rejected quads are upscaled and detected again, which rescues small or
# distant tags. Off by default, as it measured ~90 ms per 720p frame.
aruco_upscale_enabled = False
ARUCO_UPSCALE_CONTROLS = {
    "upTarget": {"label": "Upscale target px", "min": 100, "max": 300, "step": 5, "default": 190,
                 "hint": "higher = small tags read better, slower"},
    "upMinSide": {"label": "Upscale min side", "min": 6, "max": 60, "step": 1, "default": 12,
                  "hint": "lower = rescues tinier tags, slower"},
    "upMaxSide": {"label": "Upscale max side", "min": 40, "max": 200, "step": 5, "default": 110,
                  "hint": "higher = rescues larger missed tags, slower"},
}
aruco_upscale_values = {key: meta["default"] for key, meta in ARUCO_UPSCALE_CONTROLS.items()}
# How far, on average, a printed sheet's tags must move (in map pixels) before the view projected
# onto the sheet follows them; smaller shifts count as jitter. Read by printedScreen.js via /api/tags.
SCREEN_JITTER_CONTROL = {"key": "jitterPx", "label": "Sheet jitter px", "min": 0, "max": 30, "step": 1, "default": 3,
                         "hint": "higher = projected sheets ignore bigger shifts"}
screen_jitter_px = SCREEN_JITTER_CONTROL["default"]
ARUCO_UPSCALE_PAD = 1.0
ARUCO_UPSCALE_MAX_ASPECT = 1.7
ARUCO_UPSCALE_MERGE_TOL = 15.0


def _tuned_parameters():
    params = cv2.aruco.DetectorParameters()
    for key, meta in ARUCO_TUNING_CONTROLS.items():
        raw = aruco_tuning_values.get(key, meta["start"])
        if meta.get("odd") and raw % 2 == 0:
            raw += 1
        if hasattr(params, meta["param"]):
            setattr(params, meta["param"], raw * meta["scale"])
    return params


def _roi_tag_side(quad):
    """Mean side length of a square-ish, tag-sized quad, else None."""
    edges = [float(np.linalg.norm(quad[(k + 1) % 4] - quad[k])) for k in range(4)]
    shortest = min(edges)
    if shortest < 1e-3 or max(edges) / shortest > ARUCO_UPSCALE_MAX_ASPECT:
        return None
    side = sum(edges) / 4.0
    if not (aruco_upscale_values["upMinSide"] <= side <= aruco_upscale_values["upMaxSide"]):
        return None
    return side


def _second_pass(gray, rejected, det):
    """Detect again on an upscaled crop of each tag-sized rejected quad. A hit counts only if its
    centre lies inside the quad it came from. Returns (corner arrays, ids) in frame pixels."""
    height, width = gray.shape[:2]
    target = float(aruco_upscale_values["upTarget"])
    found_corners = []
    found_ids = []
    for quad in rejected:
        q = np.asarray(quad, np.float32).reshape(4, 2)
        side = _roi_tag_side(q)
        if side is None:
            continue
        x0, y0 = q.min(axis=0)
        x1, y1 = q.max(axis=0)
        pad_x = int((x1 - x0) * ARUCO_UPSCALE_PAD) + 4
        pad_y = int((y1 - y0) * ARUCO_UPSCALE_PAD) + 4
        cx0 = max(0, int(x0 - pad_x))
        cy0 = max(0, int(y0 - pad_y))
        cx1 = min(width, int(x1 + pad_x))
        cy1 = min(height, int(y1 + pad_y))
        crop = gray[cy0:cy1, cx0:cx1]
        if crop.size == 0 or min(crop.shape[:2]) < 8:
            continue
        scale = float(np.clip(target / side, 2.0, 10.0))
        upscaled = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        corners, ids, _ = det.detectMarkers(upscaled)
        if ids is None:
            continue
        for corner, tag_id in zip(corners, ids.ravel()):
            pts = np.asarray(corner, np.float32).reshape(4, 2) / scale + [cx0, cy0]
            center = pts.mean(axis=0)
            if x0 - 2 <= center[0] <= x1 + 2 and y0 - 2 <= center[1] <= y1 + 2:
                found_corners.append(pts)
                found_ids.append(int(tag_id))
    return found_corners, found_ids


def _quad_area(c):
    return 0.5 * abs(
        (c[0][0] * c[1][1] - c[1][0] * c[0][1])
        + (c[1][0] * c[2][1] - c[2][0] * c[1][1])
        + (c[2][0] * c[3][1] - c[3][0] * c[2][1])
        + (c[3][0] * c[0][1] - c[0][0] * c[3][1])
    )


class ArucoDetection:
    """One detected tag: its id and its four corners."""
    __slots__ = ("tag_id", "corners")

    def __init__(self, tag_id, corners):
        self.tag_id = tag_id
        self.corners = corners  # (4, 2) float32, TL TR BR BL


class ArucoDetector:
    """OpenCV ArUco over several families, merging their results."""

    def __init__(self, families, min_area_px):
        self.detectors = []
        for family in families:
            if family not in APRILTAG_DICTS:
                raise ValueError(f"Unsupported ArUco family '{family}'. Choose from: {list(APRILTAG_DICTS)}")
            dictionary = cv2.aruco.getPredefinedDictionary(APRILTAG_DICTS[family])
            self.detectors.append(cv2.aruco.ArucoDetector(dictionary, _tuned_parameters()))
        self.min_area = float(min_area_px)

    def detect(self, gray):
        seen_ids = set()
        results = []
        for det in self.detectors:
            corners, ids, rejected = det.detectMarkers(gray)
            pass_corners = []
            pass_ids = []
            if ids is not None:
                pass_corners = [np.asarray(c, np.float32).reshape(4, 2) for c in corners]
                pass_ids = [int(v) for v in ids.ravel()]

            if aruco_upscale_enabled and rejected is not None and len(rejected):
                centers = [c.mean(axis=0) for c in pass_corners]
                extra_corners, extra_ids = _second_pass(gray, rejected, det)
                for corner, tag_id in zip(extra_corners, extra_ids):
                    center = corner.mean(axis=0)
                    duplicate = any(
                        known_id == tag_id and float(np.hypot(*(center - known))) < ARUCO_UPSCALE_MERGE_TOL
                        for known_id, known in zip(pass_ids, centers)
                    )
                    if not duplicate:
                        pass_corners.append(corner)
                        pass_ids.append(tag_id)
                        centers.append(center)

            for pts, tag_id in zip(pass_corners, pass_ids):
                if tag_id in seen_ids or _quad_area(pts) < self.min_area:
                    continue
                seen_ids.add(tag_id)
                results.append(ArucoDetection(tag_id, pts))
        return results


def normalize_apriltag_families(raw):
    """Family names from a string or list, split on commas and spaces."""
    if raw is None:
        return []
    tokens = raw if isinstance(raw, (list, tuple)) else [raw]
    families = []
    for token in tokens:
        families += str(token or "").replace(",", " ").split()
    return families


class DetectorManager:
    """Owns the live detector; rebuilds it when the marker family or the tuning changes."""

    def __init__(self, args, families):
        self.args = args
        self.detector = None
        self.families = []
        self.configure(families, force=True)

    def configure(self, families, force=False):
        families = normalize_apriltag_families(families) or [marker_settings_family()]
        with detector_lock:
            if not force and families == self.families:
                return
        min_area = self.args.aruco_min_area
        detector = ArucoDetector(families, min_area)
        with detector_lock:
            self.detector = detector
            self.families = families
        print(f"[Detector] OpenCV ArUco  families={families}  min_area={min_area}px²", flush=True)

    def rebuild(self):
        with detector_lock:
            families = list(self.families)
        self.configure(families, force=True)

    def get_detector(self):
        with detector_lock:
            return self.detector


def start_detector(args):
    global detector_manager
    detector_manager = DetectorManager(args, args.apriltag_family)


def use_marker_family(family):
    """Follow the family chosen on the Marker Setting page."""
    if detector_manager is None:
        return
    try:
        detector_manager.configure([family])
    except Exception as exc:
        print(f"[Detector] Could not apply marker family '{family}': {exc}", flush=True)


def _project_point(x, y, transform):
    out = cv2.perspectiveTransform(np.array([[[float(x), float(y)]]], dtype=np.float32), transform).reshape(-1, 2)
    if out.size < 2:
        return None
    return {"u": float(out[0][0]), "v": float(out[0][1])}


def map_detection(det, transform):
    """A detection as JSON. Its anchor is the midpoint of the tag's own corners 2 and 3 (its decoded
    bottom edge), so it turns with the tag; the anchor and corners are also given in surface uv."""
    corners = np.array(det.corners, dtype=np.float32).reshape(-1, 2)
    anchor = corners[[2, 3]].mean(axis=0)
    x = float(anchor[0])
    y = float(anchor[1])
    uv = None
    uv_corners = None
    if transform is not None:
        corners_uv = cv2.perspectiveTransform(corners.reshape(-1, 1, 2), transform).reshape(-1, 2)
        uv_corners = [{"u": float(p[0]), "v": float(p[1])} for p in corners_uv]
        uv = _project_point(x, y, transform)  # mapped itself: a homography does not keep midpoints
    return {
        "id": int(det.tag_id),
        "center": {"x": x, "y": y},
        "corners": [{"x": float(p[0]), "y": float(p[1])} for p in corners],
        "uv": uv,
        "uvCorners": uv_corners,
    }


def detector_loop():
    global latest_tags, latest_tags_updated_at
    last_seq = -1
    while not shutdown_event.is_set():
        seq, frame = camera.new_frame(last_seq)
        if frame is None:
            time.sleep(0.001)
            continue
        last_seq = seq
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        detector = detector_manager.get_detector() if detector_manager else None
        if detector is None:
            time.sleep(0.01)
            continue
        try:
            detections = detector.detect(gray)
        except Exception as exc:
            print(f"[Detector] detect failed: {exc}", flush=True)
            time.sleep(0.05)
            continue

        paper_watch.offer(seq, frame, detections)
        surface.update_from_detections(detections)
        transform = surface.surface_transform()
        mapped = [map_detection(det, transform) for det in detections]
        with tags_lock:
            latest_tags = mapped
            latest_tags_updated_at = time.time()


def aruco_tuning_payload():
    controls = []
    for key, meta in ARUCO_TUNING_CONTROLS.items():
        controls.append({"key": key, "label": meta["label"], "hint": meta["hint"], "min": meta["min"],
                         "max": meta["max"], "step": meta["step"], "default": meta["opencv"],
                         "value": aruco_tuning_values[key]})
    upscale = []
    for key, meta in ARUCO_UPSCALE_CONTROLS.items():
        upscale.append({"key": key, "label": meta["label"], "hint": meta["hint"], "min": meta["min"],
                        "max": meta["max"], "step": meta["step"], "default": meta["default"],
                        "value": aruco_upscale_values[key]})
    jitter = SCREEN_JITTER_CONTROL
    return {
        "controls": controls,
        "upscale": upscale,
        "upscaleEnabled": aruco_upscale_enabled,
        "screen": [{"key": jitter["key"], "label": jitter["label"], "hint": jitter["hint"], "min": jitter["min"],
                    "max": jitter["max"], "step": jitter["step"], "default": jitter["default"],
                    "value": screen_jitter_px}],
    }


@bp.route("/api/tags")
def api_tags():
    with tags_lock:
        tags = list(latest_tags)
        updated_at = latest_tags_updated_at
    return jsonify({
        "tags": tags,
        "updatedAt": updated_at,
        "corners": surface.snapshot_corners(),
        "frame": camera.frame_info(),
        "source": camera.camera_source,
        "screenJitterPx": screen_jitter_px,
    })


@bp.route("/api/aruco-tuning", methods=["GET"])
def api_aruco_tuning_get():
    return jsonify({"ok": True, **aruco_tuning_payload()})


def _slider_value(payload, key, meta):
    """The payload's value for a slider, rounded and clamped; None when absent or not a number."""
    if key not in payload:
        return None
    try:
        raw = int(round(float(payload[key])))
    except (TypeError, ValueError):
        return None
    return max(meta["min"], min(meta["max"], raw))


@bp.route("/api/aruco-tuning", methods=["PUT"])
def api_aruco_tuning_set():
    global aruco_upscale_enabled, screen_jitter_px
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_payload"}), 400
    # The tuning values are baked into the detector, so a change rebuilds it; the upscale ones are read live.
    changed = False
    for key, meta in ARUCO_TUNING_CONTROLS.items():
        value = _slider_value(payload, key, meta)
        if value is not None and value != aruco_tuning_values[key]:
            aruco_tuning_values[key] = value
            changed = True
    for key, meta in ARUCO_UPSCALE_CONTROLS.items():
        value = _slider_value(payload, key, meta)
        if value is not None:
            aruco_upscale_values[key] = value
    if "upEnabled" in payload:
        aruco_upscale_enabled = bool(payload["upEnabled"])
    jitter = _slider_value(payload, SCREEN_JITTER_CONTROL["key"], SCREEN_JITTER_CONTROL)
    if jitter is not None:
        screen_jitter_px = jitter
    if changed and detector_manager is not None:
        try:
            detector_manager.rebuild()
        except Exception as exc:
            print(f"[Detector] aruco-tuning rebuild failed: {exc}", flush=True)
    return jsonify({"ok": True, "changed": changed, **aruco_tuning_payload()})
