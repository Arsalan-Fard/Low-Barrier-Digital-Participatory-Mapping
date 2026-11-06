# digitizer — paper map sheets to data, with a human in the loop

Reads a photographed i-mobyl sheet (the map side with its 8 AprilTags) and
produces stickers, routes and handwritten texts as JSON and GeoJSON,
plus a page where a person says what is on each photo -- its list of stickers
(shape x colour name) and pens, colours taken from the photo with an
eyedropper -- digitizes it, and fixes the result by hand: placing missed
stickers, drawing missed routes, erasing false ones. Nothing is learned from
those fixes (since 2026-10-02).

It is part of the workshop app: the home menu's **Digitize Paper Map**
(`python app.py`, then http://127.0.0.1:5000/digitizer/). It reads
`data/map_sheets/<id>.json|png` and never writes there; its sheets stay in
`data/digitized_sheets/` (each sheet's folder keeps its photo, list and
eyedropper looks). Once a sheet is digitised, every save also writes its
GeoJSON into the results folder the Results panel of Run a Workshop reads,
`sessions/<sheet>.geojson` (`sessions/1_05.geojson` for map 1, sheet 5), so a
sheet is in Results as soon as it is digitised and always up to date there.
`data/digitizer_palettes/` holds colour examples learned before 2026-10-02,
read only. These folders are in `backend/config.py`. (It replaced the map
page's old Digitize panel on 2026-09-25.)

Sheets digitised on another computer come in by copying their folders into
`data/digitized_sheets/`; the page lists them on the next load. A GeoJSON file
cannot be brought back in: it has neither the photo nor the stickers' place on
it. The 97 IMOBYL sheets of 2026-09-24 came in this way on 2026-10-02, checked
by hand ("checked by Claude" on the page). Their comments pages were transcribed
too: that text stays in each `result.json`, and this page does not show it.

## The page

The page calls the stickers on the paper **marks**.

* One row on top: ‹ Menu, the sheet, **Upload** (map photos), **Fit** (F),
  **Overlay** (how strongly marks and routes are drawn), **Map** (how much of
  the photo shows; at 0 only the marks and routes remain, on white) and
  **Short strokes** (pen lines under 25 mm — ticks, crosses, arrows — which are
  not counted as routes and are hidden by default).
* **Upload** opens a card: the map ID, then photos of that map, clicked in from
  the drop zone or dragged onto it (or anywhere on the page, which opens the
  card with them); each is listed with a preview and can be taken off again. A
  name like `2_05_map.jpg` fills in the map ID. Each photo is prepared (straightened
  and colour-corrected, ~15 s) and digitised with the full list (~15 s more), one
  after another; the first one done opens. A photo named like `2_05_map.jpg`
  becomes sheet 5 of map 2, the others get the next free numbers. To look for
  exactly what is on a sheet, edit its list and **Digitize again**.
* **Handwriting** (top bar): **No VLM**, **Qwen3-VL 4B** on this computer, or
  **Qwen3-VL 32B** on a server (**Server…** sets its address). With a model
  chosen, uploading reads each map's handwriting too: the model finds what was
  written by hand (not the printed labels) and it is placed where it was
  written. The **Texts** tab lists it and reads a sheet's handwriting again
  (**Read handwriting**); click a text to fix it (Save) or erase it, and the
  **Text** tool (T) types one where something is written. Texts typed or fixed by
  hand stay when the handwriting is read again; erased ones stay erased.
* The toolbox on the map is the photo's list: a row per pen and per mark
  colour name ("Pink"), with a cell per shape (circle, triangle, star). Clicking a
  pen and dragging draws a route (R, B for red and blue); clicking a disk, then
  the map, places that mark (it stays picked). Also **Move** (S; drag the map,
  click a mark or line to see it), **Eraser** (E; click or drag over marks
  and lines) and **Undo / Redo** (Ctrl+Z, Ctrl+Y or Ctrl+Shift+Z: every edit,
  list and digitizing included, back to the start of the server's run).
  Wheel zooms; the right or middle button, or Space held down, drags the map
  with any tool. Escape goes back to Move; Delete erases the selected mark or
  line.
* The **pencil** edits the list. Every name the workshop knows shows, faded
  where it is not on this photo's list; clicking a cell puts that mark or pen
  on or off the list. Digitizing looks only for what is listed -- so take off
  only what is not on the photo: a mark type taken off by mistake is forced
  into a listed one (on the test photo, the blue triangles came out as blue
  circles). Clicking a **name** takes its colour from the photo: click one of
  its marks (or a line drawn with the pen) and that look is added to the
  name, for this photo and every later one -- one colour can look different
  from photo to photo, and even on one photo (two pink stocks). **+ Colour** /
  **+ Pen** make a new name: type it, pick the shape, click it on the photo.
  The name is what the GeoJSON says (`colorLabel`), whatever it looked like;
  its `color` is the first click's. What a mark *means* stays on the
  printed legend.
* **Digitize again** (when the list changed, or from the pencil) keeps what was
  done by hand: placed marks and drawn lines stay, erased ones stay erased
  where they are found again. It needs the sheet's
  photo (kept in its folder for sheets made in the page).
* **Marks** and **Routes** list the sheet's items ("Pink triangle"); clicking
  one zooms to it.
* **Export**: **Download GeoJSON** (this sheet) or **Download all** (every sheet
  in one file, each feature carrying its `sheet`). The GeoJSON holds only the
  marks (Point: `kind` `mark`, `shape`, `color`, `colorLabel`, `confidence`, and `source`
  `auto` or `manual`), the routes (LineString: `color`, `colorLabel` -- the
  pen's name -- and a `note` on a line the child labelled METRO) and the
  handwriting (Point: `kind` `text`, `text`, `source`), and beside
  them the sheet's name; the
  printed legend says what a shape and colour mean. The same GeoJSON is the
  sheet's file in the results folder (`sessions/1_03.geojson`), which the
  Results panel of Run a Workshop shows: the Export tab says where it is.
  Deleted items are left out everywhere.

## How it works

Geometry and pixels are measured; nothing is guessed by a model.

| Step | Module | What it does |
|---|---|---|
| Register | `register.py` | AprilTags → page homography → the map square, cut upright. Then ECC and a **tile-based displacement field** remove paper curl (measured on the test photo: 25-30 px residual at a curled corner → median 0.5 px). |
| What was added | `photometric.py` | Colour-fit the clean reference render to the photo, remove lighting (with ink left out of the lighting estimate, so stickers leave no halo), score every pixel by how far it falls outside the colours the print has nearby. Printed detail that vanished under something opaque also counts (a black sticker over a dark park icon scored as ink only where it overhung the icon). |
| Stickers | `stickers.py` | Colour-blind detection: fat added ink (a morphological opening removes pen strokes), split into colour clusters, then **template pursuit** with circles / triangles / stars at known sizes. Other colours under a template are neutral (a sticker may lie on top), and a sticker partly hidden by ones already found is judged on the part that shows (a sixth to a quarter visible is enough). Each fit is then polished against its own colour at full resolution, re-trying the other shapes when it was a close call. Tested on a three-deep stack (a red circle over a green triangle over a pale-pink circle): all three found. Rules from the legend and the pens (`pipeline.py`), judged on hue: a **star is only fitted where the colour could be gold** and **no triangle where it can only be black** (black stickers are circles); after fitting, a star whose measured colour is not gold, a second star on the same spot, and a **weak fit whose colour is a pen's** -- felt pen running into a sticker -- are dropped (map 1: five false "pink triangles" on four sheets, none left). A pile gets as many colour groups as it could hold stickers, plus one (up to 8): with a fixed 4, a school pile's yellow circles, cream foil star and pale pink were one colour and got five "stars". No real sticker lost on the eleven test photos. |
| Names and looks | `workshop.py` | Each sticker colour and pen is a name with looks (colours as the camera records them), pooled from the stock (`legend.json`), the old session palette and every eyedropper click on any sheet of the session. Each photo's list says which stickers (shape × colour name) and pens are on it; digitizing uses only those. The pen eyedropper reads only added ink (`score.png`), so a printed street beside the line is not taken for it. |
| Colours | `palette.py` | Nearest look in corrected Lab (lightness down-weighted), a per-sheet shift, then this sheet's confident stickers join the looks (leave-one-out). Unknown or ambiguous colours are flagged, never guessed. A shape that comes in one colour only on the photo's list (the star: gold) is not measured at all, and that colour is never offered for the other shapes. Measured on the 97 checked IMOBYL sheets: 1 click per colour on the photo only 90 % right, the stock's measured looks 97 % (a new colour's clicks add up across photos: 94 % after 1 photo, 96 % after 8). |
| Routes | `strokes.py` | Hysteresis + a multi-scale ridge filter (thin pens), skeleton graph with whisker pruning, joins through junctions by direction, gap bridging under stickers and over dark print, pen colour from each line's core — or, for faint lines, from the **direction** the ink moves the paper's colour. |
| Review | `review.py`, `server.py`, `static/` | An uploaded photo is prepared (`pipeline.prepare`) and digitised with the full list (`pipeline.digitize`); with its list edited it is digitised again (`carry_over` keeps the hand's work). Edits (list, looks, place, draw, texts, erase) rewrite `result.json` without re-running vision and teach nothing; an in-memory history per sheet undoes and redoes them, digitizing included. |

## Human in the loop

* `legend.json` is the stock: the sticker colours and pens a new photo's list
  starts with, with their measured looks and the shapes' sizes. New colours and pens need no change there: they are
  named and picked on a photo in the page. Each entry has an English `label`
  (the name the page and the GeoJSON use). What a shape and colour *mean* is
  not in it: that stays on the printed legend. The classes also say which
  colours each shape comes in: with only `star × gold`, stars are gold and gold
  is only a star.
* Each sheet belongs to a session (`session` in its `result.json`, "default"
  for sheets made in the page); `data/digitizer_palettes/<session>/palette.json`
  holds the examples learned before 2026-10-02, when the page still taught the
  palette -- read, no longer written.
* Corrections are made by hand in the page and stay on the sheet.

## Results so far

| | Old digitiser (`app.py`) | This one |
|---|---|---|
| Stickers, 24 Sept photo (21 real) | 20 found, red circle lost in the route; 2 greens → "other", black → blue | **21/21, all shapes, colours and categories right, 0 flagged** |
| Routes, 24 Sept photo | red route in 4 pieces + a phantom blue route | **1 route (313 mm on paper, ~2 km) + its branch to the Collège** |
| Stickers, 16 Sept photo (Telegram, 964×1280, other stock; 12 real) | — | **12/12 shapes**; 10 colours right, 2 pale pinks flagged unknown |
| Routes, 16 Sept photo | red in 2 pieces, blue in 3 | **red 1 piece, navy pen 1 piece, no false routes** |
| Synthetic thin pens drawn into the photo | — | 0.5 mm blue/red, 0.35 mm light blue, 0.3 mm very light red: **all traced 100%, right pen**, lengths within 3% |
| Stickers, map 1 sheets 1-5 (workshop photos, 2026-09-25 rules) | — | 79 kept; all 6 stars gold (3 had measured "unknown" or black foil before); the 5 pen-ink "pink triangles" gone; one known miss: a blue triangle under two others on sheet 3 |

A few real photos and a synthetic test are not an evaluation set: annotate more
sheets before trusting these numbers. On a laptop, preparing and digitizing a
sheet takes about 25-30 s.

## Handwriting models

Reading handwriting is optional; the rest of the Digitizer needs neither model.

* **Qwen3-VL 4B, this computer**: runs inside the app with PyTorch and
  transformers (not in `requirements.txt`): on an 8 GB laptop GPU the language
  model is loaded 4-bit and the vision tower stays in bf16 (~4.3 GB of GPU
  memory). It needs an NVIDIA GPU, `pip install torch transformers accelerate
  bitsandbytes` (PyTorch with CUDA from pytorch.org), and the model, downloaded
  by transformers the first time (`Qwen/Qwen3-VL-4B-Instruct`, ~9 GB). It stays
  loaded while sheets wait and the GPU is freed when the last one is done. Not
  in the packaged Mac and Windows apps.
* **Qwen3-VL 32B, a server**: any OpenAI-compatible server, e.g. on the GPU
  machine `vllm serve Qwen/Qwen3-VL-32B-Instruct --max-model-len 16384` (about
  40 GB of GPU memory in 8-bit, 80 GB in full); its address (`http://host:8000/v1`)
  and model name go in **Server…**, kept in `data/vlm.json`.

How it reads (`handwriting.py`): the model looks for handwriting on the map with
the print taken away -- only what was added on paper (the added-ink image,
`score.png`, measured again from the photo for sheets prepared before it was
kept) keeps its colour -- so street names cannot be taken for handwriting. That
map is cut into overlapping 1024 px tiles (tiles without added ink are skipped);
for each the model lists the handwriting it sees with a box, then each find is
read again from a close-up of its box on the photo, where the strokes are whole.
Answers are cached in `digitized_sheets/vlm_cache.jsonl`, so reading a sheet
again costs nothing twice. Measured with Qwen3-VL 4B on the laptop (RTX 4070,
8 GB): map 1 sheet 6 in ~70 s ("Normal", "Mamie", "KFC", the circled M), after
~20 s loading the model; it reads slanted or joined writing poorly (sheet 10's
"École primaire rue Hippolyte Maindron" came out garbled), which is what the
32B model is for.

## Known gaps

* Handwriting is read only with a model chosen; the model can miss faint or
  tiny writing, or read a word wrong: check the Texts tab.
* Shapes drawn and coloured in with a pen instead of a sticker (seen on map 1
  sheet 4: a blue triangle scribbled in ballpoint) are not detected as stickers.
* A sticker almost entirely under others can be missed (map 1 sheet 3: a blue
  triangle under the green and pink ones at the Collège); add it in the page.
* The page cannot move or resize a mark: delete it and add it again.
* A mark type taken off a photo's list while it is on the photo is forced
  into a listed shape (the test photo's blue triangles became blue circles).
* Digitize again needs the sheet's photo. The 97 IMOBYL sheets were read from
  `D:\IP3\IMOBYL\Photos`, since renamed into `D:\IP3\IMOBYL\Data Photos`
  (`3/3_01_map.jpeg`, ...): copy a sheet's photo into its folder as `photo.jpeg`
  first.
* Shapes are circle, triangle and star; another shape needs code
  (`stickers.py`, and the page's drawing).
* Sheet 2's stored reference PNG lacks the "Collège Montgolfier" label that is
  on the print; the digitiser sees it as ink (filtered out, but a sign the
  reference render and the PDF can differ).
* Sticker sizes and colour examples in `legend.json` were measured on the
  September 2026 stock.

## Files

```
digitizer/
  legend.json        the stock (colours with looks, classes, pens, shape sizes)
  workshop.py        colour and pen names, their pooled looks, each photo's list, the eyedropper
  pipeline.py        prepare + digitize, digitizing again, outputs (<sheet>/result.json, images; sessions/<sheet>.geojson)
  register.py        tags, homography, rectification, curl correction
  photometric.py     colour fit and the "added ink" score
  stickers.py        colour-blind sticker detection (template pursuit)
  palette.py         colour classes from examples, per-sheet adaptation
  strokes.py         routes from ink (thin pens, junctions, gaps)
  handwriting.py     the handwriting on the map, found and read by the model
  vlm.py             the optional handwriting models: on this computer or a server
  sheet.py           the printed map sheet's record and reference render
  review.py          the page's edits: list, looks, place, draw, texts, erase, undo/redo
  server.py, static/ the page and its API, a Flask blueprint at /digitizer/
```
