# Standalone Sketch Map Tool drawing-detector test

This experiment runs only the marking-detection part of
[GIScience/sketch-map-tool](https://github.com/GIScience/sketch-map-tool):

1. select one of this project's stored clean map IDs;
2. upload a photo or scan of the marked sheet;
3. align it to the clean map using BRISK feature matching;
4. detect markings using SMT-OSM/SMT-ESRI, classify them with SMT-CLS, and segment
   them with SAM2;
5. display the raw or processed raster mask on a standard OpenStreetMap layer;
6. download the raw mask as PNG or georeferenced GeoTIFF, or the processed result
   as PNG/GeoJSON.

It deliberately has no Redis, PostgreSQL, Celery, QR-code workflow, map generation,
accounts, or other Sketch Map Tool application components.

## Setup and run

From PowerShell in this directory:

```powershell
.\setup.ps1
.\.venv\Scripts\python.exe .\app.py
```

Then open <http://127.0.0.1:5055/>. The first setup downloads the three HeiGIT
weights plus one SAM2 checkpoint (about 740 MiB total). Inference uses CUDA when
available.

The page reads clean references and coordinates from `data/map_sheets/*.json` and
`data/map_sheets/*.png`; it does not modify them.

## Why a separate environment?

The upstream detector pins an older Ultralytics release and uses HeiGIT's custom
six-channel Ultralytics fork. The local `.venv` shadows that package without changing
the main project's Python environment. Existing heavyweight packages such as PyTorch
are reused from the system environment.
