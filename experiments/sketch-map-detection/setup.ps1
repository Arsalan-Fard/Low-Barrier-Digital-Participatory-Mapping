$ErrorActionPreference = "Stop"
$ExperimentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvPython = Join-Path $ExperimentDir ".venv\Scripts\python.exe"

python -m venv --clear --system-site-packages (Join-Path $ExperimentDir ".venv")
uv --cache-dir (Join-Path $ExperimentDir ".uv-cache") pip install --python $VenvPython --no-deps `
  "ultralytics==8.1.14" `
  "git+https://github.com/GIScience/ultralytics_siamese_smt.git@4cf4acc9c92df2b37937e52660675af9e75de8cb" `
  "git+https://github.com/facebookresearch/segment-anything-2.git"
uv --cache-dir (Join-Path $ExperimentDir ".uv-cache") pip install --python $VenvPython `
  "numpy<2" `
  "rasterio==1.4.4"

$WeightsDir = Join-Path $ExperimentDir "weights"
New-Item -ItemType Directory -Force -Path $WeightsDir | Out-Null
$Downloads = @{
  "SMT-OSM.pt" = "https://downloads.ohsome.org/sketch-map-tool/weights/SMT-OSM.pt"
  "SMT-ESRI.pt" = "https://downloads.ohsome.org/sketch-map-tool/weights/SMT-ESRI.pt"
  "SMT-CLS.pt" = "https://downloads.ohsome.org/sketch-map-tool/weights/SMT-CLS.pt"
  "sam2_hiera_base_plus.pt" = "https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_base_plus.pt"
}
foreach ($Entry in $Downloads.GetEnumerator()) {
  $Target = Join-Path $WeightsDir $Entry.Key
  if (-not (Test-Path $Target)) {
    Write-Host "Downloading $($Entry.Key)..."
    curl.exe -L --fail --output $Target $Entry.Value
  }
}

Write-Host "Ready. Run:"
Write-Host "  $VenvPython app.py"
