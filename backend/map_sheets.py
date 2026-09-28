"""Printable map sheets exported from Maputnik: the map picture framed by eight registration
AprilTags, with an ID plate and optional header, footer and side-margin text, saved as PNG, PDF,
Word and a JSON record the Digitizer registers photos against."""
import base64
import binascii
import contextlib
import io
import json
import logging
import math
import os
import re
import threading

import cv2
import numpy as np
from flask import Blueprint, jsonify, request, send_from_directory

from . import config
from .helpers import utc_now_iso
from .map_sheet_docx import build_map_sheet_docx
from .map_sheet_layout import (MAP_SHEET_PAGE_MARGIN, SHEET_PAGE_SIZES, SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_PAD,
                               SIDE_PANEL_SIDES, clean_side_panels, fiducial_image, map_sheet_layout,
                               panel_font_size, panel_regions)

bp = Blueprint("map_sheets", __name__)


def clean_map_sheet_id(raw):
    """A map ID ("7") or a digitised sheet ID ("7_3"), else ""."""
    value = str(raw or "").strip()
    if re.fullmatch(r"[1-9][0-9]{0,8}(?:_[1-9][0-9]{0,8})?", value):
        return value
    return ""


def _map_id_of(sheet_id):
    return str(sheet_id or "").split("_", 1)[0]


def _record_stem(sheet_id):
    """The stored record a sheet aligns against: its own if there is one, else its map's; "" if none."""
    for stem in (sheet_id, _map_id_of(sheet_id)):
        if (config.MAP_SHEETS_DIR / f"{stem}.json").exists():
            return stem
    return ""


def _clean_lnglat_corners(raw_corners):
    if not isinstance(raw_corners, list) or len(raw_corners) != 4:
        raise ValueError("invalid_corners")
    cleaned = []
    for point in raw_corners:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            raise ValueError("invalid_corners")
        try:
            lng = float(point[0])
            lat = float(point[1])
        except (TypeError, ValueError):
            raise ValueError("invalid_corners") from None
        if not (math.isfinite(lng) and math.isfinite(lat) and -180 <= lng <= 180 and -90 <= lat <= 90):
            raise ValueError("invalid_corners")
        cleaned.append([round(lng, 10), round(lat, 10)])
    return cleaned


def _clean_camera(raw):
    camera = raw if isinstance(raw, dict) else {}
    center = camera.get("center") if isinstance(camera.get("center"), list) else []
    clean = {
        "center": [round(float(center[0]), 10), round(float(center[1]), 10)],
        "zoom": round(float(camera.get("zoom")), 6),
        "bearing": round(float(camera.get("bearing", 0)), 6),
        "pitch": round(float(camera.get("pitch", 0)), 6),
    }
    values = clean["center"] + [clean["zoom"], clean["bearing"], clean["pitch"]]
    if not all(math.isfinite(value) for value in values):
        raise ValueError("invalid_camera")
    return clean


def _decode_png(image_uri):
    """(png bytes, image) from a PNG data: URI of at most 30 MB and 12000 px a side, else None."""
    match = re.fullmatch(r"data:image/png;base64,([A-Za-z0-9+/=\r\n]+)", str(image_uri or ""))
    if not match:
        return None
    try:
        png_bytes = base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError):
        return None
    if not png_bytes.startswith(b"\x89PNG\r\n\x1a\n") or len(png_bytes) > 30 * 1024 * 1024:
        return None
    image = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim < 2 or image.shape[0] > 12000 or image.shape[1] > 12000:
        return None
    return png_bytes, image


def _map_sheet_summary(record):
    sheet_id = record.get("id")
    has_docx = (config.MAP_SHEETS_DIR / f"{sheet_id}.docx").exists()
    return {
        "id": sheet_id,
        "title": record.get("title") or "Reference map",
        "createdAt": record.get("createdAt"),
        "corners": record.get("corners"),
        "camera": record.get("camera"),
        "theme": record.get("theme") or "",
        "imageUrl": f"/api/map-sheets/{sheet_id}/image",
        "pdfUrl": f"/api/map-sheets/{sheet_id}/pdf",
        "docxUrl": f"/api/map-sheets/{sheet_id}/docx" if has_docx else None,
    }


def _side_panel_summary(layout, side_panels):
    regions = panel_regions(layout)
    summary = {}
    for side in SIDE_PANEL_SIDES:
        panel = side_panels[side]
        if panel:
            summary[side] = {"regionPoints": [round(value, 3) for value in regions[side]], "text": panel["text"]}
        else:
            summary[side] = None
    return summary


def _wrapped_lines(pdf, text, font_name, font_size, max_width):
    """Word-wrap `text` to `max_width`, breaking a single too-long word across lines."""
    lines = []
    for paragraph in str(text or "").splitlines() or [""]:
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = ""
        for word in words:
            candidate = word if not current else f"{current} {word}"
            if pdf.stringWidth(candidate, font_name, font_size) <= max_width:
                current = candidate
                continue
            if current:
                lines.append(current)
            fragment = ""
            for character in word:
                candidate = fragment + character
                if fragment and pdf.stringWidth(candidate, font_name, font_size) > max_width:
                    lines.append(fragment)
                    fragment = character
                else:
                    fragment = candidate
            current = fragment
        lines.append(current)
    return lines


def draw_map_sheet_pdf(png_bytes, record, layout, side_panels):
    """The sheet as a PDF. Also stores the print geometry in record["print"]: tag corners, the map
    frame and the areas registration must ignore, in page points with a top-left origin."""
    try:
        from reportlab.lib.utils import ImageReader
        from reportlab.pdfgen import canvas
    except ImportError as exc:
        raise RuntimeError("reportlab_not_installed") from exc

    page_w, page_h = layout["page"]
    map_x, map_y, map_w, map_h = layout["mapFrame"]
    map_pdf_y = page_h - map_y - map_h
    tag_size = layout["tagSize"]
    quiet = layout["quiet"]
    patch_size = layout["patchSize"]
    tag_positions = [(x, page_h - y - patch_size) for x, y in layout["patches"]]  # reportlab: bottom-left origin

    def normalized_rect(left, top, width, height):
        return [
            round((left - map_x) / map_w, 6), round((top - map_y) / map_h, 6),
            round((left + width - map_x) / map_w, 6), round((top + height - map_y) / map_h, 6),
        ]

    fiducials = []
    mask_rects = []
    for tag_id, (patch_x, patch_y) in zip(layout["tagIds"], tag_positions):
        patch_top = page_h - (patch_y + patch_size)
        left = patch_x + quiet
        top = patch_top + quiet
        fiducials.append({
            "id": tag_id,
            "cornersPagePoints": [
                [round(left, 3), round(top, 3)],
                [round(left + tag_size, 3), round(top, 3)],
                [round(left + tag_size, 3), round(top + tag_size, 3)],
                [round(left, 3), round(top + tag_size, 3)],
            ],
        })
        mask_rects.append(normalized_rect(patch_x, patch_top, patch_size, patch_size))

    badge_x, badge_top, badge_w, badge_h = layout["badge"]
    badge_y = page_h - badge_top - badge_h
    show_badge = layout["showBadge"]
    if show_badge and not layout["badgePanel"]:
        mask_rects.append(normalized_rect(badge_x, badge_top, badge_w, badge_h))

    record["print"] = {
        "paper": f"{layout['pageSize']} landscape",
        "pageSize": layout["pageSize"],
        "pagePoints": [round(page_w, 3), round(page_h, 3)],
        "mapFramePoints": [round(map_x, 3), round(map_y, 3), round(map_w, 3), round(map_h, 3)],
        "mapCornerPagePoints": [
            [round(map_x, 3), round(map_y, 3)],
            [round(map_x + map_w, 3), round(map_y, 3)],
            [round(map_x + map_w, 3), round(map_y + map_h, 3)],
            [round(map_x, 3), round(map_y + map_h, 3)],
        ],
        "fiducialFamily": "DICT_APRILTAG_16h5",
        "fiducials": fiducials,
        "maskRectsNormalized": mask_rects,
        "header": layout["header"],
        "footer": layout["footer"],
        "sidePanels": _side_panel_summary(layout, side_panels),
    }

    out = io.BytesIO()
    pdf = canvas.Canvas(out, pagesize=(page_w, page_h), pageCompression=1)
    pdf.setTitle(f"Map sheet {record['id']}")
    pdf.setAuthor("Low-Barrier Digital Participatory Mapping")
    pdf.setSubject("Printable georeferenced reference map")

    pdf.setFillColorRGB(1, 1, 1)
    pdf.rect(0, 0, page_w, page_h, fill=1, stroke=0)
    pdf.drawImage(ImageReader(io.BytesIO(png_bytes)), map_x, map_pdf_y, map_w, map_h,
                  preserveAspectRatio=False, mask="auto")
    pdf.setStrokeColorRGB(0, 0, 0)
    pdf.setLineWidth(0.8)
    pdf.rect(map_x, map_pdf_y, map_w, map_h, fill=0, stroke=1)

    for tag_id, (patch_x, patch_y) in zip(layout["tagIds"], tag_positions):
        ok, encoded = cv2.imencode(".png", fiducial_image(tag_id))
        if not ok:
            raise RuntimeError("fiducial_generation_failed")
        pdf.drawImage(ImageReader(io.BytesIO(encoded.tobytes())), patch_x, patch_y, patch_size, patch_size,
                      preserveAspectRatio=False, mask="auto")

    if show_badge:
        pdf.setFillColorRGB(1, 1, 1)
        pdf.rect(badge_x, badge_y, badge_w, badge_h, fill=1, stroke=0)
        pdf.setFillColorRGB(0, 0, 0)
        badge_text = f"MAP ID: {record['id']}"
        font_size = 9.0
        while font_size > 5.0 and pdf.stringWidth(badge_text, "Helvetica-Bold", font_size) > badge_w - 4.0:
            font_size -= 0.5
        pdf.setFont("Helvetica-Bold", font_size)
        pdf.drawCentredString(badge_x + badge_w * 0.5, badge_y + max(2.0, (badge_h - font_size) * 0.45), badge_text)

    def draw_text_area(block, top, bottom):
        area_h = bottom - top
        # Under 13 pt not even one line at the 9 pt floor fits; drawing would spill over the map.
        if not block["enabled"] or not block["text"] or area_h < 13.0:
            return
        # A header is read at arm's length across a table, so it is larger than body text.
        preferred = 15.0 if layout["pageSize"] == "A4" else 19.0
        font_size = min(preferred, max(9.0, (area_h - 2.0) / 1.45))
        leading = font_size * 1.2
        pad_y = max(1.0, min(font_size * 0.25, (area_h - font_size) * 0.5))
        pad_x = max(4.0, font_size * 0.55)
        max_width = max(1.0, map_w - pad_x * 2.0)
        max_lines = max(1, int(max(0.0, area_h - pad_y * 2.0 - font_size) // leading) + 1)
        lines = _wrapped_lines(pdf, block["text"], "Helvetica", font_size, max_width)
        if len(lines) > max_lines:
            lines = lines[:max_lines]
            last = lines[-1]
            while last and pdf.stringWidth(last + "...", "Helvetica", font_size) > max_width:
                last = last[:-1]
            lines[-1] = last + "..."
        pdf.setFillColorRGB(0, 0, 0)
        pdf.setFont("Helvetica", font_size)
        baseline = page_h - top - pad_y - font_size
        lowest = page_h - bottom + pad_y
        for line in lines:
            if baseline < lowest:
                break
            pdf.drawString(map_x + pad_x, baseline, line)
            baseline -= leading

    def draw_side_panel(side, panel, region):
        """The margin's text, top-down; lines that don't fit are left off (the editor shows the same box)."""
        if not panel or not panel["text"]:
            return
        left, top, width, height = region
        if width < SIDE_PANEL_MIN_WIDTH or height < 13.0:
            return
        font_size = panel_font_size(layout)
        leading = font_size * 1.25
        pad = SIDE_PANEL_PAD
        cursor = top + pad
        limit = top + height - pad
        if show_badge and layout["badgePanel"] == side:
            limit -= badge_h + pad
        pdf.setFillColorRGB(0, 0, 0)
        pdf.setFont("Helvetica", font_size)
        for line in _wrapped_lines(pdf, panel["text"], "Helvetica", font_size, max(1.0, width - pad * 2.0)):
            if cursor + font_size > limit:
                break
            pdf.drawString(left + pad, page_h - (cursor + font_size * 0.85), line)
            cursor += leading

    draw_text_area(layout["header"], MAP_SHEET_PAGE_MARGIN, map_y)
    draw_text_area(layout["footer"], map_y + map_h, page_h - MAP_SHEET_PAGE_MARGIN)
    regions = panel_regions(layout)
    for side in SIDE_PANEL_SIDES:
        draw_side_panel(side, side_panels[side], regions[side])
    pdf.showPage()
    pdf.save()
    return out.getvalue()


def _write_sheet_files(sheet_id, files):
    """Write {extension: bytes} through temporary files and move the JSON record in last, so a reader
    never sees a record before its image and PDF. A sheet saved without a .docx drops the old one."""
    folder = config.MAP_SHEETS_DIR
    folder.mkdir(parents=True, exist_ok=True)
    temporary = {ext: folder / f".{sheet_id}.{os.getpid()}.{threading.get_ident()}.{ext}.tmp" for ext in files}
    try:
        for ext, data in files.items():
            temporary[ext].write_bytes(data)
        if "docx" not in files:
            with contextlib.suppress(OSError):
                (folder / f"{sheet_id}.docx").unlink()
        for ext in ("png", "pdf", "docx", "json"):
            if ext in files:
                os.replace(temporary[ext], folder / f"{sheet_id}.{ext}")
    finally:
        for path in temporary.values():
            with contextlib.suppress(OSError):
                path.unlink()


def _save_map_sheet(payload):
    """POST /api/map-sheets: returns (response body, status)."""
    sheet_id = clean_map_sheet_id(payload.get("id"))
    if not sheet_id:
        return {"ok": False, "error": "invalid_map_sheet_id"}, 400
    overwritten = (config.MAP_SHEETS_DIR / f"{sheet_id}.json").exists()
    try:
        corners = _clean_lnglat_corners(payload.get("corners"))
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400
    decoded = _decode_png(payload.get("image"))
    if decoded is None:
        return {"ok": False, "error": "invalid_png"}, 400
    png_bytes, image = decoded
    try:
        camera = _clean_camera(payload.get("camera"))
    except (IndexError, TypeError, ValueError):
        return {"ok": False, "error": "invalid_camera"}, 400

    record = {
        "version": 2,
        "id": sheet_id,
        "title": str(payload.get("title") or "Reference map").strip()[:80] or "Reference map",
        "createdAt": utc_now_iso(),
        "coordinateSystem": "EPSG:4326",
        "cornerOrder": ["top-left", "top-right", "bottom-right", "bottom-left"],
        "corners": corners,
        "camera": camera,
        "theme": str(payload.get("theme") or "")[:40],
        "imageSize": {"width": int(image.shape[1]), "height": int(image.shape[0])},
    }
    customization = payload.get("layout") if isinstance(payload.get("layout"), dict) else {}
    try:
        layout = map_sheet_layout(payload.get("pageSize"), customization)
        side_panels = clean_side_panels(customization.get("sidePanels"))
        files = {"png": png_bytes, "pdf": draw_map_sheet_pdf(png_bytes, record, layout, side_panels)}
        # The Word file is a convenience copy; failing to make it must not lose the PDF.
        try:
            files["docx"] = build_map_sheet_docx(png_bytes, layout, side_panels, record)
        except Exception:
            logging.exception("Could not build the Word copy of map sheet %s", sheet_id)
        files["json"] = (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        _write_sheet_files(sheet_id, files)
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}, 500
    except OSError:
        logging.exception("Could not save map sheet")
        return {"ok": False, "error": "map_sheet_save_failed"}, 500
    return {"ok": True, "overwritten": overwritten, **_map_sheet_summary(record)}, 200 if overwritten else 201


@bp.route("/api/map-sheet-layout")
def api_map_sheet_layout():
    return jsonify({
        "ok": True,
        "sizes": list(SHEET_PAGE_SIZES),
        "layouts": {size: map_sheet_layout(size) for size in SHEET_PAGE_SIZES},
    })


@bp.route("/api/map-sheets", methods=["GET", "POST"])
def api_map_sheets():
    if request.method == "POST":
        body, status = _save_map_sheet(request.get_json(silent=True) or {})
        return jsonify(body), status
    records = []
    if config.MAP_SHEETS_DIR.exists():
        for path in config.MAP_SHEETS_DIR.glob("*.json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                if clean_map_sheet_id(record.get("id")):
                    records.append(_map_sheet_summary(record))
            except (OSError, ValueError, TypeError, AttributeError):
                continue
    records.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
    return jsonify({"ok": True, "items": records})


@bp.route("/api/map-sheets/<sheet_id>", methods=["GET"])
def api_map_sheet(sheet_id):
    clean_id = clean_map_sheet_id(sheet_id)
    if not clean_id:
        return jsonify({"ok": False, "error": "invalid_map_sheet_id"}), 400
    stem = _record_stem(clean_id)
    if not stem:
        return jsonify({"ok": False, "error": "map_sheet_not_found"}), 404
    try:
        record = json.loads((config.MAP_SHEETS_DIR / f"{stem}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return jsonify({"ok": False, "error": "map_sheet_unreadable"}), 500
    return jsonify({"ok": True, **record, "mapId": _map_id_of(stem), "pdfUrl": f"/api/map-sheets/{stem}/pdf"})


def _sheet_file(sheet_id, ext):
    """The sheet's file name if `sheet_id` is valid and the file exists, else None."""
    clean_id = clean_map_sheet_id(sheet_id)
    if clean_id and (config.MAP_SHEETS_DIR / f"{clean_id}.{ext}").exists():
        return f"{clean_id}.{ext}"
    return None


@bp.route("/api/map-sheets/<sheet_id>/pdf", methods=["GET"])
def api_map_sheet_pdf(sheet_id):
    name = _sheet_file(sheet_id, "pdf")
    if name is None:
        return jsonify({"ok": False, "error": "map_sheet_not_found"}), 404
    return send_from_directory(config.MAP_SHEETS_DIR, name, as_attachment=True,
                               download_name=f"map-sheet-{name}", mimetype="application/pdf")


@bp.route("/api/map-sheets/<sheet_id>/docx", methods=["GET"])
def api_map_sheet_docx(sheet_id):
    name = _sheet_file(sheet_id, "docx")
    if name is None:
        return jsonify({"ok": False, "error": "map_sheet_docx_not_found"}), 404
    return send_from_directory(config.MAP_SHEETS_DIR, name, as_attachment=True, download_name=f"map-sheet-{name}",
                               mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document")


@bp.route("/api/map-sheets/<sheet_id>/image", methods=["GET"])
def api_map_sheet_image(sheet_id):
    name = _sheet_file(sheet_id, "png")
    if name is None:
        return jsonify({"ok": False, "error": "map_sheet_not_found"}), 404
    response = send_from_directory(config.MAP_SHEETS_DIR, name, mimetype="image/png")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response
