# Start the Python bot and Node.js voice listener together (Windows).
# Voice monitoring won't work if you only run `python main.py`.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not $env:PORT) { $env:PORT = "8001" }

# Load .env into this shell if present
if (Test-Path .env) {
    Get-Content .env | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim()
            if ($value -and -not [Environment]::GetEnvironmentVariable($name)) {
                Set-Item -Path "env:$name" -Value $value
            }
        }
    }
}

# Pull secrets saved during onboarding (SQLite) into the environment for Node
& .\.venv\Scripts\python.exe export_env.py | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') {
        Set-Item -Path "env:$($matches[1])" -Value $matches[2]
    }
}

if (-not $env:DISCORD_TOKEN) {
    Write-Error "DISCORD_TOKEN not set — complete onboarding at http://localhost:$env:PORT first."
}
if (-not $env:SECRET_KEY) {
    Write-Error "SECRET_KEY not set — complete onboarding or set it in the dashboard."
}

Write-Host "Starting voice listener (Node)..." -ForegroundColor Cyan
$listener = Start-Process -FilePath "node" -ArgumentList "listener/index.js" -PassThru -NoNewWindow -WorkingDirectory $PSScriptRoot

Write-Host "Starting Discord bot + dashboard (Python) on port $env:PORT..." -ForegroundColor Cyan
try {
    & .\.venv\Scripts\python.exe main.py
} finally {
    if ($listener -and -not $listener.HasExited) {
        Write-Host "Stopping voice listener..." -ForegroundColor Yellow
        Stop-Process -Id $listener.Id -Force -ErrorAction SilentlyContinue
    }
}
