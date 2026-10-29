@echo off
setlocal EnableExtensions

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\OpenCode Server.lnk"

if exist "%LNK%" (
  echo [OpenCode] Autostart: enabled
  echo [OpenCode] Shortcut: %LNK%
  exit /b 0
)

echo [OpenCode] Autostart: disabled
exit /b 0
