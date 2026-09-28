"""The digitizer's page and API, as a Flask blueprint.

The workshop app mounts it at /digitizer/ (app.py; the home menu's
"Digitizer"). On its own: ``python -m digitizer serve`` -> http://127.0.0.1:5077/

Sheets are digitised one at a time on a worker thread (one GPU). Everything a
reviewer does goes through ``review.Run``. The page uses relative URLs only, so
it works under any prefix.

Configuration (the mounting app's ``config``): ``DIGITIZER_RUNS`` and
``DIGITIZER_SESSIONS`` (folders; default: next to this package),
``DIGITIZER_HOME`` (a "back to the menu" link on the page) and
``DIGITIZER_RESULTS`` (the workshop app's sessions folder, which its Results
page shows: "Move to Results" writes each sheet there as a session).
"""
from __future__ import annotations

import importlib.util
import json
import queue
import threading
import time
import traceback
from pathlib import Path

from flask import Blueprint, Flask, abort, current_app, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

from .palette import SessionPalette
from .pipeline import (DEFAULT_LEGEND, DEFAULT_RUNS, DEFAULT_SESSIONS, Options, load_legend, run,
                       sheet_label, sheet_run_id, to_geojson)
from .review import Run
from .sheet import load_sheet

STATIC = Path(__file__).resolve().parent / "static"
bp = Blueprint("digitizer", __name__)
jobs: dict[str, dict] = {}
work: "queue.Queue[tuple[str, Options]]" = queue.Queue()
_worker_lock = threading.Lock()
_worker: threading.Thread | None = None


def _work() -> None:
    while True:
        run_id, options = work.get()
        job = jobs[run_id]
        job.update(status="running", started=time.time())
        try:
            run(options)
            job["status"] = "done"
        except Exception as exc:  # noqa: BLE001 - reported to the page
            job.update(status="error", error=f"{type(exc).__name__}: {exc}", trace=traceback.format_exc())
        job["finished"] = time.time()


def _start_worker() -> None:
    global _worker
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, name="digitizer-worker", daemon=True)
            _worker.start()


def vlm_installed() -> bool:
    """Is the in-process VLM (torch + transformers) there at all? Without it sheets are read without it."""
    return all(importlib.util.find_spec(name) is not None for name in ("torch", "transformers"))


def _runs_dir() -> Path:
    return Path(current_app.config.get("DIGITIZER_RUNS") or DEFAULT_RUNS)


def _sessions_dir() -> Path:
    return Path(current_app.config.get("DIGITIZER_SESSIONS") or DEFAULT_SESSIONS)


def _results_dir() -> Path | None:
    configured = current_app.config.get("DIGITIZER_RESULTS")
    return Path(configured) if configured else None


def _run_dir(run_id: str) -> Path:
    path = _runs_dir() / secure_filename(run_id)
    if not (path / "result.json").exists():
        abort(404, f"no run {run_id}")
    return path


def _error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


@bp.get("/")
def page():
    html = (STATIC / "review.html").read_text(encoding="utf-8")
    home = str(current_app.config.get("DIGITIZER_HOME") or "")
    html = html.replace('data-home=""', f'data-home="{home}"', 1)
    return html, 200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"}


@bp.get("/static/<path:name>")
def static_file(name: str):
    return send_from_directory(STATIC, name, max_age=0)


@bp.get("/runs/<run_id>/<path:name>")
def run_file(run_id: str, name: str):
    return send_from_directory(_run_dir(run_id), name)


@bp.get("/api/info")
def info():
    return jsonify({"vlm": vlm_installed(), "results": _results_dir() is not None})


@bp.get("/api/legend")
def legend():
    session_name = request.args.get("session", "default")
    data = load_legend(DEFAULT_LEGEND)
    session = SessionPalette(data, _sessions_dir() / secure_filename(session_name))
    return jsonify({"legend": data, "palette": {"stickers": [c.to_dict() for c in session.stickers.classes],
                                                "pens": [c.to_dict() for c in session.pens.classes]}})


def _order(map_id: str, number) -> tuple:
    """Map 1 sheet 2 before map 1 sheet 10 before map 2; unnumbered runs last."""
    key = int(map_id) if str(map_id).isdigit() else 10**6
    return (number is None, key, str(map_id), number or 0)


@bp.get("/api/runs")
def list_runs():
    items = []
    for directory in _runs_dir().glob("*/result.json"):
        try:
            result = json.loads(directory.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        sheet = result.get("sheet") or {}
        items.append({
            "id": result["runId"], "mapId": result["mapId"], "number": sheet.get("number"),
            "label": sheet.get("label") if sheet.get("number") is not None else result["runId"],
            "status": (result.get("review") or {}).get("status", "pending"),
        })
    for run_id, job in jobs.items():
        if job["status"] in ("queued", "running", "error"):
            items = [i for i in items if i["id"] != run_id]
            items.append({"id": run_id, "mapId": job["mapId"], "number": job.get("number"),
                          "label": job.get("label", run_id), "status": job["status"], "error": job.get("error")})
    items.sort(key=lambda i: _order(i["mapId"], i["number"]))
    return jsonify(items)


def _next_sheet_number(map_id: str) -> int:
    numbers = [job.get("number") or 0 for job in jobs.values() if job.get("mapId") == map_id]
    for path in _runs_dir().glob("*/result.json"):
        try:
            sheet = json.loads(path.read_text(encoding="utf-8")).get("sheet") or {}
        except (OSError, json.JSONDecodeError):
            continue
        if str(sheet.get("map")) == map_id and sheet.get("number"):
            numbers.append(int(sheet["number"]))
    return max(numbers, default=0) + 1


@bp.post("/api/runs")
def start_run():
    map_id = secure_filename((request.form.get("mapId") or "").strip())
    photo = request.files.get("mapPhoto")
    if not map_id or photo is None or not photo.filename:
        return _error("a map id and a map photo are needed")
    number_text = (request.form.get("sheetNumber") or "").strip()
    if number_text and not number_text.isdigit():
        return _error("the sheet number must be a whole number")
    number = int(number_text) if number_text else _next_sheet_number(map_id)
    run_id = sheet_run_id(map_id, number)
    runs_dir = _runs_dir()
    if (runs_dir / run_id / "result.json").exists() and request.form.get("replace") != "1":
        return _error(f"sheet {sheet_label(map_id, number)} is already digitised")
    uploads = runs_dir / "_uploads" / run_id
    uploads.mkdir(parents=True, exist_ok=True)
    map_path = uploads / ("map" + Path(photo.filename).suffix.lower())
    photo.save(map_path)
    use_vlm = request.form.get("vlm", "1") != "0" and vlm_installed()
    options = Options(map_id=map_id, map_photo=map_path, sheet_number=number,
                      session=secure_filename(request.form.get("session") or "default"),
                      runs_dir=runs_dir, sessions_dir=_sessions_dir(), use_vlm=use_vlm)
    jobs[run_id] = {"status": "queued", "mapId": map_id, "number": number,
                    "label": sheet_label(map_id, number), "queued": time.time()}
    _start_worker()
    work.put((run_id, options))
    return jsonify({"ok": True, "runId": run_id, "label": sheet_label(map_id, number)})


@bp.get("/api/runs/<run_id>/status")
def run_status(run_id: str):
    job = jobs.get(run_id)
    if job is None:
        _run_dir(run_id)
        return jsonify({"status": "done"})
    return jsonify({k: v for k, v in job.items() if k != "trace"})


@bp.get("/api/runs/<run_id>")
def get_run(run_id: str):
    return send_from_directory(_run_dir(run_id), "result.json", max_age=0)


def _open(run_id: str) -> Run:
    return Run(_run_dir(run_id), sessions_dir=_sessions_dir())


def _edit(run_id: str, action):
    try:
        result = action(_open(run_id))
    except (KeyError, ValueError) as exc:
        return _error(str(exc))
    return jsonify({"ok": True, "result": result})


@bp.post("/api/runs/<run_id>/stickers/<int:sticker_id>")
def sticker_edit(run_id: str, sticker_id: int):
    body = request.get_json(force=True) or {}
    return _edit(run_id, lambda r: r.edit_sticker(sticker_id, colour=body.get("colour"), shape=body.get("shape"),
                                                  deleted=body.get("deleted"), confirm=bool(body.get("confirm"))))


@bp.post("/api/runs/<run_id>/stickers")
def sticker_add(run_id: str):
    body = request.get_json(force=True) or {}
    return _edit(run_id, lambda r: r.add_sticker(float(body["x"]), float(body["y"]), body["shape"], body.get("colour")))


@bp.post("/api/runs/<run_id>/routes/<int:route_id>")
def route_edit(run_id: str, route_id: int):
    body = request.get_json(force=True) or {}
    return _edit(run_id, lambda r: r.edit_route(route_id, pen=body.get("pen"), deleted=body.get("deleted"),
                                                kind=body.get("kind")))


@bp.post("/api/runs/<run_id>/routes")
def route_add(run_id: str):
    body = request.get_json(force=True) or {}
    return _edit(run_id, lambda r: r.add_route(body["points"], body["pen"]))


@bp.post("/api/runs/<run_id>/answers")
def answers(run_id: str):
    body = request.get_json(force=True) or {}
    return _edit(run_id, lambda r: r.set_answers(body.get("questionnaire")))


@bp.get("/api/runs/<run_id>/export.geojson")
def export(run_id: str):
    runner = _open(run_id)
    data = to_geojson(runner.result, runner.sheet, runner.legend)
    response = jsonify(data)
    response.headers["Content-Disposition"] = f'attachment; filename="{run_id}.geojson"'
    return response


def _all_results() -> list[dict]:
    results = []
    for path in _runs_dir().glob("*/result.json"):
        try:
            results.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    results.sort(key=lambda r: _order(r["mapId"], (r.get("sheet") or {}).get("number")))
    return results


def _sheet_label(result: dict) -> str:
    return (result.get("sheet") or {}).get("label") or result["runId"]


def _geojson_of(results: list[dict]):
    """(result, its GeoJSON) per sheet; each map record is loaded once."""
    legend = load_legend(DEFAULT_LEGEND)
    sheets: dict[str, object] = {}
    for result in results:
        map_id = str(result["mapId"])
        if map_id not in sheets:
            sheets[map_id] = load_sheet(map_id)
        yield result, to_geojson(result, sheets[map_id], legend)


@bp.get("/api/export.geojson")
def export_all():
    """Every sheet in one file: each feature says which sheet it is from."""
    features, collections = [], []
    for result, data in _geojson_of(_all_results()):
        label = _sheet_label(result)
        for feature in data["features"]:
            feature["properties"] = {"sheet": label, "mapId": str(result["mapId"]), **feature["properties"]}
            features.append(feature)
        collections.append({"sheet": label, **data["properties"]})
    response = jsonify({"type": "FeatureCollection", "features": features, "properties": {"sheets": collections}})
    response.headers["Content-Disposition"] = 'attachment; filename="digitized-sheets.geojson"'
    return response


def _empty() -> dict:
    return {"type": "FeatureCollection", "features": []}


def _to_results(results: list[dict]):
    """Write sheets as sessions of the workshop app's Results page.

    That page reads ``session_*.json`` with ``stickers`` (points) and
    ``drawings`` (lines) collections, each feature coloured by its ``color``;
    one file per sheet, so moving a sheet again replaces it there.
    """
    folder = _results_dir()
    if folder is None:
        return _error("this digitizer is not connected to a Results page", 404)
    folder.mkdir(parents=True, exist_ok=True)
    moved = []
    for result, data in _geojson_of(results):
        label = _sheet_label(result)
        kinds = {"sticker": [], "line": []}
        for feature in data["features"]:
            kinds.setdefault(feature["properties"]["kind"], []).append(feature)
        session = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": "digitizer", "runId": result["runId"], "mapId": str(result["mapId"]), "sheet": label,
            "basemap": "mapbox",
            "stickers": {"type": "FeatureCollection", "features": kinds["sticker"]},
            "drawings": {"type": "FeatureCollection", "features": kinds["line"]},
            "annotations": _empty(), "keyboardAnnotations": _empty(), "generalAnnotations": [],
            "questionnaire": data["properties"]["questionnaire"],
        }
        name = "session_sheet_" + secure_filename(label) + ".json"
        (folder / name).write_text(json.dumps(session, ensure_ascii=False, indent=1), encoding="utf-8")
        moved.append(label)
    return jsonify({"ok": True, "moved": moved})


@bp.post("/api/runs/<run_id>/to-results")
def run_to_results(run_id: str):
    return _to_results([json.loads((_run_dir(run_id) / "result.json").read_text(encoding="utf-8"))])


@bp.post("/api/to-results")
def all_to_results():
    return _to_results(_all_results())


def create_app() -> Flask:
    """The page on its own, at /."""
    app = Flask(__name__, static_folder=None)
    app.register_blueprint(bp)
    return app


def serve(host: str = "127.0.0.1", port: int = 5077) -> None:
    DEFAULT_RUNS.mkdir(parents=True, exist_ok=True)
    print(f"digitizer: http://{host}:{port}/")
    create_app().run(host=host, port=port, threaded=True, use_reloader=False)
