@echo off
setlocal
cd /d "%~dp0"
if not defined PORT set PORT=3000

where node >nul 2>nul
if errorlevel 1 (
  echo [Error] Node.js was not found.
  echo Please install Node.js 22 or newer from https://nodejs.org/
  pause
  exit /b 1
)

for /f %%v in ('node -p "Number(process.versions.node.split('.')[0])"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo [Error] Node.js 22 or newer is required. Current version:
  node --version
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { $r=Invoke-RestMethod 'http://127.0.0.1:%PORT%/api/health' -TimeoutSec 1; if($r.app -eq 'eventlens-local'){exit 0}else{exit 1} } catch { exit 1 }"
if not errorlevel 1 (
  start "" "http://127.0.0.1:%PORT%"
  exit /b 0
)

powershell -NoProfile -Command "if(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue){exit 0}else{exit 1}"
if not errorlevel 1 (
  echo [Error] Port %PORT% is already used by another program.
  pause
  exit /b 1
)

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%'"
echo ======================================================
echo  EventLens local trading competition analysis
echo  Address: http://127.0.0.1:%PORT%
echo  Close this window or press Ctrl+C to stop the service.
echo ======================================================
node server.js
endlocal
