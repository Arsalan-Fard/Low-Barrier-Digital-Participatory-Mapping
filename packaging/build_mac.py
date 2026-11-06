"""Build the workshop app for macOS -- on any computer, no Mac needed.

    python packaging/build_mac.py                  # -> ../mac, beside the repository
    python packaging/build_mac.py --out D:/somewhere --no-token
    python packaging/build_mac.py --no-results     # without the results made so far

Nothing is compiled: a portable Python 3.11 for each Mac chip (python-build-standalone, Apple
Silicon and Intel) and the macOS wheels of the app's packages come ready-made, downloaded once into
<out>/download-cache. They are laid out with the app's own files:

    Digital Mapping Workshop/              keep the folder together
        Start Workshop.command             double-click: the app opens full screen in Chrome or Edge
        Read me.txt
        app/                               the code, the web pages, the setup data, Python
            runtime/arm64, runtime/x86_64  Python and the packages, per Mac chip
    Digital-Mapping-Workshop-mac.zip       the same, with the Unix file permissions: copy this to the Mac

The results made so far go in too, so the Mac shows them: the workshop sessions (sessions/) and the
digitised sheets with their photos (data/digitized_sheets/). Those photos carry children's names and
handwriting, so share such a zip only within the team; --no-results builds one without them.
Recordings always stay out. The app runs as ``python app.py`` inside app/, so what it saves stays in
app/data and app/sessions.
Needs macOS 12 or later (the wheels below are built for it).
"""
from __future__ import annotations
import argparse
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NAME = "Digital Mapping Workshop"
ZIP_NAME = "Digital-Mapping-Workshop-mac.zip"

PYTHON_RELEASE, PYTHON_VERSION = "20261001", "3.11.17"
PYTHON_URL = ("https://github.com/astral-sh/python-build-standalone/releases/download/"
              "{release}/cpython-{version}+{release}-{triple}-install_only_stripped.tar.gz")
CHIPS = {  # folder under runtime/ -> (python-build-standalone triple, wheel platform)
    "arm64": ("aarch64-apple-darwin", "macosx_12_0_arm64"),
    "x86_64": ("x86_64-apple-darwin", "macosx_12_0_x86_64"),
}
# What the app imports, at the versions it runs with here. opencv-contrib (headless: the app opens no
# OpenCV windows) brings cv2.aruco and cv2.ximgproc.thinning, so scikit-image is not needed. As in the
# PyInstaller build, osmnx / networkx / shapely stay out: the street-network tools are optional.
PACKAGES = ["flask==3.1.2", "numpy==2.4.6", "opencv-contrib-python-headless==4.10.0.84", "scipy==1.17.0",
            "sounddevice==0.5.3", "imageio-ffmpeg==0.6.0", "reportlab==4.4.10", "mss==10.2.0"]

APP_FILES = ["app.py"]
APP_FOLDERS = ["backend", "digitizer", "web", "map-style-editor/maputnik/dist"]
# data/ minus what the app no longer reads, and minus the digitised sheets (added below with the results)
DATA_LEFT_OUT = {"_archive", "captures", "digitize_sessions", "digitized_sheets", "digitized_sheet_counters.json"}
# The results made so far (unless --no-results): folder -> what stays out of it. Out: the results bin,
# a review's scratch folder and the batch plan (photo paths on this computer).
RESULTS = {
    "sessions": {"deleted"},
    "data/digitized_sheets": {"_review_claude", "batch-plan.json"},
}
SKIPPED_NAMES = {"__pycache__", ".DS_Store", "Thumbs.db"}
STORED = {".jpg", ".jpeg", ".png", ".gz", ".zip", ".whl", ".mp4", ".webp", ".pdf"}   # already compressed

LAUNCHER = """#!/bin/bash
# Starts the Digital Mapping Workshop. It opens full screen in Google Chrome or Microsoft Edge (or in
# your web browser). Keep this window open while you work; close it (or press Ctrl+C) to stop.
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/app"
if [ "$(uname -m)" = "arm64" ]; then RUNTIME="$APP/runtime/arm64"; else RUNTIME="$APP/runtime/x86_64"; fi
PY="$RUNTIME/bin/python3.11"
# A folder that came from a download is quarantined, and macOS would refuse the
# bundled Python: once this file is allowed to open, it clears the whole folder.
if xattr -p com.apple.quarantine "$PY" >/dev/null 2>&1; then
  echo "First start: clearing the download quarantine (a few seconds)..."
  xattr -dr com.apple.quarantine "$HERE" 2>/dev/null
fi
# Copied without the zip (a USB stick, a network share), the programs lose their permission to run.
chmod +x "$RUNTIME"/bin/* "$RUNTIME"/lib/python3.11/site-packages/imageio_ffmpeg/binaries/* 2>/dev/null
# An Android phone on a USB cable (USB debugging on, Android's adb here): its IP Webcam stream is
# forwarded to this Mac's port 8080, where the app looks first. Redone every few seconds, so a phone
# plugged in later is found too. adb is Google's "platform-tools" folder beside this file (or in
# Downloads), or Homebrew's, or Android Studio's; with none of them it is downloaded here.
ADB="$(command -v adb)"
for candidate in "$HERE/platform-tools/adb" "$HERE/../platform-tools/adb" "$HOME/Downloads/platform-tools/adb" \\
    /opt/homebrew/bin/adb /usr/local/bin/adb "$HOME/Library/Android/sdk/platform-tools/adb"; do
  if [ -z "$ADB" ] && [ -f "$candidate" ]; then ADB="$candidate"; fi
done
if [ -z "$ADB" ]; then
  # Beside this file, or in Downloads when this folder cannot be written to.
  DEST="$HERE"
  [ -w "$DEST" ] || DEST="$HOME/Downloads"
  echo "Downloading Android's adb for a phone on a USB cable: Google's SDK Platform-Tools (16 MB),"
  echo "  under Google's terms (https://developer.android.com/studio/terms)..."
  TMP="$(mktemp -d)"
  if curl -fsSL --connect-timeout 8 --max-time 300 -o "$TMP/platform-tools.zip" \\
      "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip" \\
    && unzip -q "$TMP/platform-tools.zip" -d "$TMP" && [ -f "$TMP/platform-tools/adb" ] \\
    && rm -rf "$DEST/platform-tools" && mv "$TMP/platform-tools" "$DEST/platform-tools"; then
    ADB="$DEST/platform-tools/adb"
    echo "  Saved in $DEST/platform-tools"
  else
    echo "  Could not download it (is this Mac online?). It is tried again at the next start."
  fi
  rm -rf "$TMP"
fi
if [ -n "$ADB" ]; then
  xattr -d com.apple.quarantine "$ADB" 2>/dev/null
  chmod +x "$ADB" 2>/dev/null
  echo "Android phone on USB: its camera is forwarded with adb ($ADB)."
  (
    LAST="(start)"
    while true; do
      "$ADB" forward tcp:8080 tcp:8080 >/dev/null 2>&1
      STATE="$("$ADB" devices 2>/dev/null | awk 'NR > 1 && NF >= 2 { print $2; exit }')"
      if [ "$STATE" != "$LAST" ]; then
        case "$STATE" in
          device) echo "[USB] Phone connected: start IP Webcam's server, then click Smartphone." ;;
          unauthorized) echo "[USB] Phone found: tap Allow on the phone (USB debugging)." ;;
          "") echo "[USB] No phone on USB: plug it in with USB debugging on." ;;
          *) echo "[USB] Phone on USB: $STATE" ;;
        esac
        LAST="$STATE"
      fi
      sleep 5
    done
  ) &
  FORWARDING=$!
  trap 'kill "$FORWARDING" 2>/dev/null; "$ADB" forward --remove tcp:8080 >/dev/null 2>&1' EXIT
else
  echo "No adb, so an Android phone on a USB cable cannot be used for now (Wi-Fi still works)."
  echo "  See \\"The phone camera\\" in Read me.txt."
fi
cd "$APP" || exit 1
# -E -s: a Python installed on this Mac (PYTHONPATH, user packages) must not mix in
"$PY" -E -s app.py "$@"
echo ""
echo "The workshop app has stopped. You can close this window."
"""

README = """Digital Mapping Workshop for macOS
===================================

Start: double-click "Start Workshop.command". The app opens full screen in
Google Chrome or Microsoft Edge (or in your web browser). A Terminal window
opens with it: keep it open while you work; close it to stop the app.

Needs macOS 12 (Monterey) or later, on Apple Silicon or Intel. Nothing to
install: Python and everything else is inside the "app" folder.

The very first time
-------------------
macOS does not know this app's maker, so it blocks the first start once:
  * macOS 15 (Sequoia) and later: click "Done", then open System Settings >
    Privacy & Security, scroll down to "Start Workshop.command was blocked"
    and click "Open Anyway" (then "Open Anyway" again, and your password).
  * macOS 12 to 14: Control-click (or right-click) "Start Workshop.command",
    choose Open, then Open again.
After that a double-click is enough.

macOS then asks, once each:
  * whether "python3.11" may accept incoming network connections: Allow
    (a phone or tablet on the same network can then open the app);
  * whether Terminal may use the camera and the microphone: OK (the webcam,
    and recording workshop audio).

If a double-click does nothing, open Terminal, type "bash " (with a space),
drag "Start Workshop.command" into the Terminal window and press Return.

The phone camera
----------------
A Mac usually cannot use an Android phone's USB tethering. Use one of these
instead, then start IP Webcam's server on the phone ("Start server"):

  * Over the USB cable (adb). This needs Android's adb tool, which
    Start Workshop.command downloads by itself the first time, so be online
    then: Google's SDK Platform-Tools (16 MB, under Google's terms,
    https://developer.android.com/studio/terms) go into a "platform-tools"
    folder here, beside Start Workshop.command. Offline, get them by hand:
    download "SDK Platform-Tools for Mac" from
    https://developer.android.com/tools/releases/platform-tools , unzip it
    and put the "platform-tools" folder here (Downloads works too). Or, with
    Homebrew: brew install android-platform-tools
    Once on the phone: Settings > About phone, tap "Build number" seven
    times; then in Developer options (in Settings, often under System)
    turn on "USB debugging". Plug the phone in and tap "Allow" when it
    asks about this computer. Start Workshop.command does the rest: it forwards
    the camera over the cable, also when the phone is plugged in later, and
    its window says what it sees ("[USB] Phone connected", ...).
    In a virtual machine, pass the phone's USB through to it.
  * Over Wi-Fi: connect the phone and the Mac to the same Wi-Fi network
    (a virtual machine needs bridged networking to be on it).

Either way, click "Smartphone" in the app (it retries every 10 seconds).

An iPhone works too, as a webcam (Continuity Camera, macOS 13 and iOS 16 or
later, same Apple ID, wireless or on its cable): click "Webcam" in the app
and try device 1, 2, ... until the iPhone's picture shows.

What is in this folder
----------------------
  app            the program, with its setup (app/data: map sheets, workshops,
                 markers, data layers). What you make while it runs is saved
                 inside it too: workshop results in app/sessions, digitised
                 sheets in app/data/digitized_sheets. Both come with the
                 results made before this copy was built. Back up the app
                 folder.
  token.txt      (inside app) the Mapbox key the maps use.
  platform-tools Android's adb, downloaded at the first start (the phone on USB).

Keep the folder together.
"""


def log(message: str) -> None:
    print(message, flush=True)


# ---------------------------------------------------------------- downloads
def python_runtime(cache: Path, triple: str) -> Path:
    name = PYTHON_URL.format(release=PYTHON_RELEASE, version=PYTHON_VERSION, triple=triple).rsplit("/", 1)[1]
    path = cache / name
    if not path.exists():
        url = PYTHON_URL.format(release=PYTHON_RELEASE, version=PYTHON_VERSION, triple=triple)
        log(f"  downloading {name}")
        partial = path.with_suffix(".part")
        urllib.request.urlretrieve(url, partial)
        partial.rename(path)
    return path


def wheels(cache: Path, chip: str, platform: str) -> list[Path]:
    folder = cache / f"wheels-{chip}"
    folder.mkdir(parents=True, exist_ok=True)
    log(f"  wheels for {chip} ({platform})")
    subprocess.run([sys.executable, "-m", "pip", "download", "--quiet", "--disable-pip-version-check",
                    "--only-binary=:all:", "--platform", platform, "--python-version", "3.11",
                    "--implementation", "cp", "--abi", "cp311", "--dest", str(folder), *PACKAGES], check=True)
    return sorted(folder.glob("*.whl"))


# ---------------------------------------------------------------- layout
def unpack_runtime(archive: Path, target: Path) -> None:
    """The archive's python/ folder becomes ``target``. Its symlinks (python3 -> python3.11, ...) are
    left out: the launcher calls python3.11 itself, and a Windows folder cannot hold them."""
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            relative = Path(*Path(member.name).parts[1:])
            dest = target / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as source, open(dest, "wb") as out:
                shutil.copyfileobj(source, out)


def install_wheel(wheel: Path, site_packages: Path) -> None:
    """A wheel is a zip of the package; its ``*.data/purelib|platlib`` parts go into site-packages too."""
    with zipfile.ZipFile(wheel) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            parts = Path(info.filename).parts
            if parts[0].endswith(".data"):
                if len(parts) < 3 or parts[1] not in ("purelib", "platlib"):
                    continue   # scripts and headers: not needed
                parts = parts[2:]
            dest = site_packages.joinpath(*parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, open(dest, "wb") as out:
                shutil.copyfileobj(source, out)


def copy_tree(source: Path, target: Path, left_out: set[str] = frozenset()) -> None:
    for item in source.iterdir():
        if item.name in SKIPPED_NAMES or item.name in left_out:
            continue
        if item.is_dir():
            copy_tree(item, target / item.name)
        else:
            target.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target / item.name)


def copy_app(app: Path, with_token: bool, with_results: bool = True) -> None:
    for name in APP_FILES:
        shutil.copy2(REPO / name, app / name)
    for folder in APP_FOLDERS:
        copy_tree(REPO / folder, app / folder)
    copy_tree(REPO / "data", app / "data", DATA_LEFT_OUT)
    (app / "sessions").mkdir(exist_ok=True)
    if with_results:
        for folder, left_out in RESULTS.items():
            if (REPO / folder).is_dir():
                copy_tree(REPO / folder, app / folder, left_out)
    token = REPO / "token.txt"
    if with_token and token.exists():
        shutil.copy2(token, app / "token.txt")
    else:
        (app / "token.txt").write_text("", encoding="utf-8")


# ---------------------------------------------------------------- zip
def executable(relative: str) -> bool:
    return ("/runtime/" in relative and "/bin/" in relative) or "/imageio_ffmpeg/binaries/" in relative \
        or relative.endswith(".command")


def write_zip(folder: Path, zip_path: Path) -> None:
    """Zipped with Unix permissions (create_system 3): unzipped on the Mac, Python can run straight away."""
    partial = zip_path.with_suffix(".part")
    with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(folder.rglob("*")):
            relative = path.relative_to(folder.parent).as_posix()
            if path.is_dir():
                info = zipfile.ZipInfo(relative + "/")
                info.create_system = 3
                info.external_attr = (0o40755 << 16) | 0x10
                archive.writestr(info, b"")
                continue
            info = zipfile.ZipInfo.from_file(path, relative)
            info.create_system = 3
            info.external_attr = (0o100755 if executable(relative) else 0o100644) << 16
            info.compress_type = zipfile.ZIP_STORED if path.suffix.lower() in STORED else zipfile.ZIP_DEFLATED
            with open(path, "rb") as source, archive.open(info, "w") as out:
                shutil.copyfileobj(source, out, 1 << 20)
    partial.replace(zip_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=REPO.parent / "mac", help="where to build (default: ../mac)")
    parser.add_argument("--no-token", action="store_true", help="leave the Mapbox token out (an empty token.txt)")
    parser.add_argument("--no-results", action="store_true",
                        help="leave the results made so far out (sessions/ and data/digitized_sheets/)")
    args = parser.parse_args()

    out = args.out.resolve()
    if out == REPO or REPO in out.parents:
        parser.error("build outside the repository")
    cache = out / "download-cache"
    cache.mkdir(parents=True, exist_ok=True)
    folder = out / NAME
    if folder.exists():
        log(f"removing the previous build: {folder}")
        shutil.rmtree(folder)
    app = folder / "app"
    app.mkdir(parents=True)

    log("Python and the packages, per Mac chip")
    for chip, (triple, platform) in CHIPS.items():
        runtime = app / "runtime" / chip
        unpack_runtime(python_runtime(cache, triple), runtime)
        site_packages = runtime / "lib" / "python3.11" / "site-packages"
        for wheel in wheels(cache, chip, platform):
            install_wheel(wheel, site_packages)

    log("The app")
    copy_app(app, with_token=not args.no_token, with_results=not args.no_results)
    (folder / "Start Workshop.command").write_text(LAUNCHER, encoding="utf-8", newline="\n")
    (folder / "Read me.txt").write_text(README, encoding="utf-8", newline="\n")

    log("Zipping")
    write_zip(folder, out / ZIP_NAME)
    size = lambda p: sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) / 1e6
    log(f"Done: {folder} ({size(folder):.0f} MB)\n      {out / ZIP_NAME} ({(out / ZIP_NAME).stat().st_size / 1e6:.0f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
