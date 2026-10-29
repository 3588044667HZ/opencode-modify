# Windows standalone server launchers

Build the standalone server with:

```bat
bun run build:server
```

Output: `packages/opencode/dist-server/opencode-windows-x64/bin/`; the launchers
below are copied next to `opencode.exe` automatically.

These launchers start the headless OpenCode server without the Electron GUI.
Autostart is **off by default**; nothing here enables it automatically.

Place `start-server.bat`, `stop-server.bat`, `status-server.bat`,
`start-server-hidden.vbs`, `enable-autostart.bat`, `disable-autostart.bat`, and
`autostart-status.bat` next to `opencode-server.exe` (or `opencode.exe`), or set
`OPENCODE_SERVER_EXE` to the executable path.

## Start / stop

```bat
start-server.bat
start-server.bat --no-browser
start-server.bat --silent --no-browser
stop-server.bat
status-server.bat
```

The server listens on `127.0.0.1:4096` by default. Override with
`OPENCODE_PORT` and `OPENCODE_HOSTNAME`. If `OPENCODE_SERVER_PASSWORD` is set,
the launcher uses it for the health check; the web UI will ask for Basic Auth.

Set `OPENCODE_DEVICE_NAME` to a short device label for the browser UI, for
example `linux-1g` or `windows-main`. It defaults to the OS hostname.

Logs and the PID file live under `%LOCALAPPDATA%\OpenCode\`.

## Optional autostart

```bat
enable-autostart.bat
autostart-status.bat
disable-autostart.bat
```

`enable-autostart.bat` creates one per-user shortcut:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\OpenCode Server.lnk
```

It points to `wscript.exe` running `start-server-hidden.vbs`, so no console window
is kept open. It does not require administrator rights and does not create a
Windows Service. `disable-autostart.bat` removes only that shortcut.
