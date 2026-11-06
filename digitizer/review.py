"""A reviewer's edits to a run: the photo's list, eyedropper looks, stickers, routes, handwritten texts,
erasing, undo.

Edits never re-run the vision steps and nothing is learned from them: each one
rewrites ``result.json`` (and its GeoJSON) and nothing else. A change to the
photo's list or looks waits for the next Digitize. Every edit can be undone
and redone, digitizing too; the history lives in memory, per sheet, until the
server stops.
"""
from __future__ import annotations

import json
import math
import threading
import time
from pathlib import Path

import cv2

from backend import config
from .pipeline import load_legend, write_result
from .sheet import load_sheet
from .stickers import SHAPES, outline
from .workshop import Workshop, lab_to_hex, name_id, name_label, sample_look

_LOCK = threading.Lock()
_HISTORY: dict[str, dict[str, list[str]]] = {}
HISTORY_LIMIT = 100


class Run:
    def __init__(self, directory: Path):
        self.dir = Path(directory)
        self.stock = load_legend(config.DIGITIZER_LEGEND_FILE)
        self.sessions_dir = Path(config.DIGITIZER_PALETTES_DIR)
        self._reload()
        self.sheet = load_sheet(self.result["mapId"])

    def _reload(self) -> None:
        self.result = json.loads((self.dir / "result.json").read_text(encoding="utf-8"))

    def workshop(self) -> Workshop:
        return Workshop(self.stock, self.dir.parent, self.result.get("session", "default"), self.sessions_dir)

    def view(self, result: dict | None = None) -> dict:
        """The sheet as the page needs it: with its list even when it was digitised before lists existed."""
        result = dict(result if result is not None else self.result)
        result["legend"] = self.workshop().photo_list(result)
        return result

    # ----------------------------------------------------------- persistence
    def save(self) -> dict:
        review = self.result.setdefault("review", {"status": "pending", "corrections": 0})
        review["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        write_result(self.dir, self.result, self.sheet, self.workshop().export_legend(self.result))
        return self.result

    def _count(self) -> None:
        review = self.result.setdefault("review", {"status": "pending", "corrections": 0})
        review["corrections"] = int(review.get("corrections", 0)) + 1
        if review.get("status") == "reviewed":
            review["status"] = "in-review"

    def _list_changed(self) -> None:
        if self.result.get("stage") != "prepared":
            self.result["listChanged"] = True   # the page offers to digitize again

    # --------------------------------------------------------------- history
    def _history(self) -> dict[str, list[str]]:
        return _HISTORY.setdefault(str(self.dir.resolve()), {"undo": [], "redo": []})

    def _remember(self) -> None:
        """Keep the sheet as it is now, before an edit changes it."""
        history = self._history()
        history["undo"].append(json.dumps(self.result, ensure_ascii=False))
        del history["undo"][:-HISTORY_LIMIT]
        history["redo"].clear()

    def checkpoint(self) -> None:
        """Before digitizing: undo then brings back the sheet as it is now."""
        with _LOCK:
            self._reload()
            self._remember()

    def _step(self, back: bool) -> dict:
        with _LOCK:
            self._reload()
            history = self._history()
            source, target = (history["undo"], history["redo"]) if back else (history["redo"], history["undo"])
            if not source:
                raise ValueError("nothing to undo" if back else "nothing to redo")
            target.append(json.dumps(self.result, ensure_ascii=False))
            self.result = json.loads(source.pop())
            return self.save()

    def undo(self) -> dict:
        return self._step(back=True)

    def redo(self) -> dict:
        return self._step(back=False)

    # ------------------------------------------------------------ the list
    def set_list(self, stickers: list[dict], pens: list[str]) -> dict:
        """Which stickers (shape x colour) and pens are on this photo: what digitizing looks for."""
        with _LOCK:
            self._reload()
            workshop = self.workshop()
            own = workshop.photo_list(self.result)
            names = own.get("names") or {}
            colours = set(workshop.colours) | set(names.get("colours") or {})
            known_pens = set(workshop.pens) | set(names.get("pens") or {})
            types = []
            for item in stickers:
                shape, colour = item.get("shape"), item.get("colour")
                if shape not in SHAPES or colour not in colours:
                    raise ValueError(f"no {colour} {shape} mark is known")
                if (shape, colour) not in [(t["shape"], t["colour"]) for t in types]:
                    types.append({"shape": shape, "colour": colour})
            pens = list(dict.fromkeys(pens))
            if any(pen not in known_pens for pen in pens):
                raise ValueError("unknown pen")
            self._remember()
            self.result["legend"] = workshop.with_names(types, pens, names)
            self._list_changed()
            return self.save()

    def add_look(self, kind: str, text: str, x: float, y: float, shape: str | None = None) -> dict:
        """The eyedropper: the colour under (x, y) becomes a look of the name -- a new name if it is new --
        and the name goes on this photo's list (with ``shape``, for a sticker)."""
        with _LOCK:
            self._reload()
            if kind not in ("sticker", "pen"):
                raise ValueError("a look is of a mark or a pen")
            name = name_id(text)
            if not name:
                raise ValueError("type a name first")
            if kind == "sticker" and shape is not None and shape not in SHAPES:
                raise ValueError(f"unknown shape {shape}")
            width, height = self.result["map"]["width"], self.result["map"]["height"]
            if not (0 <= x <= width and 0 <= y <= height):
                raise ValueError("click on the map")
            image = cv2.imread(str(self.dir / "map.jpg"), cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError("this sheet has no map image")
            ink = None
            if kind == "pen":   # where ink was added: on a prepared sheet, else the routes' ink of an older one
                for name_of_file in ("score.png", "ink.png"):
                    ink = cv2.imread(str(self.dir / name_of_file), cv2.IMREAD_GRAYSCALE)
                    if ink is not None and ink.shape == image.shape[:2]:
                        break
                    ink = None
            lab = sample_look(image, x, y, self.result["map"]["pxPerMm"], kind,
                              self.stock["stickers"]["sizesMm"].get("circle", 10.0), ink)
            workshop = self.workshop()
            own = workshop.photo_list(self.result)
            names = own.get("names") or {}
            registry = workshop.colours if kind == "sticker" else workshop.pens
            mine = names.get("colours" if kind == "sticker" else "pens") or {}
            known = registry.get(name) or mine.get(name)
            label = known["label"] if known else name_label(text)
            self._remember()
            self.result.setdefault("looks", []).append({
                "kind": kind, "name": name, "label": label, "lab": lab, "display": lab_to_hex(lab),
                "x": round(float(x), 1), "y": round(float(y), 1), "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            })
            types = [dict(t) for t in own["stickers"]]
            pens = list(own["pens"])
            if kind == "pen" and name not in pens:
                pens.append(name)
            if kind == "sticker" and shape and not any(t["shape"] == shape and t["colour"] == name for t in types):
                types.append({"shape": shape, "colour": name})
            if not known:   # a new name, drawn in the colour just picked
                names = {**names, ("colours" if kind == "sticker" else "pens"): {
                    **mine, name: {"label": label, "display": lab_to_hex(lab)}}}
            self.result["legend"] = workshop.with_names(types, pens, names)
            self._list_changed()
            return self.save()

    # ----------------------------------------------------------------- edits
    def add_sticker(self, x: float, y: float, shape: str, colour: str) -> dict:
        with _LOCK:
            self._reload()
            listed = self.workshop().photo_list(self.result)["stickers"]
            if not any(t["shape"] == shape and t["colour"] == colour for t in listed):
                raise ValueError(f"no {colour} {shape} on this photo's list")
            width, height = self.result["map"]["width"], self.result["map"]["height"]
            if not (0 <= x <= width and 0 <= y <= height):
                raise ValueError("a mark goes on the map")
            self._remember()
            diameter = self.stock["stickers"]["sizesMm"][shape] * self.result["map"]["pxPerMm"]
            next_id = max([s["id"] for s in self.result["stickers"]] + [0]) + 1
            self.result["stickers"].append({
                "id": next_id, "shape": shape, "x": float(x), "y": float(y), "angle": 0.0,
                "diameter_px": float(diameter), "fill": 1.0, "occluded": 0.0, "shape_score": 1.0,
                "shape_margin": 1.0, "lab": [], "lab_spread": 0.0, "pixels": 0,
                "polygon": outline(shape, diameter, 0.0, x, y).tolist(), "colour": colour,
                "colour_confidence": 1.0, "colour_alternatives": [],
                "flags": [], "source": "human", "reviewed": True,
            })
            self._count()
            return self.save()

    def add_route(self, points: list[list[float]], pen: str) -> dict:
        with _LOCK:
            self._reload()
            if pen not in self.workshop().photo_list(self.result)["pens"]:
                raise ValueError(f"no {pen} pen on this photo's list")
            if len(points) < 2:
                raise ValueError("a route needs at least two points")
            self._remember()
            points = [[round(float(x), 1), round(float(y), 1)] for x, y in points]
            length = sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))
            next_id = max([r["id"] for r in self.result["routes"]] + [0]) + 1
            self.result["routes"].append({
                "id": next_id, "pen": pen, "points": points, "length_px": round(length, 2), "width_px": 0.0,
                "colour_lab": [], "pen_confidence": 1.0, "pen_alternatives": [], "kind": "route",
                "bridged_gaps": 0, "printed_share": 0.0, "flags": [], "source": "human", "reviewed": True,
            })
            self._count()
            return self.save()

    def add_text(self, x: float, y: float, text: str) -> dict:
        """Handwriting typed by hand where it was written."""
        with _LOCK:
            self._reload()
            text = " ".join(str(text or "").split())
            if not text:
                raise ValueError("type the text first")
            width, height = self.result["map"]["width"], self.result["map"]["height"]
            if not (0 <= x <= width and 0 <= y <= height):
                raise ValueError("a text goes on the map")
            self._remember()
            mm = self.result["map"]["pxPerMm"]
            texts = self.result.setdefault("texts", [])
            texts.append({
                "id": max([t["id"] for t in texts] + [0]) + 1, "x": round(float(x), 1), "y": round(float(y), 1),
                "box": [round(float(x) - 6 * mm, 1), round(float(y) - 3 * mm, 1),
                        round(float(x) + 6 * mm, 1), round(float(y) + 3 * mm, 1)],
                "text": text, "source": "human",
            })
            self._count()
            return self.save()

    def set_text(self, text_id: int, text: str) -> dict:
        """A text read wrong, fixed by hand (digitizing again keeps it)."""
        with _LOCK:
            self._reload()
            text = " ".join(str(text or "").split())
            if not text:
                raise ValueError("an empty text is erased, not saved")
            item = next((t for t in self.result.get("texts") or [] if t["id"] == text_id and not t.get("deleted")),
                        None)
            if item is None:
                raise ValueError(f"no text {text_id}")
            if item["text"] == text:
                return self.result
            self._remember()
            item["text"] = text
            item["source"] = "human"
            self._count()
            return self.save()

    def erase(self, sticker_ids: list[int], route_ids: list[int], text_ids: list[int] = ()) -> dict:
        """Remove stickers, routes and texts (they stay in result.json, marked deleted)."""
        with _LOCK:
            self._reload()
            sticker_ids, route_ids, text_ids = set(sticker_ids), set(route_ids), set(text_ids)
            stickers = [s for s in self.result["stickers"] if s["id"] in sticker_ids and not s.get("deleted")]
            routes = [r for r in self.result["routes"] if r["id"] in route_ids and not r.get("deleted")]
            texts = [t for t in self.result.get("texts") or [] if t["id"] in text_ids and not t.get("deleted")]
            if not stickers and not routes and not texts:
                raise ValueError("nothing to erase")
            self._remember()
            for item in stickers + routes + texts:
                item["deleted"] = True
            self._count()
            return self.save()
