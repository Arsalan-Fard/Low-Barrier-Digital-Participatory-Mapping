# -*- mode: python ; coding: utf-8 -*-
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_dynamic_libs


# SPECPATH is injected by PyInstaller: the directory containing this spec file
# (packaging/). The repo root is one level up.
root = Path(SPECPATH).resolve().parent


def add_tree(path):
    src = root / path
    if not src.exists():
        return []
    entries = []
    for child in src.rglob("*"):
        if not child.is_file():
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
):
    datas += add_tree(dirname)


a = Analysis(
    [str(root / "digital_mapping_workshop_launcher.py")],
    pathex=[str(root)],
    # pupil_apriltags ships its native apriltag.dll inside the package but has
    # no PyInstaller hook — collect it explicitly or the detector won't start.
    binaries=collect_dynamic_libs("pupil_apriltags"),
    datas=datas,
    hiddenimports=[
        "pupil_apriltags",
        "sounddevice",
        "imageio_ffmpeg",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "torch",
        "torchvision",
        "torchaudio",
        "osmnx",
        "networkx",
        "shapely",
        "stag",
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
