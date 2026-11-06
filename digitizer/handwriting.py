"""Handwriting on the map, found and read by the VLM (``vlm.py``) and placed where it was written.

The model looks for handwriting on the map with the print taken away: only what was added on the
paper (the "added ink" image, ``photometric.py``) keeps its colour, everything else turns white, so
street names and other printed labels cannot be taken for handwriting. That map is cut into
overlapping tiles small enough to keep each letter readable; tiles with no added ink are skipped.
For each tile the model lists the handwriting it sees, with a box. Each find is then read again
from a close-up of its box on the photo itself, where the strokes are whole: that sharpens the
words. A find is kept when both readings agree enough -- a pen mark beside a printed label can be
read as the label in the close-up -- and finds seen in two overlapping tiles are kept once.
"""
from __future__ import annotations

from difflib import SequenceMatcher

import cv2
import numpy as np

TILE_PX = 1024
OVERLAP_PX = 192
INK_LEVEL = 40          # added-ink strength (0-255) counted as ink
INK_GROW_PX = 5         # the ink mask grown by this, so a stroke keeps its edges
MIN_TILE_INK = 200      # ink pixels a tile needs to be worth a question
MIN_AGREEMENT = 0.3     # how alike the find's text and the close-up's must be (0-1)

FIND_PROMPT = (
    "This image shows what a participant added with pens and stickers on a paper map; the printed "
    "map has been removed. Find every piece of text written by hand: words, names, numbers or "
    "letters. Leave out stickers (coloured discs, triangles, stars) and lines or arrows without "
    "letters. For each one give bbox_2d [x1, y1, x2, y2] in coordinates relative to the image, from "
    "0 to 1000, and the text exactly as written (keep its language, usually French). "
    'Reply as {"texts": [{"bbox_2d": [x1, y1, x2, y2], "text": "..."}]}, or {"texts": []} if there '
    "is no handwriting."
)
READ_PROMPT = (
    "This is a close-up of a printed street map with something written on it by hand with a pen. "
    "Transcribe only the handwriting, exactly as written, keeping its language; leave out the "
    'printed map text. Reply as {"text": "..."}, or {"text": ""} if there is no handwriting.'
)


def _tiles(length: int) -> list[int]:
    """Start offsets covering ``length`` with tiles of TILE_PX overlapping by OVERLAP_PX."""
    if length <= TILE_PX:
        return [0]
    step = TILE_PX - OVERLAP_PX
    starts = list(range(0, length - TILE_PX, step))
    return starts + [length - TILE_PX]


def _boxes(answer) -> list[tuple[list[float], str]]:
    texts = answer.get("texts") if isinstance(answer, dict) else answer
    out = []
    for item in texts if isinstance(texts, list) else []:
        box = item.get("bbox_2d") if isinstance(item, dict) else None
        text = str(item.get("text") or "").strip() if isinstance(item, dict) else ""
        if (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)
                and box[2] > box[0] and box[3] > box[1] and text):
            out.append(([float(v) for v in box], text))
    return out


def _overlap(a: list[float], b: list[float]) -> float:
    """Intersection over the smaller box's area."""
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return w * h / smaller if smaller > 0 else 0.0


def _agree(first: str, close: str) -> bool:
    """Whether the find and the close-up read the same writing (letters in common, case ignored)."""
    a, b = first.lower().replace(" ", ""), close.lower().replace(" ", "")
    return SequenceMatcher(None, a, b).ratio() >= MIN_AGREEMENT


def read_handwriting(vlm, image: np.ndarray, added: np.ndarray | None, log=None) -> list[dict]:
    """[{x, y, box: [x1, y1, x2, y2], text}] in the map image's pixels. ``image`` is the straightened
    (colour-corrected) map, BGR; ``added`` its added-ink strength (None: the whole map is shown)."""
    height, width = image.shape[:2]
    if added is not None:
        mask = cv2.dilate((added > INK_LEVEL).astype(np.uint8), np.ones((INK_GROW_PX, INK_GROW_PX), np.uint8))
        searched = np.full_like(image, 255)
        searched[mask > 0] = image[mask > 0]
    else:
        mask, searched = None, image
    found: list[tuple[list[float], str]] = []
    asked = 0
    for top in _tiles(height):
        for left in _tiles(width):
            if mask is not None and int(mask[top:top + TILE_PX, left:left + TILE_PX].sum()) < MIN_TILE_INK:
                continue
            tile = searched[top:top + TILE_PX, left:left + TILE_PX]
            th, tw = tile.shape[:2]
            asked += 1
            for box, text in _boxes(vlm.ask(tile, FIND_PROMPT, max_new_tokens=600)):
                found.append(([left + box[0] / 1000 * tw, top + box[1] / 1000 * th,
                               left + box[2] / 1000 * tw, top + box[3] / 1000 * th], text))
    if log is not None:
        log.append(f"handwriting: {len(found)} found in {asked} tiles")

    # Kept once: the largest of overlapping finds (the same words seen from two tiles).
    found.sort(key=lambda item: -(item[0][2] - item[0][0]) * (item[0][3] - item[0][1]))
    kept: list[tuple[list[float], str]] = []
    for box, text in found:
        if all(_overlap(box, other) < 0.5 for other, _ in kept):
            kept.append((box, text))

    texts = []
    for box, first in kept:
        bw, bh = box[2] - box[0], box[3] - box[1]
        pad = max(24.0, 0.35 * max(bw, bh))
        x1, y1 = int(max(0, box[0] - pad)), int(max(0, box[1] - pad))
        x2, y2 = int(min(width, box[2] + pad)), int(min(height, box[3] + pad))
        answer = vlm.ask(image[y1:y2, x1:x2], READ_PROMPT, max_new_tokens=120, min_pixels=256 * 1024)
        text = str(answer.get("text") or "").strip() if isinstance(answer, dict) else ""
        if not text or not _agree(first, text):
            continue
        texts.append({"x": round((box[0] + box[2]) / 2, 1), "y": round((box[1] + box[3]) / 2, 1),
                      "box": [round(v, 1) for v in box], "text": text})
    if log is not None:
        log.append(f"handwriting: {len(texts)} kept after the close-up reading (of {len(kept)})")
    return texts
