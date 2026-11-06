"""Which AprilTag family is in use and which tag id does which job (the Marker Setting page)."""
import json
import re
import threading

import cv2

from . import config

APRILTAG_DICTS = {
    "tag16h5": cv2.aruco.DICT_APRILTAG_16h5,
    "tag25h9": cv2.aruco.DICT_APRILTAG_25h9,
    "tag36h10": cv2.aruco.DICT_APRILTAG_36h10,
    "tag36h11": cv2.aruco.DICT_APRILTAG_36h11,
}
DEFAULT_FAMILY = "tag36h11"
DEFAULT_DRAW_OFFSET_CM = 3.0
# The printed screens' border tags in this order everywhere (here, tagAssignments.js, the marker
# page): corners clockwise from top-left, then the middles of the right, bottom and left edges.
SCREEN_SLOTS = ("tl", "tr", "br", "bl", "rm", "bm", "lm")
# The printed screens, one A3 sheet each: the street view and a close-up map round the same pointer.
SCREEN_TOOLS = ("street-screen", "map-screen")
# There can be several map view sheets: the first is "map-screen", the others are added on the
# Marker Setting page as "map-screen-<n>". The number is printed on the sheet, so it stays with it.
MAP_SHEET_KEY = "map-screen"
MAX_MAP_SHEETS = 20
_EXTRA_MAP_SHEET = re.compile(r"^map-screen-(\d{1,2})$")
# Keep in step with DEFAULT_SLOTS in web/src/tagAssignments.js. Only "draw" slots (multi-state
# pointers: closed they point, pinched open they act) and extra map view sheets can be added or
# removed, and only "draw" slots recoloured.
MARKER_SLOT_DEFAULTS = [
    {"key": "draw-1", "group": "Pointer", "tool": "draw", "label": "Pointer 1", "tagId": 11, "tagId2": None, "selectorTagId": 20, "selectorTagId2": 19, "color": "#ff5b5b", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "draw-2", "group": "Pointer", "tool": "draw", "label": "Pointer 2", "tagId": 12, "tagId2": None, "selectorTagId": None, "selectorTagId2": None, "color": "#3b82f6", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "draw-3", "group": "Pointer", "tool": "draw", "label": "Pointer 3", "tagId": 13, "tagId2": None, "selectorTagId": None, "selectorTagId2": None, "color": "#22cc66", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "draw-4", "group": "Pointer", "tool": "draw", "label": "Pointer 4", "tagId": 14, "tagId2": None, "selectorTagId": None, "selectorTagId2": None, "color": "#111111", "offsetCm": DEFAULT_DRAW_OFFSET_CM},
    {"key": "pointer-single-1", "group": "Single-state pointer", "tool": "street-view", "label": "Street view", "tagId": 23, "color": ""},
    {"key": "street-screen", "group": "Screens", "tool": "street-screen", "label": "Street view", "tagId": None, "frameTagIds": [2, 3, 4, 5, 6, 7, 8], "color": ""},
    {"key": "map-screen", "group": "Screens", "tool": "map-screen", "label": "Map view", "tagId": None, "frameTagIds": [15, 16, 17, 18, 24, 25, 26], "color": ""},
    {"key": "route-origin", "group": "Shortest-path", "tool": "route-origin", "label": "Route start", "tagId": 9, "color": ""},
    {"key": "route-dest", "group": "Shortest-path", "tool": "route-dest", "label": "Route end", "tagId": 10, "color": ""},
    {"key": "isochrone-5", "group": "Analysis", "tool": "isochrone", "label": "Isochrone 5 min", "tagId": 38, "color": "", "minutes": 5},
    {"key": "isochrone-15", "group": "Analysis", "tool": "isochrone", "label": "Isochrone 15 min", "tagId": 37, "color": "", "minutes": 15},
    {"key": "isovist-1", "group": "Analysis", "tool": "isovist", "label": "Isovist", "tagId": 39, "color": ""},
]
TAG_ID_PROPS = ("tagId", "tagId2", "selectorTagId", "selectorTagId2")


def map_sheet_number(key):
    """1 for the first map view sheet, n for "map-screen-<n>", None for anything else."""
    key = str(key or "")
    if key == MAP_SHEET_KEY:
        return 1
    match = _EXTRA_MAP_SHEET.match(key)
    if match and 2 <= int(match.group(1)) <= MAX_MAP_SHEETS:
        return int(match.group(1))
    return None


def map_sheet_label(number, sheet_count):
    """"Map view" while it is the only map view sheet, else "Map view <n>"."""
    return "Map view" if sheet_count <= 1 else f"Map view {number}"


def _tag_count(family):
    try:
        return int(cv2.aruco.getPredefinedDictionary(APRILTAG_DICTS[family]).bytesList.shape[0])
    except Exception:
        return 0


FAMILY_TAG_COUNTS = {family: _tag_count(family) for family in sorted(APRILTAG_DICTS)}

_settings_lock = threading.Lock()


def available_marker_families():
    return [{"family": family, "ids": list(range(count))} for family, count in FAMILY_TAG_COUNTS.items() if count > 0]


def marker_family_ids(family):
    return set(range(FAMILY_TAG_COUNTS.get(family, 0)))


def default_marker_settings():
    return {"family": DEFAULT_FAMILY, "tagSizeCm": 3.0, "slots": [dict(slot) for slot in MARKER_SLOT_DEFAULTS]}


def load_marker_settings():
    with _settings_lock:
        try:
            data = json.loads(config.MARKER_SETTINGS_FILE.read_text(encoding="utf-8"))
        except FileNotFoundError:
            data = default_marker_settings()
        except Exception:
            data = {}
    return sanitize_marker_settings(data)


def save_marker_settings(payload):
    settings = sanitize_marker_settings(payload)
    with _settings_lock:
        config.MARKER_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.MARKER_SETTINGS_FILE.write_text(json.dumps(settings, ensure_ascii=True, indent=2), encoding="utf-8")
    return settings


def marker_settings_family():
    return load_marker_settings()["family"]


def _clean_color(raw, fallback):
    text = str(raw or "").strip()
    if re.match(r"^#[0-9a-fA-F]{6}$", text):
        return text.lower()
    return fallback


def _clean_offset_cm(raw, fallback):
    try:
        value = float(raw)
    except Exception:
        value = fallback
    return max(0.0, min(20.0, value))


def _clean_tag_id(raw, allowed_ids):
    if raw in (None, ""):
        return None
    try:
        tag_id = int(raw)
    except Exception:
        return None
    if allowed_ids and tag_id not in allowed_ids:
        return None
    return tag_id


def _clean_frame_tag_ids(raw, fallback, allowed_ids):
    """One entry per screen slot; None where a slot has no tag or repeats one (the camera
    could not tell the two apart)."""
    source = raw if isinstance(raw, list) else fallback
    ids = []
    for index in range(len(SCREEN_SLOTS)):
        tag_id = _clean_tag_id(source[index] if index < len(source) else None, allowed_ids)
        if tag_id in ids:
            tag_id = None
        ids.append(tag_id)
    return ids


def _clean_pointer(slot, src, defaults, allowed_ids):
    """The second tag, selector pair and pen offset of a multi-state pointer; a tag never does two jobs."""
    tag_id = slot["tagId"]
    tag_id2 = _clean_tag_id(src.get("tagId2", defaults.get("tagId2")), allowed_ids)
    if tag_id2 == tag_id:
        tag_id2 = None
    selector = _clean_tag_id(src.get("selectorTagId", defaults.get("selectorTagId")), allowed_ids)
    selector2 = _clean_tag_id(src.get("selectorTagId2", defaults.get("selectorTagId2")), allowed_ids)
    if selector in (tag_id, tag_id2):
        selector = None
    if selector2 in (tag_id, tag_id2, selector):
        selector2 = None
    default_offset = defaults.get("offsetCm", DEFAULT_DRAW_OFFSET_CM)
    slot["tagId2"] = tag_id2
    slot["selectorTagId"] = selector
    slot["selectorTagId2"] = selector2
    slot["offsetCm"] = _clean_offset_cm(src.get("offsetCm", default_offset), default_offset)


def sanitize_marker_settings(payload):
    if not isinstance(payload, dict):
        payload = {}
    family = str(payload.get("family") or DEFAULT_FAMILY).strip()
    if FAMILY_TAG_COUNTS.get(family, 0) <= 0:
        family = DEFAULT_FAMILY
    allowed = marker_family_ids(family)
    try:
        tag_size = float(payload.get("tagSizeCm", 3.0))
    except Exception:
        tag_size = 3.0
    tag_size = max(1.0, min(20.0, tag_size))

    incoming = payload.get("slots")
    if not isinstance(incoming, list):
        incoming = []
    by_key = {}
    for src in incoming:
        if isinstance(src, dict) and src.get("key") is not None:
            by_key[str(src["key"] or "")] = src

    slots = []
    for default in MARKER_SLOT_DEFAULTS:
        tool = default["tool"]
        if incoming and tool == "draw" and default["key"] not in by_key:
            continue  # a pointer the user removed
        src = by_key.get(default["key"], {})
        slot = dict(default)
        slot["tagId"] = _clean_tag_id(src.get("tagId", default["tagId"]), allowed)
        if tool == "draw":
            slot["color"] = _clean_color(src.get("color"), default["color"])
            _clean_pointer(slot, src, default, allowed)
        if tool in SCREEN_TOOLS:
            slot["tagId"] = None
            slot["frameTagIds"] = _clean_frame_tag_ids(src.get("frameTagIds"), default["frameTagIds"], allowed)
        if "minutes" in default:
            try:
                slot["minutes"] = max(1, min(180, int(src.get("minutes", default["minutes"]))))
            except Exception:
                slot["minutes"] = default["minutes"]
        slots.append(slot)

    for src in incoming:
        if not isinstance(src, dict):
            continue
        key = str(src.get("key") or "")
        if not key.startswith("extra-") or str(src.get("tool") or "").strip() != "draw":
            continue
        if any(slot["key"] == key for slot in slots):
            continue
        extra = {"key": key, "group": "Pointer", "tool": "draw", "label": "",
                 "tagId": _clean_tag_id(src.get("tagId"), allowed),
                 "color": _clean_color(src.get("color"), "#ff5b5b")}
        _clean_pointer(extra, src, {}, allowed)
        slots.append(extra)

    # Extra map view sheets go right after the first one, in number order.
    extra_sheets = {}
    for src in incoming:
        if not isinstance(src, dict) or str(src.get("tool") or "").strip() != "map-screen":
            continue
        number = map_sheet_number(src.get("key"))
        if number is None or number == 1 or number in extra_sheets:
            continue
        extra_sheets[number] = {"key": f"map-screen-{number}", "group": "Screens", "tool": "map-screen",
                                "label": "", "tagId": None, "color": "",
                                "frameTagIds": _clean_frame_tag_ids(src.get("frameTagIds"), [], allowed)}
    if extra_sheets:
        at = next((i + 1 for i, slot in enumerate(slots) if slot["key"] == MAP_SHEET_KEY), len(slots))
        slots[at:at] = [extra_sheets[number] for number in sorted(extra_sheets)]
    sheet_count = sum(1 for slot in slots if slot["tool"] == "map-screen")
    for slot in slots:
        if slot["tool"] == "map-screen":
            slot["label"] = map_sheet_label(map_sheet_number(slot["key"]), sheet_count)

    # Where a screen shares an id with another tool, the screen gives way: its ids are easy
    # to hand out again, while a pointer's id is printed on a tool somebody is holding. Of two
    # screens sharing an id the later one gives way, or the camera could not tell them apart.
    claimed = set()
    for slot in slots:
        if slot["tool"] not in SCREEN_TOOLS:
            claimed.update(slot[prop] for prop in TAG_ID_PROPS if slot.get(prop) is not None)
    pointer_number = 0
    for slot in slots:
        if slot["tool"] in SCREEN_TOOLS:
            slot["frameTagIds"] = [None if tag_id in claimed else tag_id for tag_id in slot["frameTagIds"]]
            claimed.update(tag_id for tag_id in slot["frameTagIds"] if tag_id is not None)
        elif slot["tool"] == "draw":
            pointer_number += 1
            slot["label"] = f"Pointer {pointer_number}"

    return {"family": family, "tagSizeCm": tag_size, "slots": slots}
