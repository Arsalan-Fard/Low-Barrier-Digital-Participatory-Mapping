#!/usr/bin/env python3
"""Rank the POIs in a bbox by prominence, so a sheet can show the top N.

OpenMapTiles' `rank` (what web/ and the Maputnik POI buckets use today) is a
row_number() within each z14 tile ordered by a fixed class-importance table.
It is a label-collision device: a world-famous museum and a two-room one are
both class=museum and rank identically. This computes real prominence instead.

Signals, and why each is here (all measured on the Belleville default centre,
3558 named POIs):

  views      fr/en Wikipedia mean monthly traffic. The only true popularity
             signal in open data. Separates Parc des Buttes-Chaumont (4470)
             from Gambetta metro (462) -- sitelinks rate both 26.
  sitelinks  Wikidata language count. Kept at low weight ONLY: every Paris
             metro station has ~20 auto-created stubs, so alone it puts 8
             stations in the top 13 and buries the cemetery below #324.
  edits      OSM object version. Covers 100% of POIs, unlike Wikipedia's 6%.
             Wikidata-linked POIs average 8.12 edits vs 5.58 for plain ones.
  ntags      OSM tag richness. Same 100% coverage; 11.68 vs 7.06 on that split.
  area       Footprint. Parks and cemeteries anchor a mental map.
  klass      Category salience for a neighbourhood map (curated, see KLASS).

Evaluated and rejected:
  Overture Places `confidence` -- not prominence. The top 25 of 5231 places in
      the bbox are all "Vinted Go Locker" parcel lockers, which also fill the
      bottom at 0.000. All 5231 carry exactly 2 sources, so no signal there.
  Foursquare OS Places -- the open release is now gated behind HuggingFace
      auth and the S3 bucket is no longer publicly listable. Unverified.
  Google Places `rankPreference: POPULARITY` -- real prominence, but exposed
      only as an ordering, and the ToS caps field caching at 30 days, so it
      cannot be baked into a printed sheet.

Output is two tiers, deliberately not blended into one number:
  landmark  Wikidata-backed, driven by pageviews
  tail      OSM-only, driven by edits/tags/class/area -- this is what carries
            areas Wikipedia ignores (Palaiseau: 169 of 178 POIs, ranked
            sensibly with zero Wikipedia data)

Usage:
  python tools/poi_prominence.py --center 2.39104,48.86889 --out ranked.geojson
  python tools/poi_prominence.py --bbox S,W,N,E --top 40
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import math
import pathlib
import re
import sys
import time
import unicodedata
import urllib.parse

import requests

UA = "LowBarrierMapping/1.0 (participatory mapping; +https://github.com/)"
HDR = {"User-Agent": UA}
SPARQL = "https://query.wikidata.org/sparql"
OVERPASS = ("https://overpass.kumi.systems/api/interpreter",
            "https://overpass-api.de/api/interpreter")
CACHE = pathlib.Path(__file__).parent / ".poi_cache"

# Category salience for a neighbourhood participatory map. This is the one
# hand-tuned table: "how much does this kind of thing anchor a mental map",
# not popularity. Tune per workshop rather than chasing a global constant.
KLASS = {
    "tourism=attraction": 1.00, "tourism=museum": 1.00, "historic=monument": 0.95,
    "leisure=park": 0.95, "landuse=cemetery": 0.90, "railway=station": 0.45,
    "amenity=place_of_worship": 0.85, "amenity=hospital": 0.85,
    "amenity=townhall": 0.85, "amenity=university": 0.85, "leisure=stadium": 0.80,
    "amenity=theatre": 0.80, "amenity=college": 0.75, "amenity=library": 0.75,
    "amenity=cinema": 0.75, "amenity=marketplace": 0.75, "amenity=arts_centre": 0.75,
    "leisure=garden": 0.70, "tourism=gallery": 0.65, "historic=memorial": 0.65,
    "amenity=community_centre": 0.65, "leisure=sports_centre": 0.65,
    "amenity=school": 0.60, "shop=mall": 0.60, "leisure=swimming_pool": 0.60,
    "amenity=police": 0.55, "amenity=post_office": 0.50, "amenity=pharmacy": 0.45,
    "shop=supermarket": 0.45, "amenity=bank": 0.40, "tourism=hotel": 0.40,
    "leisure=playground": 0.35, "amenity=restaurant": 0.30, "amenity=cafe": 0.30,
    "amenity=bar": 0.30, "amenity=pub": 0.30, "shop=bakery": 0.30,
    "amenity=fast_food": 0.20, "shop=convenience": 0.20,
    "amenity=bicycle_rental": 0.10, "shop=hairdresser": 0.08, "shop=beauty": 0.08,
    "historic=tomb": 0.05, "office=estate_agent": 0.05,
    # "panneau Histoire de Paris" boards carry the exact name of the thing they
    # describe, cloning real landmarks into the ranking.
    "tourism=information": 0.05,
}
DEFAULT_KLASS = 0.25
PRIMARY = ("tourism", "historic", "leisure", "amenity", "railway", "shop",
           "office", "craft", "healthcare", "public_transport", "landuse")

WEIGHTS = {"views": .42, "sitelinks": .05, "edits": .17,
           "ntags": .06, "area": .12, "klass": .18}
CAPS = {"views": 30000, "sitelinks": 60, "edits": 60, "ntags": 40, "area": 300000}

# Article traffic that belongs to an event or a person, not to the place. An
# air-crash memorial plaque in Pere Lachaise otherwise outranks the cemetery.
# Q39614 (cemetery) and Q41426 (trainer) do NOT belong here -- damping the
# former cut Pere Lachaise's own 14571 views down to 2185.
EVENT_CLASSES = {
    "Q5",         # human -- graves of the famous
    "Q198",       # war
    "Q13418847",  # historical event
    "Q744913",    # aviation accident
    "Q168983",    # conflagration
    "Q3199915",   # massacre
    "Q1656682",   # planned event
    "Q381885",    # tomb / burial place
    "Q203443",    # tombstone
}
EVENT_DAMP = 0.15

# A shop called "Fromagerie de Belleville" must not inherit the Belleville
# quartier's 3394 monthly views. Without this bar, 95 POIs did exactly that.
AREA_CLASSES = {"Q123705", "Q252916", "Q702842", "Q484170", "Q2983893",
                "Q3957", "Q515", "Q1523174", "Q194203", "Q6465", "Q34876"}

JOIN_RADIUS_M = 1200      # Buttes-Chaumont's centroid sits 466 m from its WD point
DEDUPE_RADIUS_M = 400


def _cache(name: str):
    CACHE.mkdir(exist_ok=True)
    return CACHE / name


def slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def haversine(alat, alon, blat, blon):
    R = 6371000.0
    p1, p2 = math.radians(alat), math.radians(blat)
    dp, dl = p2 - p1, math.radians(blon - alon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def fetch_osm(bbox: str):
    q = f"""[out:json][timeout:180];
(
  nwr["amenity"]["name"]({bbox}); nwr["shop"]["name"]({bbox});
  nwr["tourism"]["name"]({bbox}); nwr["leisure"]["name"]({bbox});
  nwr["historic"]["name"]({bbox}); nwr["office"]["name"]({bbox});
  nwr["craft"]["name"]({bbox}); nwr["healthcare"]["name"]({bbox});
  nwr["railway"~"^(station|halt)$"]["name"]({bbox});
  nwr["public_transport"="station"]["name"]({bbox});
  nwr["landuse"~"^(cemetery|forest|allotments|recreation_ground)$"]["name"]({bbox});
  nwr["amenity"="grave_yard"]["name"]({bbox});
);
out meta center bb;"""
    cf_ = _cache(f"osm_{hashlib.md5(q.encode()).hexdigest()[:12]}.json")
    if cf_.exists():
        return json.loads(cf_.read_text(encoding="utf-8"))
    for attempt in range(5):
        for url in OVERPASS:
            try:
                r = requests.post(url, data={"data": q}, headers=HDR, timeout=240)
                if r.status_code == 200:
                    els = r.json().get("elements", [])
                    cf_.write_text(json.dumps(els), encoding="utf-8")
                    return els
                print(f"      {url.split('/')[2]} -> {r.status_code}", file=sys.stderr)
            except Exception as e:
                print(f"      {url.split('/')[2]} -> {type(e).__name__}", file=sys.stderr)
        time.sleep(25 * (attempt + 1))
    raise RuntimeError("Overpass unavailable")


def fetch_wikidata(center, radius_km=1.6):
    """Every Wikidata item near `center`, with sitelinks and article titles.

    Driven by location, not by OSM's `wikidata` tag: that tag reaches only 39
    article-bearing places here, the spatial sweep reaches 907.
    """
    lon, lat = center
    q = f"""
SELECT ?item ?itemLabel ?lat ?lon ?sitelinks ?fr ?en
       (GROUP_CONCAT(DISTINCT ?cls; separator="|") AS ?classes) WHERE {{
  SERVICE wikibase:around {{
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point({lon} {lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "{radius_km}" .
  }}
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks > 0)
  OPTIONAL {{ ?item wdt:P31 ?c . BIND(STRAFTER(STR(?c),"entity/") AS ?cls) }}
  OPTIONAL {{ ?a schema:about ?item; schema:isPartOf <https://fr.wikipedia.org/>; schema:name ?fr }}
  OPTIONAL {{ ?b schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?en }}
  BIND(geof:latitude(?coord) AS ?lat) BIND(geof:longitude(?coord) AS ?lon)
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "fr,en". }}
}} GROUP BY ?item ?itemLabel ?lat ?lon ?sitelinks ?fr ?en"""
    # Key on the centre as well as the radius; keying on radius alone served one
    # neighbourhood's sweep for a query 20 km away.
    cf_ = _cache(f"wd_{lon:.5f}_{lat:.5f}_{radius_km}.json")
    if cf_.exists():
        bindings = json.loads(cf_.read_text(encoding="utf-8"))
    else:
        for attempt in range(4):
            r = requests.get(SPARQL, params={"query": q, "format": "json"},
                             headers={**HDR, "Accept": "application/sparql-results+json"},
                             timeout=180)
            if r.status_code == 200:
                break
            time.sleep(8 * (attempt + 1))
        else:
            raise RuntimeError("Wikidata SPARQL unavailable")
        bindings = r.json()["results"]["bindings"]
        cf_.write_text(json.dumps(bindings), encoding="utf-8")
    out = []
    for row in bindings:
        classes = set((row.get("classes", {}).get("value") or "").split("|")) - {""}
        out.append({
            "qid": row["item"]["value"].rsplit("/", 1)[-1],
            "label": row.get("itemLabel", {}).get("value", ""),
            "lat": float(row["lat"]["value"]), "lon": float(row["lon"]["value"]),
            "sitelinks": int(row["sitelinks"]["value"]),
            "fr": row.get("fr", {}).get("value"),
            "en": row.get("en", {}).get("value"),
            "classes": classes,
            "is_area": bool(classes & AREA_CLASSES),
            "damped": bool(classes & EVENT_CLASSES),
        })
    return out


_SESSION = requests.Session()
_SESSION.headers.update(HDR)


def _one_pageview(job):
    proj, title = job
    t = urllib.parse.quote(title.replace(" ", "_"), safe="")
    url = ("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
           f"{proj}/all-access/user/{t}/monthly/20240801/20250801")
    for attempt in range(4):
        try:
            r = _SESSION.get(url, timeout=45)
            if r.status_code == 200:
                items = r.json().get("items", [])
                return sum(i["views"] for i in items) // max(1, len(items))
            if r.status_code == 404:
                return 0
        except Exception:
            pass
        time.sleep(1.5 * (attempt + 1))
    return None


def fetch_pageviews(jobs):
    """Mean monthly views per article. 4 workers, not 8: heavier concurrency
    produced a 65% spurious-miss rate that looked like missing articles."""
    cf_ = _cache("pageviews.json")
    seen = json.loads(cf_.read_text(encoding="utf-8")) if cf_.exists() else {}
    todo = [j for j in jobs if f"{j[0]}|{j[1]}" not in seen]
    if todo:
        with cf.ThreadPoolExecutor(max_workers=4) as ex:
            for j, v in zip(todo, ex.map(_one_pageview, todo)):
                if v is not None:
                    seen[f"{j[0]}|{j[1]}"] = v
        cf_.write_text(json.dumps(seen), encoding="utf-8")
    return seen


def sweep_radius_km(bbox: str) -> float:
    """Half-diagonal of the bbox, so the Wikidata sweep reaches its corners.
    A fixed radius silently under-covers any bbox bigger than the one it was
    picked for -- at z14.5 on A3 the extent is ~4.7x the default."""
    s, w, n, e = (float(x) for x in bbox.split(","))
    mid = math.radians((s + n) / 2)
    dy = (n - s) * 111.320 / 2
    dx = (e - w) * 111.320 * math.cos(mid) / 2
    return round(math.hypot(dx, dy) * 1.05, 2)      # 5% margin


def build(bbox: str, center, verbose=True):
    def say(*a):
        if verbose:
            print(*a, file=sys.stderr)

    say("[1/5] OpenStreetMap ...")
    pois = []
    for e in fetch_osm(bbox):
        t = e.get("tags") or {}
        if not t.get("name"):
            continue
        bb = e.get("bounds")
        lat = e.get("lat") or (e.get("center") or {}).get("lat")
        lon = e.get("lon") or (e.get("center") or {}).get("lon")
        if lat is None and bb:
            # `out center bb` emits bounds INSTEAD of center for ways/relations.
            # Deriving the centroid here is what keeps the cemetery and the
            # parks in the set at all -- without it 336 large features vanish.
            lat = (bb["minlat"] + bb["maxlat"]) / 2.0
            lon = (bb["minlon"] + bb["maxlon"]) / 2.0
        if lat is None:
            continue
        area = 0.0
        if bb:
            dy = (bb["maxlat"] - bb["minlat"]) * 111320.0
            dx = (bb["maxlon"] - bb["minlon"]) * 111320.0 * math.cos(math.radians(lat))
            area = abs(dx * dy)
        pois.append({
            "osm": f"{e['type']}/{e['id']}", "name": t["name"],
            "lat": lat, "lon": lon, "area": area,
            "kind": next((f"{k}={t[k]}" for k in PRIMARY if t.get(k)), ""),
            "edits": e.get("version", 1), "ntags": len(t),
            "qid": t.get("wikidata"),
        })
    say(f"      {len(pois)} named POIs")

    radius = sweep_radius_km(bbox)
    say(f"[2/5] Wikidata spatial sweep (r={radius} km) ...")
    wd = fetch_wikidata(center, radius)
    arts = [w for w in wd if w["fr"] or w["en"]]
    say(f"      {len(wd)} items, {len(arts)} with an article")

    say("[3/5] Wikipedia pageviews ...")
    jobs = [("fr.wikipedia", w["fr"]) if w["fr"] else ("en.wikipedia", w["en"])
            for w in arts]
    seen = fetch_pageviews(jobs)
    for w, j in zip(arts, jobs):
        raw = seen.get(f"{j[0]}|{j[1]}", 0)
        w["views_raw"] = raw
        w["views"] = int(raw * EVENT_DAMP) if w["damped"] else raw
    for w in wd:
        w.setdefault("views", 0)
        w.setdefault("views_raw", 0)

    say("[4/5] join ...")
    by_qid = {w["qid"]: w for w in wd}
    by_slug = {}
    for w in wd:
        if not w["is_area"]:
            by_slug.setdefault(slug(w["label"]), []).append(w)
    joined = 0
    for p in pois:
        best = None
        if p["qid"] and p["qid"] in by_qid:
            best = by_qid[p["qid"]]                       # explicit link, trust it
        else:
            # EXACT slug only. Substring matching bled one quartier article into
            # 95 unrelated businesses that merely shared a word with it.
            cands = [(haversine(p["lat"], p["lon"], w["lat"], w["lon"]), w)
                     for w in by_slug.get(slug(p["name"]), [])]
            cands = [c for c in cands if c[0] <= JOIN_RADIUS_M]
            if cands:
                best = min(cands, key=lambda c: c[0])[1]
        p["views"] = best["views"] if best else 0
        p["views_raw"] = best["views_raw"] if best else 0
        p["sitelinks"] = best["sitelinks"] if best else 0
        p["wikidata"] = best["qid"] if best else None
        p["damped"] = best["damped"] if best else False
        joined += bool(best)
    say(f"      joined {joined}/{len(pois)}")

    say("[5/5] score ...")
    for key, cap in CAPS.items():
        vals = [math.log1p(min(p[key], cap)) for p in pois]
        hi = max(vals) or 1.0
        for p, v in zip(pois, vals):
            p["_" + key] = v / hi
    for p in pois:
        p["_klass"] = KLASS.get(p["kind"], DEFAULT_KLASS)
        p["score"] = round(100 * sum(WEIGHTS[k] * p["_" + k] for k in WEIGHTS), 2)
        p["tier"] = "landmark" if (p["views"] or p["sitelinks"]) else "tail"
        for k in [x for x in p if x.startswith("_")]:
            del p[k]

    # One landmark is often several OSM objects (the polygon, its entrance node,
    # its info board). Keep the best per name within DEDUPE_RADIUS_M.
    pois.sort(key=lambda p: -p["score"])
    kept = []
    for p in pois:
        s = slug(p["name"])
        clash = next((q for q in kept if slug(q["name"]) == s
                      and haversine(p["lat"], p["lon"], q["lat"], q["lon"])
                      <= DEDUPE_RADIUS_M), None)
        if clash:
            p["dup_of"] = clash["osm"]
            p["score"] = round(p["score"] * 0.25, 2)
        else:
            p["dup_of"] = None
            kept.append(p)

    pois.sort(key=lambda p: -p["score"])
    for i, p in enumerate(pois, 1):
        p["rank"] = i
    return pois


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--center", default="2.39104,48.86889",
                    help="lon,lat (default: PAPER_DEFAULT_CENTER)")
    ap.add_argument("--bbox", help="S,W,N,E; overrides --center extent")
    ap.add_argument("--zoom", type=float,
                    help="MapLibre zoom; derives the extent for --page instead "
                         "of --dlon/--dlat")
    ap.add_argument("--page", default="A3", choices=("A3", "A4"),
                    help="sheet the extent is computed for (default A3)")
    ap.add_argument("--dlon", type=float, default=0.016)
    ap.add_argument("--dlat", type=float, default=0.008)
    ap.add_argument("--top", type=int, default=30)
    ap.add_argument("--out", help="write ranked GeoJSON here")
    a = ap.parse_args()

    lon, lat = (float(x) for x in a.center.split(","))
    if a.bbox:
        bbox = a.bbox
    elif a.zoom is not None:
        # Web-mercator ground resolution, then the A3/A4 landscape frame in pt
        # (1190.55x841.89 / 841.89x595.28), matching map_sheet_layout() in app.py.
        res = 156543.03392 * math.cos(math.radians(lat)) / (2 ** a.zoom)
        pw, ph = (1190.55, 841.89) if a.page == "A3" else (841.89, 595.28)
        dlon = (pw * res / 2) / (111320.0 * math.cos(math.radians(lat)))
        dlat = (ph * res / 2) / 111320.0
        bbox = f"{lat-dlat},{lon-dlon},{lat+dlat},{lon+dlon}"
        print(f"z{a.zoom} on {a.page}: {pw*res/1000:.2f} x {ph*res/1000:.2f} km "
              f"({res:.2f} m/px)", file=sys.stderr)
    else:
        bbox = f"{lat-a.dlat},{lon-a.dlon},{lat+a.dlat},{lon+a.dlon}"
    pois = build(bbox, (lon, lat))

    print(f"{'#':>4} {'score':>6} {'views':>7} {'sl':>3} {'ed':>3}  {'name':<38} kind")
    for p in pois[:a.top]:
        d = "*" if p["damped"] else " "
        print(f"{p['rank']:>4} {p['score']:>6.2f} {p['views']:>7}{d}{p['sitelinks']:>3} "
              f"{p['edits']:>3}  {p['name'][:38]:<38} {p['kind']}")
    lm = sum(1 for p in pois if p["tier"] == "landmark")
    print(f"\n{len(pois)} POIs: {lm} landmark, {len(pois)-lm} tail"
          f"   (* pageviews damped: article is about an event or person)")

    if a.out:
        pathlib.Path(a.out).write_text(json.dumps({
            "type": "FeatureCollection",
            "features": [{"type": "Feature",
                          "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
                          "properties": p} for p in pois],
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
