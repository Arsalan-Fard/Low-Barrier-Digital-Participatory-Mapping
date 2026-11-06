"""The printed screens: A3 sheets with AprilTags round their border, laid on the table. The map
page fits each sheet's pose from its tags and projects into its white inside: the street view on
one, a map on each map view sheet (a close-up round the street view pointer, or the view the
Project panel assigned to it). Every sheet carries its own tags. The layout JSON and the PDF come
from the same numbers, so they cannot drift apart. The pen drawings on the map view sheets are
photographed by paper_watch.py, whenever no hand is over the paper."""
import re
import io
import logging
import random

import cv2
from flask import Blueprint, Response, jsonify, request

from .marker_settings import APRILTAG_DICTS, SCREEN_SLOTS, load_marker_settings, map_sheet_number

bp = Blueprint("street_screen", __name__)

SCREEN_PAGE_MM = (420.0, 297.0)  # A3 landscape
SCREEN_EDGE_MM = 3.0  # left blank: most printers cannot reach the edge
SCREEN_QUIET_MM = 3.0  # white round the black square inside its cell
SCREEN_MIN_TAGS = 2
# Per screen tool: the label printed on its border when the slot has none, the mosaic's seed (so
# the sheets do not look alike; map view sheet n adds 100 * (n - 1)) and whether the street view
# pointer is printed too. The PDF's title and file name come from the label.
SCREENS = {
    "street-screen": {"label": "Street view", "seed": 7, "pointerPage": True},
    "map-screen": {"label": "Map view", "seed": 8, "pointerPage": False},
}


def screen_settings(tool, sheet=None):
    """(family, {slot: tag id}, street view pointer tag id or None, the screen's marker slot) from
    the marker settings. sheet picks a map view sheet by its key; the first when not given."""
    settings = load_marker_settings()
    key = str(sheet) if tool == "map-screen" and sheet else tool
    screen = None
    pointer_id = None
    for slot in settings["slots"]:
        if slot["tool"] == tool and slot["key"] == key:
            screen = slot
        elif slot["tool"] == "street-view" and pointer_id is None and slot.get("tagId") is not None:
            pointer_id = int(slot["tagId"])
    if screen is None:
        raise ValueError("unknown_sheet")
    slot_ids = {name: int(tag_id) for name, tag_id in zip(SCREEN_SLOTS, screen["frameTagIds"]) if tag_id is not None}
    return settings["family"], slot_ids, pointer_id, screen


def screen_label(tool, screen):
    return str(screen.get("label") or SCREENS[tool]["label"])


def screen_seed(tool, screen):
    return SCREENS[tool]["seed"] + 100 * ((map_sheet_number(screen["key"]) or 1) - 1)


def slot_centres(page_mm=SCREEN_PAGE_MM, tag_mm=32.0):
    """[(slot, cx, cy)] in SCREEN_SLOTS order: where each border tag's cell is centred, in mm."""
    width, height = page_mm
    cell = tag_mm + 2.0 * SCREEN_QUIET_MM
    near = SCREEN_EDGE_MM + cell / 2.0  # a cell centre's distance from the page edge
    return [
        ("tl", near, near), ("tr", width - near, near),
        ("br", width - near, height - near), ("bl", near, height - near),
        ("rm", width - near, height / 2.0), ("bm", width / 2.0, height - near),
        ("lm", near, height / 2.0),
    ]


def frame_layout(family, slot_ids, label_text, pointer_id=None, border_mm=24.0, tag_mm=32.0,
                 page_mm=SCREEN_PAGE_MM):
    """A sheet with tags round its border ({slot: tag id}), in millimetres from the top-left, y down.
    The tag cells are bigger than the border band and stand proud of it into the white inside,
    their outer edge on the page margin."""
    width, height = page_mm
    edge = SCREEN_EDGE_MM
    cell = tag_mm + 2.0 * SCREEN_QUIET_MM
    half = tag_mm / 2.0
    tags = []
    for slot, cx, cy in slot_centres(page_mm, tag_mm):
        if slot in slot_ids:
            tags.append({
                "id": slot_ids[slot], "slot": slot, "cx": cx, "cy": cy,
                # the black square's corners as OpenCV reports an upright marker: clockwise from top-left
                "corners": [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]],
            })
    # Between the two top corner cells, with a margin (an A4 portrait page is narrower than 150 mm allows).
    label_w = min(150.0, width - 2.0 * (edge + cell + 6.0))
    return {
        "pageMm": [width, height],
        "edgeMm": edge,
        "borderMm": border_mm,
        "tagMm": tag_mm,
        "quietMm": SCREEN_QUIET_MM,
        "cellMm": cell,
        "interiorMm": [edge + border_mm, edge + border_mm, width - edge - border_mm, height - edge - border_mm],
        "labelMm": [width / 2.0 - label_w / 2.0, edge + 2.0, width / 2.0 + label_w / 2.0, edge + border_mm - 2.0],
        "labelText": label_text,
        "tags": tags,
        "pointerTagId": pointer_id,
        "family": family,
    }


def screen_layout(tool, border_mm=24.0, tag_mm=32.0, sheet=None):
    """The layout of a printed screen from its tags on the Marker Setting page."""
    family, slot_ids, pointer_id, screen = screen_settings(tool, sheet)
    if len(slot_ids) < SCREEN_MIN_TAGS:
        raise ValueError("screen_tags_unassigned")
    layout = frame_layout(family, slot_ids, screen_label(tool, screen).upper(), pointer_id, border_mm, tag_mm)
    layout["sheet"] = screen["key"]
    return layout


def _screen_args(default_seed):
    """borderMm, tagMm and seed from the query string, bounded to what prints and still decodes."""
    try:
        border = float(request.args.get("borderMm", 24.0))
        tag = float(request.args.get("tagMm", 32.0))
        seed = int(request.args.get("seed", default_seed))
    except (TypeError, ValueError):
        raise ValueError("invalid_size")
    if not (10.0 <= border <= 60.0) or not (8.0 <= tag <= 60.0):
        raise ValueError("invalid_size")
    return border, tag, seed


def _marker_bitmap(family, tag_id):
    """(the marker's cells as a 0/255 array, black border included, cells per side)."""
    dictionary = cv2.aruco.getPredefinedDictionary(APRILTAG_DICTS[family])
    cells = int(getattr(dictionary, "markerSize", 4)) + 2
    return cv2.aruco.generateImageMarker(dictionary, int(tag_id), cells), cells


def screen_mosaic(layout, seed=7, density=0.5, moat_modules=1):
    """The border as random black squares on the tags' own module grid, so the band reads as one big
    tag; rectangles in mm clipped to the band. Each real tag keeps a one-module white moat beyond
    its cell, or a square touching its border would fuse with it on camera. Random rather than
    regular, since a regular pattern can line up with the detector's sampling and fake a code."""
    width, height = layout["pageMm"]
    edge = layout["edgeMm"]
    border = layout["borderMm"]
    module = layout["tagMm"] / _marker_bitmap(layout["family"], layout["tags"][0]["id"])[1]
    rng = random.Random(int(seed))
    pad = moat_modules * module
    half = layout["cellMm"] / 2.0 + pad
    keep_out = [(tag["cx"] - half, tag["cy"] - half, tag["cx"] + half, tag["cy"] + half) for tag in layout["tags"]]
    label = layout["labelMm"]
    keep_out.append((label[0] - pad, label[1] - pad, label[2] + pad, label[3] + pad))
    bands = [
        (edge, edge, width - edge, edge + border),
        (edge, height - edge - border, width - edge, height - edge),
        (edge, edge, edge + border, height - edge),
        (width - edge - border, edge, width - edge, height - edge),
    ]
    squares = []
    columns = int((width - 2 * edge) / module) + 1
    rows = int((height - 2 * edge) / module) + 1
    for row in range(rows):
        for column in range(columns):
            x0 = edge + column * module
            y0 = edge + row * module
            x1 = x0 + module
            y1 = y0 + module
            # Drawn for every module, landing or not, so a seed's pattern does not shift with the layout.
            if rng.random() >= density:
                continue
            for bx0, by0, bx1, by1 in bands:
                cx0 = max(x0, bx0)
                cy0 = max(y0, by0)
                cx1 = min(x1, bx1)
                cy1 = min(y1, by1)
                if cx1 - cx0 < 0.05 or cy1 - cy0 < 0.05:
                    continue
                if any(cx0 < k[2] and cx1 > k[0] and cy0 < k[3] and cy1 > k[1] for k in keep_out):
                    continue
                squares.append((cx0, cy0, cx1 - cx0, cy1 - cy0))
                break
    return squares


def draw_screen_pdf(layout, title, pointer_size_cm, seed=7):
    """Page 1: the screen, at the layout's page size. Page 2, when pointer_size_cm is given: two
    copies of the street view pointer tag to cut out."""
    try:
        from reportlab.lib.units import mm
        from reportlab.pdfgen import canvas
    except ImportError as exc:
        raise RuntimeError("reportlab_not_installed") from exc

    width, height = layout["pageMm"]
    page = (width * mm, height * mm)
    page_h = page[1]
    family = layout["family"]

    def px(x_mm):
        return x_mm * mm

    def py(y_mm):  # the layout's y runs down the page, reportlab's up
        return page_h - y_mm * mm

    out = io.BytesIO()
    pdf = canvas.Canvas(out, pagesize=page, pageCompression=1)
    pdf.setTitle(title)
    pdf.setAuthor("Low-Barrier Digital Participatory Mapping")

    def draw_marker(cx, cy, size_mm, tag_id):
        bitmap, cells = _marker_bitmap(family, tag_id)
        cell = size_mm / cells
        left = cx - size_mm / 2.0
        top = cy - size_mm / 2.0
        pdf.setFillColorRGB(0, 0, 0)
        for row in range(cells):
            for column in range(cells):
                if int(bitmap[row, column]) < 128:
                    pdf.rect(px(left + column * cell), py(top + (row + 1) * cell), cell * mm, cell * mm, fill=1, stroke=0)

    pdf.setFillColorRGB(0, 0, 0)
    for x, y, w, h in screen_mosaic(layout, seed):
        pdf.rect(px(x), py(y + h), w * mm, h * mm, fill=1, stroke=0)
    cell = layout["cellMm"]
    for tag in layout["tags"]:
        pdf.setFillColorRGB(1, 1, 1)
        pdf.rect(px(tag["cx"] - cell / 2.0), py(tag["cy"] + cell / 2.0), cell * mm, cell * mm, fill=1, stroke=0)
        draw_marker(tag["cx"], tag["cy"], layout["tagMm"], tag["id"])

    x0, y0, x1, y1 = layout["labelMm"]
    text = layout["labelText"]
    pdf.setFillColorRGB(1, 1, 1)
    pdf.roundRect(px(x0), py(y1), (x1 - x0) * mm, (y1 - y0) * mm, 2.5 * mm, fill=1, stroke=0)
    # As large as the plate allows with a margin; Helvetica's capitals stand about 0.72 em.
    font = "Helvetica-Bold"
    size = min(((y1 - y0) - 6.0) * mm / 0.72, 200.0)
    while size > 6 and pdf.stringWidth(text, font, size) > (x1 - x0 - 16.0) * mm:
        size -= 0.5
    pdf.setFillColorRGB(0, 0, 0)
    pdf.setFont(font, size)
    baseline = (y0 + y1) / 2.0 + (size * 0.72 / mm) / 2.0
    pdf.drawCentredString(px((x0 + x1) / 2.0), py(baseline), text)
    pdf.showPage()

    pointer_id = layout["pointerTagId"]
    if pointer_id is not None and pointer_size_cm is not None:
        pointer = float(pointer_size_cm) * 10.0
        card_w = pointer + 40.0
        card_h = pointer + 58.0
        gap = 24.0
        left0 = (width - 2 * card_w - gap) / 2.0
        top0 = (height - card_h) / 2.0
        cells = _marker_bitmap(family, pointer_id)[1]
        for k in range(2):
            left = left0 + k * (card_w + gap)
            pdf.setStrokeColorRGB(0.5, 0.5, 0.5)
            pdf.setLineWidth(0.5)
            pdf.setDash(3, 3)
            pdf.rect(px(left), py(top0 + card_h), card_w * mm, card_h * mm, fill=0, stroke=1)
            pdf.setDash()
            cx = left + card_w / 2.0
            cy = top0 + 24.0 + pointer / 2.0
            draw_marker(cx, cy, pointer, pointer_id)
            # The tag's up is the direction of the view; the arrow keeps that after cutting out.
            pdf.setStrokeColorRGB(0.1, 0.1, 0.1)
            pdf.setFillColorRGB(0.1, 0.1, 0.1)
            pdf.setLineWidth(1.2)
            ay = top0 + 20.0
            pdf.line(px(cx), py(ay), px(cx), py(ay - 11.0))
            pdf.line(px(cx), py(ay - 11.0), px(cx - 3.0), py(ay - 7.5))
            pdf.line(px(cx), py(ay - 11.0), px(cx + 3.0), py(ay - 7.5))
            pdf.setFont("Helvetica-Bold", 10)
            pdf.drawCentredString(px(cx), py(cy + pointer / 2.0 + 9.0), "Street view pointer  -  ID " + str(pointer_id))
            pdf.setFont("Helvetica", 7.5)
            pdf.drawCentredString(px(cx), py(cy + pointer / 2.0 + 15.0),
                                  "Place it on the map; the arrow is the direction of the view")
            pdf.drawCentredString(px(cx), py(cy + pointer / 2.0 + 20.5),
                                  "%s, %d modules, %.0f mm" % (family, cells, pointer))
        pdf.showPage()
    pdf.save()
    return out.getvalue()


# /api/street-screen/... and /api/map-screen/...; a map view sheet other than the first is picked
# with ?sheet=<its key>.
@bp.route("/api/<any(street, map):kind>-screen/frame", methods=["GET"])
def api_screen_frame(kind):
    tool = kind + "-screen"
    try:
        border, tag, _seed = _screen_args(0)
        layout = screen_layout(tool, border, tag, request.args.get("sheet"))
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True, **layout})


@bp.route("/api/<any(street, map):kind>-screen/frame.pdf", methods=["GET"])
def api_screen_frame_pdf(kind):
    tool = kind + "-screen"
    title = SCREENS[tool]["label"] + " screen"
    try:
        _family, _ids, _pointer, screen = screen_settings(tool, request.args.get("sheet"))
        label = screen_label(tool, screen)
        title = label + " screen"
        border, tag, seed = _screen_args(screen_seed(tool, screen))
        layout = screen_layout(tool, border, tag, screen["key"])
        pointer_cm = float(load_marker_settings()["tagSizeCm"] or 3.0) if SCREENS[tool]["pointerPage"] else None
        pdf_bytes = draw_screen_pdf(layout, title, pointer_cm, seed)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500
    except Exception:
        logging.exception("Failed to create the %s PDF", title.lower())
        return jsonify({"ok": False, "error": "screen_export_failed"}), 500
    filename = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") + "-screen-A3.pdf"
    return Response(pdf_bytes, mimetype="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="%s"' % filename})
