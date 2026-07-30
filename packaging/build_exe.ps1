$ErrorActionPreference = "Stop"

# Run PyInstaller from the repo root so build/ and dist/ land there.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$pythonExe = $null
$pythonPrefix = @()
foreach ($candidate in @("python3", "python")) {
  $command = Get-Command $candidate -ErrorAction SilentlyContinue
  if (-not $command) { continue }
  try {
    & $command.Source -c "import PyInstaller" 2>$null
    if ($LASTEXITCODE -eq 0) {
      $pythonExe = $command.Source
      break
    }
  } catch {
    # Try the next Python command.
  }
}

if (-not $pythonExe) {
  $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
  if ($pyLauncher) {
    try {
      & $pyLauncher.Source -3.11 -c "import PyInstaller" 2>$null
      if ($LASTEXITCODE -eq 0) {
        $pythonExe = $pyLauncher.Source
        $pythonPrefix = @("-3.11")
      }
    } catch {
      # The launcher exists but has no usable Python 3.11 installation.
    }
  }
}

if (-not $pythonExe) {
  throw "Python 3 with PyInstaller is required. Install requirements.txt first."
}

& $pythonExe @pythonPrefix -m PyInstaller --clean --noconfirm .\packaging\DigitalMappingWorkshop.spec
if ($LASTEXITCODE -ne 0) {
  throw "PyInstaller failed with exit code $LASTEXITCODE."
}

$exePath = Join-Path $repoRoot "dist\DigitalMappingWorkshop\DigitalMappingWorkshop.exe"
if (-not (Test-Path -LiteralPath $exePath)) {
  throw "Build finished without creating $exePath"
}

Write-Host ""
Write-Host "Built: $exePath"
Write-Host "Place token.txt next to the exe to configure Mapbox/Google keys."
