# Lang Audio Tool — startup script
# Run from the project root: .\start.ps1

$ErrorActionPreference = "Stop"

# Check Python
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "Python not found. Install Python 3.10+ and add to PATH."
    exit 1
}

# Check ffmpeg
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning "ffmpeg not found. Export will not work. Install from https://ffmpeg.org/download.html"
}

# Install dependencies if missing
$pip = python -m pip show faster-whisper 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing dependencies..."
    python -m pip install -r requirements.txt
}

# Launch backend
Write-Host "Starting server at http://localhost:8000 ..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PSScriptRoot\backend'; python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

# Open browser
Start-Sleep -Seconds 2
Start-Process "http://localhost:8000"
