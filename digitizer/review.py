"""Human-in-the-loop: apply a reviewer's edits to a run, and learn from them.

Edits never re-run the vision steps; they rewrite ``result.json``.

* A colour fix on a sticker clamps it (it is never re-labelled again), adds its
  measured colour to the session palette -- so later sheets of the session know
  that look -- and re-classifies every *other* sticker of this sheet with the
  fix as an extra example: correcting one pink that was read as red re-labels
  its look-alikes on the same photo at once.
* Confirming a flagged sticker unchanged also teaches the palette (a doubtful
  colour a human vouched for is exactly the example that was missing).
* A pen fix on a route teaches the session's pen palette the same way.

Every change is appended to ``sessions/<session>/corrections.jsonl`` too: the
raw material for retraining later.
"""
from __future__ import annotations

import json
import math
import threading
import time
from pathlib import Path

import cv2
import numpy as np

from .palette import SessionPalette
from .pipeline import (DEFAULT_LEGEND, DEFAULT_SESSIONS, classify_stickers, fixed_colours, legend_class, load_legend,
                       reserved_colours, write_result)
from .sheet import load_sheet
from .stickers import SHAPES, Sticker, outline

_LOCK = threading.Lock()


class Run:
    def __init__(self, directory: Path, legend_path: Path = DEFAULT_LEGEND, sessions_dir: Path = DEFAULT_SESSIONS):
        self.dir = Path(directory)
        self.result = json.loads((self.dir / "result.json").read_text(encoding="utf-8"))
        self.legend = load_legend(legend_path)
        self.session = SessionPalette(self.legend, Path(sessions_dir) / self.result.get("session", "default"))
        self.sheet = load_sheet(self.result["mapId"])

    # ----------------------------------------------------------- persistence
    def save(self) -> dict:
        review = self.result.setdefault("review", {"status": "pending", "corrections": 0})
        review["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        write_result(self.dir, self.result, self.sheet, self.legend)
        return self.result

    def _count(self) -> None:
        review = self.result.setdefault("review", {"status": "pending", "corrections": 0})
        review["corrections"] = int(review.get("corrections", 0)) + 1
        if review.get("status") == "reviewed":
            review["status"] = "in-review"

    def _source(self, **extra) -> dict:
        return {"run": self.result["runId"], "map": self.result["mapId"], **extra}

    # ------------------------------------------------------------- stickers
    def _sticker(self, sticker_id: int) -> dict:
        for sticker in self.result["stickers"]:
            if sticker["id"] == sticker_id:
                return sticker
        raise KeyError(f"no sticker {sticker_id}")

    def _reclassify(self) -> None:
        """Re-run the colour step on this sheet with every human decision clamped."""
        live = [s for s in self.result["stickers"] if not s.get("deleted")]
        previous_flags = {s["id"]: list(s.get("flags", [])) for s in live}
        objects = []
        for data in live:
            fields = {k: v for k, v in data.items() if k in Sticker.__dataclass_fields__}
            objects.append(Sticker(**fields))
        clamp = {s.id: s.colour for s in objects if s.source == "human" and s.colour}
        info = classify_stickers(objects, self.session.stickers, self.legend, clamp)
        by_id = {s.id: s for s in objects}
        for data in live:
            updated = by_id[data["id"]].to_dict()
            reviewed = data.get("reviewed")
            data.update({k: updated[k] for k in ("colour", "colour_confidence", "colour_alternatives",
                                                  "category", "label", "flags", "source")})
            if reviewed:   # a human looked at it: its remaining doubts are answered
                data["reviewed"] = True
                kept = [f for f in data["flags"] if f in ("no-legend-class",)]
                if "colour-not-learned" in previous_flags.get(data["id"], []):
                    kept.append("colour-not-learned")
                data["flags"] = kept
        self.result["colourAdaptation"] = info

    def _check_colour(self, shape: str, colour: str | None) -> None:
        """A star is gold and gold is only for stars (whatever the legend says of that kind)."""
        if not colour:
            return
        fixed, reserved = fixed_colours(self.legend), reserved_colours(self.legend)
        if shape in fixed and colour != fixed[shape]:
            raise ValueError(f"a {shape} is always {fixed[shape]}")
        if shape not in fixed and colour in reserved:
            raise ValueError(f"{colour} only comes as a {reserved[colour]}")

    def edit_sticker(self, sticker_id: int, colour: str | None = None, shape: str | None = None,
                     deleted: bool | None = None, confirm: bool = False) -> dict:
        with _LOCK:
            sticker = self._sticker(sticker_id)
            self._check_colour(shape or sticker["shape"], colour)
            if deleted is not None:
                sticker["deleted"] = bool(deleted)
                self._count()
                self._log_only("sticker-deleted" if deleted else "sticker-restored", sticker)
            if shape and shape != sticker["shape"]:
                if shape not in SHAPES:
                    raise ValueError(f"unknown shape {shape}")
                sticker["shape"] = shape
                # the new shape at its own size (a crescent fitted as a 17 mm
                # triangle is a 10 mm circle, not a 17 mm one)
                sticker["diameter_px"] = self.legend["stickers"]["sizesMm"][shape] * self.result["map"]["pxPerMm"]
                sticker["polygon"] = outline(shape, sticker["diameter_px"], sticker.get("angle", 0.0),
                                             sticker["x"], sticker["y"]).tolist()
                sticker["reviewed"] = True
                self._count()
                self._log_only("sticker-shape", sticker)
            was_flagged = bool(sticker.get("flags"))
            if colour and colour != sticker.get("colour"):
                if self.session.stickers.get(colour) is None:
                    raise ValueError(f"unknown colour {colour}; add it to the legend or session palette first")
                sticker["colour"], sticker["source"], sticker["reviewed"] = colour, "human", True
                self.session.learn("sticker", colour, sticker["lab"], source=self._source(sticker=sticker_id,
                                                                                         action="relabel"))
                self._count()
            elif confirm or (colour and colour == sticker.get("colour")):
                sticker["reviewed"] = True
                if sticker.get("colour"):
                    sticker["source"] = "human"
                    if was_flagged:
                        self.session.learn("sticker", sticker["colour"], sticker["lab"],
                                           source=self._source(sticker=sticker_id, action="confirm"))
            self._reclassify()
            return self.save()

    def add_sticker(self, x: float, y: float, shape: str, colour: str | None) -> dict:
        with _LOCK:
            if shape not in SHAPES:
                raise ValueError(f"unknown shape {shape}")
            colour = fixed_colours(self.legend).get(shape, colour)
            if not colour:
                raise ValueError("pick the sticker's colour")
            self._check_colour(shape, colour)
            sizes = self.legend["stickers"]["sizesMm"]
            px_per_mm = self.result["map"]["pxPerMm"]
            diameter = sizes[shape] * px_per_mm
            lab = self._measure(x, y, 0.28 * sizes["circle"] * px_per_mm)
            next_id = max([s["id"] for s in self.result["stickers"]] + [0]) + 1
            polygon = outline(shape, diameter, 0.0, x, y).tolist()
            entry = legend_class(self.legend, shape, colour)
            self.result["stickers"].append({
                "id": next_id, "shape": shape, "x": float(x), "y": float(y), "angle": 0.0,
                "diameter_px": float(diameter), "fill": 1.0, "occluded": 0.0, "shape_score": 1.0,
                "shape_margin": 1.0, "lab": [round(float(v), 1) for v in lab], "lab_spread": 0.0, "pixels": 0,
                "polygon": polygon, "colour": colour, "colour_confidence": 1.0, "colour_alternatives": [],
                "category": entry["category"] if entry else None, "label": entry["label"] if entry else None,
                "flags": [] if entry else ["no-legend-class"], "source": "human", "reviewed": True, "vlm": None,
            })
            if self._plausible(colour, lab):
                self.session.learn("sticker", colour, lab, source=self._source(sticker=next_id, action="add"))
            else:
                self.result["stickers"][-1]["flags"].append("colour-not-learned")
            self._count()
            self._reclassify()
            return self.save()

    def _plausible(self, colour: str, lab: list[float]) -> bool:
        """Is a clicked colour fit to teach the palette? (A mis-click must not poison it.)

        Bare paper is never a sticker colour, and a colour far from every look
        the class already has is more likely a slip than a new stock -- a new
        stock is taught by relabelling a detected sticker instead.
        """
        from .palette import weighted_distance

        lightness, chroma = lab[0], math.hypot(lab[1] - 128.0, lab[2] - 128.0)
        if lightness > 235 and chroma < 10:
            return False
        known = self.session.stickers.get(colour)
        if known and known.examples:
            return float(weighted_distance(np.asarray(known.examples), np.asarray(lab)).min()) <= 60.0
        return True

    def _measure(self, x: float, y: float, radius: float) -> list[float]:
        image = cv2.imread(str(self.dir / "map.jpg"), cv2.IMREAD_COLOR)
        mask = np.zeros(image.shape[:2], np.uint8)
        cv2.circle(mask, (int(round(x)), int(round(y))), max(2, int(round(radius))), 255, -1)
        lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)[mask > 0].astype(np.float64)
        return np.median(lab, axis=0).tolist() if len(lab) else [0.0, 128.0, 128.0]

    def _log_only(self, action: str, item: dict) -> None:
        path = self.session.directory / "corrections.jsonl"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "action": action,
                                     **self._source(item=item.get("id"))}, ensure_ascii=False) + "\n")

    # --------------------------------------------------------------- routes
    def _route(self, route_id: int) -> dict:
        for route in self.result["routes"]:
            if route["id"] == route_id:
                return route
        raise KeyError(f"no route {route_id}")

    def edit_route(self, route_id: int, pen: str | None = None, deleted: bool | None = None,
                   kind: str | None = None) -> dict:
        with _LOCK:
            route = self._route(route_id)
            if deleted is not None:
                route["deleted"] = bool(deleted)
                self._log_only("route-deleted" if deleted else "route-restored", route)
            if kind in ("route", "mark"):
                route["kind"] = kind
            if pen and pen != route.get("pen"):
                if self.session.pens.get(pen) is None:
                    raise ValueError(f"unknown pen {pen}")
                route["pen"] = pen
                if route.get("colour_lab"):
                    self.session.learn("pen", pen, route["colour_lab"], source=self._source(route=route_id,
                                                                                           action="relabel"))
            route["source"] = "human"
            route["reviewed"] = True
            route["flags"] = []
            self._count()
            return self.save()

    def add_route(self, points: list[list[float]], pen: str) -> dict:
        with _LOCK:
            if len(points) < 2:
                raise ValueError("a route needs at least two points")
            length = sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))
            next_id = max([r["id"] for r in self.result["routes"]] + [0]) + 1
            self.result["routes"].append({
                "id": next_id, "pen": pen, "points": [[round(float(x), 1), round(float(y), 1)] for x, y in points],
                "length_px": round(length, 2), "width_px": 0.0, "colour_lab": [], "pen_confidence": 1.0,
                "pen_alternatives": [], "kind": "route", "bridged_gaps": 0, "printed_share": 0.0, "flags": [],
                "source": "human", "reviewed": True,
            })
            self._count()
            return self.save()

    # --------------------------------------------------------------- answers
    def set_answers(self, questionnaire: dict | None = None) -> dict:
        with _LOCK:
            if questionnaire is not None:
                block = self.result.get("questionnaire") or {}
                block["fields"] = questionnaire
                block["reviewed"] = True
                self.result["questionnaire"] = block
            self._count()
            return self.save()
