@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PROJECT_DIR=%CD%"

if not defined PORT set PORT=8001

echo.
echo  Discord Agent - restart
echo.

if not exist ".venv\Scripts\python.exe" (
  echo ERROR: .venv not found.
  echo Run: python -m venv .venv
  echo      .venv\Scripts\pip install -r requirements.txt
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: node not found. Install Node.js and add it to PATH.
  exit /b 1
)

REM Read PORT from .env (default 8001; avoid 8000 if another app uses it)
if exist .env (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
  )
)

echo Stopping discord-agent processes...
call :KillProject
call :KillPort 8091
call :KillPort %PORT%
if not "%PORT%"=="8001" call :KillPort 8001
timeout /t 2 /nobreak >nul
call :KillProject
call :KillPort 8091
call :KillPort %PORT%
if not "%PORT%"=="8001" call :KillPort 8001

call :PortInUse 8091
if not errorlevel 1 (
  echo ERROR: Port 8091 is still in use.
  exit /b 1
)
call :PortInUse %PORT%
if not errorlevel 1 (
  echo ERROR: Port %PORT% is still in use.
  exit /b 1
)

echo Ports are free.
echo Loading config from database...

set "ENV_FILE=%TEMP%\discord-agent-env.txt"
.\.venv\Scripts\python.exe export_env.py > "!ENV_FILE!" 2>&1
if errorlevel 1 (
  echo ERROR: Could not load config:
  type "!ENV_FILE!"
  exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%a in ("!ENV_FILE!") do (
  set "%%a=%%b"
)

if not defined PORT set PORT=8001

echo Dashboard: http://localhost:%PORT%
echo.

if not defined DISCORD_TOKEN (
  echo WARNING: DISCORD_TOKEN not set - open http://localhost:%PORT% to finish setup.
)

echo Starting voice listener ^(port 8091^)...
start "Discord Agent Listener" /B node listener\index.js

echo Starting bot + dashboard ^(port %PORT%^)...
echo Press Ctrl+C to stop both.
echo.
.\.venv\Scripts\python.exe main.py

echo.
echo Stopping voice listener...
call :KillProject
call :KillPort 8091

endlocal
exit /b 0

REM --- helpers ---

:KillProject
powershell -NoProfile -Command ^
  "$root = '%PROJECT_DIR%'.ToLower();" ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($root) -and ($_.CommandLine -match 'main\.py' -or $_.CommandLine -match 'listener\\index\.js' -or $_.CommandLine -match 'listener/index\.js') } | ForEach-Object { Write-Host ('  Killing PID ' + $_.ProcessId + ' ' + $_.Name); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
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
