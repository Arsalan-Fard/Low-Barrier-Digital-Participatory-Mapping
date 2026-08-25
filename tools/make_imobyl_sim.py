#!/usr/bin/env python3
"""Synthesise an IMOBYL workshop session so the aggregate view can be judged
before a single sheet is printed.

What it fakes, and why it is shaped this way:

  One reference, not sixty.  A session stores one entry per printed sheet, and
  the page gives each entry its own *animated* canvas source pinned to the
  sheet corners.  Sixty of those means sixty 1000x707 textures re-uploaded
  every frame, which is unusable.  Every legend, count and heatmap in the page
  sums across references anyway, so pooling all sixty participants onto one
  sheet produces exactly the same aggregate picture at the cost of one canvas.
  Each mark still carries `participant`, so provenance survives in the file.

  Marks cannot leave the paper.  Participants draw on a printed sheet, so its
  extent is a hard bound: there is no such thing as a sticker 2 km out in a
  direction where the paper stops at 1.2 km.  A draw that lands off the sheet
  keeps its bearing and is pulled back to the furthest point that still fits,
  so the far ring stays populated and simply piles up against the north and
  south edges -- which is what a real far-living cohort does on this frame.
  The distances actually achieved are printed as a histogram, not assumed.

  Routes are geometric, not routed.  There is no local street network to snap
  to, so each trip is a bent curve between two real endpoints with pen wobble
  on top.  At sheet scale that reads like a felt-tip line, but no single stroke
  can claim to follow a legal route.  The aggregate corridors -- the thing this
  file exists to show -- come from the endpoint distribution, which is real.

Sticker colours stand for the workshop's questions.  The file itself only
stores colour names, so the mapping in CATEGORIES is an assumption; change it
to match the questions actually asked.
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import random
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHEETS_DIR = ROOT / "data" / "map_sheets"
SESSIONS_DIR = ROOT / "data" / "imobyl_sessions"
CURATED = ROOT / "data" / "custom_layers" / "poi-jean-baptiste-clement.geojson"

# The page's hidden ink canvas; every manual x/y lives in this pixel space.
INK_W, INK_H = 1000, 707

# web/imobyl.html MANUAL_STICKER_COLORS / MANUAL_PATH_COLORS.
STICKER_COLORS = {
    "yellow": ("Yellow", "#f7ea55"),
    "green": ("Green", "#5ba24f"),
    "orange": ("Orange", "#f59a4a"),
    "cyan": ("Cyan", "#4acfff"),
    "pink": ("Pink", "#f05c8c"),
}
PATH_COLORS = {"black": ("Black", "#252525"), "red": ("Red", "#eb6f73")}

# The workshop asks ten questions: every colour/shape pair is one of them, and
# every participant answers all ten with one or two stickers.  Colour carries
# the theme, shape splits it into the place itself (circle) and the thing on
# the way to it or around it (triangle).  Placement per question is resolved in
# place_sticker(); the file itself stores only colour and shape, so this table
# is the assumption to edit when the real questions differ.
STICKER_QUESTIONS = [
    ("cyan", "circle", "home"),             # where I live
    ("cyan", "triangle", "stop"),           # the stop I use on the way in
    ("green", "circle", "liked"),           # a place I like
    ("green", "triangle", "improve"),       # a place worth improving
    ("orange", "circle", "avoided"),        # a place I avoid
    ("orange", "triangle", "crossing"),     # a crossing that scares me
    ("pink", "circle", "friends"),          # where I meet friends
    ("pink", "triangle", "activity"),       # sport / club / activity
    ("yellow", "circle", "errands"),        # everyday shopping
    ("yellow", "triangle", "weekend"),      # where I go at the weekend
]
CATEGORIES = STICKER_QUESTIONS

# Junction hotspots, as metres east/north of the school.  No curated POI stands
# for "the crossing that scares me", but the answer to that question clusters
# hard on a few corners in reality, so it must cluster here too.
HOTSPOTS = [
    (-260, 60, "Belleville crossroads"),
    (150, -430, "Menilmontant junction"),
    (430, 210, "Pyrenees / Jourdain"),
    (-120, -250, "Couronnes corner"),
    (620, -160, "Gambetta approach"),
]


def metres_per_degree(lat):
    return 111320.0 * math.cos(math.radians(lat)), 110540.0


class Sheet:
    """The printed frame, and the exact pixel mapping web/imobyl.html uses."""

    def __init__(self, corners):
        self.corners = corners
        self.west, self.north = corners[0]
        self.east = corners[1][0]
        self.south = corners[3][1]
        self.span_lng = self.east - self.west
        self.span_lat = self.south - self.north
        self.mid_lat = (self.north + self.south) / 2
        self.m_lng, self.m_lat = metres_per_degree(self.mid_lat)

    def to_pixel(self, lng, lat):
        x = ((lng - self.west) / self.span_lng) * (INK_W - 1)
        y = ((lat - self.north) / self.span_lat) * (INK_H - 1)
        return x, y

    def contains(self, lng, lat, margin_m=60.0):
        """Inside the paper, with a margin so nothing lands on the trim."""
        dx = margin_m / self.m_lng
        dy = margin_m / self.m_lat
        return (self.west + dx <= lng <= self.east - dx
                and self.south + dy <= lat <= self.north - dy)

    def offset(self, lng, lat, east_m, north_m):
        return lng + east_m / self.m_lng, lat + north_m / self.m_lat

    def distance_m(self, a, b):
        return math.hypot((a[0] - b[0]) * self.m_lng, (a[1] - b[1]) * self.m_lat)

    def width_km(self):
        return abs(self.span_lng) * self.m_lng / 1000.0

    def height_km(self):
        return abs(self.span_lat) * self.m_lat / 1000.0


def load_sheet(sheet_id):
    path = SHEETS_DIR / f"{sheet_id}.json"
    if not path.exists():
        raise SystemExit(f"no such map sheet: {path}")
    record = json.loads(path.read_text(encoding="utf-8"))
    corners = record.get("corners") or []
    if len(corners) != 4:
        raise SystemExit(f"map sheet {sheet_id} has no usable corners")
    return Sheet([[float(c[0]), float(c[1])] for c in corners])


def load_anchors():
    """Real curated POIs, so clusters land on places that exist."""
    data = json.loads(CURATED.read_text(encoding="utf-8"))
    anchors, school = [], None
    for feature in data.get("features") or []:
        props = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            continue
        lng, lat = geometry["coordinates"][:2]
        entry = {
            "name": props.get("name") or "",
            "icon": props.get("icon") or "",
            "lng": float(lng),
            "lat": float(lat),
            "distance_m": float(props.get("distance_m") or 0),
        }
        anchors.append(entry)
        # The curated set marks the school itself with icon "home", distance 0.
        if entry["icon"] == "home" and entry["distance_m"] == 0:
            school = entry
    if school is None:
        raise SystemExit("could not find the school anchor in the curated POIs")
    return anchors, school


def by_icon(anchors, icons):
    return [a for a in anchors if a["icon"] in icons]


def sample_radius(rng, near_share, near_m, far_m):
    """Most trips inside near_m, the rest out to far_m.

    Uniform in *area* within each band, so the near ring is not over-dense at
    the centre the way a uniform-in-radius draw would be.
    """
    if rng.random() < near_share:
        return near_m * math.sqrt(rng.random())
    return math.sqrt(near_m ** 2 + (far_m ** 2 - near_m ** 2) * rng.random())


def sample_point(rng, sheet, origin, near_share, near_m, far_m, tries=24):
    """A point at the requested distance that is still on the paper.

    When a far draw lands off the sheet the bearing is kept and the radius is
    walked down to the furthest point the paper allows, rather than resampled.
    Resampling would quietly refill the far ring from the near one, turning a
    "lives 1.8 km away, in a direction where the sheet stops at 1.2 km"
    participant into a fictitious one living next to the school.
    """
    for _ in range(tries):
        radius = sample_radius(rng, near_share, near_m, far_m)
        angle = rng.uniform(0, 2 * math.pi)
        east, north = math.cos(angle), math.sin(angle)
        lng, lat = sheet.offset(origin["lng"], origin["lat"],
                                radius * east, radius * north)
        if sheet.contains(lng, lat):
            return lng, lat, radius
        # Shrink along this bearing until it fits; 12 halvings is well under
        # a metre of residual error on a 2 km draw.
        low, high = 0.0, radius
        for _ in range(12):
            mid = (low + high) / 2
            probe = sheet.offset(origin["lng"], origin["lat"],
                                 mid * east, mid * north)
            if sheet.contains(*probe):
                low = mid
            else:
                high = mid
        if low > 150.0:
            lng, lat = sheet.offset(origin["lng"], origin["lat"],
                                    low * east, low * north)
            return lng, lat, low
    # Only reachable if the origin itself is against the edge.
    radius = 250.0 * math.sqrt(rng.random())
    angle = rng.uniform(0, 2 * math.pi)
    lng, lat = sheet.offset(origin["lng"], origin["lat"],
                            radius * math.cos(angle), radius * math.sin(angle))
    return lng, lat, radius


def jitter_around(rng, sheet, anchor, spread_m):
    for _ in range(40):
        lng, lat = sheet.offset(anchor["lng"], anchor["lat"],
                                rng.gauss(0, spread_m), rng.gauss(0, spread_m))
        if sheet.contains(lng, lat):
            return lng, lat
    return anchor["lng"], anchor["lat"]


def draw_route(rng, sheet, start, end, *, step_m=55.0, bend=0.22, wobble_m=7.0):
    """A hand-drawn line from start to end: one bend, then pen wobble.

    Sampled along a quadratic Bezier whose control point is pushed sideways, so
    the stroke leaves and arrives at plausible angles instead of slicing the
    block diagonally, then resampled at a spacing a felt-tip would produce.
    """
    length = sheet.distance_m(start, end)
    steps = max(6, min(70, int(length / step_m)))
    mid_lng, mid_lat = (start[0] + end[0]) / 2, (start[1] + end[1]) / 2
    dx_m = (end[0] - start[0]) * sheet.m_lng
    dy_m = (end[1] - start[1]) * sheet.m_lat
    norm = math.hypot(dx_m, dy_m) or 1.0
    push = length * bend * rng.uniform(-1.0, 1.0)
    control = sheet.offset(mid_lng, mid_lat,
                           -dy_m / norm * push, dx_m / norm * push)

    points = []
    for i in range(steps + 1):
        t = i / steps
        one = 1 - t
        lng = one * one * start[0] + 2 * one * t * control[0] + t * t * end[0]
        lat = one * one * start[1] + 2 * one * t * control[1] + t * t * end[1]
        # No wobble at the ends: a drawn line starts and stops where it means to.
        damp = math.sin(math.pi * t)
        lng, lat = sheet.offset(lng, lat,
                                rng.gauss(0, wobble_m) * damp,
                                rng.gauss(0, wobble_m) * damp)
        lng = min(max(lng, sheet.west), sheet.east)
        lat = min(max(lat, sheet.south), sheet.north)
        x, y = sheet.to_pixel(lng, lat)
        points.append([round(x, 2), round(y, 2)])
    return points, length


def place_sticker(rng, sheet, question, ctx):
    """Where one answer lands, per question.

    Each rule is a claim about behaviour, not decoration: "home" scatters over
    the catchment, "crossing" piles onto a handful of junctions because that is
    what that answer does in a real room, and "stop" lands along the commute so
    the corridor thickens where people actually walk.
    """
    if question == "home":
        return jitter_around(rng, sheet, ctx["home"], 45)
    if question == "stop":
        # Somewhere along the home->school line, biased towards the home end:
        # the stop you name is the one near where you start.
        t = rng.uniform(0.15, 0.6)
        lng = ctx["home"]["lng"] + (ctx["school"]["lng"] - ctx["home"]["lng"]) * t
        lat = ctx["home"]["lat"] + (ctx["school"]["lat"] - ctx["home"]["lat"]) * t
        return jitter_around(rng, sheet, {"lng": lng, "lat": lat}, 90)
    if question == "liked":
        return jitter_around(rng, sheet, rng.choice(ctx["liked"]), 110)
    if question == "improve":
        # Split between the squares people want fixed and the bad junctions.
        pool = ctx["improve"] if rng.random() < 0.6 else ctx["hotspots"]
        return jitter_around(rng, sheet, rng.choice(pool), 100)
    if question == "avoided":
        return jitter_around(rng, sheet, rng.choice(ctx["hotspots"]), 85)
    if question == "crossing":
        # Tighter than "avoided": a crossing is a point, not an area, and the
        # one named is usually on the way in rather than anywhere in the map.
        near = sorted(ctx["hotspots"],
                      key=lambda h: sheet.distance_m((h["lng"], h["lat"]),
                                                     (ctx["home"]["lng"],
                                                      ctx["home"]["lat"])))
        pick_from = near[:3] if len(near) >= 3 else near
        return jitter_around(rng, sheet, rng.choice(pick_from), 45)
    if question == "friends":
        return jitter_around(rng, sheet, rng.choice(ctx["friends"]), 130)
    if question == "activity":
        return jitter_around(rng, sheet, rng.choice(ctx["activity"]), 95)
    if question == "errands":
        return jitter_around(rng, sheet, rng.choice(ctx["errands"]), 100)
    # weekend: further afield, and the sheet edge does the clipping.
    return jitter_around(rng, sheet, rng.choice(ctx["weekend"]), 160)


def build(args):
    rng = random.Random(args.seed)
    sheet = load_sheet(args.sheet)
    anchors, school = load_anchors()

    # Pools by curated icon, so every cluster sits on a place that exists.
    parks = by_icon(anchors, {"park"})
    sport = by_icon(anchors, {"sport"})
    culture = by_icon(anchors, {"culture", "library"})
    youth = by_icon(anchors, {"youth"})
    food = by_icon(anchors, {"food"})
    shops = by_icon(anchors, {"shop"})
    civic = by_icon(anchors, {"civic"})
    # Weighted by repetition: a park is named far more often than a bookshop.
    pools = {
        "liked": parks * 3 + sport * 2 + culture * 2 + youth + [school],
        "improve": parks * 2 + civic * 2 + youth + sport,
        "friends": parks * 3 + food * 2 + youth * 2 + culture,
        "activity": sport * 3 + youth * 2 + parks,
        "errands": shops * 3 + food * 2 + civic,
        "weekend": culture * 3 + parks * 2 + food + shops,
    }
    for key, pool in pools.items():
        if not pool:
            pools[key] = [school]

    hotspots = []
    for east_m, north_m, label in HOTSPOTS:
        lng, lat = sheet.offset(school["lng"], school["lat"], east_m, north_m)
        if sheet.contains(lng, lat):
            hotspots.append({"name": label, "lng": lng, "lat": lat})
    if not hotspots:
        hotspots = [school]

    markers, strokes = [], []
    homes, walks, rides, sticker_distances = [], [], [], []

    for participant in range(1, args.participants + 1):
        home_lng, home_lat, home_radius = sample_point(
            rng, sheet, school, args.near_share, args.near_m, args.far_m)
        home = {"lng": home_lng, "lat": home_lat}
        homes.append(home_radius)

        # --- stickers: one or two of EVERY colour and shape ----------------
        # Each participant answers all ten questions, so the sheet carries the
        # full palette from every person rather than a sample of it.
        context = dict(pools, home=home, school=school, hotspots=hotspots)
        for colour, shape, question in STICKER_QUESTIONS:
            count = 1 if rng.random() < args.single_sticker_share else 2
            for _ in range(count):
                lng, lat = place_sticker(rng, sheet, question, context)
                x, y = sheet.to_pixel(lng, lat)
                label, hex_colour = STICKER_COLORS[colour]
                markers.append({
                    "x": round(x, 2), "y": round(y, 2), "shape": shape,
                    "color": hex_colour, "colorClass": colour,
                    "colorLabel": label, "manual": True,
                    "participant": participant, "question": question,
                })
                sticker_distances.append(
                    sheet.distance_m((school["lng"], school["lat"]), (lng, lat)))

        # --- walking (red): the commute, drawn home <-> school -------------
        start = (home["lng"], home["lat"])
        end = jitter_around(rng, sheet, school, 35)
        if rng.random() < 0.5:
            start, end = end, start
        points, length = draw_route(rng, sheet, start, end)
        label, hex_colour = PATH_COLORS["red"]
        strokes.append({
            "points": points, "color": hex_colour, "colorClass": "red",
            "colorLabel": label, "width": rng.choice([6, 7, 8, 8, 9, 10]),
            "participant": participant, "mode": "walking",
        })
        walks.append(length)

        # --- cycling (black): fewer students, and they go further ----------
        if rng.random() < args.cycle_share:
            far = max(args.far_m, args.near_m * 2)
            dest_lng, dest_lat, _ = sample_point(
                rng, sheet, school, 0.35, args.near_m, far)
            ride_start = jitter_around(rng, sheet, home, 40)
            points, length = draw_route(rng, sheet, ride_start,
                                        (dest_lng, dest_lat),
                                        step_m=70, bend=0.16)
            label, hex_colour = PATH_COLORS["black"]
            strokes.append({
                "points": points, "color": hex_colour, "colorClass": "black",
                "colorLabel": label, "width": rng.choice([5, 6, 6, 7, 8]),
                "participant": participant, "mode": "cycling",
            })
            rides.append(length)

    record = {
        "name": args.name,
        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "version": 1,
        "threshold": 29,
        "mapId": str(args.sheet),
        "participantId": "",
        "heat": {colour: {"enabled": False, "binMetres": 220,
                          "perLevel": 1, "opacity": 0.65}
                 for colour in STICKER_COLORS},
        "references": [{
            "id": str(args.sheet),
            "corners": sheet.corners,
            "visible": True,
            "photos": [],
            "manual": {"markers": markers, "strokes": strokes},
        }],
        "simulated": {
            "generator": "tools/make_imobyl_sim.py",
            "seed": args.seed,
            "participants": args.participants,
            "questions": {f"{colour}-{shape}": question
                          for colour, shape, question in STICKER_QUESTIONS},
            "note": "Synthetic data for previewing the aggregate view. Routes "
                    "are geometric approximations, not routed along streets.",
        },
    }
    return record, {
        "sheet": sheet, "school": school, "homes": homes, "walks": walks,
        "rides": rides, "stickers": sticker_distances,
        "markers": markers, "strokes": strokes,
    }


def histogram(label, values, edges):
    if not values:
        print(f"  {label:18s} none")
        return
    buckets = [0] * (len(edges) + 1)
    for value in values:
        for i, edge in enumerate(edges):
            if value <= edge:
                buckets[i] += 1
                break
        else:
            buckets[-1] += 1
    parts = []
    for i, edge in enumerate(edges):
        low = 0 if i == 0 else edges[i - 1]
        parts.append(f"{low/1000:g}-{edge/1000:g}km {buckets[i]:3d}")
    parts.append(f">{edges[-1]/1000:g}km {buckets[-1]:3d}")
    median = sorted(values)[len(values) // 2]
    print(f"  {label:18s} n={len(values):4d} median={median:5.0f}m   "
          + "  ".join(parts))


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--participants", type=int, default=60)
    parser.add_argument("--sheet", default="1",
                        help="map sheet id whose frame the marks are pinned to")
    parser.add_argument("--seed", type=int, default=20260819)
    parser.add_argument("--name", default="Simulation - 60 participants (JBC)")
    parser.add_argument("--near-m", type=float, default=1000.0)
    parser.add_argument("--far-m", type=float, default=2000.0)
    parser.add_argument("--near-share", type=float, default=0.70,
                        help="share of homes/destinations inside --near-m")
    parser.add_argument("--cycle-share", type=float, default=0.55,
                        help="share of participants who also draw a cycling path")
    parser.add_argument("--single-sticker-share", type=float, default=0.55,
                        help="per colour/shape, the chance of 1 sticker not 2")
    parser.add_argument("--out", default="",
                        help="output path (default: a new session file)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    record, stats = build(args)
    sheet = stats["sheet"]

    # Nothing may sit off the paper: such marks would silently never render.
    stray = [m for m in stats["markers"]
             if not (0 <= m["x"] <= INK_W - 1 and 0 <= m["y"] <= INK_H - 1)]
    off = [p for s in stats["strokes"] for p in s["points"]
           if not (0 <= p[0] <= INK_W - 1 and 0 <= p[1] <= INK_H - 1)]
    if stray or off:
        raise SystemExit(f"generator bug: {len(stray)} markers and {len(off)} "
                         f"path points fell outside {INK_W}x{INK_H}")

    body = json.dumps(record, separators=(",", ":"), ensure_ascii=False)
    walking = [s for s in stats["strokes"] if s["colorClass"] == "red"]
    cycling = [s for s in stats["strokes"] if s["colorClass"] == "black"]
    by_colour = {}
    for marker in stats["markers"]:
        by_colour[marker["colorClass"]] = by_colour.get(marker["colorClass"], 0) + 1
    school_px = sheet.to_pixel(stats["school"]["lng"], stats["school"]["lat"])

    print(f"sheet {args.sheet}: {sheet.width_km():.2f} x {sheet.height_km():.2f} km"
          f"   school at pixel ({school_px[0]:.0f}, {school_px[1]:.0f})")
    print(f"participants {args.participants}   stickers {len(stats['markers'])}"
          f"   paths {len(stats['strokes'])}"
          f" (walking {len(walking)}, cycling {len(cycling)})")
    # The colour/shape matrix is the summary that matters now: every cell is
    # one question, and every participant must appear in all ten.
    print("  stickers per question (colour x shape):")
    for colour, shape, question in STICKER_QUESTIONS:
        cell = [m for m in stats["markers"]
                if m["colorClass"] == colour and m["shape"] == shape]
        who = {m["participant"] for m in cell}
        flag = "" if len(who) == args.participants else             f"  << only {len(who)}/{args.participants} participants"
        print(f"    {colour:7s} {shape:9s} {question:9s} {len(cell):4d}"
              f"  ({len(cell)/max(1, args.participants):.2f} per participant){flag}")
    print("  stickers by colour: " + ", ".join(
        f"{k} {v}" for k, v in sorted(by_colour.items(), key=lambda kv: -kv[1])))
    histogram("home distance", stats["homes"], [500, 1000, 1500, 2000])
    histogram("sticker distance", stats["stickers"], [500, 1000, 1500, 2000])
    histogram("walking length", stats["walks"], [500, 1000, 1500, 2000])
    histogram("cycling length", stats["rides"], [500, 1000, 1500, 2000])
    print(f"file size {len(body.encode('utf-8')) / 1024:.0f} kB")

    if args.dry_run:
        print("dry run: nothing written")
        return
    if args.out:
        path = pathlib.Path(args.out)
    else:
        session_id = (time.strftime("%Y%m%d-%H%M%S") + "-"
                      + uuid.uuid4().hex[:6])
        path = SESSIONS_DIR / f"{session_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    try:
        shown = path.resolve().relative_to(ROOT)
    except ValueError:
        shown = path
    print(f"wrote {shown}")


if __name__ == "__main__":
    main()
