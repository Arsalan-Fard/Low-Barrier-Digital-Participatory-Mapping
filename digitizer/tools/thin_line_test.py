"""Synthetic thin-pen test: draw thin lines into a real photo, check they come back.

The lines are drawn in *camera* space (through the sheet's own tag
registration), anti-aliased, slightly blurred and not fully opaque, so they go
through exactly the same warp, colour fit and difference steps as real ink.

    python -m digitizer.tools.thin_line_test --map-id 2 --photo digitizer/IMG_20260924_121031.jpg

Reports, per synthetic line, how much of it a detected route covers and which
pen it was given. The truth is placed through the tag homography only, while
the pipeline also corrects the paper's curl (up to ~4 mm on a curled sheet),
so "covered" allows 4 mm; the lines are drawn in empty parts of the map, where
nothing else could be matched instead.
"""
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

import cv2
import numpy as np

from ..pipeline import DEFAULT_LEGEND, Options, run
from ..register import _rect_to_page, choose_map_width, register_page
from ..sheet import load_sheet

# (name, BGR ink, width mm, opacity, expected pen); paths are in map millimetres
LINES = [
    ("blue ballpoint 0.5 mm", (70, 40, 35), 0.5, 0.85, "blue"),
    ("red ballpoint 0.5 mm", (40, 45, 185), 0.5, 0.85, "red"),
    ("blue ballpoint 0.35 mm, light hand", (80, 50, 45), 0.35, 0.6, "blue"),
    ("red ballpoint 0.3 mm, very light", (60, 60, 190), 0.3, 0.5, "red"),
]
# drawn on empty paper of map 2 (clear of its stickers and routes)
PATHS_MM = [
    [(40, 20), (70, 26), (95, 22), (120, 35), (140, 32)],
    [(150, 250), (175, 240), (200, 252), (230, 238), (255, 246)],
    [(245, 150), (255, 180), (248, 210), (262, 240)],
    [(18, 110), (32, 140), (24, 165), (36, 190)],
]


def draw(photo: np.ndarray, sheet, registration, map_width: int) -> tuple[np.ndarray, list[np.ndarray]]:
    height = int(round(map_width * sheet.reference.shape[0] / sheet.reference.shape[1]))
    rect_to_photo = registration.page_to_photo @ _rect_to_page(sheet.map_corners_pt, map_width, height)
    px_per_mm_map = map_width / sheet.map_width_mm
    out = photo.copy().astype(np.float32)
    truth = []
    for (name, colour, width_mm, opacity, _), path in zip(LINES, PATHS_MM):
        # densify so the drawn line follows the perspective faithfully
        pts = np.asarray(path, np.float64) * px_per_mm_map
        dense = np.vstack([np.linspace(pts[i], pts[i + 1], 40, endpoint=False) for i in range(len(pts) - 1)] + [pts[-1:]])
        truth.append(dense)
        camera = cv2.perspectiveTransform(dense.reshape(-1, 1, 2), rect_to_photo).reshape(-1, 2)
        layer = np.zeros(photo.shape[:2], np.uint8)
        thickness = max(1, int(round(width_mm * registration.photo_px_per_mm)))
        cv2.polylines(layer, [np.round(camera * 16).astype(np.int32).reshape(-1, 1, 2)], False, 255, thickness,
                      cv2.LINE_AA, shift=4)
        alpha = cv2.GaussianBlur(layer.astype(np.float32) / 255.0, (0, 0), 0.8)[:, :, None] * opacity
        out = out * (1 - alpha) + np.asarray(colour, np.float32) * alpha
    return np.clip(out, 0, 255).astype(np.uint8), truth


def coverage(truth: np.ndarray, route_points: list[np.ndarray], tolerance: float) -> float:
    if not route_points:
        return 0.0
    covered = 0
    for point in truth:
        best = min(_distance(point, poly) for poly in route_points)
        covered += best <= tolerance
    return covered / len(truth)


def _distance(point: np.ndarray, poly: np.ndarray) -> float:
    if len(poly) == 1:
        return float(np.linalg.norm(point - poly[0]))
    a, b = poly[:-1], poly[1:]
    ab = b - a
    t = np.clip(((point - a) * ab).sum(1) / np.maximum((ab * ab).sum(1), 1e-9), 0, 1)
    return float(np.min(np.linalg.norm(a + ab * t[:, None] - point, axis=1)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map-id", required=True)
    parser.add_argument("--photo", required=True, type=Path)
    args = parser.parse_args()
    photo = cv2.imread(str(args.photo))
    sheet = load_sheet(args.map_id)
    registration = register_page(photo, sheet)
    width = choose_map_width(sheet, registration)
    synthetic, truth = draw(photo, sheet, registration, width)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "synthetic.jpg"
        cv2.imwrite(str(path), synthetic, [cv2.IMWRITE_JPEG_QUALITY, 92])
        out = run(Options(map_id=args.map_id, map_photo=path, legend_path=DEFAULT_LEGEND, use_vlm=False,
                          session="thin-line-test", run_id="thin-line-test"))
    result = json.loads((out / "result.json").read_text(encoding="utf-8"))
    px_per_mm = result["map"]["pxPerMm"]
    routes = [r for r in result["routes"]]
    print(f"run -> {out}")
    for (name, _, _, _, expected), line in zip(LINES, truth):
        best_share, best_pen, best_len = 0.0, None, 0.0
        for route in routes:
            share = coverage(line, [np.asarray(route["points"])], 4.0 * px_per_mm)
            if share > best_share:
                best_share, best_pen, best_len = share, route["pen"], route["length_px"] / px_per_mm
        true_len = float(np.linalg.norm(np.diff(line, axis=0), axis=1).sum()) / px_per_mm
        verdict = "OK " if best_share >= 0.9 and best_pen == expected else "BAD"
        print(f"  {verdict} {name:36s} covered {best_share:5.0%} ({best_len:.0f} of {true_len:.0f} mm)  "
              f"pen={best_pen} (expected {expected})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
