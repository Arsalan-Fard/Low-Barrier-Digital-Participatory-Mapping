"""Geometry of a printable map sheet, shared by the PDF and the Word export."""
import math

import cv2

SHEET_PAGE_SIZES = ("A4", "A3")
MAP_SHEET_PAGE_MARGIN = 12.0
# Side margins ("panels") are note columns left and/or right of the map frame; the frame gives
# up the width, so a panel is whatever the frame leaves free.
SIDE_PANEL_MIN_WIDTH = 20.0
SIDE_PANEL_PAD = 6.0
SIDE_PANEL_TEXT_LIMIT = 4000
SIDE_PANEL_SIDES = ("left", "right")


def _clean_page_size(raw):
    value = str(raw or "").strip().upper()
    return value if value in SHEET_PAGE_SIZES else "A4"


def _clean_text_block(raw):
    source = raw if isinstance(raw, dict) else {}
    text = str(source.get("text") or "").replace("\x00", "").strip()
    return {"enabled": bool(source.get("enabled")), "text": text[:1200]}


def _clean_map_frame(raw, page_w, page_h, patch_size):
    """[left, top, width, height] of the map on the page, inside the margins and not too small."""
    margin = MAP_SHEET_PAGE_MARGIN
    default = [margin, margin, page_w - margin * 2.0, page_h - margin * 2.0]
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return default
    try:
        frame = [float(value) for value in raw]
    except (TypeError, ValueError):
        return default
    if not all(math.isfinite(value) for value in frame):
        return default
    min_w = max(patch_size * 4.25, page_w * 0.28)
    min_h = max(patch_size * 3.25, page_h * 0.28)
    width = min(page_w - margin * 2.0, max(min_w, frame[2]))
    height = min(page_h - margin * 2.0, max(min_h, frame[3]))
    left = min(max(margin, frame[0]), page_w - margin - width)
    top = min(max(margin, frame[1]), page_h - margin - height)
    return [left, top, width, height]


def clean_side_panels(raw):
    """{"left": {"text"} | None, "right": ...}. A panel with no text is still a blank margin."""
    source = raw if isinstance(raw, dict) else {}
    panels = {}
    for side in SIDE_PANEL_SIDES:
        panel = source.get(side)
        if isinstance(panel, dict):
            text = str(panel.get("text") or "").replace("\x00", "")
            text = text.replace("\r\n", "\n").replace("\r", "\n").strip("\n")
            panels[side] = {"text": text[:SIDE_PANEL_TEXT_LIMIT]}
        else:
            panels[side] = None
    return panels


def panel_font_size(layout):
    return 11.0 if layout["pageSize"] == "A4" else 13.0


def panel_regions(layout):
    """Left and right panel rectangles [x, y, w, h] in points, top-left origin."""
    page_w = layout["page"][0]
    map_x, map_y, map_w, map_h = layout["mapFrame"]
    margin = MAP_SHEET_PAGE_MARGIN
    return {
        "left": [margin, map_y, max(0.0, map_x - margin), map_h],
        "right": [map_x + map_w, map_y, max(0.0, page_w - margin - (map_x + map_w)), map_h],
    }


def map_sheet_layout(page_size="A4", customization=None):
    """Geometry of a sheet in PDF points with a TOP-LEFT origin, as the browser and OpenCV use. The
    PDF and the Word file are drawn from it, and /api/map-sheet-layout serves it to the editor."""
    size = _clean_page_size(page_size)
    if size == "A3":
        page_w, page_h = 1190.55, 841.89
        tag_size = 28.0
    else:
        page_w, page_h = 841.89, 595.28
        tag_size = 20.0
    quiet = 3.0
    patch = tag_size + 2.0 * quiet
    custom = customization if isinstance(customization, dict) else {}
    map_x, map_y, map_w, map_h = _clean_map_frame(custom.get("mapFrame"), page_w, page_h, patch)
    # Eight tags: three across the top, one mid-left, one mid-right, three across the bottom.
    mid_x = map_x + (map_w - patch) * 0.5
    mid_y = map_y + (map_h - patch) * 0.5
    right = map_x + map_w - patch
    bottom = map_y + map_h - patch
    patches = [(map_x, map_y), (mid_x, map_y), (right, map_y), (map_x, mid_y),
               (right, mid_y), (map_x, bottom), (mid_x, bottom), (right, bottom)]

    # The ID plate sits just right of the top-left tag, away from the edge a drawing hand rests
    # on; a side margin wide enough for it takes it instead (foot of the margin, left first).
    badge_w, badge_h = 70.0, 14.0
    badge_x = map_x + patch + 4.0
    badge_top = map_y + (patch - badge_h) * 0.5
    badge_panel = None
    side_panels = clean_side_panels(custom.get("sidePanels"))
    margin = MAP_SHEET_PAGE_MARGIN
    spans = {"left": (margin, map_x - margin), "right": (map_x + map_w, page_w - margin - (map_x + map_w))}
    for side in SIDE_PANEL_SIDES:
        span_left, span_width = spans[side]
        if side_panels[side] and span_width >= badge_w + SIDE_PANEL_PAD * 2.0:
            badge_panel = side
            badge_x = span_left + (span_width - badge_w) / 2
            badge_top = map_y + map_h - SIDE_PANEL_PAD - badge_h
            break
    return {
        "pageSize": size,
        "page": [page_w, page_h],
        "mapFrame": [round(map_x, 3), round(map_y, 3), round(map_w, 3), round(map_h, 3)],
        # 16h5 ids 21-28 stay clear of the tangible tools' ids (1-20).
        "tagIds": list(range(21, 29)),
        "tagSize": tag_size,
        "quiet": quiet,
        "patchSize": patch,
        "patches": [[round(x, 3), round(y, 3)] for x, y in patches],
        "badge": [round(badge_x, 3), round(badge_top, 3), badge_w, badge_h],
        "badgePanel": badge_panel,
        # Missing means shown, so sheets from clients that never send it keep their ID.
        "showBadge": bool(custom.get("showBadge", True)),
        "header": _clean_text_block(custom.get("header")),
        "footer": _clean_text_block(custom.get("footer")),
    }


def fiducial_image(tag_id):
    """AprilTag 16h5 `tag_id` with a white border, as a grayscale image."""
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_16h5)
    marker = cv2.aruco.generateImageMarker(dictionary, tag_id, 600, borderBits=1)
    return cv2.copyMakeBorder(marker, 90, 90, 90, 90, cv2.BORDER_CONSTANT, value=255)
