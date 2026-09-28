# One-time setup on a Windows machine with an NVIDIA GPU:
#     powershell -ExecutionPolicy Bypass -File digitizer\setup.ps1
# Creates digitizer\.venv with its own Python packages (nothing global is touched).
#
#   -Cuda cu124   RTX 20/30/40-series, RTX 5000/6000 Ada (default; tested)
#   -Cuda cu128   RTX 50-series, RTX PRO 6000 Blackwell (needs torch >= 2.7)
#   -Cpu          no NVIDIA GPU: the vision steps work, the VLM would be far too
#                 slow in-process -- run with --no-vlm or point --vlm-url at a server
param(
    [string]$Cuda = "cu124",
    [switch]$Cpu,
    [string]$Python = "python"
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here ".venv"

$version = & $Python -c "import sys; print('%d.%d' % sys.version_info[:2])"
if ([version]$version -lt [version]"3.10") { throw "Python 3.10+ is needed (found $version). Install it from python.org." }

if (-not (Test-Path $venv)) { & $Python -m venv $venv }
$py = Join-Path $venv "Scripts\python.exe"
& $py -m pip install --upgrade pip

if ($Cpu) {
    & $py -m pip install torch torchvision
} else {
    & $py -m pip install torch torchvision --index-url "https://download.pytorch.org/whl/$Cuda"
}
& $py -m pip install -r (Join-Path $here "requirements.txt")

& $py -c "import torch, cv2, transformers; print('torch', torch.__version__, '| CUDA', torch.cuda.is_available(), '|', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no GPU'); print('opencv', cv2.__version__, '| aruco', hasattr(cv2, 'aruco'), '| transformers', transformers.__version__)"
Write-Host ""
Write-Host "Done. Run commands with: $py -m digitizer ..."
