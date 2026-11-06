"""Hands in a camera frame, found by MediaPipe's hand landmarker (models/hand_landmarker.task, the
float16 model Google publishes for it). paper_watch.py asks before it photographs a sheet: a hand
over the paper hides ink and must not be read as a drawing.

MediaPipe is optional. Without it (not installed, or the model missing) hands_in() returns None and
the watcher relies on its other checks: every border tag in view, the page standing still, nothing
large lying on it. MediaPipe loads on first use, in the caller's thread; it takes a second or two."""
import logging
import sys
import threading
import types
from pathlib import Path

import cv2
import numpy as np

MODEL_FILE = Path(__file__).resolve().parent / "models" / "hand_landmarker.task"
MAX_HANDS = 4
# Low: a hand missed spoils a photo, a hand imagined only delays one.
MIN_CONFIDENCE = 0.3
# The palm detector sees its whole input at 192 px, so a hand must not be small in it: the area
# looked at (a sheet with a margin, wider than tall) is cut into overlapping squares, each scaled to
# at most TILE_PX before detection.
TILE_PX = 640
TILE_OVERLAP = 0.25

_lock = threading.Lock()
_state = {"landmarker": None, "failed": False}


def _import_mediapipe():
    """import mediapipe. It imports matplotlib.pyplot, but only for a 3D plotting helper this app
    never calls; the packaged app leaves matplotlib out (packaging/DigitalMappingWorkshop.spec), so
    an empty stand-in takes its place there."""
    try:
        import mediapipe
        return mediapipe
    except ImportError as exc:
        if "matplotlib" not in str(exc):
            raise
    for name in [n for n in sys.modules if n == "mediapipe" or n.startswith("mediapipe.")]:
        del sys.modules[name]  # the half-imported package
    matplotlib, pyplot = types.ModuleType("matplotlib"), types.ModuleType("matplotlib.pyplot")
    matplotlib.pyplot = pyplot
    sys.modules["matplotlib"], sys.modules["matplotlib.pyplot"] = matplotlib, pyplot
    import mediapipe
    return mediapipe


def _landmarker():
    """The landmarker, built on first use; None when MediaPipe or the model is missing."""
    if _state["landmarker"] is not None or _state["failed"]:
        return _state["landmarker"]
    try:
        mp = _import_mediapipe()
        from mediapipe.tasks.python import BaseOptions, vision
        options = vision.HandLandmarkerOptions(
            # A buffer rather than a path: MediaPipe cannot open some non-ASCII Windows paths.
            base_options=BaseOptions(model_asset_buffer=MODEL_FILE.read_bytes()),
            running_mode=vision.RunningMode.IMAGE,
            num_hands=MAX_HANDS,
            min_hand_detection_confidence=MIN_CONFIDENCE,
            min_hand_presence_confidence=MIN_CONFIDENCE,
        )
        _state["landmarker"] = (mp, vision.HandLandmarker.create_from_options(options))
        print("[Hands] MediaPipe hand detection ready", flush=True)
    except Exception as exc:  # ImportError, a missing model file, a broken install
        _state["failed"] = True
        logging.warning("Hand detection is off (%s): paper photos rely on the other checks", exc)
    return _state["landmarker"]


def available():
    with _lock:
        return _landmarker() is not None


def _tiles(x0, y0, x1, y1):
    """Squares as tall as the box (or as wide, when it stands upright) along its long side,
    overlapping by TILE_OVERLAP, so a hand stays as large as the box's short side allows."""
    width, height = x1 - x0, y1 - y0
    side = min(width, height)
    length = max(width, height)
    count = max(1, int(np.ceil((length - side * TILE_OVERLAP) / (side * (1.0 - TILE_OVERLAP)))))
    step = (length - side) / (count - 1) if count > 1 else 0.0
    if width >= height:
        return [(int(x0 + i * step), y0, int(x0 + i * step) + side, y1) for i in range(count)]
    return [(x0, int(y0 + i * step), x1, int(y0 + i * step) + side) for i in range(count)]


def hands_in(frame, box):
    """The hands seen in the frame within box (x0, y0, x1, y1 frame px): a list of 21 x 2 arrays of
    landmark positions in frame px, or None when hand detection is not available."""
    height, width = frame.shape[:2]
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(width, x1), min(height, y1)
    if x1 - x0 < 16 or y1 - y0 < 16:
        return []
    with _lock:
        loaded = _landmarker()
        if loaded is None:
            return None
        mp, landmarker = loaded
        hands = []
        for tx0, ty0, tx1, ty1 in _tiles(x0, y0, x1, y1):
            crop = frame[ty0:ty1, tx0:tx1]
            scale = min(1.0, TILE_PX / float(max(crop.shape[:2])))
            if scale < 1.0:
                crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            rgb = np.ascontiguousarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
            result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
            for landmarks in result.hand_landmarks:
                points = np.float32([[p.x * (tx1 - tx0) + tx0, p.y * (ty1 - ty0) + ty0] for p in landmarks])
                hands.append(points)
        return hands


def any_in(hands, polygon):
    """Whether any landmark of the hands lies in the polygon (N x 2 frame px)."""
    contour = np.float32(polygon).reshape(-1, 1, 2)
    for points in hands or ():
        for x, y in points:
            if cv2.pointPolygonTest(contour, (float(x), float(y)), False) >= 0:
                return True
    return False
