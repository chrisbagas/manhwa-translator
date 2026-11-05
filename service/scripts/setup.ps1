# One-time setup of the Dalbit local service (Windows PowerShell).
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 18+ is required (https://nodejs.org)" }
if (-not (Test-Path .venv)) { py -3 -m venv .venv }
$py = ".\.venv\Scripts\python.exe"
& $py -m pip install --upgrade pip
& $py -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
& $py -m pip install -r requirements.txt
Push-Location bergamot_host; npm ci --no-audit --no-fund; Pop-Location
& $py scripts\download_models.py @args
& $py -m dalbit doctor --warm
Write-Host "`nStart the service with:  .venv\Scripts\python.exe -m dalbit serve"
Write-Host "Pairing token: $(& $py -m dalbit token)"
