@echo off
setlocal EnableExtensions

set "HOST=127.0.0.1"
set "PORT=4096"
if defined OPENCODE_HOSTNAME set "HOST=%OPENCODE_HOSTNAME%"
if defined OPENCODE_PORT set "PORT=%OPENCODE_PORT%"

set "PID_FILE=%LOCALAPPDATA%\OpenCode\server.pid"
if exist "%PID_FILE%" (
  set /p SERVER_PID=<"%PID_FILE%"
  echo [OpenCode] PID: %SERVER_PID%
) else (
  echo [OpenCode] PID: not running
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ('http://' + $env:HOST + ':' + $env:PORT + '/global/health'); Write-Host ('[OpenCode] Health: ' + $r.StatusCode + ' ' + $r.Content) } catch { Write-Host '[OpenCode] Health: unavailable'; exit 1 }"
exit /b %errorlevel%
