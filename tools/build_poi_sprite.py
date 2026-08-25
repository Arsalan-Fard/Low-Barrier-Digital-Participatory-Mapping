#!/usr/bin/env python3
"""Build a MapLibre sprite sheet of Google-Maps-style POI markers.

Why a font rather than SVGs: Material Symbols ships as a variable font, so
Pillow can render each glyph natively with correct curves. Rasterising the SVGs
instead would need cairo, which has no usable wheel on Windows -- both cairosvg
and svglib's renderPM backend fail to load libcairo here.

Icons are Material Symbols (Apache 2.0), Google's own set, so the look matches
Google Maps and the licence permits commercial use -- no research exemption
needed.

Each marker is drawn the way Google draws them: a solid colour disc, a white
ring so it separates from the map beneath, and a white glyph filling most of
the disc. Output is `<out>.png` + `<out>.json` in MapLibre sprite format.

    python tools/build_poi_sprite.py --out web/sprites/curated
"""
from __future__ import annotations

import argparse
import io
import json
import math
import pathlib
import sys

import requests
from PIL import Image, ImageDraw, ImageFont

FONT_BASE = ("https://raw.githubusercontent.com/google/material-design-icons"
             "/master/variablefont/")
FONT_STEM = "MaterialSymbolsRounded%5BFILL%2CGRAD%2Copsz%2Cwght%5D"

# Category colours, shared by the curated layer's legend and the basemap POIs
# so the two never disagree about what "a park" looks like.
CAT = {
    "food":      "#f9ab00",
    "shops":     "#5c6bc0",
    "parks":     "#1e8e3e",
    "education": "#e8710a",
    "health":    "#d93025",
    "culture":   "#9334e6",
    "civic":     "#546e7a",
    "transport": "#1a73e8",
    "street":    "#80868b",
}

# Marker id -> (Material Symbols glyph, disc colour).
#
# The ids in the first block are the curated layer's own groups. Everything
# after is keyed by OpenMapTiles POI *class*, so the basemap POI layers can
# resolve `curated:<class>` straight from the feature. Classes with no entry
# fall back to OpenFreeMap's sprite, so this table can grow gradually.
MARKERS = {
    # --- curated layer groups ---------------------------------------------
    "park":      ("park",            CAT["parks"]),
    "culture":   ("theater_comedy",  CAT["culture"]),
    "sport":     ("sports_soccer",   CAT["transport"]),
    "library":   ("local_library",   "#00897b"),
    "school":    ("school",          CAT["education"]),
    "youth":     ("groups",          "#d01884"),
    "shop":      ("storefront",      CAT["shops"]),
    "civic":     ("location_city",   CAT["civic"]),
    "food":      ("restaurant",      CAT["food"]),
    # The workshop's own school, deliberately distinct from the other schools.
    "home":      ("star",            "#d93025"),

    # --- food ---------------------------------------------------------------
    "restaurant":     ("restaurant",        CAT["food"]),
    "cafe":           ("local_cafe",        CAT["food"]),
    "fast_food":      ("lunch_dining",      CAT["food"]),
    "bar":            ("local_bar",         CAT["food"]),
    "beer":           ("sports_bar",        CAT["food"]),
    "pub":            ("sports_bar",        CAT["food"]),
    "ice_cream":      ("icecream",          CAT["food"]),

    # --- shops --------------------------------------------------------------
    "grocery":        ("local_grocery_store", CAT["shops"]),
    "bakery":         ("bakery_dining",     CAT["shops"]),
    "butcher":        ("kebab_dining",      CAT["shops"]),
    "clothing_store": ("checkroom",         CAT["shops"]),
    "alcohol_shop":   ("liquor",            CAT["shops"]),
    "hairdresser":    ("content_cut",       CAT["shops"]),
    "laundry":        ("local_laundry_service", CAT["shops"]),
    "florist":        ("local_florist",     CAT["shops"]),
    "jewelry":        ("diamond",           CAT["shops"]),
    "books":          ("menu_book",         CAT["shops"]),
    "marketplace":    ("storefront",        CAT["shops"]),

    # --- parks --------------------------------------------------------------
    "garden":         ("yard",              CAT["parks"]),
    "playground":     ("attractions",       CAT["parks"]),
    "dog_park":       ("pets",              CAT["parks"]),
    "picnic_site":    ("outdoor_grill",     CAT["parks"]),
    "nature_reserve": ("forest",            CAT["parks"]),

    # --- education ----------------------------------------------------------
    "college":        ("school",            CAT["education"]),
    "university":     ("account_balance",   CAT["education"]),
    "kindergarten":   ("child_care",        CAT["education"]),

    # --- health -------------------------------------------------------------
    "pharmacy":       ("local_pharmacy",    CAT["health"]),
    "doctors":        ("stethoscope",       CAT["health"]),
    "dentist":        ("dentistry",         CAT["health"]),
    # 800 weight: the default stroke makes "add" a hairline cross on a disc.
    "hospital":       ("add",               CAT["health"], 800),
    "veterinary":     ("pets",              CAT["health"]),
    "clinic":         ("medical_services",  CAT["health"]),

    # --- culture ------------------------------------------------------------
    "art_gallery":    ("palette",           CAT["culture"]),
    "theatre":        ("theater_comedy",    CAT["culture"]),
    "museum":         ("museum",            CAT["culture"]),
    "cinema":         ("movie",             CAT["culture"]),
    "attraction":     ("photo_camera",      CAT["culture"]),
    "castle":         ("castle",            CAT["culture"]),
    "pitch":          ("sports_soccer",     CAT["transport"]),
    "sports_centre":  ("fitness_center",    CAT["transport"]),
    "swimming_pool":  ("pool",              CAT["transport"]),
    "stadium":        ("stadium",           CAT["transport"]),
    "zoo":            ("pets",              CAT["culture"]),

    # --- civic --------------------------------------------------------------
    "town_hall":        ("account_balance", CAT["civic"]),
    "post":             ("local_post_office", CAT["civic"]),
    "bank":             ("account_balance_wallet", CAT["civic"]),
    "atm":              ("local_atm",       CAT["civic"]),
    "police":           ("local_police",    CAT["civic"]),
    "fire_station":     ("local_fire_department", CAT["health"]),
    "place_of_worship": ("church",          CAT["civic"]),
    "office":           ("business_center", CAT["civic"]),
    "lodging":          ("hotel",           CAT["civic"]),
    "embassy":          ("flag",            CAT["civic"]),
    "courthouse":       ("gavel",           CAT["civic"]),
    "community_centre": ("groups",          CAT["civic"]),

    # --- transport ----------------------------------------------------------
    "bus":              ("directions_bus",  CAT["transport"]),
    "rail":             ("train",           CAT["transport"]),
    "railway":          ("train",           CAT["transport"]),
    "subway":           ("subway",          CAT["transport"]),
    "tram":             ("tram",            CAT["transport"]),
    "ferry_terminal":   ("directions_boat", CAT["transport"]),
    "airport":          ("flight",          CAT["transport"]),
    "bicycle_rental":   ("pedal_bike",      CAT["transport"]),
    "car_rental":       ("car_rental",      CAT["transport"]),
    "parking":          ("local_parking",   CAT["transport"]),
    "fuel":             ("local_gas_station", CAT["transport"]),
    "charging_station": ("ev_station",      CAT["transport"]),
    "harbor":           ("anchor",          CAT["transport"]),
    "car":              ("directions_car",  CAT["transport"]),

    # --- street furniture ---------------------------------------------------
    "bicycle_parking":  ("pedal_bike",      CAT["street"]),
    "motorcycle_parking": ("two_wheeler",   CAT["street"]),
    "recycling":        ("recycling",       CAT["street"]),
    "drinking_water":   ("water_drop",      CAT["street"]),
    "bench":            ("chair",           CAT["street"]),
    "toilets":          ("wc",              CAT["street"]),
    "shelter":          ("home",            CAT["street"]),
    "waste_basket":     ("delete",          CAT["street"]),
    "information":      ("info",            CAT["street"]),
    "entrance":         ("door_front",      CAT["street"]),
}

# Drawn at PIXEL_RATIO times the nominal size so the sheet stays crisp when the
# print render scales icons up; MapLibre divides by pixelRatio from the JSON.
NOMINAL = 28
PIXEL_RATIO = 4
RING = 0.085          # white ring width, as a fraction of the marker
GLYPH = 0.60          # glyph height, as a fraction of the marker
LETTER = 0.52         # cap height for letter markers, as a fraction

# Markers whose content is a letter, not an icon. The Paris metro is an "M", and
# `paper-metro-marker` is the id the transit layers already ask for -- providing
# it here replaces the old white square with no style change at all.
TEXT_MARKERS = {
    "paper-metro-marker": ("M",   CAT["transport"]),
    "metro":              ("M",   CAT["transport"]),
    "tramway":            ("T",   CAT["transport"]),
    "rer":                ("RER", CAT["transport"]),
}

# Roboto is vendored with Maputnik (Apache 2.0), so letter markers need no
# extra download and match the app's own typography.
ROBOTO_GLOBS = [
    "map-style-editor/maputnik/dist/assets/Roboto-Medium-*.ttf",
    "map-style-editor/maputnik/dist/assets/Roboto-Regular-*.ttf",
]


def cache_dir() -> pathlib.Path:
    d = pathlib.Path(__file__).parent / ".poi_cache"
    d.mkdir(exist_ok=True)
    return d


def load_font_and_codepoints():
    """Fetch once, then reuse: the variable font is ~15 MB."""
    cache = cache_dir()
    ttf, cps = cache / "MaterialSymbolsRounded.ttf", cache / "MaterialSymbols.codepoints"
    if not ttf.exists():
        print("  downloading Material Symbols font (~15 MB) ...", file=sys.stderr)
        ttf.write_bytes(requests.get(FONT_BASE + FONT_STEM + ".ttf", timeout=180).content)
    if not cps.exists():
        cps.write_bytes(requests.get(FONT_BASE + FONT_STEM + ".codepoints",
                                     timeout=120).content)
    table = {}
    for line in cps.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        name, code = line.split()
        table[name] = int(code, 16)
    return ttf, table


def glyph_image(ttf: pathlib.Path, codepoint: int, px: int,
                weight: int = 500) -> Image.Image:
    """A white glyph on transparency, trimmed to its ink and scaled to `px`."""
    font = ImageFont.truetype(str(ttf), px)
    try:
        # Fill=1 gives the solid form Google Maps uses; the outline form reads
        # as hollow and thin once it is shrunk onto a disc.
        font.set_variation_by_axes([1, 0, 48, weight])
    except Exception:
        pass                                    # static build: already filled
    pad = px // 2
    canvas = Image.new("RGBA", (px + pad * 2, px + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).text((pad, pad), chr(codepoint),
                                font=font, fill=(255, 255, 255, 255))
    box = canvas.getbbox()
    return canvas.crop(box) if box else canvas


def text_font() -> pathlib.Path:
    root = pathlib.Path(__file__).parent.parent
    for pattern in ROBOTO_GLOBS:
        found = sorted(root.glob(pattern))
        if found:
            return found[0]
    for fallback in (r"C:\Windows\Fonts\arialbd.ttf", "/Library/Fonts/Arial Bold.ttf",
                     "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if pathlib.Path(fallback).exists():
            return pathlib.Path(fallback)
    raise SystemExit("no text font found for letter markers")


def letter_image(text: str, px: int) -> Image.Image:
    """White letters on transparency, trimmed to their ink."""
    font = ImageFont.truetype(str(text_font()), px)
    pad = px
    canvas = Image.new("RGBA", (px * len(text) + pad * 2, px + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).text((pad, pad), text, font=font,
                                fill=(255, 255, 255, 255))
    bbox = canvas.getbbox()
    return canvas.crop(bbox) if bbox else canvas


def disc(colour, size) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    ring = max(1, round(size * RING))
    d.ellipse([0, 0, size - 1, size - 1], fill=(255, 255, 255, 255))
    d.ellipse([ring, ring, size - 1 - ring, size - 1 - ring], fill=colour)
    return img, d


def text_marker(text: str, colour, size) -> Image.Image:
    img, _ = disc(colour, size)
    letters = letter_image(text, size)
    # Fit by height for one letter, by width once it is a word like "RER".
    target_h, target_w = size * LETTER, size * 0.66
    scale = min(target_h / letters.height, target_w / letters.width)
    letters = letters.resize(
        (max(1, round(letters.width * scale)), max(1, round(letters.height * scale))),
        Image.LANCZOS,
    )
    img.alpha_composite(letters, ((size - letters.width) // 2,
                                  (size - letters.height) // 2))
    return img


def marker(ttf, codepoint, colour, size, weight=500) -> Image.Image:
    img, d = disc(colour, size)

    glyph = glyph_image(ttf, codepoint, size, weight)
    target = size * GLYPH
    scale = min(target / glyph.width, target / glyph.height)
    glyph = glyph.resize(
        (max(1, round(glyph.width * scale)), max(1, round(glyph.height * scale))),
        Image.LANCZOS,
    )
    img.alpha_composite(glyph, ((size - glyph.width) // 2, (size - glyph.height) // 2))
    return img


def build(out_stem: pathlib.Path):
    ttf, table = load_font_and_codepoints()
    size = NOMINAL * PIXEL_RATIO
    missing = [e[0] for e in MARKERS.values() if e[0] not in table]
    if missing:
        raise SystemExit(f"glyphs not in this font: {missing}")

    images = {}
    for name, entry in MARKERS.items():
        glyph, colour = entry[0], entry[1]
        weight = entry[2] if len(entry) > 2 else 500
        images[name] = marker(ttf, table[glyph], colour, size, weight)
    images.update({name: text_marker(text, colour, size)
                   for name, (text, colour) in TEXT_MARKERS.items()})

    # A grid, not a row: ~90 markers at 112px would make a 10080px-wide sheet,
    # past MAX_TEXTURE_SIZE on 4096-limited GPUs, and the sprite would simply
    # fail to load.
    cols = math.ceil(math.sqrt(len(images)))
    rows = math.ceil(len(images) / cols)
    sheet = Image.new("RGBA", (size * cols, size * rows), (0, 0, 0, 0))
    index = {}
    for i, (name, img) in enumerate(sorted(images.items())):
        x, y = (i % cols) * size, (i // cols) * size
        sheet.paste(img, (x, y))
        index[name] = {
            "x": x, "y": y, "width": size, "height": size,
            "pixelRatio": PIXEL_RATIO, "sdf": False,
        }

    out_stem.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_stem.with_suffix(".png"))
    out_stem.with_suffix(".json").write_text(
        json.dumps(index, indent=1) + "\n", encoding="utf-8")
    # MapLibre asks for @2x on HiDPI; serve the same sheet so it never 404s.
    sheet.save(out_stem.parent / (out_stem.name + "@2x.png"))
    (out_stem.parent / (out_stem.name + "@2x.json")).write_text(
        json.dumps(index, indent=1) + "\n", encoding="utf-8")

    print(f"{out_stem.with_suffix('.png')}  {sheet.width}x{sheet.height}px, "
          f"{len(index)} markers @ {size}px (pixelRatio {PIXEL_RATIO})")
    for name in sorted(index):
        if name in MARKERS:
            print(f"   {name:20s} glyph {MARKERS[name][0]:18s} {MARKERS[name][1]}"
                  f"{'  w' + str(MARKERS[name][2]) if len(MARKERS[name]) > 2 else ''}")
        else:
            print(f"   {name:20s} text  {TEXT_MARKERS[name][0]:18s} {TEXT_MARKERS[name][1]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="web/sprites/curated",
                    help="output stem (writes .png and .json)")
    build(pathlib.Path(ap.parse_args().out))
