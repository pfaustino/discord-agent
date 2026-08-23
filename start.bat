@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PROJECT_DIR=%CD%"

if not defined PORT set PORT=8000

echo.
echo  Discord Agent (nodebot) - restart
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: node not found. Install Node.js 22+ and add it to PATH.
  exit /b 1
)

REM Read PORT from .env (default 8000)
if exist .env (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
  )
)

echo Stopping discord-agent processes...
call :KillProject
call :KillPort %PORT%
timeout /t 2 /nobreak >nul 2>nul
call :KillProject
call :KillPort %PORT%

call :PortInUse %PORT%
if not errorlevel 1 (
  echo ERROR: Port %PORT% is still in use.
  exit /b 1
)

echo Port %PORT% is free.

set "ENV_FILE=%TEMP%\discord-agent-env.txt"
if exist data\bot.db (
  node export_env.js data\bot.db > "!ENV_FILE!" 2>nul
  if exist "!ENV_FILE!" (
    for /f "usebackq tokens=1,* delims==" %%a in ("!ENV_FILE!") do (
      if not defined %%a set "%%a=%%b"
    )
  )
)

if not exist nodebot\node_modules (
  echo Installing nodebot dependencies...
  cd nodebot
  call npm ci --omit=dev
  if errorlevel 1 exit /b 1
  cd ..
)

if exist data\bot.db (
  if not exist data\nodebot.db (
    echo Migrating guild settings from data\bot.db ...
    node --experimental-sqlite nodebot\src\migrate-settings.js --from data\bot.db --to data\nodebot.db
  )
)

echo Dashboard: http://localhost:%PORT%
echo.

if not exist .env (
  echo WARNING: .env not found — copy .env.example and fill in DISCORD_TOKEN, etc.
)

echo Registering slash commands (non-fatal if this fails)...
node --experimental-sqlite nodebot\src\deploy-commands.js || echo Slash-command registration skipped.

echo Starting bot + dashboard...
echo Press Ctrl+C to stop.
echo.
node --experimental-sqlite nodebot\src\index.js

echo.
echo Stopping...
call :KillProject

endlocal
exit /b 0

REM --- helpers ---

:KillProject
powershell -NoProfile -Command ^
  "$root = '%PROJECT_DIR%'.ToLower();" ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($root) -and ($_.CommandLine -match 'nodebot' -or $_.CommandLine -match 'listener\\index\.js' -or $_.CommandLine -match 'listener/index\.js' -or $_.CommandLine -match 'main\.py') } | ForEach-Object { Write-Host ('  Killing PID ' + $_.ProcessId + ' ' + $_.Name); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
goto :eof

:KillPort
set "KP=%~1"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr /C:":%KP% "') do (
  if not "%%p"=="0" (
    echo   Killing PID %%p ^(port %KP%^)
    taskkill /F /PID %%p >nul 2>&1
  )
)
goto :eof

:PortInUse
set "PU=%~1"
netstat -ano | findstr LISTENING | findstr /C:":%PU% " >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0
