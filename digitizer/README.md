# digitizer — paper map sheets to data, with a human in the loop

Reads a photographed i-mobyl sheet (the map side with its 8 AprilTags) and
produces stickers, routes and the questionnaire's checkboxes as JSON and GeoJSON,
plus a page where a person checks and corrects the result. Corrections teach the
session's colour palette, so a new sticker stock or a pink that looks red is
fixed once, not on every sheet.

The workshop app mounts it as the home menu's **Digitizer** (`python app.py`, then
http://127.0.0.1:5000/digitizer/); it also runs on its own. Either way it reads
`data/map_sheets/<id>.json|png` and never writes there; its results and learned
colours stay in `digitizer/runs/` and `digitizer/sessions/`. (It replaced the
map page's old Digitize panel on 2026-09-25.)

## Quick start

```bash
pip install -r digitizer/requirements.txt         # or reuse the global env: torch, transformers>=4.57, bitsandbytes
python -m digitizer run --map-id 2 --map-photo digitizer/IMG_20260924_121031.jpg
python -m digitizer serve                          # the page on its own: http://127.0.0.1:5077/
```

Without torch/transformers (e.g. the standalone app builds) sheets are still
digitised -- stickers and routes -- but the questionnaire is not read.

A whole workshop, one sub-folder per map id (`Photos/1`, `Photos/2`, ...):

```bash
python -m digitizer batch --photos D:/IP3/IMOBYL/Photos --plan-only   # which photos are sheets
python -m digitizer batch --photos D:/IP3/IMOBYL/Photos               # digitise; resumes if interrupted
python -m digitizer batch --photos D:/IP3/IMOBYL/Photos --limit 5     # only the next 5 sheets not done yet
```

Each photo showing the map's tags is a sheet; photos without them (the back of
a sheet) are listed and skipped. Sheets are numbered in capture (file-name)
order per map and stored as `runs/<map>_<nn>`; the page lists them as
`1-1 … 1-25, 2-1 …`. The plan is written to `runs/batch-plan.json`. Already
digitised sheets are skipped (`--force` redoes them and loses their corrections).

`--no-vlm` skips the questionnaire and the sticker second opinions (about
20-30 s per sheet instead of about a minute on the laptop GPU). The first VLM
run downloads `Qwen/Qwen3-VL-4B-Instruct` (~9 GB) into the Hugging Face cache.

## The page

* One row on top: ‹ Menu, the sheet, **New sheet** (a map photo), then the map
  tools: Select, Add sticker (A), Draw route (R), Fit (F), overlay opacity, and
  **Short strokes** (pen lines under 25 mm — ticks, crosses, arrows — which are
  not counted as routes and are hidden by default).
* **To check** lists what the pipeline doubts; clicking an item zooms to it. The
  inspector below changes a sticker's shape or colour, confirms it, or deletes
  it; picking a colour teaches the session palette and re-checks the sheet.
* **Answers** swaps the map for the photographed checkbox side (wheel to zoom,
  drag to pan), with the checkboxes on the right to correct and save. Names are
  not read.
* **Export**: **Download GeoJSON** (this sheet) or **Download all** (every sheet
  in one file, each feature carrying its `sheet`); **Move to Results** / **Move
  all to Results** put sheets on the app's Results page, one session per sheet
  (`sessions/session_sheet_1-3.json`: stickers as points, routes as lines, in
  their colours). Moving a sheet again replaces it there; it stays in the
  Digitizer. Deleted items are left out everywhere.

## Running on another computer

Git carries the code only. Three things travel by hand, because they are
participant data or generated data and are kept out of git on purpose:

| What | From this machine | Needed? |
|---|---|---|
| Map sheet records | `data/map_sheets/<id>.json` + `<id>.png` for maps 1-4 (8 files, ~29 MB) | yes |
| Photos | `D:\IP3\IMOBYL\Photos\1..4\` | yes |
| Results and learned colours | `digitizer/runs/`, `digitizer/sessions/` | only to continue where you left off |

Needs Python 3.10+ (python.org, tick "Add to PATH"), Git and, for the VLM, an
NVIDIA GPU with a current driver. About 5 GB for the packages plus 9 GB for the
model, which downloads itself on the first VLM run.

```powershell
git clone <repo url>
cd Low-Barrier-Digital-Participatory-Mapping
powershell -ExecutionPolicy Bypass -File digitizer\setup.ps1              # RTX 20/30/40, RTX 5000/6000 Ada
powershell -ExecutionPolicy Bypass -File digitizer\setup.ps1 -Cuda cu128  # instead, for RTX 50xx / RTX PRO 6000 Blackwell
# copy the 8 sheet files into data\map_sheets\ (or anywhere, then add --sheets <folder> to the commands)
digitizer\.venv\Scripts\python -m digitizer batch --photos D:\IP3\IMOBYL\Photos --limit 5
digitizer\.venv\Scripts\python -m digitizer serve                          # http://127.0.0.1:5077/
```

Linux: `bash digitizer/setup.sh [cu124|cu128|cpu]`, then `digitizer/.venv/bin/python -m digitizer ...`.

On a big GPU, load the model unquantised (`--vlm-quant none`, better and
faster than 4-bit) or a larger one (`--vlm-model Qwen/Qwen3-VL-8B-Instruct
--vlm-quant none`, ~18 GB download, ~20 GB of GPU memory). The setup scripts
have been syntax-checked but not run on a fresh machine yet; the cu128 path,
`--vlm-quant none` and `--vlm-url` are untested.

## How it works

Geometry and pixels are measured; the VLM reads and judges small crops.

| Step | Module | What it does |
|---|---|---|
| Register | `register.py` | AprilTags → page homography → the map square and the questionnaire panel, cut upright. Then ECC and a **tile-based displacement field** remove paper curl (measured on the test photo: 25-30 px residual at a curled corner → median 0.5 px). The panel is cut 75 mm past where the record puts it and trimmed back to the paper's edge: on map 1 the paper ended 50-57 mm beyond the record's page edge, and the old 25 mm margin cut the first checkbox column in half. |
| What was added | `photometric.py` | Colour-fit the clean reference render to the photo, remove lighting (with ink left out of the lighting estimate, so stickers leave no halo), score every pixel by how far it falls outside the colours the print has nearby. Printed detail that vanished under something opaque also counts (a black sticker over a dark park icon scored as ink only where it overhung the icon). |
| Stickers | `stickers.py` | Colour-blind detection: fat added ink (a morphological opening removes pen strokes), split into colour clusters, then **template pursuit** with circles / triangles / stars at known sizes. Other colours under a template are neutral (a sticker may lie on top), and a sticker partly hidden by ones already found is judged on the part that shows (a sixth to a quarter visible is enough). Each fit is then polished against its own colour at full resolution, re-trying the other shapes when it was a close call. Tested on a three-deep stack (a red circle over a green triangle over a pale-pink circle): all three found. Rules from the legend and the pens (`pipeline.py`), judged on hue: a **star is only fitted where the colour could be gold** and **no triangle where it can only be black** (black stickers are circles); after fitting, a star whose measured colour is not gold, a second star on the same spot, and a **weak fit whose colour is a pen's** -- felt pen running into a sticker -- are dropped (map 1: five false "pink triangles" on four sheets, none left). A pile gets as many colour groups as it could hold stickers, plus one (up to 8): with a fixed 4, a school pile's yellow circles, cream foil star and pale pink were one colour and got five "stars". No real sticker lost on the eleven test photos. |
| Colours | `palette.py` | Nearest example in corrected Lab (lightness down-weighted), a per-sheet shift, then this sheet's confident stickers join the examples (leave-one-out). Unknown or ambiguous colours are flagged, never guessed. A shape that comes in one colour only (the star: gold) is not measured at all, and that colour is never offered for the other shapes. |
| Routes | `strokes.py` | Hysteresis + a multi-scale ridge filter (thin pens), skeleton graph with whisker pruning, joins through junctions by direction, gap bridging under stickers and over dark print, pen colour from each line's core — or, for faint lines, from the **direction** the ink moves the paper's colour. |
| Reading | `reading.py`, `vlm.py` | Qwen3-VL, one narrow question per call, JSON answers, "unclear" allowed, cached. Questionnaire: an overview pass, then each field **located** (grounding) and re-read from a full-resolution crop; disagreements are flagged. Doubtful stickers: a crop with the sticker outlined, beside same-photo examples. |
| Review | `review.py`, `server.py`, `static/` | Edits rewrite `result.json` without re-running vision. A colour fix is learned into `sessions/<name>/palette.json` and re-labels the other stickers of the sheet at once. |

### Where the VLM is and is not trusted

Measured on the test photo's 21 stickers with outlined crops: the model named 21/21
shapes and 20/21 colours — the miss was a pink sticker called red, with a
same-photo pink and red shown beside it. So its colour opinion only surfaces
where the palette measurement is itself unsure, and its shape opinion clears the
detector's "shape unsure" flags when they agree.

## Human in the loop

* `legend.json` is the workshop: sticker colours (as example colours, several
  looks allowed), shape × colour → category, pens → travel mode, questionnaire
  fields. Another workshop is a new legend, not new code. Each entry has an
  English `label` (what the page shows) and, where it is on the sheet, the
  French `printed` text the VLM looks for. The classes also say which colours
  each shape comes in: with only `star × gold`, stars are gold and gold is only
  a star.
* `--session <name>` keeps a palette per session (e.g. one per workshop/stock).
* In the page, picking a colour for a sticker, confirming a flagged one, or
  picking a pen for a route adds that colour to the session palette.
  Demonstrated on the 16 Sept photo: its two pale-pink stickers were "unknown";
  labelling one pink turned the other pink immediately, and a fresh run in that
  session recognised both without help.
* Everything is logged to `sessions/<name>/corrections.jsonl` for later
  retraining. Only the questionnaire fields in the legend are exported.

## Results so far

| | Old digitiser (`app.py`) | This one |
|---|---|---|
| Stickers, 24 Sept photo (21 real) | 20 found, red circle lost in the route; 2 greens → "other", black → blue | **21/21, all shapes, colours and categories right, 0 flagged** |
| Routes, 24 Sept photo | red route in 4 pieces + a phantom blue route | **1 route (313 mm on paper, ~2 km) + its branch to the Collège** |
| Stickers, 16 Sept photo (Telegram, 964×1280, other stock; 12 real) | — | **12/12 shapes**; 10 colours right, 2 pale pinks flagged unknown (VLM suggests pink) |
| Routes, 16 Sept photo | red in 2 pieces, blue in 3 | **red 1 piece, navy pen 1 piece, no false routes** |
| Synthetic thin pens drawn into the photo (`tools/thin_line_test.py`) | — | 0.5 mm blue/red, 0.35 mm light blue, 0.3 mm very light red: **all traced 100%, right pen**, lengths within 3% |
| Questionnaire checkboxes | — | 11/11 (overview and close-up disagreed on one; the close-up was right, the disagreement is flagged) |
| Stickers, map 1 sheets 1-5 (workshop photos, 2026-09-25 rules) | — | 79 kept; all 6 stars gold (3 had measured "unknown" or black foil before); the 5 pen-ink "pink triangles" gone; one known miss: a blue triangle under two others on sheet 3 |

A few real photos and a synthetic test are not an evaluation set: annotate more
sheets before trusting these numbers.

Laptop RTX 4070 (8 GB): vision ~25-30 s per sheet; VLM ~20 s model load, ~40 s
questionnaire (5 calls), ~4 s per doubtful sticker; peak VRAM ~4.3 GB (4-bit).

## Bigger GPU

Serve a larger model with an OpenAI-compatible server and point the pipeline at it:

```bash
vllm serve Qwen/Qwen3-VL-32B-Instruct --max-model-len 16384        # on the GPU box
python -m digitizer run ... --vlm-url http://gpu-box:8000/v1 --vlm-model Qwen/Qwen3-VL-32B-Instruct
```

The prompts are the same. The HTTP backend (`VLM(backend="openai")`) sends JSON
schemas as `response_format`, which vLLM enforces. **It has not been tested
against a live server yet.**

## Known gaps

* Handwritten names next to black stickers on the map are not read.
* Shapes drawn and coloured in with a pen instead of a sticker (seen on map 1
  sheet 4: a blue triangle scribbled in ballpoint) are not detected as stickers.
* A sticker almost entirely under others can be missed (map 1 sheet 3: a blue
  triangle under the green and pink ones at the Collège); add it in the page.
* The page cannot move or resize a sticker: delete it and add it again.
* Sheet 2's stored reference PNG lacks the "Collège Montgolfier" label that is
  on the print; the digitiser sees it as ink (filtered out, but a sign the
  reference render and the PDF can differ).
* Sticker sizes and colour examples in `legend.json` were measured on the
  September 2026 stock.

## Files

```
digitizer/
  legend.json        workshop definition (colours, classes, pens, questionnaire)
  pipeline.py        end-to-end run, outputs (runs/<id>/result.json, result.geojson, images)
  register.py        tags, homography, rectification, curl correction
  photometric.py     colour fit and the "added ink" score
  stickers.py        colour-blind sticker detection (template pursuit)
  palette.py         colour classes from examples, per-sheet adaptation, session learning
  strokes.py         routes from ink (thin pens, junctions, gaps)
  vlm.py             Qwen3-VL in-process (4-bit) or over HTTP; JSON answers; cache
  reading.py         questionnaire, sticker second opinions
  review.py          applies reviewer edits and learns from them
  server.py, static/ the page (a Flask blueprint: /digitizer/ in app.py, / on its own)
  tools/thin_line_test.py   synthetic thin-pen regression test
```
