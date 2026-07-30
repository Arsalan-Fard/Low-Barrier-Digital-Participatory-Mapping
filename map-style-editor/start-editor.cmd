@echo off
setlocal

cd /d "%~dp0maputnik"

if not exist node_modules (
  echo Installing the pinned Maputnik dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo Maputnik dependency installation failed.
    exit /b 1
  )
)

echo Starting the Liberty style editor...
echo Close this window or press Ctrl+C to stop it.
call npm.cmd run start -- --host 127.0.0.1 --open "/maputnik/?style=/maputnik/styles/liberty.json#15.22/48.873388/2.387845"

