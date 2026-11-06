# -*- mode: python ; coding: utf-8 -*-
import sys
from pathlib import Path


# SPECPATH is injected by PyInstaller: the directory containing this spec file
# (packaging/). The repo root is one level up.
root = Path(SPECPATH).resolve().parent


# Participant data that must never ship: the Digitizer's sheets carry the photos (children's names
# and handwriting) and their results (home locations).
LEFT_OUT = [root / "data" / "digitized_sheets"]


def add_tree(path):
    src = root / path
    if not src.exists():
        return []
    entries = []
    for child in src.rglob("*"):
        if not child.is_file() or "__pycache__" in child.parts:
            continue
        if any(child.is_relative_to(folder) for folder in LEFT_OUT):
            continue
        rel_parent = child.parent.relative_to(root)
        entries.append((str(child), str(rel_parent)))
    return entries


# NOTE: floorplan/ is deliberately NOT bundled — it holds locally uploaded
# DXF plans that must not ship in distributed builds.
datas = []
for dirname in (
    "web",
    "data",
    "map-style-editor/maputnik/dist",
    "digitizer/static",   # the Digitizer's page (its Python code is collected like the rest)
):
    datas += add_tree(dirname)
datas.append((str(root / "digitizer" / "legend.json"), "digitizer"))

# Hand detection for the photos of the map view sheets (backend/hands.py): its model, and MediaPipe's
# native library, which MediaPipe opens by path from the mediapipe.tasks.c package, out of the
# analysis' sight. Without MediaPipe installed the build simply has no hand detection.
datas.append((str(root / "backend" / "models" / "hand_landmarker.task"), "backend/models"))
try:
    from PyInstaller.utils.hooks import collect_dynamic_libs
    mediapipe_binaries = collect_dynamic_libs("mediapipe")
except Exception:
    mediapipe_binaries = []


a = Analysis(
    [str(root / "digital_mapping_workshop_launcher.py")],
    pathex=[str(root)],
    binaries=mediapipe_binaries,
    datas=datas,
    hiddenimports=[
        "sounddevice",
        "imageio_ffmpeg",
        "mediapipe.tasks.c",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "torch",
        "torchvision",
        "torchaudio",
        # Unused by the app; on a machine that has them installed, PyInstaller's analysis drags them
        # in and crashes importing them.
        "transformers",
        "tensorflow",
        "sklearn",
        "osmnx",
        "networkx",
        "shapely",
        "stag",
        # MediaPipe imports it for a plotting helper only; backend/hands.py stands in for it.
        "matplotlib",
        "IPython",
        "pytest",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="DigitalMappingWorkshop",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="DigitalMappingWorkshop",
)

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="DigitalMappingWorkshop.app",
        icon=None,
        bundle_identifier="org.participatory-mapping.digital-mapping-workshop",
        info_plist={
            "NSCameraUsageDescription": "The workshop tracks printed markers with the camera.",
            "NSMicrophoneUsageDescription": "Workshop sessions can record audio.",
        },
    )
