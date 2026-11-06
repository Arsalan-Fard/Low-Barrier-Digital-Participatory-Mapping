"""Where the projected surface is in the camera image: its four corners, set by hand or fitted from
a projected grid of tags."""
import threading

import cv2
import numpy as np
from flask import Blueprint, jsonify, request

from . import camera, marker_settings

bp = Blueprint("surface", __name__)

# Grid calibration: a 4x4 grid of tags (ids 0-15) is projected, a camera -> canvas homography is
# fitted to their centres, and the screen corners are where the canvas corners map back to. The
# grid reaches ~6% from each edge so the corners are interpolated rather than extrapolated.
CALIB_GRID_CANVAS = (1280, 720)
CALIB_GRID_TAG_SIZE = min(CALIB_GRID_CANVAS) // 8
_CALIB_XS = (0.06, 0.36, 0.64, 0.94)
_CALIB_YS = (0.06, 0.37, 0.63, 0.94)
CALIB_GRID_LAYOUT = [(row * 4 + col, _CALIB_XS[col], _CALIB_YS[row]) for row in range(4) for col in range(4)]
CALIB_GRID_TARGET_CENTERS = {
    tag_id: (x * CALIB_GRID_CANVAS[0], y * CALIB_GRID_CANVAS[1]) for tag_id, x, y in CALIB_GRID_LAYOUT
}
CALIB_MIN_TAGS = 4
CALIB_MIN_COVERAGE = 0.55  # the detected centres must span this share of each axis
CALIB_RANSAC_PX = 8.0  # canvas px; a phone lens bends the grid by more than 6
CALIB_MIN_INLIER_RATIO = 0.65
CALIB_MAX_REPROJ_PX = 10.0
CALIB_CONFIRM_FRAMES = 5
CALIB_CANDIDATE_SHIFT_PX = 8.0  # an estimate this far from the others restarts the count

corners_lock = threading.Lock()
surface_corners = [None, None, None, None]  # TL, TR, BR, BL in camera pixels
grid_calib_enabled = False
grid_calib_candidates = []
grid_calib_status = {
    "active": False, "tags_found": 0, "tags_total": len(CALIB_GRID_LAYOUT), "stable": 0,
    "confirm": CALIB_CONFIRM_FRAMES, "error": None, "done": False, "found_ids": [], "reason": None,
}


def snapshot_corners():
    with corners_lock:
        return [None if c is None else {"x": float(c["x"]), "y": float(c["y"])} for c in surface_corners]


def surface_transform():
    """Homography from camera pixels to surface uv (0..1), or None until all four corners are known."""
    corners = snapshot_corners()
    if any(c is None for c in corners):
        return None
    src = np.array([[c["x"], c["y"]] for c in corners], dtype=np.float32)
    dst = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32)
    return cv2.getPerspectiveTransform(src, dst)


def update_from_detections(detections):
    """Feed one frame's detections to the grid calibration while it runs."""
    if grid_calib_enabled:
        _process_grid_calibration(detections)


def _estimate_corners_from_grid(detections):
    """(corners TL/TR/BR/BL in camera px or None, tags found, reprojection error or None, why not)."""
    cam_pts = []
    canvas_pts = []
    for det in detections:
        tag_id = int(det.tag_id)
        if tag_id not in CALIB_GRID_TARGET_CENTERS:
            continue
        pts = np.array(det.corners, dtype=np.float32).reshape(-1, 2)
        if pts.shape != (4, 2) or not np.isfinite(pts).all():
            continue
        cam_pts.append(pts.mean(axis=0))
        canvas_pts.append(CALIB_GRID_TARGET_CENTERS[tag_id])
    found = len(cam_pts)
    if found < CALIB_MIN_TAGS:
        return None, found, None, "too_few_tags"

    cam = np.float32(cam_pts)
    canvas = np.float32(canvas_pts)
    width, height = CALIB_GRID_CANVAS
    if np.ptp(canvas[:, 0]) / width < CALIB_MIN_COVERAGE or np.ptp(canvas[:, 1]) / height < CALIB_MIN_COVERAGE:
        return None, found, None, "tags_too_clustered"

    homography, inliers = cv2.findHomography(cam, canvas, cv2.RANSAC, CALIB_RANSAC_PX)
    if homography is None or inliers is None:
        return None, found, None, "no_fit"
    projected = cv2.perspectiveTransform(cam.reshape(1, -1, 2), homography).reshape(-1, 2)
    errors = np.linalg.norm(projected - canvas, axis=1)
    mask = inliers.ravel().astype(bool)
    if not mask.any():
        return None, found, None, "no_fit"
    reproj = float(np.sqrt(np.mean(np.square(errors[mask]))))
    if float(np.mean(mask)) < CALIB_MIN_INLIER_RATIO or reproj > CALIB_MAX_REPROJ_PX:
        return None, found, reproj, "fit_too_loose"

    try:
        inverse = np.linalg.inv(homography)
    except np.linalg.LinAlgError:
        return None, found, reproj, "no_fit"
    bounds = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
    surface = cv2.perspectiveTransform(bounds.reshape(1, 4, 2), inverse).reshape(4, 2)
    if not np.isfinite(surface).all() or abs(cv2.contourArea(surface.astype(np.float32))) < 100:
        return None, found, reproj, "no_fit"
    return [[float(p[0]), float(p[1])] for p in surface], found, reproj, None


def _process_grid_calibration(detections):
    """Update the live status; once CALIB_CONFIRM_FRAMES estimates agree, set the corners and stop."""
    global grid_calib_enabled
    corners, found, error, reason = _estimate_corners_from_grid(detections)
    seen = sorted({int(det.tag_id) for det in detections if int(det.tag_id) in CALIB_GRID_TARGET_CENTERS})
    with corners_lock:
        grid_calib_status["tags_found"] = found
        grid_calib_status["found_ids"] = seen
        grid_calib_status["reason"] = reason
        grid_calib_status["error"] = None if error is None else round(float(error), 2)
        if corners is None:
            return
        candidate = np.float32(corners)
        if grid_calib_candidates:
            reference = np.mean(grid_calib_candidates, axis=0)
            if float(np.max(np.linalg.norm(candidate - reference, axis=1))) > CALIB_CANDIDATE_SHIFT_PX:
                grid_calib_candidates.clear()
        grid_calib_candidates.append(candidate)
        grid_calib_status["stable"] = len(grid_calib_candidates)
        if len(grid_calib_candidates) < CALIB_CONFIRM_FRAMES:
            return
        averaged = np.mean(grid_calib_candidates, axis=0)
        for i in range(4):
            surface_corners[i] = {"x": float(averaged[i][0]), "y": float(averaged[i][1])}
        grid_calib_status["done"] = True
        grid_calib_status["active"] = False
        grid_calib_enabled = False
        grid_calib_candidates.clear()


@bp.route("/api/corners", methods=["GET"])
def api_corners_get():
    return jsonify({"corners": snapshot_corners()})


@bp.route("/api/corners", methods=["DELETE"])
def api_corners_reset():
    with corners_lock:
        surface_corners[:] = [None, None, None, None]
    return jsonify({"ok": True, "corners": snapshot_corners()})


@bp.route("/api/corners", methods=["POST"])
def api_corners_set():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    index = payload.get("index")
    x = payload.get("x")
    y = payload.get("y")
    if not isinstance(index, int) or index < 0 or index > 3:
        return jsonify({"ok": False, "error": "invalid_index"}), 400
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return jsonify({"ok": False, "error": "invalid_point"}), 400

    frame = camera.frame_info()
    x = float(x)
    y = float(y)
    if frame["width"] > 0 and frame["height"] > 0:
        x = float(max(0, min(frame["width"] - 1, x)))
        y = float(max(0, min(frame["height"] - 1, y)))
    with corners_lock:
        surface_corners[index] = {"x": x, "y": y}
    return jsonify({"ok": True, "corners": snapshot_corners()})


@bp.route("/api/auto-calibrate/layout", methods=["GET"])
def api_auto_calibrate_layout():
    # The page draws each tag box at (cx, cy) +/- tag_size/2 on this canvas, in the family the detector reads.
    return jsonify({
        "ok": True,
        "canvas": list(CALIB_GRID_CANVAS),
        "tag_size": CALIB_GRID_TAG_SIZE,
        "family": marker_settings.marker_settings_family(),
        "tags": [{"id": tag_id, "cx": x, "cy": y} for tag_id, x, y in CALIB_GRID_LAYOUT],
    })


@bp.route("/api/auto-calibrate", methods=["GET"])
def api_auto_calibrate_get():
    with corners_lock:
        status = dict(grid_calib_status)
    status["corners"] = snapshot_corners()
    return jsonify({"ok": True, **status})


@bp.route("/api/auto-calibrate", methods=["POST"])
def api_auto_calibrate_set():
    global grid_calib_enabled
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or "enabled" not in payload:
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    enabled = bool(payload["enabled"])
    with corners_lock:
        grid_calib_enabled = enabled
        grid_calib_candidates.clear()
        grid_calib_status.update({
            "active": enabled, "tags_found": 0, "stable": 0,
            "error": None, "done": False, "found_ids": [], "reason": None,
        })
    return jsonify({"ok": True, "enabled": enabled})
