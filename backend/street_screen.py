"""The street view screen: an A3 sheet with AprilTags round its border, laid on the table. The map
page fits the sheet's pose from the tags and projects the street view into its white inside.
The layout JSON and the PDF come from the same numbers, so they cannot drift apart."""
import io
import logging
import random

import cv2
from flask import Blueprint, Response, jsonify, request

from .marker_settings import APRILTAG_DICTS, STREET_SCREEN_SLOTS, load_marker_settings

bp = Blueprint("street_screen", __name__)

STREET_SCREEN_PAGE_MM = (420.0, 297.0)  # A3 landscape
STREET_SCREEN_EDGE_MM = 3.0  # left blank: most printers cannot reach the edge
STREET_SCREEN_QUIET_MM = 3.0  # white round the black square inside its cell
STREET_SCREEN_LABEL = "STREET VIEW"
STREET_SCREEN_MIN_TAGS = 2


def street_screen_settings():
    """(family, {slot: tag id}, pointer tag id or None) from the marker settings."""
    settings = load_marker_settings()
    slot_ids = {}
    pointer_id = None
    for slot in settings["slots"]:
        if slot["tool"] == "street-screen":
            for name, tag_id in zip(STREET_SCREEN_SLOTS, slot["frameTagIds"]):
                if tag_id is not None:
                    slot_ids[name] = int(tag_id)
        elif slot["tool"] == "street-view" and pointer_id is None and slot.get("tagId") is not None:
            pointer_id = int(slot["tagId"])
    return settings["family"], slot_ids, pointer_id


def street_screen_layout(border_mm=24.0, tag_mm=32.0):
    """Millimetres from the top-left, y down. The tag cells are bigger than the border band and
    stand proud of it into the white inside, their outer edge on the page margin."""
    family, slot_ids, pointer_id = street_screen_settings()
    if len(slot_ids) < STREET_SCREEN_MIN_TAGS:
        raise ValueError("screen_tags_unassigned")
    width, height = STREET_SCREEN_PAGE_MM
    edge = STREET_SCREEN_EDGE_MM
    cell = tag_mm + 2.0 * STREET_SCREEN_QUIET_MM
    near = edge + cell / 2.0  # a cell centre's distance from the page edge
    centres = [
        ("tl", near, near), ("tr", width - near, near),
        ("br", width - near, height - near), ("bl", near, height - near),
        ("rm", width - near, height / 2.0), ("bm", width / 2.0, height - near),
        ("lm", near, height / 2.0),
    ]
    half = tag_mm / 2.0
    tags = []
    for slot, cx, cy in centres:
        if slot in slot_ids:
            tags.append({
                "id": slot_ids[slot], "slot": slot, "cx": cx, "cy": cy,
                # the black square's corners as OpenCV reports an upright marker: clockwise from top-left
                "corners": [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]],
            })
    label_w = 150.0
    return {
        "pageMm": [width, height],
        "edgeMm": edge,
        "borderMm": border_mm,
        "tagMm": tag_mm,
        "quietMm": STREET_SCREEN_QUIET_MM,
        "cellMm": cell,
        "interiorMm": [edge + border_mm, edge + border_mm, width - edge - border_mm, height - edge - border_mm],
        "labelMm": [width / 2.0 - label_w / 2.0, edge + 2.0, width / 2.0 + label_w / 2.0, edge + border_mm - 2.0],
        "labelText": STREET_SCREEN_LABEL,
        "tags": tags,
        "pointerTagId": pointer_id,
        "family": family,
    }


def _screen_args():
    """borderMm, tagMm and seed from the query string, bounded to what prints and still decodes."""
    try:
        border = float(request.args.get("borderMm", 24.0))
        tag = float(request.args.get("tagMm", 32.0))
        seed = int(request.args.get("seed", 7))
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


def street_screen_mosaic(layout, seed=7, density=0.5, moat_modules=1):
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


def _draw_street_screen_pdf(layout, pointer_size_cm, seed=7):
    """Page 1: the screen. Page 2: two copies of the street view pointer tag to cut out."""
    try:
        from reportlab.lib.pagesizes import A3, landscape
        from reportlab.lib.units import mm
        from reportlab.pdfgen import canvas
    except ImportError as exc:
        raise RuntimeError("reportlab_not_installed") from exc

    page = landscape(A3)
    page_h = page[1]
    width, height = layout["pageMm"]
    family = layout["family"]

    def px(x_mm):
        return x_mm * mm

    def py(y_mm):  # the layout's y runs down the page, reportlab's up
        return page_h - y_mm * mm

    out = io.BytesIO()
    pdf = canvas.Canvas(out, pagesize=page, pageCompression=1)
    pdf.setTitle("Street view screen")
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
    for x, y, w, h in street_screen_mosaic(layout, seed):
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
    if pointer_id is not None:
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


@bp.route("/api/street-screen/frame", methods=["GET"])
def api_street_screen_frame():
    try:
        border, tag, _seed = _screen_args()
        layout = street_screen_layout(border, tag)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True, **layout})


@bp.route("/api/street-screen/frame.pdf", methods=["GET"])
def api_street_screen_frame_pdf():
    try:
        border, tag, seed = _screen_args()
        layout = street_screen_layout(border, tag)
        pointer_cm = float(load_marker_settings()["tagSizeCm"] or 3.0)
        pdf_bytes = _draw_street_screen_pdf(layout, pointer_cm, seed)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500
    except Exception:
        logging.exception("Failed to create the street view screen PDF")
        return jsonify({"ok": False, "error": "screen_export_failed"}), 500
    return Response(pdf_bytes, mimetype="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="street-view-screen-A3.pdf"'})
