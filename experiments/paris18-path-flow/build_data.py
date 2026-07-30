"""Build the demo path-flow dataset for the Paris 18th arrondissement.

Fetches the real street network from OpenStreetMap (Overpass), then assigns each
segment a SYNTHETIC "times taken" count so the map has something to visualise.

The counts are random but not uniform noise: real movement concentrates on a few
corridors, so the generator combines
  * a road-class prior (a boulevard carries more people than a back alley),
  * distance-decay attraction toward a handful of real landmarks in the 18th
    (Sacre-Coeur, Montmartre, the two stations, Barbes...),
  * a few simulated "trips" traced along the network, which is what produces
    continuous heavy corridors instead of isolated hot segments,
  * light per-segment jitter.

Output: static/paths.geojson  (LineString features, property `count`)

Run:  python build_data.py
It only needs to be run once; the generated file is committed alongside the page.
"""

from __future__ import annotations

import json
import math
import random
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_FILE = HERE / "static" / "paths.geojson"

# Bounding box of the 18th arrondissement (S, W, N, E).
BBOX = (48.8815, 2.3230, 48.9020, 2.3720)

OVERPASS_ENDPOINTS = (
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
)

HIGHWAY_CLASSES = (
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "residential", "unclassified", "living_street", "pedestrian",
)

# Relative "how busy is this kind of street" prior.
CLASS_WEIGHT = {
    "motorway": 1.00, "trunk": 0.95, "primary": 0.90, "secondary": 0.75,
    "tertiary": 0.58, "residential": 0.34, "unclassified": 0.30,
    "living_street": 0.22, "pedestrian": 0.45,
}

# Real draws in the 18th; trips are biased toward these.
LANDMARKS = [
    ("Sacre-Coeur",            2.3431, 48.8867, 1.00),
    ("Place du Tertre",        2.3405, 48.8865, 0.85),
    ("Moulin Rouge / Pigalle", 2.3323, 48.8841, 0.80),
    ("Gare du Nord (edge)",    2.3553, 48.8809, 0.90),
    ("Barbes-Rochechouart",    2.3495, 48.8837, 0.75),
    ("Marche Saint-Ouen",      2.3436, 48.9010, 0.60),
    ("Jules Joffrin",          2.3441, 48.8925, 0.55),
    ("La Chapelle",            2.3600, 48.8845, 0.55),
]

SEED = 20260724          # fixed so the demo is reproducible
TRIP_COUNT = 4000        # simulated journeys traced across the network
MAX_TRIP_STEPS = 70      # cap on segments per journey


def overpass_query() -> str:
    south, west, north, east = BBOX
    classes = "|".join(HIGHWAY_CLASSES)
    return (
        f"[out:json][timeout:180];"
        f'(way["highway"~"^({classes})$"]'
        f"({south},{west},{north},{east}););"
        f"out geom;"
    )


def fetch_streets() -> list[dict]:
    """Download the street network, trying each Overpass mirror in turn."""
    payload = urllib.parse.urlencode({"data": overpass_query()}).encode()
    last_error = None
    for attempt in range(3):
        for endpoint in OVERPASS_ENDPOINTS:
            try:
                print(f"  [Overpass] {endpoint} ...", flush=True)
                request = urllib.request.Request(
                    endpoint, data=payload,
                    headers={"User-Agent": "paris18-path-flow-experiment/1.0"},
                )
                with urllib.request.urlopen(request, timeout=240) as response:
                    elements = json.load(response).get("elements", [])
                if elements:
                    print(f"  [Overpass] got {len(elements)} ways", flush=True)
                    return elements
                last_error = "empty response"
            except Exception as exc:      # noqa: BLE001 - mirrors fail in many ways
                last_error = f"{type(exc).__name__}: {exc}"
                print(f"    failed - {last_error}", flush=True)
        if attempt < 2:
            print("  retrying in 15s ...", flush=True)
            time.sleep(15)
    raise SystemExit(f"Could not download the street network ({last_error})")


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = a
    lon2, lat2 = b
    radius = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(h))


def node_key(lon: float, lat: float) -> tuple[int, int]:
    """Snap a coordinate to ~1e-6 deg so shared endpoints join into one graph node."""
    return (round(lon * 1_000_000), round(lat * 1_000_000))


def landmark_pull(lon: float, lat: float) -> float:
    """Distance-decay attraction from every landmark, in 0..~1."""
    total = 0.0
    for _name, mlon, mlat, weight in LANDMARKS:
        distance = haversine_m((lon, lat), (mlon, mlat))
        total += weight * math.exp(-distance / 550.0)
    return total


def build_segments(ways: list[dict]) -> list[dict]:
    """Split each OSM way into individual two-point segments."""
    segments = []
    for way in ways:
        geometry = way.get("geometry") or []
        if len(geometry) < 2:
            continue
        tags = way.get("tags", {})
        highway = tags.get("highway", "residential")
        name = tags.get("name", "")
        for start, end in zip(geometry, geometry[1:]):
            a = (float(start["lon"]), float(start["lat"]))
            b = (float(end["lon"]), float(end["lat"]))
            if a == b:
                continue
            segments.append({
                "a": a, "b": b, "highway": highway, "name": name,
                "length": haversine_m(a, b),
            })
    return segments


def simulate_trips(segments: list[dict], rng: random.Random) -> dict[int, int]:
    """Trace journeys across the network so busy corridors stay continuous.

    A pure per-segment random number gives salt-and-pepper noise. Walking actual
    paths — biased toward landmarks and bigger roads — is what makes a handful of
    routes read as genuinely 'most taken'.
    """
    adjacency: dict[tuple[int, int], list[int]] = defaultdict(list)
    # Cache each segment's endpoint keys and class weight once. Recomputing them
    # inside the walk loop is what made this step take minutes.
    for index, segment in enumerate(segments):
        segment["ka"] = node_key(*segment["a"])
        segment["kb"] = node_key(*segment["b"])
        segment["w"] = CLASS_WEIGHT.get(segment["highway"], 0.3) * 1.6 + 0.15
        adjacency[segment["ka"]].append(index)
        adjacency[segment["kb"]].append(index)

    # Bias trip starts toward landmark-adjacent nodes.
    nodes = list(adjacency.keys())
    node_weights = []
    for key in nodes:
        lon, lat = key[0] / 1_000_000, key[1] / 1_000_000
        node_weights.append(0.05 + landmark_pull(lon, lat))

    traffic: dict[int, int] = defaultdict(int)
    for _ in range(TRIP_COUNT):
        current = rng.choices(nodes, weights=node_weights, k=1)[0]
        target_name, tlon, tlat, _w = rng.choice(LANDMARKS)
        visited: set[int] = set()
        for _step in range(MAX_TRIP_STEPS):
            options = [i for i in adjacency[current] if i not in visited]
            if not options:
                break
            # Prefer big roads, and steps that move toward the chosen landmark.
            scores = []
            for index in options:
                segment = segments[index]
                other = segment["b"] if node_key(*segment["a"]) == current else segment["a"]
                before = haversine_m((tlon, tlat),
                                     (current[0] / 1_000_000, current[1] / 1_000_000))
                after = haversine_m((tlon, tlat), other)
                progress = max(0.0, before - after) / max(1.0, segment["length"])
                scores.append(
                    0.15
                    + CLASS_WEIGHT.get(segment["highway"], 0.3) * 1.6
                    + progress * 2.2
                )
            index = rng.choices(options, weights=scores, k=1)[0]
            visited.add(index)
            traffic[index] += 1
            segment = segments[index]
            nxt = node_key(*segment["b"]) if node_key(*segment["a"]) == current else node_key(*segment["a"])
            current = nxt
            if haversine_m((tlon, tlat), (current[0] / 1_000_000, current[1] / 1_000_000)) < 60:
                break
    return traffic


def main() -> None:
    rng = random.Random(SEED)

    print("Downloading the 18th arrondissement street network from OSM ...")
    ways = fetch_streets()

    segments = build_segments(ways)
    print(f"Built {len(segments)} street segments from {len(ways)} ways.")
    if not segments:
        raise SystemExit("No street segments were produced.")

    print(f"Simulating {TRIP_COUNT} journeys ...")
    traffic = simulate_trips(segments, rng)

    features = []
    for index, segment in enumerate(segments):
        midpoint = ((segment["a"][0] + segment["b"][0]) / 2,
                    (segment["a"][1] + segment["b"][1]) / 2)
        base = CLASS_WEIGHT.get(segment["highway"], 0.3)
        # The simulated trips must DOMINATE: they are what creates continuous
        # heavy corridors. The class/landmark/jitter terms only lift a segment
        # off zero so untravelled back streets still show faintly. Keeping the
        # baseline small is what gives the long-tailed spread (max ~40x median)
        # that makes a handful of routes read as clearly "most taken" instead of
        # washing the whole arrondissement into one mid-ramp colour.
        count = (
            traffic.get(index, 0) ** 1.35 * 3.0
            + base * 4.0
            + landmark_pull(*midpoint) * 5.0
            + rng.random() * 3.0
            + 1.0
        )
        features.append({
            "type": "Feature",
            "properties": {
                "count": int(round(count)),
                "name": segment["name"],
                "highway": segment["highway"],
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [list(segment["a"]), list(segment["b"])],
            },
        })

    counts = sorted(f["properties"]["count"] for f in features)
    collection = {
        "type": "FeatureCollection",
        "properties": {
            "note": "SYNTHETIC demonstration data - counts are generated, not measured.",
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "seed": SEED,
            "min": counts[0],
            "max": counts[-1],
            "p50": counts[len(counts) // 2],
            "p95": counts[int(len(counts) * 0.95)],
        },
        "features": features,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(collection), encoding="utf-8")
    size_mb = OUT_FILE.stat().st_size / (1024 * 1024)
    print(f"Wrote {OUT_FILE} - {len(features)} segments, {size_mb:.2f} MiB")
    print(f"  counts: min={counts[0]} p50={collection['properties']['p50']} "
          f"p95={collection['properties']['p95']} max={counts[-1]}")


if __name__ == "__main__":
    sys.exit(main())
