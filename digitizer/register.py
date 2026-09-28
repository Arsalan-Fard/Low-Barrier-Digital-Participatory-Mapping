"""Where is the sheet in the photo? AprilTags -> page homography -> rectified crops.

The tags are printed at known page positions (``print.fiducials`` in the sheet
record), so one homography maps the whole A3 page -- not only the map square --
into the photo. From it we cut:

* the map square, upright and at a known millimetre scale, for stickers and ink;
* the side panel (the questionnaire), upright, for the VLM to read.

After the tag fit, the map square is nudged onto the clean render with ECC and
then a smooth tile-based displacement field. Paper that curls between the tags
leaves millimetres of residual, and every misregistered printed edge would
otherwise read as ink -- the thing that drowns thin pen strokes.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

from .sheet import MapSheet, POINTS_PER_MM

TAG_DICTIONARY = cv2.aruco.DICT_APRILTAG_16h5


@dataclass
class Registration:
    page_to_photo: np.ndarray         # 3x3, page points -> photo pixels
    tags_found: list[int]
    tags_expected: int
    inlier_corners: int
    reprojection_px: float            # median corner error of the fit
    photo_px_per_mm: float            # native resolution of the map square in the photo

    def to_dict(self) -> dict:
        return {
            "tagsFound": self.tags_found,
            "tagsExpected": self.tags_expected,
            "inlierCorners": self.inlier_corners,
            "reprojectionPx": round(self.reprojection_px, 2),
            "photoPxPerMm": round(self.photo_px_per_mm, 2),
        }


def detect_tags(photo_bgr: np.ndarray) -> dict[int, np.ndarray]:
    gray = cv2.cvtColor(photo_bgr, cv2.COLOR_BGR2GRAY)
    dictionary = cv2.aruco.getPredefinedDictionary(TAG_DICTIONARY)
    parameters = cv2.aruco.DetectorParameters()
    parameters.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    corners, ids, _ = cv2.aruco.ArucoDetector(dictionary, parameters).detectMarkers(gray)
    found: dict[int, np.ndarray] = {}
    if ids is not None:
        for quad, tag_id in zip(corners, ids.flatten().tolist()):
            found[int(tag_id)] = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    return found


def register_page(photo_bgr: np.ndarray, sheet: MapSheet) -> Registration:
    detected = detect_tags(photo_bgr)
    page_points, photo_points, matched, centres = [], [], [], []
    for tag_id, page_quad in sheet.fiducials_pt.items():
        if tag_id not in detected:
            continue
        page_points.extend(page_quad.tolist())
        photo_points.extend(detected[tag_id].tolist())
        matched.append(tag_id)
        centres.append(page_quad.mean(axis=0))
    if len(matched) < 3:
        raise RuntimeError(
            f"only {len(matched)} of the sheet's {len(sheet.fiducials_pt)} tags were found "
            f"(detected ids {sorted(detected)}); at least 3 are needed"
        )
    spread = abs(cv2.contourArea(cv2.convexHull(np.asarray(centres, dtype=np.float32))))
    if spread < sheet.page_size_pt[0] * sheet.page_size_pt[1] * 0.02:
        raise RuntimeError("the tags found are bunched together; the page pose would be unreliable")
    src = np.asarray(page_points, dtype=np.float64)
    dst = np.asarray(photo_points, dtype=np.float64)
    homography, inliers = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    if homography is None:
        raise RuntimeError("the tag corners did not give a consistent page pose")
    projected = cv2.perspectiveTransform(src.reshape(-1, 1, 2), homography).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst, axis=1)
    corners = cv2.perspectiveTransform(sheet.map_corners_pt.reshape(-1, 1, 2), homography).reshape(-1, 2)
    edges = [np.linalg.norm(corners[(i + 1) % 4] - corners[i]) for i in range(4)]
    native_px_per_mm = (
        0.5 * (edges[0] + edges[2]) / sheet.map_width_mm
        + 0.5 * (edges[1] + edges[3]) / sheet.map_height_mm
    ) / 2.0
    return Registration(
        page_to_photo=homography,
        tags_found=sorted(matched),
        tags_expected=len(sheet.fiducials_pt),
        inlier_corners=int(np.count_nonzero(inliers)) if inliers is not None else 0,
        reprojection_px=float(np.median(errors)),
        photo_px_per_mm=float(native_px_per_mm),
    )


def choose_map_width(sheet: MapSheet, registration: Registration, requested: int | None = None) -> int:
    """Rectify at the photo's native resolution, never above the reference's.

    Upsampling the clean reference softens its printed edges and the
    difference map fills with false ink (measured on the old pipeline), so
    the reference's own width is a hard ceiling.
    """
    ref_width = sheet.reference.shape[1]
    if requested:
        return int(min(ref_width, max(800, requested)))
    native = registration.photo_px_per_mm * sheet.map_width_mm
    # 2800 px (~9.7 px/mm) keeps a 0.3 mm pen line (tested at 8.3 px/mm) while
    # a 24 MP phone photo does not double the processing time
    return int(min(ref_width, 2800, max(1600, round(native))))


def _rect_to_page(corners_pt: np.ndarray, width: int, height: int) -> np.ndarray:
    """Homography from an axis-aligned width x height grid to a page quad."""
    grid = np.asarray([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float64)
    return cv2.getPerspectiveTransform(grid.astype(np.float32), corners_pt.astype(np.float32)).astype(np.float64)


def rectify_quad(photo_bgr: np.ndarray, registration: Registration, corners_pt: np.ndarray,
                 width: int, height: int, interpolation: int = cv2.INTER_AREA) -> np.ndarray:
    """Cut an upright ``width`` x ``height`` image of a page quad out of the photo."""
    rect_to_photo = registration.page_to_photo @ _rect_to_page(corners_pt, width, height)
    # INTER_AREA is not supported by warpPerspective; when the output is much
    # smaller than the source, pre-blur so the warp does not alias.
    photo_px_per_out_px = _scale_of(rect_to_photo, width, height)
    source = photo_bgr
    if interpolation == cv2.INTER_AREA:
        interpolation = cv2.INTER_LINEAR
        if photo_px_per_out_px > 1.6:
            sigma = 0.45 * photo_px_per_out_px
            source = cv2.GaussianBlur(photo_bgr, (0, 0), sigma)
    return cv2.warpPerspective(
        source, rect_to_photo, (width, height),
        flags=interpolation | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE,
    )


def _scale_of(rect_to_photo: np.ndarray, width: int, height: int) -> float:
    probe = np.asarray([[[width / 2, height / 2]], [[width / 2 + 1, height / 2]]], dtype=np.float64)
    moved = cv2.perspectiveTransform(probe, rect_to_photo).reshape(-1, 2)
    return float(np.linalg.norm(moved[1] - moved[0]))


def rectify_map(photo_bgr: np.ndarray, sheet: MapSheet, registration: Registration,
                width: int) -> tuple[np.ndarray, np.ndarray]:
    """The map square, upright; plus a mask of the part the photo actually shows.

    A sheet photographed with an edge cropped off is common, and the warp
    fills what the photo lacks with smeared border pixels that must never be
    read as ink.
    """
    ref_h, ref_w = sheet.reference.shape[:2]
    height = int(round(width * ref_h / float(ref_w)))
    image = rectify_quad(photo_bgr, registration, sheet.map_corners_pt, width, height)
    rect_to_photo = registration.page_to_photo @ _rect_to_page(sheet.map_corners_pt, width, height)
    inside = np.full(photo_bgr.shape[:2], 255, np.uint8)
    coverage = cv2.warpPerspective(inside, rect_to_photo, (width, height),
                                   flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP,
                                   borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return image, coverage


def rectify_panel(photo_bgr: np.ndarray, sheet: MapSheet, registration: Registration,
                  side: str = "left", px_per_mm: float = 6.0, outer_margin_mm: float = 75.0,
                  edge_margin_mm: float = 25.0, inner_margin_mm: float = 3.0) -> np.ndarray | None:
    """The questionnaire panel beside the map, upright, for the VLM.

    The panel's content is laid out in Word by the workshop team, not by this
    app, and it sits far from the tags, so its real outer edge lands well past
    where the sheet record puts it: the page pose extrapolated that far across
    curled paper was measured 10-15 mm off, and on map 1 the paper itself ended
    50-57 mm beyond the record's page edge (the print is laid out wider than
    the record) -- a 25 mm margin cut the first checkbox column in half. So the
    crop reaches ``outer_margin_mm`` past the panel on the outer side and is
    then trimmed back to where the paper ends; top and bottom keep
    ``edge_margin_mm``. The model does not mind margin, but a cut-off checkbox
    column is unreadable.
    """
    rect = sheet.panels_pt.get(side)
    if not rect:
        return None
    x, y, w, h = rect
    outer, edge, inner = (m * POINTS_PER_MM for m in (outer_margin_mm, edge_margin_mm, inner_margin_mm))
    left = x - (outer if side == "left" else inner)
    right = x + w + (inner if side == "left" else outer)
    top, bottom = y - edge, y + h + edge
    corners = np.asarray([[left, top], [right, top], [right, bottom], [left, bottom]])
    width_mm = (right - left) / POINTS_PER_MM
    height_mm = (bottom - top) / POINTS_PER_MM
    panel = rectify_quad(photo_bgr, registration, corners,
                         int(round(width_mm * px_per_mm)), int(round(height_mm * px_per_mm)))
    return _trim_to_paper(panel, px_per_mm, side)


def _trim_to_paper(panel: np.ndarray, px_per_mm: float, side: str, keep_mm: float = 4.0) -> np.ndarray:
    """Cut the table off the outer side of a panel crop.

    Walking outwards from the map, the paper ends at the first 5 mm band of
    columns that is mostly not paper-white (printed text and boxes never cover
    most of a column). A few millimetres beyond it are kept; with no such band
    (a white table, a photo cut at the page) nothing is cut. The walk only
    starts counting once it has seen paper: the inner margin can reach onto
    the map's grey print, which is not the table.
    """
    lab = cv2.cvtColor(panel, cv2.COLOR_BGR2LAB).astype(np.float32)
    lightness = lab[..., 0]
    chroma = np.hypot(lab[..., 1] - 128.0, lab[..., 2] - 128.0)
    reference = float(np.median(lightness[:, lightness.shape[1] // 3: 2 * lightness.shape[1] // 3]))
    paper = (lightness > min(165.0, 0.8 * reference)) & (chroma < 22.0)
    band = max(3, int(round(5.0 * px_per_mm)))
    window = np.ones(band) / band
    # a true mean at the ends too ("same" alone pads with zeros: half the value at the edge)
    profile = (np.convolve(paper.mean(axis=0), window, mode="same")
               / np.convolve(np.ones(paper.shape[1]), window, mode="same"))
    width = panel.shape[1]
    keep = int(round(keep_mm * px_per_mm))
    columns = range(width - 1, -1, -1) if side == "left" else range(width)
    seen_paper = False
    for column in columns:
        if profile[column] >= 0.35:
            seen_paper = True
        elif seen_paper:
            if side == "left":
                return panel[:, max(0, column - band // 2 - keep):]
            return panel[:, :min(width, column + band // 2 + keep)]
    return panel


# --------------------------------------------------------------------------
# Fine alignment of the rectified map onto the clean reference
# --------------------------------------------------------------------------

def refine_ecc(observed: np.ndarray, predicted: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, bool]:
    """Sub-pixel homography touch-up (ported from app.py's _refine_rectified_alignment)."""
    height, width = observed.shape[:2]
    scale = min(1.0, 900.0 / float(max(width, height)))
    small = (max(32, int(round(width * scale))), max(32, int(round(height * scale))))

    def prepare(image):
        gray = cv2.cvtColor(np.clip(image, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, small, interpolation=cv2.INTER_AREA)
        return cv2.GaussianBlur(gray.astype(np.float32), (0, 0), 1.2)

    template = prepare(predicted)
    moving = prepare(observed)
    mask_small = cv2.resize(valid, small, interpolation=cv2.INTER_NEAREST)
    warp = np.eye(3, dtype=np.float32)
    try:
        cv2.findTransformECC(
            template, moving, warp, cv2.MOTION_HOMOGRAPHY,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-6), mask_small, 5,
        )
    except cv2.error:
        return observed, False
    if not np.isfinite(warp).all():
        return observed, False
    to_small = np.diag([small[0] / float(width), small[1] / float(height), 1.0]).astype(np.float64)
    full_warp = np.linalg.inv(to_small) @ warp.astype(np.float64) @ to_small
    probe = np.asarray([[[0, 0]], [[width - 1, 0]], [[width - 1, height - 1]], [[0, height - 1]]], dtype=np.float64)
    moved = cv2.perspectiveTransform(probe, full_warp).reshape(-1, 2)
    shift = float(np.max(np.linalg.norm(moved - probe.reshape(-1, 2), axis=1)))
    if not math.isfinite(shift) or shift > max(6.0, width * 0.02):
        return observed, False
    aligned = cv2.warpPerspective(
        observed, full_warp.astype(np.float32), (width, height),
        flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE,
    )
    return aligned, True


def _tile_shifts(reference_gray: np.ndarray, observed_gray: np.ndarray, valid: np.ndarray,
                 cells: int, size_factor: float = 2.0):
    """Phase-correlate overlapping tiles on a cells x cells grid.

    Returns the tiles' true centres (``xs``, ``ys`` -- the outermost tiles are
    pushed inwards to stay inside the image, and a shift must be credited to
    where it was measured) and ``dx``, ``dy``, ``response`` per tile, with
    photo(p + d) == reference(p).
    """
    height, width = reference_gray.shape
    step_x, step_y = width / cells, height / cells
    size = int(min(width, height, round(size_factor * max(step_x, step_y))))
    size -= size % 2
    window = cv2.createHanningWindow((size, size), cv2.CV_32F)
    x0s = [int(min(max(0, round((i + 0.5) * step_x - size / 2)), width - size)) for i in range(cells)]
    y0s = [int(min(max(0, round((j + 0.5) * step_y - size / 2)), height - size)) for j in range(cells)]
    dx = np.zeros((cells, cells), np.float32)
    dy = np.zeros((cells, cells), np.float32)
    response = np.zeros((cells, cells), np.float32)
    for j, y0 in enumerate(y0s):
        for i, x0 in enumerate(x0s):
            if np.mean(valid[y0:y0 + size, x0:x0 + size] > 0) < 0.5:
                continue
            a = reference_gray[y0:y0 + size, x0:x0 + size]
            b = observed_gray[y0:y0 + size, x0:x0 + size]
            (sx, sy), r = cv2.phaseCorrelate(a, b, window)
            dx[j, i], dy[j, i], response[j, i] = sx, sy, r
    xs = np.asarray(x0s, np.float64) + size / 2.0
    ys = np.asarray(y0s, np.float64) + size / 2.0
    return xs, ys, dx, dy, response


def _clean_field(dx: np.ndarray, dy: np.ndarray, ok: np.ndarray, response: np.ndarray,
                 iterations: int = 6) -> tuple[np.ndarray, np.ndarray]:
    """Replace unreliable or outlying grid cells by their neighbours' median.

    A strongly correlated tile is trusted even when it disagrees with its
    neighbours: near a curled edge the shift genuinely changes fast, and
    smoothing it away is what left the first version 5-9 px off there.
    """
    dx, dy, ok = dx.copy(), dy.copy(), ok.copy()
    cells_y, cells_x = dx.shape
    for _ in range(iterations):
        changed = False
        for j in range(cells_y):
            for i in range(cells_x):
                ys = slice(max(0, j - 1), min(cells_y, j + 2))
                xs = slice(max(0, i - 1), min(cells_x, i + 2))
                neighbours = ok[ys, xs].copy()
                neighbours[j - ys.start, i - xs.start] = False
                if not neighbours.any():
                    continue
                mx, my = np.median(dx[ys, xs][neighbours]), np.median(dy[ys, xs][neighbours])
                disagreement = np.hypot(dx[j, i] - mx, dy[j, i] - my)
                outlier = ok[j, i] and neighbours.sum() >= 3 and (
                    (disagreement > 4.0 and response[j, i] < 0.2) or disagreement > 15.0)
                if not ok[j, i] or outlier:
                    dx[j, i], dy[j, i] = mx, my
                    if not ok[j, i]:
                        ok[j, i] = True
                        changed = True
        if not changed:
            break
    if not ok.all():  # nothing measurable anywhere near: fall back to the global median
        dx[~ok] = np.median(dx[ok]) if ok.any() else 0.0
        dy[~ok] = np.median(dy[ok]) if ok.any() else 0.0
    return cv2.GaussianBlur(dx, (3, 3), 0.8), cv2.GaussianBlur(dy, (3, 3), 0.8)


def _upsample_field(field: np.ndarray, xs: np.ndarray, ys: np.ndarray, width: int, height: int) -> np.ndarray:
    """Tile-centre samples -> per-pixel field, extrapolating linearly past the outer tiles.

    Curl is strongest at the sheet's edges, exactly where holding the outer
    tiles' values constant would leave it uncorrected. The extrapolation is
    clamped to the measured range (plus a margin) so it cannot run away.
    """
    from scipy.interpolate import RegularGridInterpolator

    stride = 8
    grid_y, grid_x = np.meshgrid(np.arange(0, height, stride, dtype=np.float64),
                                 np.arange(0, width, stride, dtype=np.float64), indexing="ij")
    interpolate = RegularGridInterpolator((ys, xs), field.astype(np.float64), method="linear",
                                          bounds_error=False, fill_value=None)
    coarse = interpolate(np.stack([grid_y.ravel(), grid_x.ravel()], axis=1)).reshape(grid_y.shape)
    span = float(field.max() - field.min())
    coarse = np.clip(coarse, field.min() - 0.5 * span - 1.0, field.max() + 0.5 * span + 1.0)
    coarse = cv2.GaussianBlur(coarse.astype(np.float32), (0, 0), max(1.0, 0.35 * (xs[1] - xs[0]) / stride))
    return cv2.resize(coarse, (width, height), interpolation=cv2.INTER_LINEAR)


def refine_tiles(observed: np.ndarray, predicted: np.ndarray, valid: np.ndarray,
                 max_shift_px: float, passes: tuple[int, ...] = (8, 14, 22)) -> tuple[np.ndarray, dict]:
    """Remove the smooth residual a single homography leaves on curled paper.

    Measured on a real capture: after the tag homography and ECC, the corner
    of a curled A3 sheet was still 25-30 px (3 mm) off, and every printed
    street edge there read as ink. Phase correlation of overlapping tiles gives
    a coarse displacement field; unreliable tiles (blank paper, or tiles the
    participants covered in stickers) are replaced by their neighbours, and
    the field is interpolated smoothly -- paper bends slowly, and only a slow
    field can be trusted not to drag the reference onto the ink it lacks.
    Coarse tiles catch the big shifts first, finer ones the remainder.
    """
    height, width = observed.shape[:2]
    reference_gray = cv2.cvtColor(np.clip(predicted, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
    grid_x, grid_y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    total_x = np.zeros((height, width), np.float32)
    total_y = np.zeros((height, width), np.float32)
    aligned = observed
    info: dict = {"passes": []}
    for cells in passes:
        observed_gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY).astype(np.float32)
        xs, ys, dx, dy, response = _tile_shifts(reference_gray, observed_gray, valid, cells)
        ok = (response >= 0.08) & (np.hypot(dx, dy) <= max_shift_px)
        if ok.sum() < max(4, cells):
            info["passes"].append({"cells": cells, "reliable": int(ok.sum()), "applied": False})
            continue
        dx, dy = _clean_field(dx, dy, ok, response)
        total_x += _upsample_field(dx, xs, ys, width, height)
        total_y += _upsample_field(dy, xs, ys, width, height)
        aligned = cv2.remap(observed, grid_x + total_x, grid_y + total_y, cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_REPLICATE)
        info["passes"].append({
            "cells": cells, "reliable": int(ok.sum()),
            "meanShiftPx": round(float(np.hypot(dx, dy).mean()), 2),
            "maxShiftPx": round(float(np.hypot(dx, dy).max()), 2), "applied": True,
        })
    magnitude = np.hypot(total_x, total_y)
    info["applied"] = any(p.get("applied") for p in info["passes"])
    info["meanShiftPx"] = round(float(magnitude.mean()), 2)
    info["maxShiftPx"] = round(float(magnitude.max()), 2)
    return aligned, info
