"""The printed map sheet: its record, clean reference render and geography.

Everything here is read-only. A sheet record lives in ``data/map_sheets/<id>.json``
next to ``<id>.png``, the clean render of the map square the participants drew
on. The record also carries the page layout in PDF points: where the map square,
the AprilTags and the side panel sit on the A3 page.
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SHEETS_DIR = REPO_ROOT / "data" / "map_sheets"
POINTS_PER_MM = 72.0 / 25.4


def default_sheets_dir() -> Path:
    """Where sheet records live: $DIGITIZER_SHEETS (set by --sheets), else the app's data/map_sheets.

    data/ is not in git, so on another computer the records are copied in by hand.
    """
    configured = os.environ.get("DIGITIZER_SHEETS")
    return Path(configured) if configured else DEFAULT_SHEETS_DIR


@dataclass
class MapSheet:
    id: str
    record: dict
    reference: np.ndarray                 # clean render of the map square, BGR
    page_size_pt: tuple[float, float]
    map_corners_pt: np.ndarray            # (4, 2) TL, TR, BR, BL in page points
    fiducials_pt: dict[int, np.ndarray]   # tag id -> (4, 2) corners in page points
    lnglat_corners: list[list[float]]     # TL, TR, BR, BL as [lng, lat]
    panels_pt: dict[str, list[float]] = field(default_factory=dict)  # side -> [x, y, w, h]
    mask_rects: list[list[float]] = field(default_factory=list)       # normalised tag cells

    @property
    def map_width_mm(self) -> float:
        top = self.map_corners_pt[1] - self.map_corners_pt[0]
        return float(np.hypot(*top)) / POINTS_PER_MM

    @property
    def map_height_mm(self) -> float:
        left = self.map_corners_pt[3] - self.map_corners_pt[0]
        return float(np.hypot(*left)) / POINTS_PER_MM

    def ground_width_m(self) -> float:
        (tl_lng, tl_lat), (tr_lng, _), _, _ = self.lnglat_corners
        return abs(tr_lng - tl_lng) * 111_320.0 * math.cos(math.radians(tl_lat))

    def pixel_to_lnglat(self, x: float, y: float, width: int, height: int) -> list[float]:
        """Rectified-map pixel -> [lng, lat].

        The same bilinear blend of the four geographic corners that app.py's
        ``_rectified_pixel_to_lnglat`` and the Digitize panel use, so exports
        line up with the existing ones exactly.
        """
        (tl_lng, tl_lat), (tr_lng, tr_lat), (br_lng, br_lat), (bl_lng, bl_lat) = self.lnglat_corners
        u = min(1.0, max(0.0, float(x) / max(1.0, width - 1.0)))
        v = min(1.0, max(0.0, float(y) / max(1.0, height - 1.0)))
        top_lng = tl_lng + (tr_lng - tl_lng) * u
        top_lat = tl_lat + (tr_lat - tl_lat) * u
        bottom_lng = bl_lng + (br_lng - bl_lng) * u
        bottom_lat = bl_lat + (br_lat - bl_lat) * u
        return [
            round(top_lng + (bottom_lng - top_lng) * v, 8),
            round(top_lat + (bottom_lat - top_lat) * v, 8),
        ]


def _record_path(map_id: str, sheets_dir: Path) -> Path:
    exact = sheets_dir / f"{map_id}.json"
    if exact.exists():
        return exact
    bare = sheets_dir / f"{str(map_id).split('_')[0]}.json"
    if bare.exists():
        return bare
    raise FileNotFoundError(f"no map sheet record for id {map_id!r} in {sheets_dir}")


def load_sheet(map_id: str | int, sheets_dir: str | Path | None = None) -> MapSheet:
    sheets_dir = Path(sheets_dir) if sheets_dir else default_sheets_dir()
    record_path = _record_path(str(map_id), sheets_dir)
    record = json.loads(record_path.read_text(encoding="utf-8"))
    reference = cv2.imread(str(record_path.with_suffix(".png")), cv2.IMREAD_COLOR)
    if reference is None:
        raise FileNotFoundError(f"missing clean reference render {record_path.with_suffix('.png')}")
    printed = record.get("print") or {}
    try:
        page_size = tuple(float(v) for v in printed["pagePoints"])
        map_corners = np.asarray(printed["mapCornerPagePoints"], dtype=np.float64)
        fiducials = {
            int(item["id"]): np.asarray(item["cornersPagePoints"], dtype=np.float64)
            for item in printed["fiducials"]
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"sheet {map_id} has no usable print layout: {exc}") from exc
    panels = {}
    for side, panel in (printed.get("sidePanels") or {}).items():
        if isinstance(panel, dict) and isinstance(panel.get("regionPoints"), list):
            panels[side] = [float(v) for v in panel["regionPoints"]]
    return MapSheet(
        id=str(record.get("id", map_id)),
        record=record,
        reference=reference,
        page_size_pt=(page_size[0], page_size[1]),
        map_corners_pt=map_corners,
        fiducials_pt=fiducials,
        lnglat_corners=[[float(a), float(b)] for a, b in record["corners"]],
        panels_pt=panels,
        mask_rects=printed.get("maskRectsNormalized") or [],
    )
