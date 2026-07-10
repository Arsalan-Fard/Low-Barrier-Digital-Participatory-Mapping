"""Source of StartWorkshop.exe (built with PyInstaller, see build_launchers.ps1).

A tiny double-click launcher for people who cloned the repo: finds a system
Python that has the dependencies, or bootstraps a .venv and installs
requirements.txt, then runs app.py from the repo root. Any command-line
arguments are passed straight through to app.py.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

REQUIRED_IMPORTS = "import flask, cv2, numpy, pupil_apriltags"


def root_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def has_deps(python_cmd):
    try:
        proc = subprocess.run(
            [*python_cmd, "-c", REQUIRED_IMPORTS],
            capture_output=True, timeout=120,
        )
        return proc.returncode == 0
    except Exception:
        return False


def candidate_pythons():
    candidates = []
    py = shutil.which("py")
    if py:
        candidates.append([py, "-3"])
    for name in ("python3", "python"):
        exe = shutil.which(name)
        if exe:
            candidates.append([exe])
    return candidates


def main():
    root = root_dir()
    os.chdir(root)
    app_args = sys.argv[1:]

    pythons = candidate_pythons()
    if not pythons:
        print("Python 3 is required but was not found.")
        print("Install it from https://www.python.org/downloads/ (tick 'Add to PATH'),")
        print("then run StartWorkshop again.")
        input("Press Enter to close...")
        return 1

    # A system Python that already has the dependencies wins — no venv needed.
    for python_cmd in pythons:
        if has_deps(python_cmd):
            return subprocess.call([*python_cmd, "app.py", *app_args])

    venv_python = root / ".venv" / "Scripts" / "python.exe"
    if not venv_python.exists():
        print("[Launcher] First run: creating .venv ...")
        subprocess.check_call([*pythons[0], "-m", "venv", str(root / ".venv")])
    if not has_deps([str(venv_python)]):
        print("[Launcher] First run: installing requirements (this takes a few minutes) ...")
        subprocess.check_call([str(venv_python), "-m", "pip", "install", "--upgrade", "pip"])
        subprocess.check_call([str(venv_python), "-m", "pip", "install", "-r", "requirements.txt"])
    return subprocess.call([str(venv_python), "app.py", *app_args])


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print("[Launcher] Setup step failed:", exc)
        input("Press Enter to close...")
        raise SystemExit(1)
