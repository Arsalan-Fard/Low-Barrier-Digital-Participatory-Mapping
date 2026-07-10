#!/bin/bash
# One-time build of the macOS bundle. Run this ON A MAC from anywhere:
#   bash packaging/build_app_mac.sh
# Produces dist/DigitalMappingWorkshop.app and dist/DigitalMappingWorkshop-macos.zip,
# ready to attach to a GitHub release.
set -e
cd "$(dirname "$0")/.."

python3 -m pip install --upgrade pyinstaller
python3 -m pip install -r requirements.txt

python3 -m PyInstaller --clean --noconfirm packaging/DigitalMappingWorkshop.spec

cd dist
ditto -c -k --keepParent DigitalMappingWorkshop.app DigitalMappingWorkshop-macos.zip
echo ""
echo "Built: dist/DigitalMappingWorkshop.app"
echo "Zipped: dist/DigitalMappingWorkshop-macos.zip (attach this to the GitHub release)"
