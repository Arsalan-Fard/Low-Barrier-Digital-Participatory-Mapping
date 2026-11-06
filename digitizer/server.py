"""The Digitizer's page and API, mounted at /digitizer/ by app.py (the home menu's "Digitize Paper Map").

Uploaded photos become sheets: each is prepared (straightened and colour-corrected),
digitised with the full list and, when a handwriting model is chosen, its handwriting
read -- one sheet at a time on a worker thread. A sheet's list can then be edited and
the sheet digitised again. Everything a reviewer does goes through ``review.Run``.
Its folders are in backend/config.py.
"""
from __future__ import annotations

import json
import queue
import re
import threading
import time
import traceback
from pathlib import Path

from flask import Blueprint, abort, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

from backend import config
from . import vlm as models
from .pipeline import (Options, digitize, load_legend, photo_of, prepare, read_texts, results_geojson_path,
                       sheet_label, sheet_run_id, to_geojson)
from .review import Run
from .sheet import load_sheet
from .workshop import Workshop

STATIC = Path(__file__).resolve().parent / "static"
bp = Blueprint("digitizer", __name__)
jobs: dict[str, dict] = {}
work: "queue.Queue[tuple[str, str, Options]]" = queue.Queue()
# A photo named like "2_05_map.jpg" is sheet 5 of map 2.
PHOTO_NAME = re.compile(r"^(\d+)[_-](\d+)")
_worker_lock = threading.Lock()
_worker: threading.Thread | None = None
_local_vlm: "models.VLM | None" = None   # the model on this computer, loaded once for a batch


def _vlm(key: str) -> "models.VLM":
    """The handwriting model: on this computer kept loaded while sheets wait; a server's is new each
    time, so a changed address applies at once."""
    global _local_vlm
    if models.MODELS[key]["backend"] != "local":
        return models.VLM(key, cache_path=Path(config.DIGITIZED_SHEETS_DIR) / "vlm_cache.jsonl")
    if _local_vlm is None:
        _local_vlm = models.VLM(key, cache_path=Path(config.DIGITIZED_SHEETS_DIR) / "vlm_cache.jsonl")
    return _local_vlm


def _work() -> None:
    global _local_vlm
    while True:
        run_id, kind, options = work.get()
        job = jobs[run_id]
        job.update(status="running", started=time.time())
        out = Path(options.runs_dir) / run_id
        try:
            if kind == "upload":   # prepared, then digitised: the sheet can be looked at in between
                prepare(options)
                job["kind"] = "digitize"
            if kind in ("upload", "digitize"):
                digitize(out, options)
            if options.vlm:
                job["kind"] = "handwriting"
                read_texts(out, options, _vlm(options.vlm))
            job["status"] = "done"
        except Exception as exc:  # noqa: BLE001 - reported to the page
            job.update(status="error", error=f"{type(exc).__name__}: {exc}", trace=traceback.format_exc())
        job["finished"] = time.time()
        if work.empty() and _local_vlm is not None:   # the batch is done: free the GPU
            _local_vlm.unload()
            _local_vlm = None


def _busy(run_id: str) -> bool:
    return jobs.get(run_id, {}).get("status") in ("queued", "running")


def _queue(run_id: str, kind: str, options: Options, label: str, number) -> None:
    jobs[run_id] = {"status": "queued", "kind": kind, "mapId": options.map_id, "number": number,
                    "label": label, "queued": time.time()}
    _start_worker()
    work.put((run_id, kind, options))


def _start_worker() -> None:
    global _worker
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, name="digitizer-worker", daemon=True)
            _worker.start()


def _run_dir(run_id: str) -> Path:
    path = Path(config.DIGITIZED_SHEETS_DIR) / secure_filename(run_id)
    if not (path / "result.json").exists():
        abort(404, f"no run {run_id}")
    return path


def _error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


@bp.get("/")
def page():
    response = send_from_directory(STATIC, "review.html", max_age=0)
    response.headers["Cache-Control"] = "no-store"
    return response


@bp.get("/static/<path:name>")
def static_file(name: str):
    return send_from_directory(STATIC, name, max_age=0)


@bp.get("/runs/<run_id>/<path:name>")
def run_file(run_id: str, name: str):
    return send_from_directory(_run_dir(run_id), name)


def _workshop(session: str = "default") -> Workshop:
    return Workshop(load_legend(config.DIGITIZER_LEGEND_FILE), config.DIGITIZED_SHEETS_DIR, session, config.DIGITIZER_PALETTES_DIR)


@bp.get("/api/legend")
def legend():
    """The shapes and every sticker colour and pen name the workshop knows."""
    return jsonify({"legend": _workshop(request.args.get("session") or "default").summary()})


def _order(map_id: str, number) -> tuple:
    """Map 1 sheet 2 before map 1 sheet 10 before map 2; unnumbered runs last."""
    key = int(map_id) if str(map_id).isdigit() else 10**6
    return (number is None, key, str(map_id), number or 0)


@bp.get("/api/runs")
def list_runs():
    items = []
    for directory in Path(config.DIGITIZED_SHEETS_DIR).glob("*/result.json"):
        try:
            result = json.loads(directory.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        sheet = result.get("sheet") or {}
        items.append({
            "id": result["runId"], "mapId": result["mapId"], "number": sheet.get("number"),
            "label": sheet.get("label") if sheet.get("number") is not None else result["runId"],
            "status": "prepared" if result.get("stage") == "prepared"
            else (result.get("review") or {}).get("status", "pending"),
        })
    for run_id, job in jobs.items():
        if job.get("kind") in ("digitize", "handwriting"):   # the sheet stays listed; the page shows it busy
            for item in items:
                if item["id"] == run_id and job["status"] in ("queued", "running"):
                    item["status"] = "digitizing" if job["kind"] == "digitize" else "reading"
        elif job["status"] in ("queued", "running", "error"):
            items = [i for i in items if i["id"] != run_id]
            items.append({"id": run_id, "mapId": job["mapId"], "number": job.get("number"),
                          "label": job.get("label", run_id), "status": job["status"], "error": job.get("error")})
    items.sort(key=lambda i: _order(i["mapId"], i["number"]))
    return jsonify(items)


def _next_sheet_number(map_id: str) -> int:
    numbers = [job.get("number") or 0 for job in jobs.values() if job.get("mapId") == map_id]
    for path in Path(config.DIGITIZED_SHEETS_DIR).glob("*/result.json"):
        try:
            sheet = json.loads(path.read_text(encoding="utf-8")).get("sheet") or {}
        except (OSError, json.JSONDecodeError):
            continue
        if str(sheet.get("map")) == map_id and sheet.get("number"):
            numbers.append(int(sheet["number"]))
    return max(numbers, default=0) + 1


def _number_in_name(filename: str, map_id: str) -> int | None:
    match = PHOTO_NAME.match(Path(filename).name)
    return int(match.group(2)) if match and match.group(1) == map_id and int(match.group(2)) > 0 else None


@bp.post("/api/runs")
def start_run():
    """Upload map photos of one map: each becomes a sheet, prepared and digitised in turn. Its number:
    the one given (a single photo only), else the one in its name ("2_05_map.jpg"), else the next free.
    {runs: [{runId, label, file}], failed: [{file, error}]}"""
    map_id = secure_filename((request.form.get("mapId") or "").strip())
    photos = [photo for photo in request.files.getlist("mapPhoto") if photo and photo.filename]
    if not map_id or not photos:
        return _error("a map id and at least one map photo are needed")
    number_text = (request.form.get("sheetNumber") or "").strip()
    if number_text and not number_text.isdigit():
        return _error("the sheet number must be a whole number")
    if number_text and len(photos) > 1:
        return _error("a sheet number can only be given for a single photo")
    model = (request.form.get("vlm") or "").strip()
    if model and model not in models.MODELS:
        return _error(f"unknown handwriting model {model}")
    runs_dir = Path(config.DIGITIZED_SHEETS_DIR)
    session = secure_filename(request.form.get("session") or "default")
    started, failed = [], []
    for photo in photos:
        number = int(number_text) if number_text else (_number_in_name(photo.filename, map_id)
                                                       or _next_sheet_number(map_id))
        run_id, label = sheet_run_id(map_id, number), sheet_label(map_id, number)
        if (runs_dir / run_id / "result.json").exists() and request.form.get("replace") != "1":
            failed.append({"file": photo.filename, "error": f"sheet {label} is already digitised"})
            continue
        if _busy(run_id):
            failed.append({"file": photo.filename, "error": f"sheet {label} is already being digitised"})
            continue
        folder = runs_dir / run_id
        folder.mkdir(parents=True, exist_ok=True)
        for old in folder.glob("photo.*"):
            old.unlink()
        map_path = folder / ("photo" + Path(photo.filename).suffix.lower())   # the sheet folder keeps its photo
        photo.save(map_path)
        options = Options(map_id=map_id, map_photo=map_path, sheet_number=number, session=session, runs_dir=runs_dir,
                          vlm=model)
        _queue(run_id, "upload", options, label, number)
        started.append({"runId": run_id, "label": label, "file": photo.filename})
    if not started:
        return _error("; ".join(f"{item['file']}: {item['error']}" for item in failed))
    return jsonify({"ok": True, "runs": started, "failed": failed})


@bp.post("/api/runs/<run_id>/digitize")
def run_digitize(run_id: str):
    """Digitize the sheet with its list; done before, it is digitised again (what was done by hand stays)."""
    folder = _run_dir(run_id)
    if _busy(run_id):
        return _error("this sheet is already being digitised", 409)
    runner = _open(run_id)
    result = runner.result
    sheet = result.get("sheet") or {}
    try:
        photo_of(folder, result)
    except FileNotFoundError:
        return _error("the photo of this sheet is not here any more: put it back where it was read from, "
                      "as photo.jpg in the sheet's folder, or in the photos folder")
    options = Options(map_id=str(result["mapId"]), map_photo=Path(result["inputs"]["mapPhoto"]),
                      sheet_number=sheet.get("number"), session=result.get("session", "default"),
                      runs_dir=folder.parent, run_id=run_id)
    runner.checkpoint()
    _queue(run_id, "digitize", options, sheet.get("label") or run_id, sheet.get("number"))
    return jsonify({"ok": True, "runId": run_id, "label": sheet.get("label") or run_id})


@bp.post("/api/runs/<run_id>/handwriting")
def run_handwriting(run_id: str):
    """Read the sheet's handwriting with {"model": <vlm.MODELS key>}; texts typed or fixed by hand stay."""
    folder = _run_dir(run_id)
    model = str((request.get_json(silent=True) or {}).get("model") or "")
    if model not in models.MODELS:
        return _error("choose a handwriting model")
    if _busy(run_id):
        return _error("this sheet is busy", 409)
    runner = _open(run_id)
    result = runner.result
    if result.get("stage") == "prepared":
        return _error("digitize this sheet first")
    sheet = result.get("sheet") or {}
    options = Options(map_id=str(result["mapId"]), map_photo=Path(result["inputs"]["mapPhoto"]),
                      sheet_number=sheet.get("number"), session=result.get("session", "default"),
                      runs_dir=folder.parent, run_id=run_id, vlm=model)
    runner.checkpoint()
    _queue(run_id, "handwriting", options, sheet.get("label") or run_id, sheet.get("number"))
    return jsonify({"ok": True, "runId": run_id, "label": sheet.get("label") or run_id})


@bp.get("/api/runs/<run_id>/status")
def run_status(run_id: str):
    job = jobs.get(run_id)
    if job is None:
        _run_dir(run_id)
        return jsonify({"status": "done"})
    return jsonify({k: v for k, v in job.items() if k != "trace"})


@bp.get("/api/runs/<run_id>")
def get_run(run_id: str):
    return jsonify(_open(run_id).view())


def _open(run_id: str) -> Run:
    return Run(_run_dir(run_id))


def _edit(run_id: str, action):
    if _busy(run_id):
        return _error("this sheet is being digitised: wait a moment", 409)
    runner = _open(run_id)
    try:
        result = action(runner)
    except (KeyError, ValueError) as exc:
        return _error(str(exc))
    return jsonify({"ok": True, "result": runner.view(result)})


@bp.post("/api/runs/<run_id>/list")
def list_set(run_id: str):
    body = request.get_json(force=True) or {}
    return _edit(run_id, lambda r: r.set_list(body.get("stickers", []), body.get("pens", [])))


@bp.post("/api/runs/<run_id>/looks")
def look_add(run_id: str):
    body = request.get_json(force=True) or {}
    return _edit(run_id, lambda r: r.add_look(body["kind"], body["name"], float(body["x"]), float(body["y"]),
                                              body.get("shape")))


@bp.post("/api/runs/<run_id>/stickers")
def sticker_add(run_id: str):
    body = request.get_json(force=True) or {}
    return _edit(run_id, lambda r: r.add_sticker(float(body["x"]), float(body["y"]), body["shape"], body["colour"]))


@bp.post("/api/runs/<run_id>/routes")
def route_add(run_id: str):
    body = request.get_json(force=True) or {}
    return _edit(run_id, lambda r: r.add_route(body["points"], body["pen"]))


@bp.post("/api/runs/<run_id>/erase")
def erase(run_id: str):
    body = request.get_json(force=True) or {}
    return _edit(run_id, lambda r: r.erase([int(i) for i in body.get("stickers", [])],
                                           [int(i) for i in body.get("routes", [])],
                                           [int(i) for i in body.get("texts", [])]))


@bp.post("/api/runs/<run_id>/texts")
def text_edit(run_id: str):
    """{"x", "y", "text"} adds a text; {"id", "text"} fixes one."""
    body = request.get_json(force=True) or {}
    if body.get("id") is not None:
        return _edit(run_id, lambda r: r.set_text(int(body["id"]), body.get("text", "")))
    return _edit(run_id, lambda r: r.add_text(float(body["x"]), float(body["y"]), body.get("text", "")))


@bp.get("/api/vlm")
def vlm_status():
    """The handwriting models the page offers: [{id, label, where, available, why}], "No VLM" first,
    and the server's address."""
    local_ok, local_why = models.local_status()
    server_ok, server_why = models.server_status()
    status = {"local": (local_ok, local_why), "server": (server_ok, server_why)}
    settings = models.load_settings()
    return jsonify({
        "models": [{"id": "", "label": "No VLM", "where": "", "available": True, "why": ""}] + [
            {"id": key, "label": spec["label"], "where": spec["where"], "available": status[spec["backend"]][0],
             "why": status[spec["backend"]][1]} for key, spec in models.MODELS.items()],
        "server": {"url": settings.get("serverUrl", ""),
                   "model": settings.get("serverModel") or models.MODELS["qwen3-vl-32b"]["model"]},
    })


@bp.post("/api/vlm")
def vlm_settings():
    """{"serverUrl", "serverModel"}: where the server model is; answers with the models' status."""
    body = request.get_json(force=True) or {}
    models.save_settings({"serverUrl": body.get("serverUrl", ""), "serverModel": body.get("serverModel", "")})
    return vlm_status()


@bp.post("/api/runs/<run_id>/undo")
def undo(run_id: str):
    return _edit(run_id, lambda r: r.undo())


@bp.post("/api/runs/<run_id>/redo")
def redo(run_id: str):
    return _edit(run_id, lambda r: r.redo())


@bp.get("/api/runs/<run_id>/export.geojson")
def export(run_id: str):
    runner = _open(run_id)
    data = to_geojson(runner.result, runner.sheet, runner.workshop().export_legend(runner.result))
    response = jsonify(data)
    response.headers["Content-Disposition"] = f'attachment; filename="{run_id}.geojson"'
    return response


def _all_results() -> list[dict]:
    results = []
    for path in Path(config.DIGITIZED_SHEETS_DIR).glob("*/result.json"):
        try:
            results.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    results.sort(key=lambda r: _order(r["mapId"], (r.get("sheet") or {}).get("number")))
    return results


def _sheet_label(result: dict) -> str:
    return (result.get("sheet") or {}).get("label") or result["runId"]


def _geojson_of(results: list[dict]):
    """(result, its GeoJSON) per sheet; each map record and session is loaded once."""
    sheets: dict[str, object] = {}
    workshops: dict[str, Workshop] = {}
    for result in results:
        map_id, session = str(result["mapId"]), result.get("session", "default")
        if map_id not in sheets:
            sheets[map_id] = load_sheet(map_id)
        if session not in workshops:
            workshops[session] = _workshop(session)
        yield result, to_geojson(result, sheets[map_id], workshops[session].export_legend(result))


@bp.get("/api/export.geojson")
def export_all():
    """Every sheet in one file: each feature says which sheet it is from."""
    features = []
    for result, data in _geojson_of(_all_results()):
        label = _sheet_label(result)
        for feature in data["features"]:
            feature["properties"] = {"sheet": label, "mapId": str(result["mapId"]), **feature["properties"]}
            features.append(feature)
    response = jsonify({"type": "FeatureCollection", "features": features})
    response.headers["Content-Disposition"] = 'attachment; filename="digitized-sheets.geojson"'
    return response


@bp.get("/api/runs/<run_id>/results-file")
def results_file(run_id: str):
    """Where the sheet is in the Results panel: its GeoJSON in the results folder (written on each
    save once digitised)."""
    result = json.loads((_run_dir(run_id) / "result.json").read_text(encoding="utf-8"))
    path = results_geojson_path(result)
    return jsonify({"path": str(path.resolve()), "exists": path.exists()})
