"""Digitise a whole folder of workshop photos, one sub-folder per map.

    Photos/1/IMG_...jpg    map 1, photos in capture order
    Photos/2/...           map 2

Each photo showing the map's AprilTags is a sheet; photos without them (the
back of a sheet, a stray shot) are listed and skipped. Sheets are numbered 1, 2, ... per map in capture order -- file-name order,
which is the camera's -- and written to ``runs/<map>_<nn>`` (label "1-5").

Existing sheets are skipped, so an interrupted batch resumes where it stopped;
``--force`` redoes them (and loses any review of them). The VLM is loaded once
for the whole batch.
"""
from __future__ import annotations

import json
import re
import time
import traceback
from pathlib import Path

import cv2

from .pipeline import DEFAULT_RUNS, Options, run, sheet_label, sheet_run_id
from .register import detect_tags
from .sheet import default_sheets_dir, load_sheet

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff"}


def _natural(path: Path):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def plan_folder(folder: Path, map_id: str) -> tuple[list[dict], list[str]]:
    """Pair photos into sheets. Returns (sheets, photos that could not be placed)."""
    tag_ids = set(load_sheet(map_id).fiducials_pt)
    photos = sorted((p for p in folder.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES), key=_natural)
    sheets: list[dict] = []
    unplaced: list[str] = []
    for photo in photos:
        image = cv2.imread(str(photo), cv2.IMREAD_COLOR)
        if image is None:
            unplaced.append(f"{photo.name} (unreadable)")
            continue
        found = tag_ids & set(detect_tags(image))
        if len(found) >= 3:
            sheets.append({"map": map_id, "number": len(sheets) + 1, "label": sheet_label(map_id, len(sheets) + 1),
                           "mapPhoto": str(photo), "tags": len(found)})
        else:
            unplaced.append(f"{photo.name} (no tags of map {map_id})")
    return sheets, unplaced


def map_folders(root: Path, maps: list[str] | None, sheets_dir: Path) -> list[tuple[str, Path]]:
    folders = []
    for folder in sorted((p for p in root.iterdir() if p.is_dir()), key=_natural):
        if maps and folder.name not in maps:
            continue
        if (sheets_dir / f"{folder.name}.json").exists():
            folders.append((folder.name, folder))
    return folders


def run_batch(root: Path, maps: list[str] | None = None, use_vlm: bool = True, force: bool = False,
              session: str = "default", verify_stickers: bool = True, plan_only: bool = False,
              limit: int | None = None, vlm_url: str | None = None, vlm_model: str | None = None,
              vlm_quant: str = "4bit", runs_dir: Path = DEFAULT_RUNS, sheets_dir: Path | None = None) -> dict:
    root = Path(root)
    sheets_dir = Path(sheets_dir) if sheets_dir else default_sheets_dir()
    runs_dir.mkdir(parents=True, exist_ok=True)
    folders = map_folders(root, maps, sheets_dir)
    if not folders:
        raise SystemExit(f"no sub-folder of {root} is named after a map sheet in {sheets_dir}")

    plan: dict = {"root": str(root), "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "maps": {}}
    for map_id, folder in folders:
        sheets, unplaced = plan_folder(folder, map_id)
        plan["maps"][map_id] = {"folder": str(folder), "sheets": sheets, "unplaced": unplaced}
        print(f"map {map_id}: {len(sheets)} sheets"
              + (f", {len(unplaced)} photo(s) skipped: {', '.join(unplaced)}" if unplaced else ""), flush=True)
    (runs_dir / "batch-plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")
    if plan_only:
        return plan

    todo = [s for m in plan["maps"].values() for s in m["sheets"]
            if force or not (runs_dir / sheet_run_id(s["map"], s["number"]) / "result.json").exists()]
    total = sum(len(m["sheets"]) for m in plan["maps"].values())
    if limit is not None:
        todo = todo[:limit]
    print(f"{len(todo)} of {total} sheets to digitise"
          + ("" if len(todo) == total else " (the rest are done; --force redoes them)"), flush=True)

    vlm = None
    if use_vlm and todo:
        from .vlm import DEFAULT_MODEL, VLM
        vlm = VLM(model_id=vlm_model or DEFAULT_MODEL, backend="openai" if vlm_url else "transformers",
                  base_url=vlm_url, quant=vlm_quant, cache_path=runs_dir / "vlm_cache.jsonl")
    started, failures = time.time(), []
    for index, item in enumerate(todo, start=1):
        sheet_started = time.time()
        options = Options(map_id=item["map"], map_photo=Path(item["mapPhoto"]),
                          sheet_number=item["number"], session=session, use_vlm=use_vlm,
                          verify_stickers=verify_stickers, runs_dir=runs_dir, sheets_dir=sheets_dir)
        try:
            out = run(options, vlm=vlm)
            result = json.loads((out / "result.json").read_text(encoding="utf-8"))
            live = result["stickers"]
            routes = [r for r in result["routes"] if r["kind"] == "route"]
            flagged = sum(1 for s in live if s["flags"])
            summary = f"{len(live)} stickers ({flagged} to check), {len(routes)} route(s)"
        except Exception as exc:  # noqa: BLE001 - one bad photo must not stop the batch
            failures.append({"sheet": item["label"], "error": f"{type(exc).__name__}: {exc}",
                             "trace": traceback.format_exc()})
            summary = f"FAILED: {type(exc).__name__}: {exc}"
        elapsed = time.time() - started
        eta = elapsed / index * (len(todo) - index)
        print(f"[{index}/{len(todo)}] {item['label']:>5}  {time.time() - sheet_started:5.0f} s  {summary}"
              f"   (about {eta / 60:.0f} min left)", flush=True)
    if vlm is not None:
        vlm.unload()
    if failures:
        (runs_dir / "batch-failures.json").write_text(json.dumps(failures, ensure_ascii=False, indent=1),
                                                     encoding="utf-8")
        print(f"{len(failures)} sheet(s) failed; details in {runs_dir / 'batch-failures.json'}")
    print(f"done in {(time.time() - started) / 60:.0f} min")
    return plan
