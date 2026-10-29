@echo off
setlocal EnableExtensions

set "PID_FILE=%LOCALAPPDATA%\OpenCode\server.pid"
if not exist "%PID_FILE%" (
  echo [OpenCode] No server PID file found.
  exit /b 1
)

set /p SERVER_PID=<"%PID_FILE%"
if not defined SERVER_PID (
  echo [OpenCode] Server PID file is empty.
  del /q "%PID_FILE%" >nul 2>&1
  exit /b 1
)

echo [OpenCode] Stopping server PID %SERVER_PID%...
taskkill /PID %SERVER_PID% /T /F >nul 2>&1
if errorlevel 1 (
  echo [OpenCode] Could not stop PID %SERVER_PID%, it may already be gone.
  del /q "%PID_FILE%" >nul 2>&1
  exit /b 1
)

del /q "%PID_FILE%" >nul 2>&1
echo [OpenCode] Server stopped.
exit /b 0
