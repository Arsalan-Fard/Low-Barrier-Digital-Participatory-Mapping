"""Projects: the entries of data/workshops.json. A project has steps (what a workshop run shows) and owns
results: its workshop sessions (their workshopId), the digitised sheets of its paper maps (each map
record's projectId), GeoJSON uploaded into it (projectId) and, for the project "expo", the expo sessions."""
import json
import re
import secrets
import threading
from pathlib import Path

from . import config

EXPO_PROJECT_ID = "expo"
MAP_ID = re.compile(r"^[1-9][0-9]{0,8}$")
DIGITIZED_SHEET_FILE = re.compile(r"^([1-9][0-9]{0,8})_[0-9]+$")   # <map id>_<sheet number>.geojson

# workshops.json is written by the page (PUT /api/workshops) and here; one writer at a time.
lock = threading.RLock()


def load():
    """The workshops.json payload ({"workshops": [...]}): an empty one when there is no file, None when
    the file cannot be read (so nothing overwrites it)."""
    if not config.WORKSHOPS_FILE.exists():
        return {"workshops": []}
    try:
        data = json.loads(config.WORKSHOPS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("workshops"), list):
        return {"workshops": []}
    return data


def save(data):
    config.WORKSHOPS_FILE.parent.mkdir(parents=True, exist_ok=True)
    config.WORKSHOPS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def all_projects():
    return [p for p in (load() or {"workshops": []})["workshops"] if isinstance(p, dict) and p.get("id")]


def project_names():
    """{project id: name}."""
    return {str(p["id"]): str(p.get("name") or "") for p in all_projects()}


def clean_name(name):
    return " ".join(str(name or "").split())[:80]


def new_step(n):
    return {"id": n, "label": f"Step {n}", "theme": "streets", "indoor": False, "indoorId": "",
            "mapView": None, "labels": [], "images": [], "dataLayers": []}


def new_project(name, project_id=None):
    return {"id": project_id or "ws_" + secrets.token_hex(5), "name": clean_name(name), "steps": [new_step(1)]}


def project_for_name(name):
    """The id of the project called `name` (case and spacing ignored), made and saved when there is none;
    "" for an empty name or when workshops.json cannot be read."""
    name = clean_name(name)
    if not name:
        return ""
    with lock:
        data = load()
        if data is None:
            return ""
        key = name.casefold()
        for project in data["workshops"]:
            if isinstance(project, dict) and project.get("id") and clean_name(project.get("name")).casefold() == key:
                return str(project["id"])
        project = new_project(name)
        data["workshops"].append(project)
        save(data)
        return project["id"]


def map_record_path(map_id):
    return config.MAP_SHEETS_DIR / f"{map_id}.json" if MAP_ID.match(str(map_id or "")) else None


def read_map_record(map_id):
    path = map_record_path(map_id)
    try:
        record = json.loads(path.read_text(encoding="utf-8")) if path else None
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def map_id_of_result(filename, data):
    """The paper map a digitised sheet's GeoJSON is from: its mapId, else its <map id>_<n> file name."""
    map_id = str(data.get("mapId") or "").strip()
    if not map_id:
        match = DIGITIZED_SHEET_FILE.match(Path(filename).stem)
        map_id = match.group(1) if match else ""
    return map_id if MAP_ID.match(map_id) else ""


def project_of_result(kind, filename, data, map_cache=None):
    """The id of the project a result file belongs to, or "" when it belongs to none. `map_cache`
    ({map id: record or None}) saves rereading a map record for each of its sheets."""
    if kind == "expo":
        return EXPO_PROJECT_ID
    if kind == "geojson":
        project = str(data.get("projectId") or "").strip()
        if project:
            return project
        map_id = map_id_of_result(filename, data)
        if not map_id:
            return ""
        if map_cache is None:
            map_cache = {}
        if map_id not in map_cache:
            map_cache[map_id] = read_map_record(map_id)
        return str((map_cache[map_id] or {}).get("projectId") or "").strip()
    return str(data.get("workshopId") or "").strip()


def ensure_result_projects():
    """Give each paper map with digitised results a project (named by the map's title) and the expo
    sessions the project "expo". Writes only what is missing."""
    with lock:
        if load() is None:
            return
        map_ids = set()
        for path in config.SESSIONS_DIR.glob("*.geojson") if config.SESSIONS_DIR.exists() else []:
            try:
                data = json.loads(path.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict) and not str(data.get("projectId") or "").strip():
                map_id = map_id_of_result(path.name, data)
                if map_id:
                    map_ids.add(map_id)
        for map_id in sorted(map_ids, key=int):
            record = read_map_record(map_id)
            if record is None or str(record.get("projectId") or "").strip():
                continue
            project_id = project_for_name(record.get("title") or f"Map {map_id}")
            if not project_id:
                continue
            record["projectId"] = project_id
            map_record_path(map_id).write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        has_expo = config.EXPO_SESSIONS_DIR.exists() and any(config.EXPO_SESSIONS_DIR.glob("expo_*.json"))
        data = load()
        if has_expo and data is not None and not any(
                isinstance(p, dict) and str(p.get("id")) == EXPO_PROJECT_ID for p in data["workshops"]):
            data["workshops"].append(new_project("Expo", EXPO_PROJECT_ID))
            save(data)


def remove_data_layers(keys):
    """Take the data layer keys (e.g. "result:geojson:1_01.geojson") out of every step."""
    keys = set(keys)
    if not keys:
        return
    with lock:
        data = load()
        if data is None:
            return
        changed = False
        for project in data["workshops"]:
            for step in (project.get("steps") or []) if isinstance(project, dict) else []:
                layers = step.get("dataLayers") if isinstance(step, dict) else None
                if isinstance(layers, list) and any(layer in keys for layer in layers):
                    step["dataLayers"] = [layer for layer in layers if layer not in keys]
                    changed = True
        if changed:
            save(data)
