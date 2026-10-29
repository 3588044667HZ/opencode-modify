@echo off
setlocal EnableExtensions

rem Optional: creates a per-user Startup shortcut. It is NOT enabled by default.
set "ROOT=%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\OpenCode Server.lnk"
set "HIDDEN=%ROOT%start-server-hidden.vbs"
set "APPDIR=%ROOT%"

if not exist "%HIDDEN%" (
  echo [OpenCode] Missing %HIDDEN%
  exit /b 1
)

if not exist "%STARTUP%" mkdir "%STARTUP%" >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'; $s.Arguments = [char]34 + $env:HIDDEN + [char]34; $s.WorkingDirectory = $env:APPDIR; $s.WindowStyle = 7; $s.Save()"
if errorlevel 1 (
  echo [OpenCode] Failed to create the Startup shortcut.
  exit /b 1
)

echo [OpenCode] Autostart enabled: %LNK%
exit /b 0
