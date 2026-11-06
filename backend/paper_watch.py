"""Hand-free capture of the pen drawings on the map view sheets. Nothing flashes: the sheet keeps
its map, and the camera waits for a moment when nobody's hand is over the paper.

The map page reports what each sheet shows a few times a second (POST /api/map-screen/watch): its
page (an id and the map view on it), whether that map is on the sheet and finished drawing, where the
street view cone stands on it, and whether the page is closing because the map moved. Every
CHECK_EVERY_S the watcher takes the camera's newest frame with the tags the detector found in it
(detection.py hands over every frame) and asks of each sheet:

  1. Is the whole sheet in view?  Every border tag the camera usually reads on it is found (some
                                  tags may never decode under the table's light; a hand reaching in
                                  hides one that does), and at least MIN_TAGS of them.
  2. Is no hand over it?          MediaPipe (hands.py) sees none within HAND_MARGIN_MM of the page.
  3. Is it standing still?        The straightened page hardly changed over STILL_CHECKS checks.

Then the page is clean, and the mean of those frames is used:

* The first clean moment of a page is its reference: the blank sheet with the page's map projected
  on it. Ink drawn before it is taken (normally within a second or two of the map coming up) is
  never seen.
* Later clean moments are compared with it (paper_ink.compare): the projection is in both and
  cancels out, leaving the ink drawn since. Unless something large lies on the sheet (an arm the
  hand detector missed, a phone), and if the ink changed since the page's last capture, the ink is
  traced into lines and points. Each capture reads all of the page's ink, so it replaces the last;
  the map page collects it with its next report.

slow_capture() takes a slower, sharper photo of a clean page, for reading handwriting later (a VLM).
No page uses it yet: POST /api/map-screen/slow-capture runs it.
"""
import collections
import json
import logging
import math
import threading
import time
import urllib.request

import cv2
import numpy as np
from flask import Blueprint, jsonify, request

from . import camera, config, hands, paper_ink, shutdown_event, street_screen
from .helpers import sanitize_storage_name, utc_now_iso

bp = Blueprint("paper_watch", __name__)

CHECK_EVERY_S = 0.2
STILL_CHECKS = 3          # consecutive still, hand-free checks that make a clean moment (0.4 s apart at the ends)
SETTLE_S = 1.2            # after the map comes up on a sheet: the camera's lag and the inset's fade-in
REPORT_TTL_S = 5.0        # a sheet the map page stopped reporting is no longer watched
MIN_TAGS = 4              # fewer extrapolate the inside too far
TAG_MEMORY = 25           # checks over which the watcher learns which of a sheet's tags the camera reads
TAG_USUAL = 0.6           # a tag read in this share of them is expected: when it is missing, something covers it
TAG_LEARN = 5             # checks needed before that; until then every tag is expected
HAND_MARGIN_MM = 40.0     # a hand this close to the page counts as over it: it is about to touch it
MOVE_PX_PER_MM = 1.0      # the stillness test compares copies this coarse
MOVE_LEVEL = 14.0         # grey levels a pixel must change by between checks to count as moved
MOVE_SHARE = 0.003        # share of the inside that may move between checks while still standing still
INK_TOLERANCE_MM = 1.0    # ink shifted by less than this is the same ink
CHANGED_MM2 = 3.0         # ink added or gone (beyond that tolerance) that makes a new capture
RECHECK_S = 15.0          # a page that stays clean is compared again this often anyway
CONE_MARGIN_MM = 4.0      # round the street view cone, which moves on the sheet and is left out
PAGES_FOLDER = "map_view_pages"  # in the sessions folder: <page>.geojson, .jpg, -empty.jpg, -ink.png
SLOW_PX_PER_MM = 8.0
SLOW_TIMEOUT_S = 15.0
PHOTO_TIMEOUT_S = 10.0

_lock = threading.Lock()
_clean_seen = threading.Condition(_lock)  # notified at every clean moment, for slow_capture
_sheets = {}               # sheet key -> _Sheet
_frame_lock = threading.Lock()
_latest = None             # (seq, monotonic time, frame, {tag id: 4 x 2 corners}) from the detector
_watching = False          # any sheet reported recently: only then does offer() keep frames


class _Sheet:
    """One map view sheet: the page it shows and what the watcher knows of it. The report endpoint
    sets the page fields; the watcher thread sets the rest. Whenever what the watcher holds stops
    applying (another page, the map just came up) the generation goes up, and a check begun before
    is dropped."""

    def __init__(self, key):
        self.key = key
        self.generation = 0
        self.page_id = None
        self.layout = None
        self.view = None
        self.cone = None            # (x_mm, y_mm, r_mm) from the inside's top-left, or None
        self.active = False         # the page's map is on the sheet and finished drawing
        self.settle_until = 0.0     # frames taken before this may still show an older projection
        self.closing = False        # the map moved: the page waits for a last clean capture
        self.final = False          # the closing page's ink is all read
        self.reported_at = 0.0
        self.tags_read = collections.deque(maxlen=TAG_MEMORY)  # the sheet's tags found, per check
        self.status = "idle"
        self.streak = []            # [(coarse grey copy, straightened image)] of consecutive still checks
        self.used = False           # the current streak was used already (as the reference, or compared)
        self.used_at = 0.0
        self.reference = None       # float32 straightened image of the blank sheet under the page's map
        self.reference_cone = None
        self.last_ink = None        # the ink mask of the last capture
        self.clean = None           # the last clean moment, for slow_capture
        self.version = 0            # counts the drawings handed out, across pages
        self.result = None          # {"pageId", "geojson"}: the newest drawing

    def forget_page(self):
        self.generation += 1
        self.streak, self.used = [], False
        self.reference = self.reference_cone = self.last_ink = self.clean = None
        self.final = False

    def restart(self):
        self.generation += 1
        self.streak, self.used = [], False


def offer(seq, frame, detections):
    """The detector's frame and the tags it found in it, kept as the newest while a sheet is watched.
    The frame is the detector's own copy, which it does not change."""
    global _latest
    if not _watching:
        return
    found = {int(det.tag_id): det.corners for det in detections}
    with _frame_lock:
        _latest = (seq, time.monotonic(), frame, found)


def _commit(sheet, generation, **fields):
    """Stores the fields unless the sheet moved on since the check began. Under _lock."""
    if sheet.generation != generation:
        return False
    for name, value in fields.items():
        setattr(sheet, name, value)
    return True


def _coarse(image):
    scale = MOVE_PX_PER_MM / paper_ink.PX_PER_MM
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    return cv2.GaussianBlur(cv2.resize(grey, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA), (0, 0), 1.0)


def _moved(before, after, valid):
    """Whether the page changed between two checks: a hand passing, the sheet pushed, a pen at work.
    A change of the whole picture's brightness (the camera's exposure) is not a move."""
    gain = float(np.median(before[valid])) / max(1.0, float(np.median(after[valid])))
    moved = (np.abs(after * gain - before) > MOVE_LEVEL) & valid
    return moved.sum() > MOVE_SHARE * valid.sum()


def _ink_changed(ink, last):
    grow = paper_ink._disc(INK_TOLERANCE_MM * paper_ink.PX_PER_MM)
    added = ink & ~(cv2.dilate(last.astype(np.uint8), grow) > 0)
    gone = last & ~(cv2.dilate(ink.astype(np.uint8), grow) > 0)
    return (added.sum() + gone.sum()) / paper_ink.PX_PER_MM ** 2 >= CHANGED_MM2


def _expected_tags(history, layout):
    """The sheet's tags the camera usually reads, from the checks before; all of them until it has
    seen enough checks to tell."""
    if len(history) < TAG_LEARN:
        return {tag["id"] for tag in layout["tags"]}
    counts = collections.Counter(tag_id for seen in history for tag_id in seen)
    return {tag["id"] for tag in layout["tags"] if counts[tag["id"]] >= TAG_USUAL * len(history)}


def _mean(stills):
    """The mean of a clean moment's straightened frames: less noisy than any one of them."""
    total = np.zeros(stills[0].shape, np.float32)
    for still in stills:
        total += still
    return total / len(stills)


def _discs(*cones):
    return [(x, y, r + CONE_MARGIN_MM) for x, y, r in (c for c in cones if c)]


def _pages_folder():
    folder = config.SESSIONS_DIR / PAGES_FOLDER
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _save_image(path, image):
    try:
        cv2.imwrite(str(path), np.clip(image, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 88])
    except Exception:
        logging.exception("Could not save %s", path)


# ------------------------------------------------------------------------------------- the watcher
def watch_loop():
    last_seq = -1
    while not shutdown_event.is_set():
        started = time.monotonic()
        try:
            last_seq = _check_once(last_seq)
        except Exception:
            logging.exception("The paper watcher's check failed")
        time.sleep(max(0.01, CHECK_EVERY_S - (time.monotonic() - started)))


def _check_once(last_seq):
    """One round over the watched sheets with the newest frame; returns that frame's seq."""
    global _watching
    now = time.monotonic()
    with _lock:
        for sheet in _sheets.values():
            if sheet.page_id is not None and now - sheet.reported_at > REPORT_TTL_S:
                sheet.page_id = None  # the map page went away
                sheet.active = False
                sheet.forget_page()
                sheet.status = "idle"
        _watching = any(sheet.page_id is not None for sheet in _sheets.values())
        due = [sheet for sheet in _sheets.values() if sheet.active]
    with _frame_lock:
        item = _latest
    if not due or item is None or item[0] == last_seq:
        return last_seq
    check_frame(item, due)
    return item[0]


def check_frame(item, sheets):
    """Checks the sheets against one frame: (seq, monotonic time taken, BGR frame, {tag id: corners})."""
    _seq, taken, frame, found = item
    jobs = []
    for sheet in sheets:
        with _lock:
            if not sheet.active:
                continue
            job = {"sheet": sheet, "generation": sheet.generation, "layout": sheet.layout,
                   "settle_until": sheet.settle_until}
            seen = {tag["id"] for tag in sheet.layout["tags"] if tag["id"] in found}
            expected = _expected_tags(sheet.tags_read, sheet.layout)
            sheet.tags_read.append(seen)
        layout = job["layout"]
        if taken < job["settle_until"]:
            _note(job, "settling")
            continue
        if len(seen) < MIN_TAGS or not expected <= seen:
            _note(job, "tags_hidden")
            continue
        homography, _seen = paper_ink.sheet_homography(layout, found)
        if homography is None:
            _note(job, "tags_hidden")
            continue
        job["homography"] = homography
        job["quad"] = paper_ink.sheet_quad(homography, layout, HAND_MARGIN_MM)
        jobs.append(job)
    if not jobs:
        return
    # One hand search over all the sheets in view.
    corners = np.vstack([job["quad"] for job in jobs])
    seen_hands = hands.hands_in(frame, (*corners.min(axis=0), *corners.max(axis=0)))
    for job in jobs:
        if seen_hands and hands.any_in(seen_hands, job["quad"]):
            _note(job, "hand")
            continue
        _check_page(job, frame, taken)


def _note(job, status):
    """A check that found the page not clean: the still streak starts over."""
    with _lock:
        sheet = job["sheet"]
        if sheet.generation == job["generation"]:
            sheet.status = status
            sheet.streak, sheet.used = [], False


def _check_page(job, frame, taken):
    sheet = job["sheet"]
    generation = job["generation"]
    layout = job["layout"]
    with _lock:
        if sheet.generation != generation:
            return
        page_id, view = sheet.page_id, sheet.view
        cone, reference_cone = sheet.cone, sheet.reference_cone
        reference, last_ink = sheet.reference, sheet.last_ink
        streak, used, used_at = list(sheet.streak), sheet.used, sheet.used_at
    image = paper_ink.straighten(frame, job["homography"], layout)
    valid = paper_ink.valid_mask(layout, image.shape, discs=_discs(cone, reference_cone))
    coarse = _coarse(image)
    coarse_valid = cv2.resize(valid.astype(np.uint8), (coarse.shape[1], coarse.shape[0]),
                              interpolation=cv2.INTER_NEAREST) > 0
    moved = bool(streak) and _moved(streak[-1][0], coarse, coarse_valid)
    if moved:
        streak, used = [], False
    streak = (streak + [(coarse, image)])[-STILL_CHECKS:]
    if len(streak) < STILL_CHECKS:
        with _lock:
            _commit(sheet, generation, streak=streak, used=used, status="moving" if moved else "steadying")
        return
    stills = [still for _coarse_copy, still in streak]
    now = time.monotonic()
    with _lock:
        if not _commit(sheet, generation, streak=streak):
            return
        sheet.clean = {"at": taken, "generation": generation, "stills": stills}
        _clean_seen.notify_all()
        if used and now - used_at < RECHECK_S:
            # Nothing new since the last look; with something lying on the page its ink is not all read.
            sheet.final = sheet.final or (sheet.closing and sheet.status != "covered")
            return
    clean = _mean(stills)  # only now: it takes longer than the rest of a check
    if reference is None:
        with _lock:
            _commit(sheet, generation, reference=clean, reference_cone=cone, last_ink=np.zeros(valid.shape, bool),
                    used=True, used_at=now, status="reference", final=sheet.closing)
        _save_image(_pages_folder() / f"{page_id}-empty.jpg", clean)
        print(f"[Paper] {sheet.key}: blank page {page_id} recorded", flush=True)
        return
    relative, change = paper_ink.compare(clean, reference, valid)
    if paper_ink.covered_mm2(change, valid) > paper_ink.OCCLUDER_MM2:
        with _lock:
            _commit(sheet, generation, used=True, used_at=now, status="covered")
        return
    ink = paper_ink.ink_mask(relative, valid)
    if not _ink_changed(ink, last_ink):
        with _lock:
            _commit(sheet, generation, used=True, used_at=now, status="unchanged", final=sheet.closing)
        return
    strokes, points = paper_ink.extract_marks(relative, valid, ink=ink)
    geojson = paper_ink.georeference(strokes, layout, view, points)
    geojson["properties"] = {"pageId": page_id, "sheet": layout.get("sheet"), "capturedAt": utc_now_iso(),
                             "view": view}
    with _lock:
        if not _commit(sheet, generation, last_ink=ink, used=True, used_at=now, status="captured",
                       final=sheet.closing):
            return
        sheet.version += 1
        sheet.result = {"pageId": page_id, "geojson": geojson}
    print(f"[Paper] {sheet.key}: page {page_id} read, {len(strokes)} lines and {len(points)} points", flush=True)
    folder = _pages_folder()
    try:
        (folder / f"{page_id}.geojson").write_text(json.dumps(geojson), encoding="utf-8")
    except OSError:
        logging.exception("Could not save the drawing of page %s", page_id)
    _save_image(folder / f"{page_id}.jpg", clean)
    _save_image(folder / f"{page_id}-ink.png", paper_ink.added_ink_image(relative, valid))


# ------------------------------------------------------------------------------ the map page's side
def _clean_view(raw):
    """What the sheet shows: {lng, lat, zoom, bearing, width, height}, checked."""
    if not isinstance(raw, dict):
        raise ValueError("invalid_view")
    try:
        view = {key: float(raw.get(key, 0.0 if key == "bearing" else None))
                for key in ("lng", "lat", "zoom", "bearing", "width", "height")}
    except (TypeError, ValueError):
        raise ValueError("invalid_view")
    if not all(math.isfinite(v) for v in view.values()) or abs(view["lat"]) > 85.0 or abs(view["lng"]) > 180.0 \
            or not (0.0 <= view["zoom"] <= 24.0) or view["width"] < 1.0 or view["height"] < 1.0:
        raise ValueError("invalid_view")
    return view


def _clean_cone(raw, view, layout):
    """The cone, given in the inset's CSS px ({x, y, r}), as (x_mm, y_mm, r_mm) on the inside; or None."""
    if not isinstance(raw, dict):
        return None
    try:
        x, y, r = (float(raw[key]) for key in ("x", "y", "r"))
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x, y, r)):
        return None
    x0, y0, x1, y1 = layout["interiorMm"]
    mm_per_px = (x1 - x0) / view["width"]
    return (x * mm_per_px, y * (y1 - y0) / view["height"], abs(r) * mm_per_px)


def report(key, page, now=None):
    """Takes the map page's report on a sheet (page: None, or {id, view, layout, shown, ready,
    closing, cone} already checked) and answers with what the watcher knows of it."""
    global _watching
    now = time.monotonic() if now is None else now
    with _lock:
        sheet = _sheets.get(key)
        if sheet is None:
            sheet = _sheets[key] = _Sheet(key)
        sheet.reported_at = now
        if page is None:
            if sheet.page_id is not None:
                sheet.page_id = None
                sheet.active = False
                sheet.forget_page()
                sheet.status = "idle"
            return sheet
        if page["id"] != sheet.page_id:
            sheet.forget_page()
            sheet.page_id, sheet.layout, sheet.view = page["id"], page["layout"], page["view"]
            sheet.active = False
            sheet.status = "waiting"
        active = bool(page["shown"] and page["ready"])
        if active and not sheet.active:
            sheet.settle_until = now + SETTLE_S
            sheet.restart()
        elif not active and sheet.active:
            sheet.restart()
            sheet.status = "waiting"
        sheet.active = active
        sheet.cone = _clean_cone(page.get("cone"), sheet.view, sheet.layout)
        closing = bool(page["closing"])
        if closing and not sheet.closing and sheet.reference is None:
            sheet.final = True  # nothing on record to read the page against
        sheet.closing = closing
        if not closing:
            sheet.final = False
        _watching = True
        return sheet


def _reply(sheet, known):
    with _lock:
        body = {"ok": True, "pageId": sheet.page_id, "status": sheet.status, "reference": sheet.reference is not None,
                "final": sheet.final, "version": sheet.version}
        if sheet.result is not None and sheet.version > known:
            body["drawing"] = sheet.result
    return body


@bp.route("/api/map-screen/watch", methods=["POST"])
def api_map_screen_watch():
    """The map page's report on one map view sheet ("sheet": its key, the first when missing):
    "page": {id, view, shown, ready, closing, cone} or null when it shows none. The answer says
    what the watcher is doing with the sheet ("status"), and carries the newest drawing ("drawing":
    {pageId, geojson}) when its "version" is newer than the "known" one the page sent."""
    payload = request.get_json(silent=True) or {}
    key = str(payload.get("sheet") or "map-screen")[:64]
    try:
        known = int(payload.get("known") or 0)
    except (TypeError, ValueError):
        known = 0
    raw = payload.get("page")
    page = None
    if isinstance(raw, dict):
        page_id = sanitize_storage_name(raw.get("id"), "")[:64]
        if not page_id:
            return jsonify({"ok": False, "error": "invalid_page"}), 400
        with _lock:
            current = _sheets.get(key)
            layout = current.layout if current is not None and current.page_id == page_id else None
        try:
            view = _clean_view(raw.get("view"))
            if layout is None:
                layout = street_screen.screen_layout("map-screen", sheet=key)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        page = {"id": page_id, "view": view, "layout": layout, "shown": bool(raw.get("shown")),
                "ready": bool(raw.get("ready")), "closing": bool(raw.get("closing")), "cone": raw.get("cone")}
    sheet = report(key, page)
    return jsonify(_reply(sheet, known))


# ------------------------------------------------------------------------------ the slow capture
def _ip_webcam_photo():
    """The IP Webcam app's full-resolution photo (much sharper than its video), or None."""
    base = camera.camera_base_url()
    if not base:
        return None
    try:
        with urllib.request.urlopen(f"{base}/photo.jpg", timeout=PHOTO_TIMEOUT_S) as resp:
            data = np.frombuffer(resp.read(), np.uint8)
        return cv2.imdecode(data, cv2.IMREAD_COLOR)
    except Exception as exc:
        print(f"[Paper] full-resolution photo failed: {exc}", flush=True)
        return None


def _tags_in(image, family):
    from . import detection  # detection imports this module
    manager = detection.detector_manager
    min_area = float(manager.args.aruco_min_area) if manager is not None else 200.0
    detector = detection.ArucoDetector([family], min_area)
    return {int(det.tag_id): det.corners for det in detector.detect(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))}


def _sharp_still(layout, expected):
    """(straightened image, px per mm) of the IP Webcam's photo when it shows the whole sheet (the
    expected tags) with no hand over it, else None."""
    photo = _ip_webcam_photo()
    if photo is None:
        return None
    homography, seen = paper_ink.sheet_homography(layout, _tags_in(photo, layout["family"]))
    if homography is None or len(seen) < MIN_TAGS or not set(expected) <= set(seen):
        print("[Paper] the full-resolution photo does not show the whole sheet", flush=True)
        return None
    quad = paper_ink.sheet_quad(homography, layout, HAND_MARGIN_MM)
    seen_hands = hands.hands_in(photo, (*quad.min(axis=0), *quad.max(axis=0)))
    if seen_hands and hands.any_in(seen_hands, quad):
        print("[Paper] a hand came into the full-resolution photo", flush=True)
        return None
    return paper_ink.straighten(photo, homography, layout, SLOW_PX_PER_MM), SLOW_PX_PER_MM


def slow_capture(sheet_key="map-screen", timeout_s=SLOW_TIMEOUT_S, still=_sharp_still):
    """A slower, sharper photo of a sheet's page with no hand over it, for reading handwriting later.

    Waits up to timeout_s for the sheet's next clean moment, then takes the sharpest still there is:
    the IP Webcam app's full-resolution photo (checked again for tags and hands), else the clean
    moment's own video frames. It is straightened (SLOW_PX_PER_MM for the photo) and compared with
    the page's reference, and saved in the sessions folder's map_view_pages as
    <page>-slow-<time>.jpg (the page as photographed, projection and all), -ink.png (only what was
    drawn, on white: the image digitizer/handwriting.py gives the model) and .json (how it maps onto
    the inside and the view, so finds can be placed on the map). Returns that .json's content.
    Raises LookupError when the sheet has no page with a reference yet, TimeoutError when no clean
    moment comes in time."""
    started = time.monotonic()
    deadline = started + float(timeout_s)
    with _clean_seen:
        while True:
            sheet = _sheets.get(sheet_key)
            if sheet is None or sheet.page_id is None or sheet.reference is None:
                raise LookupError("no_reference")
            clean = sheet.clean
            if clean is not None and clean["at"] >= started and clean["generation"] == sheet.generation:
                break
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("no_clean_moment")
            _clean_seen.wait(left)
        page_id, layout, view = sheet.page_id, sheet.layout, sheet.view
        reference = sheet.reference
        discs = _discs(sheet.cone, sheet.reference_cone)
        expected = _expected_tags(sheet.tags_read, layout)
    sharp = still(layout, expected) if still else None
    if sharp is not None:
        image, px_per_mm = sharp
        source = "photo"
    else:
        image, px_per_mm = _mean(clean["stills"]), paper_ink.PX_PER_MM
        source = "video"
    height, width = image.shape[:2]
    reference = cv2.resize(reference, (width, height), interpolation=cv2.INTER_CUBIC)
    valid = paper_ink.valid_mask(layout, image.shape, px_per_mm, discs)
    relative, _change = paper_ink.compare(image, reference, valid, px_per_mm)
    stamp = time.strftime("%H%M%S")
    name = f"{page_id}-slow-{stamp}"
    folder = _pages_folder()
    _save_image(folder / f"{name}.jpg", image)
    cv2.imwrite(str(folder / f"{name}-ink.png"), paper_ink.added_ink_image(relative, valid, px_per_mm))
    record = {"pageId": page_id, "sheet": layout.get("sheet"), "capturedAt": utc_now_iso(), "source": source,
              "image": f"{name}.jpg", "ink": f"{name}-ink.png", "pxPerMm": px_per_mm,
              "interiorMm": layout["interiorMm"], "view": view}
    (folder / f"{name}.json").write_text(json.dumps(record), encoding="utf-8")
    print(f"[Paper] {sheet_key}: slow capture of page {page_id} ({source}) saved as {name}", flush=True)
    return record


@bp.route("/api/map-screen/slow-capture", methods=["POST"])
def api_map_screen_slow_capture():
    """Runs slow_capture() for a sheet ("sheet": its key; "timeoutS": how long to wait for a clean
    moment). Not used by the map page yet."""
    payload = request.get_json(silent=True) or {}
    key = str(payload.get("sheet") or "map-screen")[:64]
    try:
        timeout = min(60.0, max(1.0, float(payload.get("timeoutS") or SLOW_TIMEOUT_S)))
    except (TypeError, ValueError):
        timeout = SLOW_TIMEOUT_S
    try:
        record = slow_capture(key, timeout)
    except LookupError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 409
    except TimeoutError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 504
    except Exception:
        logging.exception("The slow capture failed")
        return jsonify({"ok": False, "error": "capture_failed"}), 500
    return jsonify({"ok": True, **record})
