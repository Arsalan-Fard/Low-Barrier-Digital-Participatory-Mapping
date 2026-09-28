"""One sheet, end to end: photo in, reviewed-ready result out.

    map photo ──► register (tags) ──► rectify map + panel ──► colour-fit + diff
                                                        │
          stickers (shape only) ◄──────────────────────┤
          colours ◄── session palette (+ your corrections)
          routes (ink graph) ◄─────────────────────────┘
          VLM: questionnaire panel, doubtful stickers
                                                        │
                                   runs/<id>/result.json, result.geojson, images

Everything a reviewer changes later is applied to ``result.json`` by
``review.py`` without re-running the vision steps.
"""
from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from .palette import SessionPalette
from .photometric import analyse_map
from .register import choose_map_width, rectify_map, rectify_panel, register_page
from .sheet import MapSheet, load_sheet
from .stickers import detect_stickers
from .strokes import extract_routes

PACKAGE_DIR = Path(__file__).resolve().parent
DEFAULT_LEGEND = PACKAGE_DIR / "legend.json"
DEFAULT_RUNS = PACKAGE_DIR / "runs"
DEFAULT_SESSIONS = PACKAGE_DIR / "sessions"


@dataclass
class Options:
    map_id: str
    map_photo: Path
    legend_path: Path = DEFAULT_LEGEND
    session: str = "default"
    sessions_dir: Path = DEFAULT_SESSIONS
    runs_dir: Path = DEFAULT_RUNS
    sheets_dir: Path | None = None
    use_vlm: bool = True
    verify_stickers: bool = True
    vlm_backend: str = "transformers"
    vlm_model: str | None = None
    vlm_url: str | None = None
    vlm_quant: str = "4bit"
    map_width: int | None = None
    sheet_number: int | None = None     # the participant's sheet within its map: 1, 2, ...
    run_id: str | None = None
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


def category_label(legend: dict, category: str | None) -> str | None:
    """The review page's name for a category ("Home"), not the French printed on the sheet."""
    for item in legend["stickers"]["classes"]:
        if item["category"] == category:
            return item["label"]
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


def not_stickers(stickers: list, legend: dict, session, gate) -> dict[int, str]:
    """Fits that are not stickers, with why: pen ink beside a sticker, a star whose
    measured colour cannot be gold, a second star lying on a better one."""
    fixed = fixed_colours(legend)
    colours = session.stickers.without(reserved_colours(legend))
    why: dict[int, str] = {}
    for sticker in stickers:
        weak = sticker.occluded > 0.35 or sticker.fill < 0.5
        chroma = math.hypot(sticker.lab[1] - 128.0, sticker.lab[2] - 128.0)
        if weak and sticker.shape not in fixed and chroma >= 12.0:
            to_sticker = min(colours.distances_to(sticker.lab).values(), default=math.inf)
            to_pen = min(session.pens.distances_to(sticker.lab).values(), default=math.inf)
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


def classify_stickers(stickers: list, palette, legend: dict, clamp: dict[int, str] | None = None) -> dict:
    """Colours from the session palette, then the legend's category for (shape, colour).

    A shape that comes in one colour only takes that colour (a star is gold);
    the others are measured against every colour except those reserved for
    such a shape.
    """
    fixed, reserved = fixed_colours(legend), reserved_colours(legend)
    measured = [s for s in stickers if s.shape not in fixed]
    index_of = {s.id: i for i, s in enumerate(measured)}
    clamp_by_index = {index_of[sid]: colour for sid, colour in (clamp or {}).items()
                      if sid in index_of and colour not in reserved}
    assignments, info = palette.without(reserved).classify([s.lab for s in measured], clamp_by_index)
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
            sticker.flags += [f for f in assignment.flags if f != "human"]
            if "human" in assignment.flags:
                sticker.source = "human"
        entry = legend_class(legend, sticker.shape, sticker.colour)
        sticker.category = entry["category"] if entry else None
        sticker.label = entry["label"] if entry else None
        if entry is None:
            sticker.flags.append("no-legend-class")
    return info


def _haversine_m(a: list[float], b: list[float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


def to_geojson(result: dict, sheet: MapSheet, legend: dict) -> dict:
    """Stickers and routes as GeoJSON (the property names the old Digitize panel exported).

    Private questionnaire fields (the name) are never exported.
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
            "kind": "sticker", "id": s["id"], "shape": s["shape"],
            "color": colour.get("display"), "colorClass": s.get("colour"), "colorLabel": colour.get("label"),
            "category": s.get("category"),
            "categoryLabel": category_label(legend, s.get("category")) or s.get("label"),
            "confidence": s.get("colour_confidence"), "flags": s.get("flags", []), "source": s.get("source", "auto"),
        }, "geometry": {"type": "Point", "coordinates": sheet.pixel_to_lnglat(s["x"], s["y"], width, height)}})
    for r in result["routes"]:
        if r.get("deleted") or r.get("kind") != "route":
            continue
        coords = [sheet.pixel_to_lnglat(x, y, width, height) for x, y in r["points"]]
        length = sum(_haversine_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1))
        pen = pens.get(r.get("pen") or "", {})
        features.append({"type": "Feature", "properties": {
            "kind": "line", "id": r["id"], "color": pen.get("display"), "colorClass": r.get("pen"),
            "colorLabel": pen.get("label"), "mode": pen.get("mode"), "modeLabel": pen.get("modeLabel"),
            "lengthM": round(length, 1), "flags": r.get("flags", []), "source": r.get("source", "auto"),
        }, "geometry": {"type": "LineString", "coordinates": coords}})
    # only fields the legend still asks for, and never a private one
    exported = {f["id"] for f in (legend.get("questionnaire") or {}).get("fields", []) if not f.get("private")}
    answers = {k: v for k, v in ((result.get("questionnaire") or {}).get("fields") or {}).items() if k in exported}
    return {"type": "FeatureCollection", "features": features, "properties": {
        "mapId": result["mapId"], "runId": result["runId"], "questionnaire": answers,
    }}


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


def run(options: Options, vlm=None) -> Path:
    """Digitise one sheet. Pass ``vlm`` to share one loaded model across a batch."""
    started = time.time()
    timings: dict[str, float] = {}

    def tick(name: str, since: float) -> float:
        now = time.time()
        timings[name] = round(now - since, 2)
        options.log.append(f"{name}: {timings[name]} s")
        return now

    legend = load_legend(options.legend_path)
    session = SessionPalette(legend, Path(options.sessions_dir) / options.session)
    if options.run_id:
        run_id = options.run_id
    elif options.sheet_number is not None:
        run_id = sheet_run_id(options.map_id, options.sheet_number)
    else:
        run_id = f"{time.strftime('%Y%m%d-%H%M%S')}-map{options.map_id}"
    out = Path(options.runs_dir) / run_id
    out.mkdir(parents=True, exist_ok=True)

    t = time.time()
    sheet = load_sheet(options.map_id, options.sheets_dir)
    photo = cv2.imread(str(options.map_photo), cv2.IMREAD_COLOR)
    if photo is None:
        raise FileNotFoundError(options.map_photo)
    registration = register_page(photo, sheet)
    width = choose_map_width(sheet, registration, options.map_width)
    px_per_mm = width / sheet.map_width_mm
    rectified, coverage = rectify_map(photo, sheet, registration, width)
    panel = rectify_panel(photo, sheet, registration, px_per_mm=min(10.0, registration.photo_px_per_mm))
    t = tick("register", t)
    images = analyse_map(rectified, sheet.reference, sheet.mask_rects, px_per_mm, coverage=coverage)
    t = tick("photometry", t)

    sizes = legend["stickers"]["sizesMm"]
    gate = shape_gate(legend, session.stickers)
    stickers, cover = detect_stickers(images.corrected, images.score, images.valid, px_per_mm, sizes,
                                      covered=images.covered, shape_gate=gate)
    stickers, dropped = drop_fits(stickers, cover, not_stickers(stickers, legend, session, gate))
    colour_info = classify_stickers(stickers, session.stickers, legend)
    t = tick("stickers", t)
    routes, ink, route_info = extract_routes(images, cover, session.pens, px_per_mm, sizes["circle"] * px_per_mm)
    t = tick("routes", t)

    questionnaire, vlm_stats = None, None
    if not options.use_vlm and panel is not None:
        from .checkboxes import read_checkboxes
        questionnaire = read_checkboxes(panel, legend) or None   # the ticks, from pixels alone
    if options.use_vlm:
        from .reading import read_questionnaire, verify_stickers
        from .vlm import DEFAULT_MODEL, VLM
        shared = vlm is not None
        if not shared:
            vlm = VLM(model_id=options.vlm_model or DEFAULT_MODEL, backend=options.vlm_backend,
                      base_url=options.vlm_url, quant=options.vlm_quant,
                      cache_path=Path(options.runs_dir) / "vlm_cache.jsonl")
        stats_before = dict(vlm.stats)
        if panel is not None:
            questionnaire = read_questionnaire(vlm, panel, legend)
            t = tick("vlm-questionnaire", t)
        if options.verify_stickers:
            verify_stickers(vlm, images.corrected, stickers, session.stickers, fixed_colours(legend))
            t = tick("vlm-stickers", t)
        vlm_stats = {k: round(vlm.stats[k] - stats_before.get(k, 0), 2) for k in vlm.stats}
        vlm_stats.update(model=vlm.model_id, backend=vlm.backend)
        if not shared:
            vlm.unload()

    height = images.corrected.shape[0]
    result = {
        "runId": run_id, "mapId": sheet.id, "session": options.session,
        "sheet": {"map": sheet.id, "number": options.sheet_number,
                  "label": sheet_label(sheet.id, options.sheet_number)},
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "inputs": {"mapPhoto": str(options.map_photo)},
        "registration": registration.to_dict(),
        "map": {"width": width, "height": height, "pxPerMm": round(px_per_mm, 3),
                "groundMetresPerPx": round(sheet.ground_width_m() / width, 4),
                "corners": sheet.lnglat_corners, "alignment": images.info},
        "stickers": [s.to_dict() for s in stickers],
        "droppedFits": dropped,
        "colourAdaptation": colour_info,
        "routes": [r.to_dict() for r in routes],
        "routeInfo": route_info,
        "questionnaire": questionnaire,
        "vlm": vlm_stats,
        "timings": timings,
        "review": {"status": "pending", "corrections": 0},
    }
    result["seconds"] = round(time.time() - started, 1)
    cv2.imwrite(str(out / "map.jpg"), images.corrected, [cv2.IMWRITE_JPEG_QUALITY, 94])
    cv2.imwrite(str(out / "overlay.jpg"), render_overlay(images.corrected, result, legend), [cv2.IMWRITE_JPEG_QUALITY, 88])
    cv2.imwrite(str(out / "ink.png"), (ink.astype(np.uint8) * 255))
    if panel is not None:
        cv2.imwrite(str(out / "panel.jpg"), panel, [cv2.IMWRITE_JPEG_QUALITY, 92])
    write_result(out, result, sheet, legend)
    return out


def write_result(out: Path, result: dict, sheet: MapSheet, legend: dict) -> None:
    (out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "result.geojson").write_text(json.dumps(to_geojson(result, sheet, legend), ensure_ascii=False),
                                        encoding="utf-8")
