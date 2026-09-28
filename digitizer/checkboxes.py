"""Checkboxes read from pixels: find the printed squares, measure the ink inside.

A second reading beside the VLM's. The model misses light marks -- a single
thin slash was read as "empty" in both of its passes on map 1 sheet 12 -- while
ink inside a printed square is easy to measure: blank boxes held 0-3 % dark
pixels on the workshop photos, marked ones 10-67 %.

The squares are found by shape (four-cornered outlines of one size) and put in
the legend's order with its ``layout.columns``: column by column, top to bottom
([6, 5]: the left column's six options, then the right column's five). When the
squares found do not make exactly those columns, nothing is said -- the VLM's
reading stands alone.
"""
from __future__ import annotations

import itertools

import cv2
import numpy as np

CHECKED_INK = 0.06      # share of dark pixels inside a box above which it is marked
EMPTY_INK = 0.03        # ... and below which it is blank; in between: no opinion


def _squares(gray: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Box-sized square outlines. A tick or cross joined to a box's outline bent
    its contour out of shape -- exactly the boxes that matter -- so outlines are
    rebuilt from horizontal and vertical strokes about a box side long first:
    diagonal marks do not survive that, printed box edges do."""
    height, width = gray.shape
    dark = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 12)
    clean = _outlines(dark, width)
    side = float(np.median([b[2] for b in clean])) if clean else 0.038 * width
    length = max(5, int(round(0.6 * side)))
    lines = (cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((1, length), np.uint8))
             | cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((length, 1), np.uint8)))
    lines = cv2.morphologyEx(lines, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    return _outlines(lines, width)


def _outlines(binary: np.ndarray, width: int) -> list[tuple[int, int, int, int]]:
    contours, _ = cv2.findContours(binary, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    found = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if not (0.018 * width <= w <= 0.06 * width and 0.8 <= w / max(h, 1) <= 1.25):
            continue
        if cv2.contourArea(contour) < 0.85 * w * h:          # a circle fills ~0.79 of its box
            continue
        if len(cv2.approxPolyDP(contour, 0.06 * cv2.arcLength(contour, True), True)) != 4:
            continue
        found.append((x, y, w, h))
    found.sort(key=lambda b: -b[2] * b[3])
    kept: list[tuple[int, int, int, int]] = []
    for box in found:                                        # outer and inner outline of one square
        cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
        if all(abs(cx - (k[0] + k[2] / 2)) > 0.5 * k[2] or abs(cy - (k[1] + k[3] / 2)) > 0.5 * k[3] for k in kept):
            kept.append(box)
    return kept


def find_checkboxes(panel: np.ndarray, columns: list[int]) -> list[tuple[int, int, int, int]] | None:
    """The checkbox squares in option order, or None when they cannot be told apart."""
    gray = cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY)
    squares = _squares(gray)
    if not squares:
        return None
    side = float(np.median([b[2] for b in squares]))
    squares = [b for b in squares if 0.75 * side <= b[2] <= 1.3 * side]
    groups: list[list[tuple[int, int, int, int]]] = []
    for box in sorted(squares, key=lambda b: b[0] + b[2] / 2):
        cx = box[0] + box[2] / 2
        if groups and abs(cx - np.mean([g[0] + g[2] / 2 for g in groups[-1]])) < 0.6 * side:
            groups[-1].append(box)
        else:
            groups.append([box])
    # each column split into runs of evenly spaced squares: the checkbox list is
    # one run, other squares further down the panel another. A box whose mark
    # hid its outline leaves a double gap, filled in between its neighbours.
    candidates = []
    pitches = []
    for group in groups:
        group.sort(key=lambda b: b[1])
        steps = np.diff([b[1] for b in group])
        if len(steps):
            pitches.append(float(np.median(steps)))
        pitch = float(np.median(steps)) if len(steps) else 0.0
        run = [group[0]]
        for box, step in zip(group[1:], steps):
            if abs(step - pitch) <= 0.35 * pitch:
                run.append(box)
            elif abs(step - 2 * pitch) <= 0.35 * pitch:
                last = run[-1]
                run.append(((last[0] + box[0]) // 2, last[1] + int(round(step / 2)), last[2], last[3]))
                run.append(box)
            else:
                candidates.append(run)
                run = [box]
        candidates.append(run)
    if not pitches:
        return None
    pitch = float(np.median(pitches))
    # the columns, left to right, with the legend's counts and their tops level
    # (other squares -- the logo's -- may sit between them). A column one box
    # short gets it at the top or the bottom, whichever keeps the tops level.
    for chosen in itertools.combinations(candidates, len(columns)):
        full = [g[0][1] for g, n in zip(chosen, columns) if len(g) == n]
        if not full or any(len(g) not in (n, n - 1) for g, n in zip(chosen, columns)):
            continue
        top = float(np.median(full))
        completed = []
        for group, count in zip(chosen, columns):
            group = list(group)
            if len(group) == count - 1:
                first, last = group[0], group[-1]
                if abs(first[1] - pitch - top) <= 0.4 * pitch:
                    group.insert(0, (first[0], int(round(first[1] - pitch)), first[2], first[3]))
                elif abs(first[1] - top) <= 0.4 * pitch:
                    group.append((last[0], int(round(last[1] + pitch)), last[2], last[3]))
                else:
                    break
            if abs(group[0][1] - top) > 0.5 * pitch:
                break
            completed.append(group)
        else:
            return [box for group in completed for box in group]
    return None

def _ink(gray: np.ndarray, box: tuple[int, int, int, int]) -> float:
    x, y, w, h = box
    margin = int(round(0.18 * w))
    inner = gray[y + margin:y + h - margin, x + margin:x + w - margin]
    if inner.size == 0:
        return 0.0
    around = gray[max(0, y - h):y + 2 * h, max(0, x - w):x + 2 * w]
    paper = float(np.percentile(around, 90))
    return float((inner < 0.72 * paper).mean())


def tick_marks(panel: np.ndarray | None, field: dict) -> dict[str, str | None]:
    """option id -> "checked" / "empty" / None (no clear opinion); {} if the boxes were not found."""
    columns = ((field.get("layout") or {}).get("columns")) or []
    options = field.get("options") or []
    if panel is None or not columns or sum(columns) != len(options):
        return {}
    boxes = find_checkboxes(panel, columns)
    if boxes is None:
        return {}
    gray = cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY)
    marks: dict[str, str | None] = {}
    for option, box in zip(options, boxes):
        ink = _ink(gray, box)
        marks[option["id"]] = "checked" if ink >= CHECKED_INK else "empty" if ink <= EMPTY_INK else None
    return marks


def merge(field_id: str, options: list[dict], overview: dict, close_up: dict, marks: dict) -> tuple[dict, list]:
    """Final state per option and the disagreements worth a look.

    The pixels win where they are clear, else the close-up, else the overview.
    A difference is flagged between the pixels and the close-up, or -- when the
    pixels are silent -- between the close-up and the overview.
    """
    states, disagreements = {}, []
    for option in options:
        oid = option["id"]
        a, b, p = overview.get(oid), close_up.get(oid), marks.get(oid)
        a = a if a in ("checked", "empty") else None
        b = b if b in ("checked", "empty") else None
        states[oid] = p or b or a or "unclear"
        entry = {"field": field_id, "option": oid, "overview": a, "closeUp": b, "pixels": p}
        if p and b and p != b:
            disagreements.append(entry)
        elif not p and a and b and a != b:
            disagreements.append(entry)
    return states, disagreements


def read_checkboxes(panel: np.ndarray | None, legend: dict) -> dict:
    """The questionnaire's checkboxes from pixels alone (no VLM): {} when none could be read."""
    fields = {}
    for field in (legend.get("questionnaire") or {}).get("fields") or []:
        if field.get("kind") == "checkboxes":
            marks = tick_marks(panel, field)
            if marks:
                fields[field["id"]] = {o["id"]: marks.get(o["id"]) or "unclear" for o in field["options"]}
    return {"fields": fields, "disagreements": [], "source": "pixels"} if fields else {}
