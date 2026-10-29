@echo off
setlocal EnableExtensions

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\OpenCode Server.lnk"

if not exist "%LNK%" (
  echo [OpenCode] Autostart is already disabled.
  exit /b 0
)

del /q "%LNK%"
if errorlevel 1 (
  echo [OpenCode] Failed to remove %LNK%
  exit /b 1
)

echo [OpenCode] Autostart disabled.
exit /b 0
