"""The workshop's sticker colours and pens, their looks, and each photo's list.

A sticker colour or a pen is a name ("pink") with looks: the colours the
camera records for it (corrected Lab, see ``palette.py``), several per name --
two pink stocks, glare, shade. Looks come from three places and are pooled:

* the stock in ``legend.json``, measured on the September 2026 stickers;
* ``sessions/<name>/palette.json``, learned from corrections before the page
  stopped learning (2026-10-02); read only;
* eyedropper clicks on photos, kept in each sheet's ``result.json``
  (``looks``), so undo, or removing the sheet, takes them away again.

Each photo has its own list (``result["legend"]``): which shape x colour
stickers and which pens are on it, and the names it uses. Digitizing looks
only for those. Names stay the same from photo to photo, so the GeoJSON says
"pink" whatever pink looked like on that photo.
"""
from __future__ import annotations

import json
import re
import threading
from pathlib import Path

import cv2
import numpy as np

from .stickers import SHAPES, robust_colour

PEN_SAMPLE_MM = 1.5          # eyedropper reach on a drawn line
STICKER_SAMPLE = 0.3         # eyedropper reach on a sticker, as a share of a circle sticker's diameter
INK_MIN = 20                 # added-ink strength a drawn line has (the sticker pass's "strong")

_SCAN: dict[str, tuple[tuple[int, int], dict]] = {}
_SCAN_LOCK = threading.Lock()


def name_id(text: str) -> str:
    """The id a typed name is kept under: "Light blue" -> "light-blue"."""
    return re.sub(r"[^a-z0-9]+", "-", str(text).strip().lower()).strip("-")


def name_label(text: str) -> str:
    text = " ".join(str(text).split())
    return text[:1].upper() + text[1:]


def lab_to_hex(lab: list[float]) -> str:
    pixel = np.clip(np.round(np.asarray(lab, np.float64)), 0, 255).astype(np.uint8).reshape(1, 1, 3)
    b, g, r = cv2.cvtColor(pixel, cv2.COLOR_LAB2BGR)[0, 0]
    return f"#{int(r):02x}{int(g):02x}{int(b):02x}"


def sample_look(image: np.ndarray, x: float, y: float, px_per_mm: float, kind: str,
                circle_mm: float, ink: np.ndarray | None = None) -> list[float]:
    """The colour under an eyedropper click on the corrected map (``map.jpg``).

    On a sticker: the robust median of a disc inside it, as the detector
    measures a sticker (glare and print left out). On a drawn line, which is
    thin: its core, the pixels that differ most from the paper around the
    click -- among the added ink only when ``ink`` is given (``score.png``, or
    ``ink.png`` of a sheet digitised before), so a printed street beside the
    line is not taken for it.
    """
    height, width = image.shape[:2]
    reach = STICKER_SAMPLE * circle_mm * px_per_mm if kind == "sticker" else PEN_SAMPLE_MM * px_per_mm
    radius = max(3, int(round(reach)))
    xi, yi = int(round(x)), int(round(y))
    x0, x1 = max(0, xi - radius), min(width, xi + radius + 1)
    y0, y1 = max(0, yi - radius), min(height, yi + radius + 1)
    if x1 <= x0 or y1 <= y0:
        raise ValueError("click on the map")
    lab = cv2.cvtColor(image[y0:y1, x0:x1], cv2.COLOR_BGR2LAB)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    disc = (xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2
    if kind == "sticker":
        value, _, used = robust_colour(lab, disc)
        if not used:
            raise ValueError("no colour there")
        return [round(v, 1) for v in value]
    pixels = lab[disc].astype(np.float64)
    paper = np.median(pixels[pixels[:, 0] >= np.median(pixels[:, 0])], axis=0)
    distance = np.linalg.norm((pixels - paper) * [0.5, 1.0, 1.0], axis=1)
    if ink is not None:
        strength = ink[y0:y1, x0:x1][disc].astype(np.float64)
        added = strength >= max(INK_MIN, 0.5 * float(strength.max()))
        if not added.any():
            raise ValueError("no drawn line there: click on the line")
        pixels, distance = pixels[added], distance[added]
    elif distance.max() < 8.0:
        raise ValueError("no drawn line there: click on the line")
    core = pixels[distance >= np.quantile(distance, 0.5 if ink is not None else 0.85)]
    return [round(float(v), 1) for v in np.median(core, axis=0)]


def _scan(runs_dir: Path) -> list[dict]:
    """Every sheet's session, list and looks; a file is read again only when it changed."""
    found = []
    with _SCAN_LOCK:
        for path in sorted(Path(runs_dir).glob("*/result.json")):
            try:
                stat = path.stat()
            except OSError:
                continue
            stamp = (stat.st_mtime_ns, stat.st_size)
            cached = _SCAN.get(str(path))
            if cached is None or cached[0] != stamp:
                try:
                    result = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                cached = (stamp, {"runId": result.get("runId"), "session": result.get("session", "default"),
                                  "legend": result.get("legend"), "looks": result.get("looks") or []})
                _SCAN[str(path)] = cached
            found.append(cached[1])
    return found


def _stored_palette(directory: Path | None) -> dict:
    path = Path(directory) / "palette.json" if directory else None
    if path is None or not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


class Workshop:
    """The names of one session's sheets (all sheets in a runs folder share it), with their pooled looks."""

    def __init__(self, legend: dict, runs_dir: Path, session: str = "default", sessions_dir: Path | None = None):
        self.legend = legend
        self.session = session
        stored = _stored_palette(Path(sessions_dir) / session if sessions_dir else None)
        sheets = [s for s in _scan(runs_dir) if s["session"] == session]
        self.colours = self._names(legend["stickers"]["colours"], stored.get("stickers"), sheets, "sticker", "colours")
        self.pens = self._names(legend["pens"], stored.get("pens"), sheets, "pen", "pens")
        types = [(c["shape"], c["colour"]) for c in legend["stickers"]["classes"]]
        pens = [p["id"] for p in legend["pens"]]
        for sheet in sheets:
            own = sheet.get("legend") or {}
            types += [(t["shape"], t["colour"]) for t in own.get("stickers", [])]
            pens += list(own.get("pens", []))
        self.types = list(dict.fromkeys(t for t in types if t[1] in self.colours))
        self.pen_ids = list(dict.fromkeys(p for p in pens if p in self.pens))

    @staticmethod
    def _names(stock: list[dict], stored: list[dict] | None, sheets: list[dict], kind: str, key: str) -> dict:
        def entry(item: dict) -> dict:
            return {"id": item["id"], "label": item.get("label") or item["id"],
                    "display": item.get("display") or "#888888", "examples": []}

        names = {}
        for item in stock:
            names[item["id"]] = {**entry(item), "examples": [list(map(float, e)) for e in item.get("examples", [])]}
        for item in stored or []:
            known = names.setdefault(item["id"], entry(item))["examples"]
            known += [e for e in item.get("examples", []) if e not in known]
        for sheet in sheets:
            for name_key, item in (((sheet.get("legend") or {}).get("names") or {}).get(key) or {}).items():
                names.setdefault(name_key, entry({**item, "id": name_key}))
        # a name made with the eyedropper is drawn in the colour of its first click
        for look in sorted((look for sheet in sheets for look in sheet["looks"] if look.get("kind") == kind),
                           key=lambda look: look.get("at", "")):
            names.setdefault(look["name"], entry({"id": look["name"], "label": look.get("label"),
                                                  "display": look.get("display")}))["examples"].append(look["lab"])
        return names

    # ---------------------------------------------------------------- lists
    def with_names(self, stickers: list[dict], pens: list[str], own: dict | None = None) -> dict:
        """A photo's list, carrying the label and colour of each name it uses."""
        own = own or {}
        colours, pen_names = {}, {}
        for item in stickers:
            known = self.colours.get(item["colour"]) or (own.get("colours") or {}).get(item["colour"]) or {}
            colours[item["colour"]] = {"label": known.get("label", item["colour"]), "display": known.get("display", "#888888")}
        for pen in pens:
            known = self.pens.get(pen) or (own.get("pens") or {}).get(pen) or {}
            pen_names[pen] = {"label": known.get("label", pen), "display": known.get("display", "#888888")}
        return {"stickers": [{"shape": s["shape"], "colour": s["colour"]} for s in stickers], "pens": list(pens),
                "names": {"colours": colours, "pens": pen_names}}

    def default_list(self) -> dict:
        """What a new photo starts with: every sticker and pen the workshop knows."""
        return self.with_names([{"shape": s, "colour": c} for s, c in self.types], self.pen_ids)

    def photo_list(self, result: dict) -> dict:
        """The photo's own list; a sheet digitised before lists existed has the stock legend's."""
        own = result.get("legend")
        if own:
            return own
        legend = self.legend
        return self.with_names([{"shape": c["shape"], "colour": c["colour"]} for c in legend["stickers"]["classes"]],
                               [p["id"] for p in legend["pens"]])

    # ---------------------------------------------------------------- legends
    def photo_legend(self, result: dict) -> dict:
        """The legend digitizing uses on this photo: its stickers and pens, each with every look of its name."""
        own = self.photo_list(result)
        names = own.get("names") or {}
        types = [t for t in own["stickers"] if t["shape"] in SHAPES]
        sizes = self.legend["stickers"]["sizesMm"]

        def named(registry: dict, key: str, ids: list[str]) -> list[dict]:
            out = []
            for item_id in dict.fromkeys(ids):
                known = registry.get(item_id) or {"id": item_id, "examples": [],
                                                  **(names.get(key) or {}).get(item_id, {})}
                out.append({"id": item_id, "label": known.get("label", item_id),
                            "display": known.get("display", "#888888"), "examples": list(known.get("examples", []))})
            return out

        return {**self.legend,
                "stickers": {**self.legend["stickers"],
                             "sizesMm": {shape: sizes[shape] for shape in SHAPES if any(t["shape"] == shape for t in types)},
                             "colours": named(self.colours, "colours", [t["colour"] for t in types]),
                             "classes": [{"shape": t["shape"], "colour": t["colour"]} for t in types]},
                "pens": named(self.pens, "pens", own["pens"])}

    def export_legend(self, result: dict) -> dict:
        """Every name's label and colour (the GeoJSON's ``colorLabel`` and ``color``)."""
        own = (self.photo_list(result).get("names") or {})
        colours = {**{k: {"id": k, **v} for k, v in (own.get("colours") or {}).items()}, **self.colours}
        pens = {**{k: {"id": k, **v} for k, v in (own.get("pens") or {}).items()}, **self.pens}
        return {**self.legend, "stickers": {**self.legend["stickers"], "colours": list(colours.values())},
                "pens": list(pens.values())}

    def summary(self) -> dict:
        """For the page: the shapes, and every colour and pen name with how many looks it has."""
        def names(registry: dict) -> list[dict]:
            return [{"id": k, "label": v["label"], "display": v["display"], "looks": len(v["examples"])}
                    for k, v in registry.items()]
        return {"shapes": {s: mm for s, mm in self.legend["stickers"]["sizesMm"].items() if s in SHAPES},
                "colours": names(self.colours), "pens": names(self.pens)}
