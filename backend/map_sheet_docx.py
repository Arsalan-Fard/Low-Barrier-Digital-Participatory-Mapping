"""The Word (.docx) copy of a map sheet, written directly as OOXML: one landscape page with a
fixed-width table, the map picture in the middle column and the side margins as editable text."""
import io
import zipfile

import cv2
import numpy as np

from .map_sheet_layout import (MAP_SHEET_PAGE_MARGIN, SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_PAD, fiducial_image,
                               panel_font_size, panel_regions)

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def _draw_badge(image, box, sheet_id, scale):
    """Paint the ID plate into box (x0, y0, x1, y1) at `scale` px per point."""
    x0, y0, x1, y1 = box
    cv2.rectangle(image, (x0, y0), (x1, y1), (255, 255, 255), -1)
    text = f"MAP ID: {sheet_id}"
    font = cv2.FONT_HERSHEY_DUPLEX
    # Hershey glyphs are ~22 px tall at scale 1; aim for the PDF's 9 pt bold.
    font_scale = max(0.2, 9.0 * scale * 0.7 / 22.0)
    thickness = max(1, int(round(font_scale * 1.6)))
    while font_scale > 0.2:
        text_w = cv2.getTextSize(text, font, font_scale, thickness)[0][0]
        if text_w <= (x1 - x0) - int(round(4.0 * scale)):
            break
        font_scale -= 0.05
    (text_w, text_h), _ = cv2.getTextSize(text, font, font_scale, thickness)
    origin = (x0 + ((x1 - x0) - text_w) // 2, y1 - ((y1 - y0) - text_h) // 2)
    cv2.putText(image, text, origin, font, font_scale, (0, 0, 0), thickness, cv2.LINE_AA)


def _png(image, error):
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError(error)
    return encoded.tobytes()


def _badge_png(sheet_id, width_pt, height_pt, scale=8.0):
    """The ID plate as a picture of its own, for a plate in a side margin."""
    width = max(1, int(round(width_pt * scale)))
    height = max(1, int(round(height_pt * scale)))
    image = np.full((height, width, 3), 255, np.uint8)
    _draw_badge(image, (0, 0, width - 1, height - 1), sheet_id, scale)
    return _png(image, "badge_render_failed")


def compose_map_sheet_frame_png(png_bytes, layout, sheet_id):
    """The map frame as one picture with the border, tags and ID plate burnt in where the PDF puts
    them: Word cannot be trusted to place separate objects, and registration only relates the
    tags to the frame."""
    image = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim < 2:
        raise RuntimeError("invalid_png")
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    elif image.shape[2] == 4:
        alpha = image[:, :, 3:4].astype(np.float32) / 255.0
        image = (image[:, :, :3].astype(np.float32) * alpha + 255.0 * (1.0 - alpha)).astype(np.uint8)
    else:
        image = np.ascontiguousarray(image[:, :, :3])
    map_x, map_y, map_w, map_h = layout["mapFrame"]
    height, width = image.shape[:2]
    # The capture normally has the frame's aspect already; resample only if not.
    wanted_h = max(1, int(round(width * map_h / map_w)))
    if abs(wanted_h - height) > 2:
        image = cv2.resize(image, (width, wanted_h), interpolation=cv2.INTER_AREA)
        height = wanted_h
    scale = width / map_w

    def to_px(value):
        return int(round(value * scale))

    cv2.rectangle(image, (0, 0), (width - 1, height - 1), (0, 0, 0), max(1, to_px(0.8)))
    patch_px = max(8, to_px(layout["patchSize"]))
    for tag_id, (patch_x, patch_y) in zip(layout["tagIds"], layout["patches"]):
        marker = cv2.resize(fiducial_image(tag_id), (patch_px, patch_px), interpolation=cv2.INTER_AREA)
        x0 = min(max(0, to_px(patch_x - map_x)), width - patch_px)
        y0 = min(max(0, to_px(patch_y - map_y)), height - patch_px)
        image[y0:y0 + patch_px, x0:x0 + patch_px] = cv2.cvtColor(marker, cv2.COLOR_GRAY2BGR)

    if layout["showBadge"] and not layout["badgePanel"]:  # a plate in a side margin is placed by the .docx
        badge_x, badge_top, badge_w, badge_h = layout["badge"]
        x0 = to_px(badge_x - map_x)
        y0 = to_px(badge_top - map_y)
        x1 = min(width - 1, x0 + to_px(badge_w))
        y1 = min(height - 1, y0 + to_px(badge_h))
        _draw_badge(image, (x0, y0, x1, y1), sheet_id, scale)
    return _png(image, "frame_composite_failed")


def _xml_text(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _twips(points):
    return int(round(points * 20.0))


def _emu(points):
    return int(round(points * 12700.0))


class _Pictures:
    """The pictures of the package, and the drawing XML that shows them."""

    def __init__(self):
        self.media = []  # (file name, bytes)
        self.relationships = []  # (rId, file name)

    def add(self, data, width_pt, height_pt):
        """(extent XML, graphic XML) for a new picture; an anchored drawing puts its wrap element between them."""
        index = len(self.media) + 1
        name = f"image{index}.png"
        rid = f"rIdImage{index}"
        self.media.append((name, data))
        self.relationships.append((rid, name))
        cx = _emu(width_pt)
        cy = _emu(height_pt)
        extent = f'<wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>'
        graphic = (
            f'<wp:docPr id="{index}" name="Picture {index}"/>'
            '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            '<pic:pic>'
            f'<pic:nvPicPr><pic:cNvPr id="{index}" name="{name}"/><pic:cNvPicPr/></pic:nvPicPr>'
            f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
            '</pic:pic></a:graphicData></a:graphic>'
        )
        return extent, graphic

    def inline_paragraph(self, data, width_pt, height_pt):
        extent, graphic = self.add(data, width_pt, height_pt)
        return (
            '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
            '<w:r><w:drawing>'
            f'<wp:inline distT="0" distB="0" distL="0" distR="0">{extent}{graphic}</wp:inline>'
            '</w:drawing></w:r></w:p>'
        )

    def page_anchored_run(self, data, x_pt, y_pt, width_pt, height_pt):
        """A picture pinned to page coordinates, floating over the table."""
        extent, graphic = self.add(data, width_pt, height_pt)
        return (
            '<w:r><w:drawing>'
            '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" '
            'relativeHeight="251659264" behindDoc="0" locked="1" layoutInCell="1" allowOverlap="1">'
            '<wp:simplePos x="0" y="0"/>'
            f'<wp:positionH relativeFrom="page"><wp:posOffset>{_emu(x_pt)}</wp:posOffset></wp:positionH>'
            f'<wp:positionV relativeFrom="page"><wp:posOffset>{_emu(y_pt)}</wp:posOffset></wp:positionV>'
            f'{extent}<wp:wrapNone/>{graphic}'
            '</wp:anchor></w:drawing></w:r>'
        )


def _text_paragraphs(text, font_size):
    lines = text.split("\n")
    out = []
    for position, line in enumerate(lines):
        after = _twips(font_size * 0.6) if position == len(lines) - 1 else 0
        out.append(
            f'<w:p><w:pPr><w:spacing w:before="0" w:after="{after}" w:line="300" w:lineRule="auto"/></w:pPr>'
            f'<w:r><w:rPr><w:sz w:val="{int(round(font_size * 2))}"/></w:rPr>'
            f'<w:t xml:space="preserve">{_xml_text(line)}</w:t></w:r></w:p>'
        )
    return "".join(out)


def _cell(width_pt, body, pad_pt):
    pad = _twips(pad_pt)
    return (
        f'<w:tc><w:tcPr><w:tcW w:w="{_twips(width_pt)}" w:type="dxa"/>'
        f'<w:tcMar><w:top w:w="{pad}" w:type="dxa"/><w:left w:w="{pad}" w:type="dxa"/>'
        f'<w:bottom w:w="0" w:type="dxa"/><w:right w:w="{pad}" w:type="dxa"/></w:tcMar>'
        f'<w:vAlign w:val="top"/></w:tcPr>{body or "<w:p/>"}</w:tc>'
    )


def build_map_sheet_docx(png_bytes, layout, side_panels, record):
    """The .docx bytes. The table row is exactly the printable width, so the map keeps its physical
    size and Word prints the tags at the size the PDF would."""
    page_w, page_h = layout["page"]
    map_y, map_w, map_h = layout["mapFrame"][1:]
    regions = panel_regions(layout)
    font_size = panel_font_size(layout)
    pictures = _Pictures()
    frame_png = compose_map_sheet_frame_png(png_bytes, layout, record["id"])

    columns = []  # (width in points, body XML, cell padding)
    for side in ("left", None, "right"):
        if side is None:
            columns.append((map_w, pictures.inline_paragraph(frame_png, map_w, map_h), 0.0))
            continue
        panel = side_panels[side]
        if panel and regions[side][2] >= SIDE_PANEL_MIN_WIDTH:
            body = _text_paragraphs(panel["text"], font_size) if panel["text"] else ""
            columns.append((regions[side][2], body, SIDE_PANEL_PAD))

    table_w = sum(width for width, _, _ in columns)
    grid = "".join(f'<w:gridCol w:w="{_twips(width)}"/>' for width, _, _ in columns)
    cells = "".join(_cell(width, body, pad) for width, body, pad in columns)
    table = (
        '<w:tbl><w:tblPr>'
        f'<w:tblW w:w="{_twips(table_w)}" w:type="dxa"/>'
        '<w:tblInd w:w="0" w:type="dxa"/>'
        '<w:tblLayout w:type="fixed"/>'
        '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>'
        '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>'
        '<w:tblLook w:val="0000"/></w:tblPr>'
        f'<w:tblGrid>{grid}</w:tblGrid>'
        f'<w:tr><w:trPr><w:trHeight w:val="{_twips(map_h)}" w:hRule="atLeast"/></w:trPr>{cells}</w:tr>'
        '</w:tbl>'
    )
    # An ID plate in a side margin floats at the page position the PDF prints it at.
    badge_run = ""
    if layout["showBadge"] and layout["badgePanel"]:
        badge_x, badge_top, badge_w, badge_h = layout["badge"]
        badge_run = pictures.page_anchored_run(_badge_png(record["id"], badge_w, badge_h),
                                               badge_x, badge_top, badge_w, badge_h)
    # Word needs a paragraph after a table; a 1 pt one, with the bottom margin trimmed, keeps one page.
    trailer = (
        '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>'
        f'<w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>{badge_run}</w:p>'
    )
    margin = _twips(MAP_SHEET_PAGE_MARGIN)
    section = (
        f'<w:sectPr><w:pgSz w:w="{_twips(page_w)}" w:h="{_twips(page_h)}" w:orient="landscape"/>'
        f'<w:pgMar w:top="{_twips(map_y)}" w:right="{margin}" w:bottom="{_twips(4.0)}" '
        f'w:left="{margin}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>'
    )
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W_NS}" xmlns:r="{REL_NS}" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        f'<w:body>{table}{trailer}{section}</w:body></w:document>'
    )
    half_points = int(round(font_size * 2))
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:styles xmlns:w="{W_NS}">'
        '<w:docDefaults><w:rPrDefault><w:rPr>'
        '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/>'
        f'<w:sz w:val="{half_points}"/><w:szCs w:val="{half_points}"/>'
        '</w:rPr></w:rPrDefault>'
        '<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
        '</w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
        '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>'
        '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar>'
        '<w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>'
        '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/>'
        '</w:tblCellMar></w:tblPr></w:style></w:styles>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '</Types>'
    )
    package_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{PACKAGE_REL_NS}">'
        f'<Relationship Id="rId1" Type="{REL_NS}/officeDocument" Target="word/document.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '</Relationships>'
    )
    image_rels = "".join(
        f'<Relationship Id="{rid}" Type="{REL_NS}/image" Target="media/{name}"/>' for rid, name in pictures.relationships
    )
    document_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{PACKAGE_REL_NS}">'
        f'<Relationship Id="rIdStyles" Type="{REL_NS}/styles" Target="styles.xml"/>'
        f'{image_rels}</Relationships>'
    )
    core_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        f'<dc:title>Map sheet {_xml_text(record["id"])}</dc:title>'
        '<dc:creator>Low-Barrier Digital Participatory Mapping</dc:creator>'
        '<dc:description>Printable georeferenced reference map</dc:description>'
        '</cp:coreProperties>'
    )

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", package_rels)
        archive.writestr("docProps/core.xml", core_xml)
        archive.writestr("word/document.xml", document_xml)
        archive.writestr("word/styles.xml", styles_xml)
        archive.writestr("word/_rels/document.xml.rels", document_rels)
        for name, data in pictures.media:
            # PNGs are compressed already; storing beats deflating them again.
            archive.writestr(f"word/media/{name}", data, compress_type=zipfile.ZIP_STORED)
    return out.getvalue()
