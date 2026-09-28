#!/usr/bin/env bash
# One-time setup on Linux (or macOS without a GPU):   bash digitizer/setup.sh [cu124|cu128|cpu]
# Creates digitizer/.venv with its own Python packages.
#   cu124  RTX 20/30/40-series, RTX 5000/6000 Ada (default; tested on Windows)
#   cu128  RTX 50-series, RTX PRO 6000 Blackwell (needs torch >= 2.7)
#   cpu    no NVIDIA GPU: use --no-vlm or --vlm-url
set -euo pipefail
cuda="${1:-cu124}"
here="$(cd "$(dirname "$0")" && pwd)"
python3 -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ is needed"'
[ -d "$here/.venv" ] || python3 -m venv "$here/.venv"
py="$here/.venv/bin/python"
"$py" -m pip install --upgrade pip
if [ "$cuda" = "cpu" ]; then
  "$py" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
else
  "$py" -m pip install torch torchvision --index-url "https://download.pytorch.org/whl/$cuda"
fi
"$py" -m pip install -r "$here/requirements.txt"
"$py" -c "import torch, cv2, transformers; print('torch', torch.__version__, '| CUDA', torch.cuda.is_available()); print('opencv', cv2.__version__, '| transformers', transformers.__version__)"
echo "Done. Run commands with: $py -m digitizer ..."
