"""The saved walking network (data/osmnx_network.geojson, from OSMnx): shortest paths and walking reach."""
import json
import math
import threading
import urllib.error
import urllib.parse
import urllib.request

from flask import Blueprint, jsonify, request

from . import config

bp = Blueprint("street_network", __name__)

network_lock = threading.Lock()
graph_cache = {"graph": None, "bbox": None}  # the saved network, bbox = (min_lng, min_lat, max_lng, max_lat)
BBOX_MARGIN = 0.0005


def load_cached_network():
    """Rebuild the graph from the saved GeoJSON."""
    if not config.OSMNX_NETWORK_FILE.exists():
        return
    try:
        import networkx as nx
        from shapely.geometry import LineString
    except Exception:
        return
    try:
        raw = json.loads(config.OSMNX_NETWORK_FILE.read_text(encoding="utf-8"))
    except Exception:
        return
    features = raw.get("features") if isinstance(raw, dict) else None
    if not isinstance(features, list) or not features:
        return

    graph = nx.MultiDiGraph(crs="EPSG:4326")
    nodes = {}
    min_lng = min_lat = float("inf")
    max_lng = max_lat = float("-inf")
    for feature in features:
        props = feature.get("properties") or {}
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        try:
            u = int(props.get("u"))
            v = int(props.get("v"))
        except Exception:
            continue
        nodes[u] = (float(coords[0][0]), float(coords[0][1]))
        nodes[v] = (float(coords[-1][0]), float(coords[-1][1]))
        for x, y in coords:
            min_lng = min(min_lng, float(x))
            max_lng = max(max_lng, float(x))
            min_lat = min(min_lat, float(y))
            max_lat = max(max_lat, float(y))
        length = props.get("length")
        if not isinstance(length, (int, float)):
            length = 0.0
            for i in range(len(coords) - 1):
                length += math.hypot(coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1]) * 111000.0
        graph.add_edge(u, v, length=float(length), geometry=LineString(coords))
    for node_id, (x, y) in nodes.items():
        graph.add_node(node_id, x=x, y=y)
    if not math.isfinite(min_lng):
        return

    bbox = (min_lng, min_lat, max_lng, max_lat)
    stored = raw.get("bbox")
    if isinstance(stored, list) and len(stored) == 4:
        try:
            candidate = tuple(float(v) for v in stored)
            if all(math.isfinite(v) for v in candidate) and candidate[0] < candidate[2] and candidate[1] < candidate[3]:
                bbox = candidate
        except (TypeError, ValueError):
            pass
    with network_lock:
        graph_cache["graph"] = graph
        graph_cache["bbox"] = bbox
    print(f"[OSMnx] Loaded cached network: {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges")

    def warm_up():
        # The undirected copy (~4 s on 27k nodes) and OSMnx's nearest-node index (~1.8 s) are built
        # here in the background, rather than by the first request.
        try:
            graph.reach_undirected = graph.to_undirected()
            try:
                import osmnx as ox
                ox.distance.nearest_nodes(graph, (bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0)
            except Exception:
                pass
            print("[OSMnx] Reach index ready", flush=True)
        except Exception:
            pass

    threading.Thread(target=warm_up, daemon=True).start()


def _bbox_contains(bbox, lng, lat, margin=BBOX_MARGIN):
    if not bbox:
        return False
    min_lng, min_lat, max_lng, max_lat = bbox
    return min_lng - margin <= lng <= max_lng + margin and min_lat - margin <= lat <= max_lat + margin


def _cached_graph():
    with network_lock:
        return graph_cache["graph"], graph_cache["bbox"]


def _read_point(raw):
    """(lng, lat) from {"lng", "lat"}; ValueError unless both are finite numbers."""
    lng = float(raw["lng"])
    lat = float(raw["lat"])
    if not (math.isfinite(lng) and math.isfinite(lat)):
        raise ValueError("not finite")
    return lng, lat


def _best_edge(graph, u, v):
    """The shortest of the parallel edges u -> v, or None."""
    data = graph.get_edge_data(u, v)
    if not data:
        return None
    return min(data.values(), key=lambda edge: edge.get("length", float("inf")))


@bp.route("/api/osmnx-shortest-path", methods=["POST"])
def api_osmnx_shortest_path():
    payload = request.get_json(silent=True) or {}
    try:
        a_lng, a_lat = _read_point(payload.get("a") or {})
        b_lng, b_lat = _read_point(payload.get("b") or {})
    except Exception:
        return jsonify({"ok": False, "error": "invalid_points"}), 400
    graph, bbox = _cached_graph()
    if graph is None:
        return jsonify({"ok": False, "error": "no_graph_cached"}), 409
    # Both ends must lie in the saved network's area; otherwise the page falls back to an online router.
    if not (_bbox_contains(bbox, a_lng, a_lat) and _bbox_contains(bbox, b_lng, b_lat)):
        return jsonify({"ok": False, "error": "out_of_bounds"}), 404
    try:
        import networkx as nx
        import osmnx as ox
    except Exception as exc:
        return jsonify({"ok": False, "error": "osmnx_unavailable", "detail": str(exc)}), 500
    try:
        node_a = ox.distance.nearest_nodes(graph, a_lng, a_lat)
        node_b = ox.distance.nearest_nodes(graph, b_lng, b_lat)
    except Exception as exc:
        return jsonify({"ok": False, "error": "nearest_node_failed", "detail": str(exc)}), 500
    try:
        path = nx.shortest_path(graph, node_a, node_b, weight="length")
    except nx.NetworkXNoPath:
        return jsonify({"ok": False, "error": "no_path"}), 404
    except Exception as exc:
        return jsonify({"ok": False, "error": "shortest_path_failed", "detail": str(exc)}), 500

    coords = [[a_lng, a_lat]]
    distance = 0.0
    for u, v in zip(path, path[1:]):
        edge = _best_edge(graph, u, v)
        if edge is None:
            continue
        if edge.get("geometry") is not None:
            segment = [[float(x), float(y)] for x, y in edge["geometry"].coords]
        else:
            start = graph.nodes[u]
            end = graph.nodes[v]
            segment = [[float(start["x"]), float(start["y"])], [float(end["x"]), float(end["y"])]]
        if coords[-1] == segment[0]:
            segment = segment[1:]
        coords.extend(segment)
        length = edge.get("length")
        if isinstance(length, (int, float)) and math.isfinite(length):
            distance += float(length)
    coords.append([b_lng, b_lat])
    return jsonify({
        "ok": True,
        "geometry": {"type": "LineString", "coordinates": coords},
        "distanceMeters": distance,
        "nodes": len(path),
    })


def walking_isochrone(lng, lat, minutes, speed_mps):
    """The area reachable on foot in `minutes` from the cached graph: (response body, status)."""
    graph, bbox = _cached_graph()
    if graph is None:
        return {"ok": False, "error": "no_graph_cached"}, 409
    # The origin, and a rough circle of the walking range, must fit in the saved network's area or the
    # polygon would be clipped; the page then falls back to an online service.
    radius_m = minutes * 60.0 * speed_mps
    deg_lat = radius_m / 111000.0
    deg_lng = radius_m / (111000.0 * max(0.1, math.cos(math.radians(lat))))
    if not _bbox_contains(bbox, lng, lat):
        return {"ok": False, "error": "out_of_bounds"}, 404
    min_lng, min_lat, max_lng, max_lat = bbox
    if lng - deg_lng < min_lng or lng + deg_lng > max_lng or lat - deg_lat < min_lat or lat + deg_lat > max_lat:
        return {"ok": False, "error": "out_of_bounds"}, 404

    try:
        import networkx as nx
        import osmnx as ox
        from shapely.geometry import MultiPoint, mapping
        try:
            from shapely import concave_hull
        except Exception:
            concave_hull = None
    except Exception as exc:
        return {"ok": False, "error": "osmnx_unavailable", "detail": str(exc)}, 500
    try:
        origin = ox.distance.nearest_nodes(graph, lng, lat)
    except Exception as exc:
        return {"ok": False, "error": "nearest_node_failed", "detail": str(exc)}, 500

    # Undirected, so one-way streets don't cut a pedestrian off. Copying the graph costs seconds,
    # so the copy is kept on the graph object.
    undirected = getattr(graph, "reach_undirected", None)
    if undirected is None:
        undirected = graph.to_undirected() if graph.is_multigraph() or graph.is_directed() else graph
        graph.reach_undirected = undirected

    def seconds(_u, _v, edges):
        # a multigraph passes {key: edge data} for the parallel edges; the shortest one counts
        lengths = [edge["length"] for edge in edges.values() if isinstance(edge.get("length"), (int, float))]
        if not lengths:
            return None
        return min(lengths) / speed_mps

    try:
        costs = nx.single_source_dijkstra_path_length(undirected, origin, cutoff=minutes * 60.0, weight=seconds)
    except Exception as exc:
        return {"ok": False, "error": "dijkstra_failed", "detail": str(exc)}, 500

    points = []
    for node_id in costs:
        node = graph.nodes.get(node_id)
        if node:
            try:
                points.append((float(node["x"]), float(node["y"])))
            except Exception:
                continue
    if len(points) < 3:
        return {"ok": False, "error": "insufficient_coverage"}, 404

    hull_points = MultiPoint(points)
    polygon = None
    if concave_hull is not None:
        try:
            polygon = concave_hull(hull_points, ratio=0.35)
        except Exception:
            polygon = None
    if polygon is None or polygon.is_empty or polygon.geom_type not in ("Polygon", "MultiPolygon"):
        polygon = hull_points.convex_hull
    if polygon.geom_type == "LineString":
        polygon = polygon.buffer(1e-6)
    return {
        "ok": True,
        "minutes": minutes,
        "walkingSpeedMps": speed_mps,
        "reachableNodes": len(points),
        "geojson": {
            "type": "FeatureCollection",
            "features": [{"type": "Feature", "properties": {"contour": minutes, "metric": "time"},
                          "geometry": mapping(polygon)}],
        },
    }, 200


@bp.route("/api/osmnx-isochrone", methods=["POST"])
def api_osmnx_isochrone():
    payload = request.get_json(silent=True) or {}
    try:
        lng, lat = _read_point(payload.get("origin") or {})
    except Exception:
        return jsonify({"ok": False, "error": "invalid_origin"}), 400
    try:
        minutes = float(payload.get("minutes", 15))
    except Exception:
        minutes = 15.0
    if minutes <= 0 or minutes > 180:
        return jsonify({"ok": False, "error": "invalid_minutes"}), 400
    try:
        speed = float(payload.get("walkingSpeedMps", 1.4))  # ~5 km/h
    except Exception:
        speed = 1.4
    if speed <= 0:
        speed = 1.4
    body, status = walking_isochrone(lng, lat, minutes, speed)
    return jsonify(body), status


def _mapbox_isochrone(lng, lat, minutes, token):
    """(features, None) from the Mapbox isochrone API, or (None, why it failed)."""
    query = urllib.parse.urlencode({
        "contours_minutes": str(minutes), "polygons": "true", "denoise": "1", "access_token": token,
    })
    url = f"https://api.mapbox.com/isochrone/v1/mapbox/walking/{lng:.6f},{lat:.6f}?{query}"
    try:
        with urllib.request.urlopen(url, timeout=12) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read().decode("utf-8", "replace")[:200]
        except Exception:
            body = ""
        return None, f"http_{exc.code}: {body}"
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"
    if isinstance(data, dict) and data.get("features"):
        return data["features"], None
    return None, "empty_response"


@bp.route("/api/walk-reach", methods=["POST"])
def api_walk_reach():
    """n-minute walking reach: Mapbox (fast, no local network needed; proxied so the token stays
    here), falling back to the local OSMnx network when Mapbox is unavailable or offline."""
    payload = request.get_json(silent=True) or {}
    try:
        lng, lat = _read_point(payload.get("origin") or {})
    except Exception:
        return jsonify({"ok": False, "error": "invalid_origin"}), 400
    try:
        minutes = int(round(float(payload.get("minutes", 10))))
    except Exception:
        minutes = 10
    minutes = max(1, min(60, minutes))  # Mapbox's range

    token = config.mapbox_token()
    if not token:
        mapbox_error = "no_token"
    elif payload.get("forceOsmnx"):
        mapbox_error = "forced_osmnx"
    else:
        features, mapbox_error = _mapbox_isochrone(lng, lat, minutes, token)
        if features:
            return jsonify({"ok": True, "source": "mapbox", "minutes": minutes,
                            "geojson": {"type": "FeatureCollection", "features": features}})
        print(f"[Reach] Mapbox failed ({mapbox_error}); falling back to OSMnx", flush=True)

    graph, bbox = _cached_graph()
    if graph is None or not _bbox_contains(bbox, lng, lat):
        return jsonify({"ok": False, "error": "no_local_network", "mapboxError": mapbox_error}), 409
    try:
        body, _status = walking_isochrone(lng, lat, float(minutes), 1.4)
    except Exception as exc:
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}", "mapboxError": mapbox_error}), 500
    if not body.get("ok"):
        return jsonify({"ok": False, "error": body.get("error") or "reach_failed", "mapboxError": mapbox_error}), 502
    return jsonify({"ok": True, "source": "osmnx", "minutes": minutes, "geojson": body["geojson"],
                    "reachableNodes": body.get("reachableNodes"), "mapboxError": mapbox_error})
