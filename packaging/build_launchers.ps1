$ErrorActionPreference = "Stop"

# Rebuilds StartWorkshop.exe (the small committed repo launcher) at the repo root.
# Not to be confused with build_exe.ps1, which builds the full DigitalMappingWorkshop bundle.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
py -3.11 -m PyInstaller --onefile --console --name StartWorkshop `
  --distpath . --workpath build\start_workshop --specpath packaging `
  packaging\start_workshop.py

Write-Host ""
Write-Host "Built: $repoRoot\StartWorkshop.exe"
