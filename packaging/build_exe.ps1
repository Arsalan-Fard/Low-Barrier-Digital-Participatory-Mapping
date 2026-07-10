$ErrorActionPreference = "Stop"

# Run PyInstaller from the repo root so build/ and dist/ land there.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
py -3.11 -m PyInstaller --clean --noconfirm .\packaging\DigitalMappingWorkshop.spec

Write-Host ""
Write-Host "Built: $repoRoot\dist\DigitalMappingWorkshop\DigitalMappingWorkshop.exe"
Write-Host "Place token.txt next to the exe to configure Mapbox/Google keys."
