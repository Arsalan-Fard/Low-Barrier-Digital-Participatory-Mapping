"""One sheet, in two steps: photo in, digitised sheet out.

  prepare   map photo ──► register (tags) ──► rectify map ──► colour-fit + diff
                                                                        │ map.jpg: the page shows it
  digitize  the photo's list (which stickers, which pens) ─────────────┤
              stickers (shape only) ◄──────────────────────────────────┤
              colours ◄── every look of the listed names (workshop.py)  │
              routes (ink graph) ◄─────────────────────────────────────┘
                                                                        │
                       data/digitized_sheets/<id>/result.json, images
                       sessions/<id>.geojson: the sheet in the Results panel

The page prepares a photo, lets its list be set, then digitizes it. Everything
a reviewer changes later is applied to ``result.json`` by ``review.py`` without
re-running the vision steps, and each save rewrites the sheet's GeoJSON in the
results folder the Results panel of Run a Workshop reads.
"""
from __future__ import annotations

import json
import math
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from pathlib import Path

import cv2
import numpy as np

from backend import config
from .palette import Palettes
from .photometric import analyse_map
from .register import choose_map_width, rectify_map, register_page
from .sheet import MapSheet, load_sheet
from .stickers import detect_stickers
from .strokes import extract_routes
from .workshop import Workshop


@dataclass
class Options:
    map_id: str
    map_photo: Path
    legend_path: Path = field(default_factory=lambda: config.DIGITIZER_LEGEND_FILE)
    session: str = "default"
    sessions_dir: Path = field(default_factory=lambda: config.DIGITIZER_PALETTES_DIR)
    runs_dir: Path = field(default_factory=lambda: config.DIGITIZED_SHEETS_DIR)
    sheets_dir: Path = field(default_factory=lambda: config.MAP_SHEETS_DIR)
    sheet_number: int | None = None     # the participant's sheet within its map: 1, 2, ...
    run_id: str | None = None
    vlm: str = ""                       # the handwriting model (vlm.MODELS), or "" for none
    log: list = field(default_factory=list)


def sheet_run_id(map_id: str, number: int) -> str:
    """Run folder of a numbered sheet: map 1, sheet 5 -> "1_05" (sorts in order)."""
    return f"{map_id}_{number:02d}"


def sheet_label(map_id: str, number: int | None) -> str:
    """What people call it: map 1, sheet 5 -> "1-5"."""
    return f"{map_id}-{number}" if number is not None else str(map_id)


def load_legend(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def legend_class(legend: dict, shape: str, colour: str | None) -> dict | None:
    for item in legend["stickers"]["classes"]:
        if item["shape"] == shape and item["colour"] in ("*", colour):
            return item
    return None



def fixed_colours(legend: dict) -> dict[str, str]:
    """Shapes that come in one colour only, from the legend's classes: {"star": "gold"}.

    Their colour is never measured -- a star is gold, whatever the photo made
    of its foil (bright, khaki or nearly black).
    """
    colours_of: dict[str, set[str]] = {}
    for item in legend["stickers"]["classes"]:
        colours_of.setdefault(item["shape"], set()).add(item["colour"])
    return {shape: next(iter(colours)) for shape, colours in colours_of.items()
            if len(colours) == 1 and "*" not in colours}


def reserved_colours(legend: dict) -> dict[str, str]:
    """Colours that only one fixed-colour shape comes in: {"gold": "star"}.

    Never offered for another shape: a circle or triangle is one of the other
    colours, so gold is left out when a circle's colour is measured.
    """
    shapes_of: dict[str, set[str]] = {}
    for item in legend["stickers"]["classes"]:
        shapes_of.setdefault(item["colour"], set()).add(item["shape"])
    return {colour: shape for shape, colour in fixed_colours(legend).items() if shapes_of.get(colour) == {shape}}


# A fixed-colour shape (a star) is only fitted to a colour cluster whose hue
# could be its colour: judged on hue and saturation alone (a, b), because foil
# changes lightness most and lightness made the lighter black stickers of the
# workshop photos look "near" a dull-foil example. That colour must be the
# nearest class by hue (or within GATE_LEAD of it) and within GATE_NEAR of one of
# its examples. Measured on map 1: gold foil sits within 11 of a gold example;
# bright yellow circles 16 from yellow and 27 from gold, black circles ~5 from
# black and 24 from gold, pink and pen ink far off. (Judged on full Lab with a
# 15 lead, stars were fitted on yellow circles, pale pink and grey in a pile.)
GATE_NEAR = 25.0
GATE_LEAD = 5.0


def hue_distances(palette, lab: list[float]) -> dict[str, float]:
    """Distance in the (a, b) plane from a colour to each class's nearest example."""
    point = np.asarray(lab[1:3], np.float64)
    out = {}
    for colour in palette.classes:
        if colour.examples:
            ab = np.asarray(colour.examples, np.float64)[:, 1:3]
            out[colour.id] = float(np.sqrt(((ab - point) ** 2).sum(axis=1)).min())
    return out


def shape_gate(legend: dict, palette):
    """Which shapes a colour may be fitted with (None: any shape anywhere).

    From the legend's classes: a shape that comes in one colour only (the star:
    gold) needs that colour to be plausible; a shape some colours never come in
    (the triangle: no black one) needs one of its colours to be plausible --
    a black circle half under a yellow one showed a crescent that was fitted as
    a "black triangle". A colour far from every class could be anything, and a
    shape that comes in every other colour (the circle) is never ruled out.
    """
    fixed = {shape: colour for shape, colour in fixed_colours(legend).items() if palette.get(colour) is not None}
    reserved = set(reserved_colours(legend))
    known = {c.id for c in palette.classes}
    colours_of: dict[str, set[str]] = {}
    for item in legend["stickers"]["classes"]:
        colours_of.setdefault(item["shape"], set()).update(known if item["colour"] == "*" else {item["colour"]})
    limited = {shape: colours for shape, colours in colours_of.items()
               if shape not in fixed and not (known - reserved) <= colours}
    if not fixed and not limited:
        return None

    def allowed(lab: list[float]) -> set[str]:
        distances = hue_distances(palette, lab)
        nearest = min(distances.values(), default=math.inf)
        plausible = {c for c, d in distances.items() if d <= nearest + GATE_LEAD}
        shapes = set(legend["stickers"]["sizesMm"])
        for shape, colour in fixed.items():
            own = distances.get(colour, math.inf)
            if own > GATE_NEAR or own - nearest > GATE_LEAD:
                shapes.discard(shape)
        if nearest <= GATE_NEAR:
            for shape, colours in limited.items():
                if not plausible & colours:
                    shapes.discard(shape)
        return shapes

    return allowed


# Felt pen running into a sticker: the ink beside it is fat enough to survive
# the opening and was fitted as a mostly hidden sticker (map 1 sheets 2-4: five
# "pink triangles", red pen ink every time). A weak fit -- mostly hidden, or
# little of it filled -- whose own colour is clearly a pen's, not a sticker's,
# is ink. Measured there: the five sat 8-14 nearer a pen than any sticker stock
# and were 44-76 % hidden or 20-47 % filled; real stickers of pen-like colour
# (dark red circles) were at most 12 % hidden and 59 % filled. Near-neutral
# colours are left alone: the navy pen photographs the grey of a black sticker.
PEN_INK_MARGIN = 5.0


def not_stickers(stickers: list, legend: dict, palettes: Palettes, gate) -> dict[int, str]:
    """Fits that are not stickers, with why: pen ink beside a sticker, a star whose
    measured colour cannot be gold, a second star lying on a better one."""
    fixed = fixed_colours(legend)
    colours = palettes.stickers.without(reserved_colours(legend))
    why: dict[int, str] = {}
    for sticker in stickers:
        weak = sticker.occluded > 0.35 or sticker.fill < 0.5
        chroma = math.hypot(sticker.lab[1] - 128.0, sticker.lab[2] - 128.0)
        if weak and sticker.shape not in fixed and chroma >= 12.0:
            to_sticker = min(colours.distances_to(sticker.lab).values(), default=math.inf)
            to_pen = min(palettes.pens.distances_to(sticker.lab).values(), default=math.inf)
            if to_pen + PEN_INK_MARGIN < to_sticker:
                why[sticker.id] = "pen ink"
        elif sticker.shape in fixed and gate is not None and sticker.shape not in gate(sticker.lab):
            why[sticker.id] = f"not {fixed[sticker.shape]}"
    # Two stars at one place are one star fitted twice (from two shades of its
    # foil): the better fit stays.
    kept: list = []
    for sticker in sorted((s for s in stickers if s.shape in fixed and s.id not in why), key=lambda s: -s.shape_score):
        if any(math.hypot(sticker.x - other.x, sticker.y - other.y) < 0.4 * max(sticker.diameter_px, other.diameter_px)
               for other in kept if other.shape == sticker.shape):
            why[sticker.id] = "second fit of a star"
        else:
            kept.append(sticker)
    return why


def drop_fits(stickers: list, cover: np.ndarray, why: dict[int, str]) -> tuple[list, list]:
    """Remove the given fits; renumber the rest (and ``cover``, in place)."""
    kept, dropped = [], []
    for sticker in stickers:
        if sticker.id in why:
            cover[cover == sticker.id] = 0          # its pixels are ink for the routes again
            dropped.append({"why": why[sticker.id], "shape": sticker.shape, "x": round(sticker.x, 1),
                            "y": round(sticker.y, 1), "lab": [round(v, 1) for v in sticker.lab],
                            "occluded": round(sticker.occluded, 3), "fill": round(sticker.fill, 3)})
        else:
            kept.append(sticker)
    for new_id, sticker in enumerate(kept, start=1):   # ids ascend, so no label is overwritten
        if sticker.id != new_id:
            cover[cover == sticker.id] = new_id
            sticker.id = new_id
    return kept, dropped


def classify_stickers(stickers: list, palette, legend: dict) -> dict:
    """Each sticker's colour, from the looks of the photo's colours.

    A shape that comes in one colour only takes that colour (a star is gold);
    the others are measured against every colour except those reserved for
    such a shape. A shape x colour the photo's list does not have is flagged.
    """
    fixed, reserved = fixed_colours(legend), reserved_colours(legend)
    measured = [s for s in stickers if s.shape not in fixed]
    assignments, info = palette.without(reserved).classify([s.lab for s in measured])
    by_id = {s.id: a for s, a in zip(measured, assignments)}
    for sticker in stickers:
        sticker.flags = [f for f in sticker.flags if not f.startswith("colour-") and f != "no-legend-class"]
        if sticker.shape in fixed:
            sticker.colour, sticker.colour_confidence, sticker.colour_alternatives = fixed[sticker.shape], 1.0, []
        else:
            assignment = by_id[sticker.id]
            sticker.colour = assignment.colour
            sticker.colour_confidence = assignment.confidence
            sticker.colour_alternatives = assignment.alternatives
            sticker.flags += assignment.flags
        if legend_class(legend, sticker.shape, sticker.colour) is None:
            sticker.flags.append("no-legend-class")
    return info


def export_source(item: dict) -> str:
    """"auto" for what the detector found, "manual" for what was added or corrected by hand."""
    source = item.get("source", "auto")
    return "manual" if source == "human" else source


def to_geojson(result: dict, sheet: MapSheet, legend: dict) -> dict:
    """The sheet's marks (its stickers), routes and handwriting as GeoJSON.

    A mark keeps its shape and colour (the legend says what that pair
    means), a route its line and pen colour, a handwritten text its words at
    the middle of where they were written. A route the child labelled METRO
    gets a note: it is a metro trip, not a bike route. Beside the features:
    which sheet it is.
    """
    width, height = result["map"]["width"], result["map"]["height"]
    colours = {c["id"]: c for c in legend["stickers"]["colours"]}
    pens = {p["id"]: p for p in legend["pens"]}
    features = []
    for s in result["stickers"]:
        if s.get("deleted"):
            continue
        colour = colours.get(s.get("colour") or "", {})
        features.append({"type": "Feature", "properties": {
            "kind": "mark", "id": s["id"], "shape": s["shape"],
            "color": colour.get("display"), "colorLabel": colour.get("label"),
            "confidence": s.get("colour_confidence"), "source": export_source(s),
        }, "geometry": {"type": "Point", "coordinates": sheet.pixel_to_lnglat(s["x"], s["y"], width, height)}})
    for r in result["routes"]:
        if r.get("deleted") or r.get("kind") != "route":
            continue
        pen = pens.get(r.get("pen") or "", {})
        properties = {"kind": "line", "color": pen.get("display"), "colorLabel": pen.get("label")}
        if "labelled-metro" in r.get("flags", []):
            properties["note"] = "labelled METRO by the child: a metro trip, not a bike route"
        coords = [sheet.pixel_to_lnglat(x, y, width, height) for x, y in r["points"]]
        features.append({"type": "Feature", "properties": properties,
                         "geometry": {"type": "LineString", "coordinates": coords}})
    for text in result.get("texts") or []:
        if text.get("deleted"):
            continue
        features.append({"type": "Feature", "properties": {
            "kind": "text", "id": text["id"], "text": text["text"], "source": export_source(text),
        }, "geometry": {"type": "Point", "coordinates": sheet.pixel_to_lnglat(text["x"], text["y"], width, height)}})
    info = result.get("sheet") or {}
    return {"type": "FeatureCollection", "sheet": info.get("label") or result.get("runId"),
            "mapId": str(result.get("mapId", "")), "features": features}


def geojson_text(data: dict) -> str:
    """GeoJSON with one feature per line: still one JSON document, but readable in a text editor."""
    head = json.dumps({k: v for k, v in data.items() if k != "features"}, ensure_ascii=False)[:-1]
    features = ",\n".join(json.dumps(f, ensure_ascii=False) for f in data["features"])
    return f'{head}, "features": [\n{features}\n]}}\n'


def render_overlay(image: np.ndarray, result: dict, legend: dict) -> np.ndarray:
    colours = {c["id"]: c["display"] for c in legend["stickers"]["colours"]}
    pens = {p["id"]: p["display"] for p in legend["pens"]}

    def bgr(hex_colour: str | None) -> tuple[int, int, int]:
        value = (hex_colour or "#ff00ff").lstrip("#")
        return int(value[4:6], 16), int(value[2:4], 16), int(value[0:2], 16)

    canvas = (image.astype(np.float32) * 0.55 + 255 * 0.45).astype(np.uint8)
    thickness = max(2, image.shape[1] // 700)
    for r in result["routes"]:
        if r.get("deleted"):
            continue
        pts = np.round(np.asarray(r["points"])).astype(np.int32).reshape(-1, 1, 2)
        cv2.polylines(canvas, [pts], False, bgr(pens.get(r.get("pen"))), thickness * (2 if r["kind"] == "route" else 1),
                      cv2.LINE_AA)
    for s in result["stickers"]:
        if s.get("deleted"):
            continue
        pts = np.round(np.asarray(s["polygon"])).astype(np.int32).reshape(-1, 1, 2)
        cv2.fillPoly(canvas, [pts], bgr(colours.get(s.get("colour"))), cv2.LINE_AA)
        cv2.polylines(canvas, [pts], True, (0, 0, 0) if not s.get("flags") else (0, 0, 255), thickness, cv2.LINE_AA)
        cv2.putText(canvas, str(s["id"]), (int(s["x"]) - 14, int(s["y"]) + 10), cv2.FONT_HERSHEY_SIMPLEX,
                    0.9 * thickness / 2, (255, 255, 255), thickness, cv2.LINE_AA)
    return canvas


# ---------------------------------------------------------------- prepare, digitize

# A prepared photo's images, kept for its digitizing (the page prepares, the
# list is set, then it digitizes); without them, preparing is redone from the
# photo. Only what digitizing reads is kept, for the last few photos.
_PREPARED: "OrderedDict[str, dict]" = OrderedDict()
_PREPARED_LOCK = threading.Lock()
PREPARED_KEPT = 3


def _run_id(options: Options) -> str:
    if options.run_id:
        return options.run_id
    if options.sheet_number is not None:
        return sheet_run_id(options.map_id, options.sheet_number)
    return f"{time.strftime('%Y%m%d-%H%M%S')}-map{options.map_id}"


def _straighten(photo_path: Path, sheet: MapSheet, map_width: int | None, timings: dict) -> dict:
    """Register, rectify and colour-correct a photo: everything digitizing reads."""
    t = time.time()
    photo = cv2.imread(str(photo_path), cv2.IMREAD_COLOR)
    if photo is None:
        raise FileNotFoundError(f"cannot read the photo {photo_path}")
    registration = register_page(photo, sheet)
    width = choose_map_width(sheet, registration, map_width)
    px_per_mm = width / sheet.map_width_mm
    rectified, coverage = rectify_map(photo, sheet, registration, width)
    timings["register"] = round(time.time() - t, 2)
    t = time.time()
    images = analyse_map(rectified, sheet.reference, sheet.mask_rects, px_per_mm, coverage=coverage)
    timings["photometry"] = round(time.time() - t, 2)
    images = replace(images, observed=None, predicted=None, normalized=None)
    return {"registration": registration, "width": width, "px_per_mm": px_per_mm, "images": images}


def _keep(out: Path, data: dict) -> None:
    with _PREPARED_LOCK:
        _PREPARED[str(Path(out).resolve())] = data
        _PREPARED.move_to_end(str(Path(out).resolve()))
        while len(_PREPARED) > PREPARED_KEPT:
            _PREPARED.popitem(last=False)


def photo_of(out: Path, result: dict) -> Path:
    """The sheet's photo: where it was read from, else the copy kept in its folder."""
    recorded = Path(result["inputs"]["mapPhoto"])
    if recorded.exists():
        return recorded
    kept = sorted(Path(out).glob("photo.*"))
    if kept:
        return kept[0]
    raise FileNotFoundError(f"the photo of sheet {result['runId']} is gone ({recorded})")


def _prepared(out: Path, result: dict, sheet: MapSheet, timings: dict) -> dict:
    with _PREPARED_LOCK:
        data = _PREPARED.get(str(Path(out).resolve()))
    if data is not None:
        return data
    data = _straighten(photo_of(out, result), sheet, result["map"]["width"], timings)
    if data["images"].corrected.shape[:2] != (result["map"]["height"], result["map"]["width"]):
        raise ValueError("the photo no longer straightens to the same map size")
    return data


def prepare(options: Options) -> Path:
    """Straighten and colour-correct the photo; the sheet then waits for its list and ``digitize``."""
    started = time.time()
    stock = load_legend(options.legend_path)
    out = Path(options.runs_dir) / _run_id(options)
    out.mkdir(parents=True, exist_ok=True)
    sheet = load_sheet(options.map_id, options.sheets_dir)
    timings: dict[str, float] = {}
    data = _straighten(Path(options.map_photo), sheet, None, timings)
    images, width = data["images"], data["width"]
    workshop = Workshop(stock, options.runs_dir, options.session, options.sessions_dir)
    result = {
        "runId": out.name, "mapId": sheet.id, "session": options.session,
        "sheet": {"map": sheet.id, "number": options.sheet_number,
                  "label": sheet_label(sheet.id, options.sheet_number)},
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "inputs": {"mapPhoto": str(options.map_photo)},
        "registration": data["registration"].to_dict(),
        "map": {"width": width, "height": images.corrected.shape[0], "pxPerMm": round(data["px_per_mm"], 3),
                "groundMetresPerPx": round(sheet.ground_width_m() / width, 4),
                "corners": sheet.lnglat_corners, "alignment": images.info},
        "stage": "prepared",
        "legend": workshop.default_list(),
        "looks": [],
        "stickers": [], "routes": [],
        "timings": timings,
        "review": {"status": "pending", "corrections": 0},
        "seconds": round(time.time() - started, 1),
    }
    cv2.imwrite(str(out / "map.jpg"), images.corrected, [cv2.IMWRITE_JPEG_QUALITY, 94])
    cv2.imwrite(str(out / "score.png"), images.score)   # added ink, for the eyedropper on a drawn line
    write_result(out, result, sheet, workshop.export_legend(result))
    _keep(out, data)
    return out


def digitize(out: Path, options: Options) -> Path:
    """Find the stickers and pens on the photo's list.

    A sheet digitised again keeps what was done by hand (``carry_over``).
    """
    started = time.time()
    out = Path(out)
    result = json.loads((out / "result.json").read_text(encoding="utf-8"))
    stock = load_legend(options.legend_path)
    sheet = load_sheet(result["mapId"], options.sheets_dir)
    timings: dict[str, float] = {k: v for k, v in (result.get("timings") or {}).items()
                                 if k in ("register", "photometry")}
    data = _prepared(out, result, sheet, timings)
    images, px_per_mm = data["images"], data["px_per_mm"]
    workshop = Workshop(stock, out.parent, result.get("session", "default"), options.sessions_dir)
    legend = workshop.photo_legend(result)
    palettes = Palettes.of(legend)

    def tick(name: str, since: float) -> float:
        now = time.time()
        timings[name] = round(now - since, 2)
        options.log.append(f"{name}: {timings[name]} s")
        return now

    t = time.time()
    sizes = legend["stickers"]["sizesMm"]
    if sizes:
        gate = shape_gate(legend, palettes.stickers)
        stickers, cover = detect_stickers(images.corrected, images.score, images.valid, px_per_mm, sizes,
                                          covered=images.covered, shape_gate=gate)
        stickers, dropped = drop_fits(stickers, cover, not_stickers(stickers, legend, palettes, gate))
        colour_info = classify_stickers(stickers, palettes.stickers, legend)
    else:   # no sticker on this photo's list
        stickers, cover, dropped, colour_info = [], np.zeros(images.score.shape, np.int32), [], {}
    t = tick("stickers", t)
    if legend["pens"]:
        circle_px = stock["stickers"]["sizesMm"].get("circle", 10.0) * px_per_mm
        routes, ink, route_info = extract_routes(images, cover, palettes.pens, px_per_mm, circle_px)
    else:   # no pen on this photo's list: nothing drawn
        routes, ink, route_info = [], np.zeros(images.score.shape, bool), {"routes": 0, "marks": 0}
    t = tick("routes", t)

    again = result.get("stage") != "prepared"
    new = {
        **result,
        "stage": "digitized", "digitized": time.strftime("%Y-%m-%dT%H:%M:%S"), "listChanged": False,
        "legend": workshop.photo_list(result),
        "stickers": [s.to_dict() for s in stickers],
        "droppedFits": dropped,
        "colourAdaptation": colour_info,
        "routes": [r.to_dict() for r in routes],
        "routeInfo": route_info,
        "timings": timings,
    }
    if again:
        carry_over(result, new)
    new["seconds"] = round(time.time() - started, 1)
    names = workshop.export_legend(new)
    cv2.imwrite(str(out / "overlay.jpg"), render_overlay(images.corrected, new, names), [cv2.IMWRITE_JPEG_QUALITY, 88])
    cv2.imwrite(str(out / "ink.png"), (ink.astype(np.uint8) * 255))
    write_result(out, new, sheet, names)
    return out


# ---------------------------------------------------------------- digitizing again

def _resampled(points: list, step: float) -> np.ndarray:
    line = np.asarray(points, np.float64).reshape(-1, 2)
    if len(line) < 2:
        return line
    out = [line[0]]
    for a, b in zip(line[:-1], line[1:]):
        n = max(1, int(math.ceil(float(np.linalg.norm(b - a)) / step)))
        out.extend(a + (b - a) * (i / n) for i in range(1, n + 1))
    return np.asarray(out)


def _share_near(points: list, other: list, tolerance: float) -> float:
    """Share of a line lying within ``tolerance`` of another line."""
    samples = _resampled(points, tolerance / 2.0)
    line = np.asarray(other, np.float64).reshape(-1, 2)
    if len(samples) == 0 or len(line) == 0:
        return 0.0
    if len(line) == 1:
        near = np.linalg.norm(samples - line[0], axis=1)
    else:
        a, b = line[:-1], line[1:]
        ab = b - a
        t = np.clip((((samples[:, None, :] - a[None]) * ab[None]).sum(-1)) / np.maximum((ab * ab).sum(-1), 1e-9), 0, 1)
        near = np.linalg.norm(samples[:, None, :] - (a[None] + t[..., None] * ab[None]), axis=-1).min(axis=1)
    return float((near <= tolerance).mean())


def _same_spot(a: dict, b: dict) -> bool:
    return a["shape"] == b["shape"] and math.hypot(a["x"] - b["x"], a["y"] - b["y"]) < 0.5 * max(
        a["diameter_px"], b["diameter_px"])


def carry_over(old: dict, new: dict) -> None:
    """Digitizing again keeps the hand's work: stickers and lines placed by hand
    stay (a new find at the same place gives way to them), and what was erased
    stays erased where it is found again."""
    tolerance = 1.5 * old["map"]["pxPerMm"]
    hand_stickers = [s for s in old["stickers"] if s.get("source", "auto") != "auto"]
    hand_routes = [r for r in old["routes"] if r.get("source", "auto") != "auto"]
    erased_stickers = [s for s in old["stickers"] if s.get("source", "auto") == "auto" and s.get("deleted")]
    erased_routes = [r for r in old["routes"] if r.get("source", "auto") == "auto" and r.get("deleted")]
    placed = [s for s in hand_stickers if not s.get("deleted")]
    drawn = [r for r in hand_routes if not r.get("deleted")]
    stickers = [s for s in new["stickers"] if not any(_same_spot(s, h) for h in placed)]
    for sticker in stickers:
        if any(_same_spot(sticker, e) for e in erased_stickers):
            sticker["deleted"] = True
    routes = [r for r in new["routes"] if not any(_share_near(r["points"], h["points"], tolerance) >= 0.6
                                                    for h in drawn)]
    for route in routes:
        if any(_share_near(route["points"], e["points"], tolerance) >= 0.6
               and _share_near(e["points"], route["points"], tolerance) >= 0.6 for e in erased_routes):
            route["deleted"] = True
    for number, item in enumerate(hand_stickers, start=len(stickers) + 1):
        item["id"] = number
    for number, item in enumerate(hand_routes, start=len(routes) + 1):
        item["id"] = number
    new["stickers"] = stickers + hand_stickers
    new["routes"] = routes + hand_routes


# ---------------------------------------------------------------- handwriting

def _box_overlap(a: list, b: list) -> float:
    """Intersection over the smaller box's area."""
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return w * h / smaller if w > 0 and h > 0 and smaller > 0 else 0.0


def merge_texts(old: list, found: list) -> list:
    """A new reading of the handwriting, with the hand's work kept: texts typed or fixed by hand stay
    (a find in the same place gives way to them), and a text erased by hand stays erased where it
    is found again."""
    hand = [dict(t) for t in old if t.get("source") == "human"]
    erased = [t for t in old if t.get("source") != "human" and t.get("deleted")]
    texts = []
    for item in found:
        if any(_box_overlap(item["box"], h["box"]) >= 0.5 for h in hand if not h.get("deleted")):
            continue
        text = {**item, "source": "vlm"}
        if any(_box_overlap(item["box"], e["box"]) >= 0.5 for e in erased):
            text["deleted"] = True
        texts.append(text)
    merged = texts + hand
    for number, text in enumerate(merged, start=1):
        text["id"] = number
    return merged


def _added_ink(out: Path, result: dict, sheet: MapSheet) -> np.ndarray | None:
    """The sheet's added-ink strength (score.png): kept when it was prepared, else measured again from
    its photo (~15 s) and kept; None when the photo is gone."""
    path = out / "score.png"
    score = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if score is not None and score.shape == (result["map"]["height"], result["map"]["width"]):
        return score
    try:
        data = _prepared(out, result, sheet, {})
    except (FileNotFoundError, ValueError):
        return None
    cv2.imwrite(str(path), data["images"].score)
    return data["images"].score


def read_texts(out: Path, options: Options, vlm=None) -> Path:
    """Read the handwriting on a digitised sheet with ``options.vlm`` and place it on the map
    (``texts``); pass ``vlm`` to share one loaded model across sheets."""
    from .handwriting import read_handwriting
    from .vlm import MODELS, VLM

    started = time.time()
    out = Path(out)
    result = json.loads((out / "result.json").read_text(encoding="utf-8"))
    image = cv2.imread(str(out / "map.jpg"), cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(f"sheet {result['runId']} has no map image")
    sheet = load_sheet(result["mapId"], options.sheets_dir)
    added = _added_ink(out, result, sheet)
    vlm = vlm or VLM(options.vlm, cache_path=out.parent / "vlm_cache.jsonl")
    found = read_handwriting(vlm, image, added, options.log)
    result["texts"] = merge_texts(result.get("texts") or [], found)
    result["handwriting"] = {"model": MODELS[options.vlm]["label"], "read": time.strftime("%Y-%m-%dT%H:%M:%S"),
                             "seconds": round(time.time() - started, 1), "printRemoved": added is not None}
    workshop = Workshop(load_legend(options.legend_path), out.parent, result.get("session", "default"),
                        options.sessions_dir)
    write_result(out, result, sheet, workshop.export_legend(result))
    return out


def results_geojson_path(result: dict) -> Path:
    """Where a sheet's GeoJSON is kept: the results folder the Results panel shows, shared with the
    workshop's own results (sessions/1_05.geojson for map 1, sheet 5)."""
    return Path(config.SESSIONS_DIR) / f"{result['runId']}.geojson"


def write_result(out: Path, result: dict, sheet: MapSheet, legend: dict) -> None:
    """The sheet's record, and once digitised (a prepared photo has nothing to show yet) its GeoJSON
    in the results folder."""
    (out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    if result.get("stage") == "prepared":
        return
    path = results_geojson_path(result)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(geojson_text(to_geojson(result, sheet, legend)), encoding="utf-8")
