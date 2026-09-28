"""Command line: ``python -m digitizer run ...`` or ``python -m digitizer serve``."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SHEETS_HELP = ("folder with the map sheet records <id>.json + <id>.png "
               "(default: the app's data/map_sheets, which is not in git)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m digitizer", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    run_p = sub.add_parser("run", help="digitise one sheet from its map photo")
    run_p.add_argument("--map-id", required=True, help="map sheet id, as in data/map_sheets/<id>.json")
    run_p.add_argument("--map-photo", required=True, type=Path)
    run_p.add_argument("--session", default="default", help="palette/corrections to use and learn into")
    run_p.add_argument("--legend", type=Path, help="legend.json (default: the one next to this package)")
    run_p.add_argument("--no-vlm", action="store_true", help="skip the questionnaire and sticker checks")
    run_p.add_argument("--no-verify-stickers", action="store_true", help="do not ask the VLM about doubtful stickers")
    run_p.add_argument("--vlm-url", help="OpenAI-compatible server (e.g. vLLM on a bigger GPU): http://host:8000/v1")
    run_p.add_argument("--vlm-model", help="model id (default Qwen/Qwen3-VL-4B-Instruct)")
    run_p.add_argument("--vlm-quant", default="4bit", choices=["4bit", "8bit", "none"],
                       help="in-process quantisation (8 GB GPU: 4bit)")
    run_p.add_argument("--map-width", type=int, help="rectified map width in px (default: the photo's native)")
    run_p.add_argument("--sheets", type=Path, help=SHEETS_HELP)

    batch_p = sub.add_parser("batch", help="digitise a folder with one sub-folder per map (Photos/1, Photos/2, ...)")
    batch_p.add_argument("--photos", required=True, type=Path, help="folder holding one sub-folder per map id")
    batch_p.add_argument("--maps", nargs="*", help="only these map ids (sub-folder names)")
    batch_p.add_argument("--session", default="default")
    batch_p.add_argument("--no-vlm", action="store_true")
    batch_p.add_argument("--no-verify-stickers", action="store_true")
    batch_p.add_argument("--force", action="store_true", help="redo sheets that are already digitised")
    batch_p.add_argument("--plan-only", action="store_true", help="only show how photos pair into sheets")
    batch_p.add_argument("--limit", type=int, help="digitise at most this many sheets (the next ones not done yet)")
    batch_p.add_argument("--sheets", type=Path, help=SHEETS_HELP)
    batch_p.add_argument("--vlm-url", help="OpenAI-compatible server, e.g. vLLM on a bigger GPU: http://host:8000/v1")
    batch_p.add_argument("--vlm-model", help="model id (default Qwen/Qwen3-VL-4B-Instruct)")
    batch_p.add_argument("--vlm-quant", default="4bit", choices=["4bit", "8bit", "none"],
                         help="in-process quantisation: 4bit for 8 GB, none (bf16) on a big GPU")

    serve_p = sub.add_parser("serve", help="review page on http://127.0.0.1:<port>/")
    serve_p.add_argument("--port", type=int, default=5077)
    serve_p.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to open it to other devices on the network")
    serve_p.add_argument("--sheets", type=Path, help=SHEETS_HELP)

    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if getattr(args, "sheets", None):
        if not any(args.sheets.glob("*.json")):
            parser.error(f"no sheet records (*.json + *.png) in {args.sheets}")
        os.environ["DIGITIZER_SHEETS"] = str(args.sheets.resolve())

    if args.command == "run":
        from .pipeline import DEFAULT_LEGEND, Options, run
        options = Options(
            map_id=args.map_id, map_photo=args.map_photo,
            legend_path=args.legend or DEFAULT_LEGEND, session=args.session, use_vlm=not args.no_vlm,
            verify_stickers=not args.no_verify_stickers,
            vlm_backend="openai" if args.vlm_url else "transformers", vlm_url=args.vlm_url,
            vlm_model=args.vlm_model, vlm_quant=args.vlm_quant, map_width=args.map_width,
        )
        out = run(options)
        result = json.loads((out / "result.json").read_text(encoding="utf-8"))
        flagged = [s for s in result["stickers"] if s["flags"]]
        print(f"run {result['runId']}  ({result['seconds']} s)  ->  {out}")
        print(f"  tags {result['registration']['tagsFound']}  map {result['map']['width']} px, "
              f"{result['map']['pxPerMm']} px/mm")
        print(f"  stickers {len(result['stickers'])} ({len(flagged)} flagged for review)")
        for s in result["stickers"]:
            print(f"    #{s['id']:<3} {s['shape']:8} {str(s['colour']):7} {str(s['category']):15} "
                  f"p={s['colour_confidence']:.2f}  {' '.join(s['flags'])}")
        routes = [r for r in result["routes"] if r["kind"] == "route"]
        print(f"  routes {len(routes)}: " + ", ".join(
            f"#{r['id']} {r['pen']} {r['length_px'] / result['map']['pxPerMm']:.0f} mm" for r in routes))
        if result.get("questionnaire"):
            print("  questionnaire", json.dumps(result["questionnaire"].get("fields"), ensure_ascii=False))
        print("  timings", result["timings"])
        return 0

    if args.command == "batch":
        from .batch import run_batch
        run_batch(args.photos, maps=args.maps, use_vlm=not args.no_vlm, force=args.force, session=args.session,
                  verify_stickers=not args.no_verify_stickers, plan_only=args.plan_only, limit=args.limit,
                  vlm_url=args.vlm_url, vlm_model=args.vlm_model, vlm_quant=args.vlm_quant)
        return 0

    from .server import serve
    serve(host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
