@echo off
setlocal
title AI Chat Server

:: ---- Locate a usable Python interpreter ----
:: No hard-coded paths: this file has to work on any machine.
set "PYTHON="
python --version >nul 2>nul && set "PYTHON=python"
if not defined PYTHON (
  py --version >nul 2>nul && set "PYTHON=py"
)
if not defined PYTHON (
  echo.
  echo   [ERROR] Python 3.9+ was not found.
  echo   Install it from https://www.python.org/downloads/ and make sure
  echo   "Add python.exe to PATH" is checked during setup, then run this file again.
  echo.
  pause
  exit /b 1
)

:: Use PowerShell to find and kill any leftover server on port 5200
powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 5200 -State Listen -ErrorAction SilentlyContinue; if($c){foreach($p in $c){Stop-Process -Id $p.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host ('[cleanup] killed PID ' + $p.OwningProcess)}}" 2>nul

echo ====================================
echo   AI Chat LAN Sync Server
echo ====================================
echo.
echo   Starting server on port 5200...
echo   The browser will open automatically once the server is ready.
echo   Logs are saved under the logs folder.
echo   LAN sync address is http://your-computer-IP:5200
echo   Test phone access in its browser: http://your-computer-IP:5200/api/ping
echo   The sync token is shown below after startup.
echo   Close this window or press Ctrl+C to stop the server.
echo.
rem Open the browser only AFTER the port is really listening.
rem Python needs ~1.4s to bind the port; opening earlier gives ERR_CONNECTION_REFUSED.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wait-and-open.ps1" -Port 5200 -Url "http://localhost:5200/"
"%PYTHON%" "%~dp0server.py"

:: Final cleanup on exit
powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 5200 -State Listen -ErrorAction SilentlyContinue; if($c){foreach($p in $c){Stop-Process -Id $p.OwningProcess -Force -ErrorAction SilentlyContinue}}" 2>nul
pause
