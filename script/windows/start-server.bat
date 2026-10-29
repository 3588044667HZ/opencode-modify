@echo off
setlocal EnableExtensions

rem Starts the standalone OpenCode server without the Electron GUI.
rem Default: 127.0.0.1:4096, no autostart configuration is changed.
rem Place this file next to opencode-server.exe / opencode.exe, or set OPENCODE_SERVER_EXE.

set "ROOT=%~dp0"
set "HOST=127.0.0.1"
set "PORT=4096"
set "SILENT="
set "OPEN_BROWSER=1"

if defined OPENCODE_HOSTNAME set "HOST=%OPENCODE_HOSTNAME%"
if defined OPENCODE_PORT set "PORT=%OPENCODE_PORT%"

for %%A in (%*) do (
  if /I "%%~A"=="--silent" set "SILENT=1"
  if /I "%%~A"=="--no-browser" set "OPEN_BROWSER=0"
)

set "SERVER_EXE=%OPENCODE_SERVER_EXE%"
if not defined SERVER_EXE if exist "%ROOT%opencode-server.exe" set "SERVER_EXE=%ROOT%opencode-server.exe"
if not defined SERVER_EXE if exist "%ROOT%opencode.exe" set "SERVER_EXE=%ROOT%opencode.exe"
if not defined SERVER_EXE (
  for %%I in (opencode.exe) do if not "%%~$PATH:I"=="" set "SERVER_EXE=%%~$PATH:I"
)

if not defined SERVER_EXE (
  echo [OpenCode] Could not find opencode-server.exe or opencode.exe.
  echo [OpenCode] Place this script next to the executable or set OPENCODE_SERVER_EXE.
  if not defined SILENT pause
  exit /b 1
)

set "LOG_DIR=%LOCALAPPDATA%\OpenCode"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
set "PID_FILE=%LOG_DIR%\server.pid"
set "OUT_LOG=%LOG_DIR%\server.out.log"
set "ERR_LOG=%LOG_DIR%\server.err.log"

call :health
if not errorlevel 1 goto already_running

echo [OpenCode] Starting server at http://%HOST%:%PORT%
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Start-Process -FilePath $env:SERVER_EXE -ArgumentList @('serve','--port',$env:PORT,'--hostname',$env:HOST) -WindowStyle Hidden -PassThru -RedirectStandardOutput $env:OUT_LOG -RedirectStandardError $env:ERR_LOG; $p.Id | Set-Content -NoNewline $env:PID_FILE"
if errorlevel 1 (
  echo [OpenCode] Failed to start the server.
  if not defined SILENT pause
  exit /b 1
)

for /L %%I in (1,1,60) do (
  call :health
  if not errorlevel 1 goto ready
  timeout /t 1 /nobreak >nul
)

echo [OpenCode] Server did not become healthy within 60 seconds.
echo [OpenCode] Check logs: %ERR_LOG%
if not defined SILENT pause
exit /b 1

:ready
echo [OpenCode] Server ready: http://%HOST%:%PORT%
if "%OPEN_BROWSER%"=="1" start "" "http://%HOST%:%PORT%"
if not defined SILENT pause
exit /b 0

:already_running
echo [OpenCode] Server is already running: http://%HOST%:%PORT%
if "%OPEN_BROWSER%"=="1" start "" "http://%HOST%:%PORT%"
if not defined SILENT pause
exit /b 0

:health
set "AUTH_HEADER="
if defined OPENCODE_SERVER_PASSWORD set "AUTH_HEADER=-Headers @{Authorization=('Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('opencode:' + $env:OPENCODE_SERVER_PASSWORD)))}"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ('http://' + $env:HOST + ':' + $env:PORT + '/global/health') %AUTH_HEADER%; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
exit /b %errorlevel%
