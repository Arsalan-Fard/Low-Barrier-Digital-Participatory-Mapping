"""Marker settings API, AprilTag SVGs and the printable marker sheet."""
import io
import json
import logging
import math
import re
import xml.etree.ElementTree as ET

import cv2
from flask import Blueprint, Response, jsonify, request

from . import config, detection
from .marker_settings import (APRILTAG_DICTS, available_marker_families, load_marker_settings,
                              marker_family_ids, save_marker_settings)

bp = Blueprint("markers", __name__)


def generated_apriltag_svg(family, tag_id):
    """The tag as an SVG of black cells with a one-cell white quiet zone, or None."""
    if family not in APRILTAG_DICTS:
        return None
    try:
        dictionary = cv2.aruco.getPredefinedDictionary(APRILTAG_DICTS[family])
        if tag_id < 0 or tag_id >= int(dictionary.bytesList.shape[0]):
            return None
        marker_cells = int(getattr(dictionary, "markerSize", 6)) + 2
        marker = cv2.aruco.generateImageMarker(dictionary, tag_id, marker_cells)
    except Exception:
        return None

    size = marker_cells + 2
    rects = []
    for y in range(marker_cells):
        for x in range(marker_cells):
            if int(marker[y, x]) < 128:
                rects.append(f'<rect x="{x + 1}" y="{y + 1}" width="1" height="1"/>')
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
        'width="200" height="200" shape-rendering="crispEdges">\n'
        f'<rect x="0" y="0" width="{size}" height="{size}" fill="#fff"/>\n'
        '<g fill="#000">\n' + "".join(rects) + '\n</g>\n</svg>\n'
    )


def _marker_sheet_entries(raw_entries, family):
    """The [{id, use}] list sent by the marker page, cleaned: known ids only, each once, at most 64."""
    if isinstance(raw_entries, str):
        if len(raw_entries) > 16000:
            raise ValueError("marker_sheet_payload_too_large")
        try:
            raw_entries = json.loads(raw_entries)
        except (TypeError, ValueError):
            raise ValueError("invalid_marker_sheet_entries")
    if not isinstance(raw_entries, list):
        raise ValueError("invalid_marker_sheet_entries")

    allowed_ids = marker_family_ids(family)
    entries = []
    seen = set()
    for raw in raw_entries[:64]:
        if not isinstance(raw, dict):
            continue
        try:
            tag_id = int(raw.get("id"))
        except (TypeError, ValueError):
            continue
        if tag_id not in allowed_ids or tag_id in seen:
            continue
        use = re.sub(r"\s+", " ", str(raw.get("use") or "")).strip()[:80] or "Marker"
        entries.append({"id": tag_id, "use": use})
        seen.add(tag_id)
    if not entries:
        raise ValueError("no_marker_ids_selected")
    return entries


def _svg_path(pdf, d):
    """The M/L/H/V/Z path commands Pointer1.svg uses, as a ReportLab path."""
    tokens = re.findall(r"[MmLlHhVvZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?", str(d or ""))
    path = pdf.beginPath()
    index = 0
    command = None
    x = y = start_x = start_y = 0.0

    def is_command(token):
        return len(token) == 1 and token.isalpha()

    def number():
        nonlocal index
        if index >= len(tokens) or is_command(tokens[index]):
            raise ValueError("pointer_template_invalid")
        index += 1
        return float(tokens[index - 1])

    while index < len(tokens):
        if is_command(tokens[index]):
            command = tokens[index]
            index += 1
        if command is None:
            raise ValueError("pointer_template_invalid")
        kind = command.lower()
        relative = command.islower()
        if kind == "z":
            path.close()
            x, y = start_x, start_y
            command = None
        elif kind in ("m", "l"):
            if index + 1 >= len(tokens):
                raise ValueError("pointer_template_invalid")
            next_x = number()
            next_y = number()
            if relative:
                next_x += x
                next_y += y
            x, y = next_x, next_y
            if kind == "m":
                path.moveTo(x, y)
                start_x, start_y = x, y
                command = "l" if relative else "L"  # coordinates after a move are line-tos
            else:
                path.lineTo(x, y)
        elif kind == "h":
            value = number()
            x = x + value if relative else value
            path.lineTo(x, y)
        elif kind == "v":
            value = number()
            y = y + value if relative else value
            path.lineTo(x, y)
        else:
            raise ValueError("pointer_template_invalid")
    return path


def _draw_pointer_svg(pdf, svg_path, x, y, size):
    """Draw the checked-in Pointer1.svg into the PDF as vector paths, `size` points square."""
    from reportlab.lib.colors import HexColor

    root = ET.parse(svg_path).getroot()
    view_box = [float(v) for v in str(root.attrib.get("viewBox") or "0 0 100 100").replace(",", " ").split()]
    if len(view_box) != 4 or view_box[2] <= 0 or view_box[3] <= 0:
        raise ValueError("pointer_template_invalid")
    view_x, view_y, view_w, view_h = view_box

    def style_values(node):
        values = {}
        for item in str(node.attrib.get("style") or "").split(";"):
            if ":" in item:
                key, value = item.split(":", 1)
                values[key.strip()] = value.strip()
        for key in ("fill", "stroke", "stroke-width"):
            if key in node.attrib:
                values[key] = node.attrib[key]
        return values

    def apply_transform(node):
        text = str(node.attrib.get("transform") or "").strip()
        if not text:
            return
        match = re.fullmatch(r"matrix\(([^)]+)\)", text)
        if not match:
            raise ValueError("pointer_template_invalid")
        values = [float(v) for v in re.split(r"[\s,]+", match.group(1).strip()) if v]
        if len(values) != 6:
            raise ValueError("pointer_template_invalid")
        pdf.transform(*values)

    def render(node):
        pdf.saveState()
        apply_transform(node)
        if node.tag.rsplit("}", 1)[-1] == "path":
            values = style_values(node)
            fill_value = values.get("fill", "#000000")
            stroke_value = values.get("stroke", "none")
            fill = fill_value.lower() != "none"
            stroke = stroke_value.lower() != "none"
            if fill:
                pdf.setFillColor(HexColor(fill_value))
            if stroke:
                pdf.setStrokeColor(HexColor(stroke_value))
                try:
                    pdf.setLineWidth(float(values.get("stroke-width", 0.25)))
                except (TypeError, ValueError):
                    pdf.setLineWidth(0.25)
                pdf.setLineJoin(2)
            pdf.drawPath(_svg_path(pdf, node.attrib.get("d")), fill=int(fill), stroke=int(stroke))
        else:
            for child in node:
                render(child)
        pdf.restoreState()

    pdf.saveState()
    pdf.translate(x, y + size)
    pdf.scale(size / view_w, -size / view_h)
    pdf.translate(-view_x, -view_y)
    render(root)
    pdf.restoreState()


def _draw_marker_sheet_pdf(family, tag_size_cm, entries):
    """A printable sheet of the tags with their uses, ending with a dimensioned guide to the
    cardboard pointer. Returns (pdf bytes, "A4" or "A3")."""
    try:
        from reportlab.lib.pagesizes import A3, A4
        from reportlab.lib.units import cm, mm
        from reportlab.pdfgen import canvas
    except ImportError as exc:
        raise RuntimeError("reportlab_not_installed") from exc

    tag_size = float(tag_size_cm) * cm
    page_size = A4 if tag_size + 8 * mm <= A4[0] - 24 * mm else A3
    page_w, page_h = page_size
    margin = 12 * mm
    content_w = page_w - margin * 2
    card_w = max(36 * mm, tag_size + 6 * mm)
    card_h = tag_size + 14 * mm
    if card_w > content_w:
        raise ValueError("marker_size_does_not_fit_page")
    columns = max(1, int(content_w // card_w))
    guide_rows = max(0, int((page_h - margin - 118 * mm) // card_h))
    full_rows = max(1, int((page_h - margin * 2) // card_h))
    guide_capacity = columns * guide_rows
    full_capacity = columns * full_rows

    dictionary = cv2.aruco.getPredefinedDictionary(APRILTAG_DICTS[family])
    marker_cells = int(getattr(dictionary, "markerSize", 6)) + 2
    viewbox_cells = marker_cells + 2

    out = io.BytesIO()
    pdf = canvas.Canvas(out, pagesize=page_size, pageCompression=1)
    pdf.setTitle("Marker sheet")
    pdf.setAuthor("Low-Barrier Digital Participatory Mapping")

    def draw_marker(entry, card_x, top_y):
        tag_x = card_x + (card_w - tag_size) * 0.5
        tag_y = top_y - tag_size
        cell = tag_size / viewbox_cells
        marker = cv2.aruco.generateImageMarker(dictionary, int(entry["id"]), marker_cells)
        pdf.setFillColorRGB(1, 1, 1)
        pdf.rect(tag_x, tag_y, tag_size, tag_size, fill=1, stroke=0)
        pdf.setFillColorRGB(0, 0, 0)
        for row in range(marker_cells):
            for column in range(marker_cells):
                if int(marker[row, column]) < 128:
                    pdf.rect(tag_x + (column + 1) * cell, tag_y + tag_size - (row + 2) * cell,
                             cell, cell, fill=1, stroke=0)
        center_x = card_x + card_w * 0.5
        pdf.setFillColorRGB(0, 0, 0)
        pdf.setFont("Helvetica-Bold", 9)
        pdf.drawCentredString(center_x, tag_y - 4.2 * mm, f"ID {entry['id']}")
        label = entry["use"]
        max_width = card_w - 2 * mm
        font_size = 8.0
        while font_size > 5.5 and pdf.stringWidth(label, "Helvetica", font_size) > max_width:
            font_size -= 0.5
        if pdf.stringWidth(label, "Helvetica", font_size) > max_width:
            while label and pdf.stringWidth(label + "...", "Helvetica", font_size) > max_width:
                label = label[:-1]
            label += "..."
        pdf.setFont("Helvetica", font_size)
        pdf.drawCentredString(center_x, tag_y - 8 * mm, label)

    def draw_entries(page_entries, rows):
        for row in range(rows):
            row_entries = page_entries[row * columns:(row + 1) * columns]
            if not row_entries:
                break
            row_x = (page_w - len(row_entries) * card_w) * 0.5
            top_y = page_h - margin - row * card_h
            for column, entry in enumerate(row_entries):
                draw_marker(entry, row_x + column * card_w, top_y)

    def dimension_style():
        pdf.setStrokeColorRGB(0.18, 0.18, 0.18)
        pdf.setFillColorRGB(0.08, 0.08, 0.08)
        pdf.setLineWidth(0.45)

    def horizontal_dimension(x1, x2, y, label):
        arrow = 2.2 * mm
        dimension_style()
        pdf.line(x1, y, x2, y)
        pdf.line(x1, y, x1 + arrow, y + arrow * 0.55)
        pdf.line(x1, y, x1 + arrow, y - arrow * 0.55)
        pdf.line(x2, y, x2 - arrow, y + arrow * 0.55)
        pdf.line(x2, y, x2 - arrow, y - arrow * 0.55)
        pdf.setFont("Helvetica", 7)
        pdf.drawCentredString((x1 + x2) * 0.5, y + 1.6 * mm, label)

    def vertical_dimension(x, y1, y2, label, label_side):
        arrow = 2.2 * mm
        dimension_style()
        pdf.line(x, y1, x, y2)
        pdf.line(x, y1, x - arrow * 0.55, y1 + arrow)
        pdf.line(x, y1, x + arrow * 0.55, y1 + arrow)
        pdf.line(x, y2, x - arrow * 0.55, y2 - arrow)
        pdf.line(x, y2, x + arrow * 0.55, y2 - arrow)
        pdf.saveState()
        pdf.translate(x + label_side * 2.5 * mm, (y1 + y2) * 0.5)
        pdf.rotate(90)
        pdf.setFont("Helvetica", 7)
        pdf.drawCentredString(0, 0, label)
        pdf.restoreState()

    def draw_pointer_guide():
        guide_size = 100 * mm
        guide_x = (page_w - guide_size) * 0.5
        guide_y = 14 * mm
        _draw_pointer_svg(pdf, config.WEB_DIR / "images" / "Pointer1.svg", guide_x, guide_y, guide_size)

        unit = guide_size / 100.0  # Pointer1.svg has one viewBox unit per millimetre

        def sx(value):
            return guide_x + value * unit

        def sy(value):
            return guide_y + (100.0 - value) * unit

        horizontal_dimension(sx(10.1809), sx(90.1809), sy(5.0), "80 mm")
        vertical_dimension(sx(96.0), sy(83.733683), sy(13.73369), "70 mm", -1)
        vertical_dimension(sx(4.0), sy(53.73369), sy(13.73369), "40 mm", 1)
        pdf.setFillColorRGB(0.08, 0.08, 0.08)
        pdf.setFont("Helvetica", 6.5)
        pdf.drawCentredString(sx(29.854147), sy(11.0), "35 x 35 mm")
        pdf.drawCentredString(sx(70.14585), sy(11.0), "35 x 35 mm")
        pdf.drawCentredString(sx(50.1809), sy(91.5), "30 mm legs")
        pdf.setFont("Helvetica", 9)
        pdf.drawCentredString(page_w * 0.5, 6.5 * mm, "This guide shows how to cut and fold the cardboard pointer.")

    # The last page also holds the guide, so it takes fewer tags; the pages before it are full.
    if len(entries) <= guide_capacity:
        leading = []
    elif guide_capacity:
        leading = entries[:len(entries) - guide_capacity]
    else:
        leading = entries
    for start in range(0, len(leading), full_capacity):
        draw_entries(leading[start:start + full_capacity], full_rows)
        pdf.showPage()
    draw_entries(entries[len(leading):], guide_rows)
    draw_pointer_guide()
    pdf.showPage()
    pdf.save()
    return out.getvalue(), ("A4" if page_size == A4 else "A3")


@bp.route("/api/marker-settings", methods=["GET"])
def api_marker_settings_load():
    return jsonify({"ok": True, **load_marker_settings(), "availableFamilies": available_marker_families()})


@bp.route("/api/marker-settings", methods=["PUT"])
def api_marker_settings_save():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_payload"}), 400
    try:
        settings = save_marker_settings(payload)
    except Exception as exc:
        logging.exception("Could not save the marker settings")
        return jsonify({"ok": False, "error": "write_failed", "detail": str(exc)}), 500
    detection.use_marker_family(settings["family"])
    return jsonify({"ok": True, **settings, "availableFamilies": available_marker_families()})


@bp.route("/api/apriltag-svg/<family>/<int:tag_id>.svg", methods=["GET"])
def api_apriltag_svg(family, tag_id):
    svg = generated_apriltag_svg(family, tag_id)
    if not svg:
        return Response("AprilTag not found", status=404, mimetype="text/plain")
    return Response(svg, mimetype="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@bp.route("/api/marker-sheet.pdf", methods=["GET"])
def api_marker_sheet_pdf():
    family = str(request.args.get("family") or "").strip()
    if family not in APRILTAG_DICTS:
        return jsonify({"ok": False, "error": "invalid_marker_family"}), 400
    try:
        size_cm = float(request.args.get("sizeCm"))
        if not math.isfinite(size_cm) or size_cm < 1 or size_cm > 20:
            raise ValueError("invalid_marker_size")
        entries = _marker_sheet_entries(request.args.get("entries"), family)
        pdf_bytes, page_name = _draw_marker_sheet_pdf(family, size_cm, entries)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500
    except Exception:
        logging.exception("Failed to create the marker-sheet PDF")
        return jsonify({"ok": False, "error": "marker_sheet_export_failed"}), 500

    size_label = f"{size_cm:g}".replace(".", "_")
    filename = f"markers_{family}_{size_label}cm_{page_name}.pdf"
    return Response(pdf_bytes, mimetype="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"})
