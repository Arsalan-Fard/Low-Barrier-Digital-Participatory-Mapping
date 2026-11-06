"""The HTML pages, the generated src/config.js, /data files and the bundled Maputnik build."""
import json

from flask import Blueprint, Response, jsonify, redirect, request, send_from_directory

from . import config
from .marker_settings import load_marker_settings

bp = Blueprint("pages", __name__)

NO_STORE = "no-store, no-cache, must-revalidate, max-age=0"


@bp.route("/")
def root():
    return redirect("/home", code=302)


@bp.route("/home")
def home_page():
    return send_from_directory(config.WEB_DIR, "home.html")


@bp.route("/marker")
def marker_page():
    return send_from_directory(config.WEB_DIR, "marker.html")


@bp.route("/map")
@bp.route("/floorplan")
def map_page():
    return send_from_directory(config.WEB_DIR, "index.html")


@bp.route("/data/<path:filename>")
def data_asset(filename):
    # data/ is outside the static web/ folder (it mixes shipped datasets with app state).
    return send_from_directory(config.ROOT / "data", filename)


@bp.route("/src/config.js")
def serve_config_js():
    """config.js with the Mapbox token (kept out of git, in token.txt) and the marker settings filled in."""
    try:
        text = (config.WEB_DIR / "src" / "config.js").read_text(encoding="utf-8")
    except Exception:
        return Response("// config.js not found", status=404, mimetype="application/javascript")
    text = text.replace("__MAPBOX_TOKEN__", config.mapbox_token())
    settings = json.dumps(load_marker_settings(), ensure_ascii=True)
    text = text.replace("markerSettings: null,", "markerSettings: " + settings + ",")
    return Response(text, mimetype="application/javascript", headers={"Cache-Control": "no-store"})


@bp.route("/api/google-maps-key", methods=["GET"])
def api_google_maps_key():
    return jsonify({"ok": True, "key": config.google_maps_key()})


@bp.route("/maputnik/")
def maputnik_page():
    response = send_from_directory(config.MAPUTNIK_DIST_DIR, "index.html")
    response.headers["Cache-Control"] = NO_STORE
    response.headers["Pragma"] = "no-cache"
    return response


def _style_with_absolute_sprites(path):
    """The style at `path` with its root-relative sprite URLs made absolute for this host, or None.
    MapLibre resolves sprite URLs with `new URL(url)` and no base, and one failing sprite silently
    drops the basemap's icons too."""
    if not path.exists():
        return None
    try:
        style = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    sprites = style.get("sprite") if isinstance(style, dict) else None
    if not isinstance(sprites, list):
        return None
    base = request.host_url.rstrip("/")
    for entry in sprites:
        url = str(entry.get("url") or "")
        if url.startswith("/"):
            entry["url"] = base + url
    return style


@bp.route("/maputnik/<path:filename>")
def maputnik_asset(filename):
    if filename.endswith(".json") and "styles/" in filename.replace("\\", "/"):
        path = (config.MAPUTNIK_DIST_DIR / filename).resolve()
        try:
            path.relative_to(config.MAPUTNIK_DIST_DIR.resolve())
        except ValueError:
            return "", 404
        style = _style_with_absolute_sprites(path)
        if style is not None:
            response = jsonify(style)
            response.headers["Cache-Control"] = NO_STORE
            return response
    response = send_from_directory(config.MAPUTNIK_DIST_DIR, filename)
    response.headers["Cache-Control"] = NO_STORE
    response.headers["Pragma"] = "no-cache"
    return response
