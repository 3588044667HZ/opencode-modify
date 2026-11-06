# Laptop Bridge MVP

Status: Draft for implementation  
Date: 2026-11-03  
Related: OpenCode remote MCP, DesktopCommanderMCP 0.3.1, supergateway 4.2.1

## 1. Summary

Laptop Bridge exposes a **generic shell on the user's laptop** to OpenCode running on a workstation. The bridge runs on the laptop, is reachable only over Tailscale, and is consumed by OpenCode as a standard remote MCP server.

The bridge is not an adb tool. adb, esptool, pio, idf.py, openocd, ssh, docker, and any other local toolchain command are ordinary commands executed through the same shell/process interface.

The bridge is implemented as a separate project, not as a `packages/*` package in the OpenCode monorepo. This spec lives in the OpenCode repository because it defines the integration contract; implementation lives in the standalone bridge project.

## 2. Goals

- Expose arbitrary shell command execution on the laptop.
- Support one-shot commands, long-running processes, and interactive process input.
- Work through Tailscale without exposing a LAN or public port.
- Require an API token in addition to Tailscale network access.
- Make the execution location unambiguous in OpenCode: local `shell` runs on the workstation; `laptop_*` tools run on the laptop.
- Keep the MVP small: no custom MCP protocol server, no adb-specific tools, no serial implementation.

## 3. Non-goals

- No sandbox. The bridge runs with the laptop user's authority.
- No adb-specific tool.
- No serial/PTY-specific tool in the MVP.
- No filesystem MCP tools; shell commands cover file operations.
- No multi-user tenancy.
- No public exposure, Tailscale Funnel, or LAN binding.
- No OAuth flow in the MVP; bearer token only.
- No automatic updater or installer productization in the MVP.

## 4. Architecture

```text
OpenCode (workstation)
  MCP client
    server name: laptop
    transport: Streamable HTTP
    URL: https://<laptop>.<tailnet>.ts.net/mcp
    auth: Authorization: Bearer <token>
        |
        v
Tailscale Serve (HTTPS, tailnet only)
        |
        v
supergateway 4.2.1 (127.0.0.1:8765, API key, tool filter)
        |
        v
DesktopCommanderMCP 0.3.1 (stdio)
        |
        v
laptop user session: shell, child processes, adb, toolchain
```

The bridge is a **server**. OpenCode remains a **client**. There is no source-level dependency between the bridge and `packages/opencode/src/mcp`.

## 5. MCP Contract

### 5.1 Server identity

- OpenCode config key: `laptop`
- MCP server display name: `desktop-commander` (provided by DesktopCommanderMCP)
- OpenCode-generated tool prefix: `laptop_`
- Raw MCP tool names are not prefixed by the bridge.

### 5.2 Transport

- Primary: Streamable HTTP
- Path: `/mcp`
- SSE fallback is not required for the MVP, but the bridge must not break OpenCode's fallback attempt.
- The bridge binds `127.0.0.1` only. Tailscale Serve provides TLS and tailnet reachability.

### 5.3 Authentication

Every MCP request must carry:

```http
Authorization: Bearer <LAPTOP_MCP_TOKEN>
```

- Missing/invalid token returns HTTP 401.
- The token is supplied through an environment variable or protected file; it must not be committed.
- supergateway's `--apiKey` or `SUPERGATEWAY_API_KEY` mechanism is acceptable.
- `oauth` is disabled in the OpenCode config because the MVP uses a static bearer token.

### 5.4 Exposed tools

The MVP exposes only the process/shell tools:

| Raw tool | OpenCode tool | Purpose |
| --- | --- | --- |
| `start_process` | `laptop_start_process` | Start a shell command or interactive process |
| `read_process_output` | `laptop_read_process_output` | Read output from a running process |
| `interact_with_process` | `laptop_interact_with_process` | Send input to a running process |
| `force_terminate` | `laptop_force_terminate` | Terminate a process session |
| `list_sessions` | `laptop_list_sessions` | List active process sessions |

All other DesktopCommander tools must be filtered out with `supergateway --tools`.

#### `start_process`

Input:

```ts
{
  command: string
  timeout_ms: number
  shell?: string
  verbose_timing?: boolean
}
```

Behavior:

- Starts the command on the laptop.
- Returns initial output and a process ID when the process remains active.
- A timeout does not necessarily kill the process; the process may continue in the background.
- `command` is the generic shell entry point. adb and other tools are normal commands.
- There is no separate `cwd` field in DesktopCommander 0.3.1. Use a platform-appropriate `cd` prefix in `command`, or set `shell`.

#### `read_process_output`

Input:

```ts
{
  pid: number
  timeout_ms?: number
  offset?: number
  length?: number
  verbose_timing?: boolean
}
```

#### `interact_with_process`

Input:

```ts
{
  pid: number
  input: string
  timeout_ms?: number
  wait_for_prompt?: boolean
  verbose_timing?: boolean
}
```

#### `force_terminate`

Input:

```ts
{ pid: number }
```

#### `list_sessions`

Input:

```ts
{}
```

### 5.5 Tool naming

OpenCode applies `McpCatalog.toolName(serverName, toolName)`:

```text
laptop + start_process -> laptop_start_process
laptop + read_process_output -> laptop_read_process_output
```

The bridge must not add its own tool prefix. supergateway `--toolPrefix` must not be used.

### 5.6 OpenCode configuration

```json
{
  "mcp": {
    "laptop": {
      "type": "remote",
      "url": "https://<laptop>.<tailnet>.ts.net/mcp",
      "enabled": false,
      "oauth": false,
      "timeout": 120000,
      "headers": {
        "Authorization": "Bearer {env:LAPTOP_MCP_TOKEN}"
      }
    }
  }
}
```

- `enabled:false` avoids startup failure when the laptop is offline. Use `mcp(op="enable", name="laptop")` when needed.
- If the laptop is always online, `enabled:true` is acceptable.
- `timeout` must be large enough for builds and device operations.
- The OpenCode agent must not silently fall back to local `shell` when `laptop_*` is unavailable.

## 6. Security

This MVP intentionally exposes arbitrary shell execution to an authorized MCP client. It is not a sandbox.

Required controls:

- Bind the bridge to `127.0.0.1`; never `0.0.0.0`.
- Expose only through Tailscale Serve, never Tailscale Funnel or a public port.
- Restrict access with Tailscale ACLs to the workstation identity/device.
- Require the bearer token even inside the tailnet.
- Run as the normal user, not root/Administrator.
- Windows: run at user logon through Task Scheduler, not as a Session 0 service; USB and adb must be visible to the user session.
- Linux: user-level systemd service; grant `dialout`/`plugdev` only if serial devices are needed.
- Record command, cwd/command prefix, pid, exit status, duration, and errors where available.
- Never commit the token or deployment credentials.
- Keep OpenCode permission for `laptop_*` at `ask` initially.

## 7. Implementation Layout

Standalone project: `E:\opencode-laptop-bridge`

```text
opencode-laptop-bridge/
  package.json
  README.md
  .env.example
  scripts/
    start-bridge.mjs
    smoke-test.mjs
  deploy/
    windows/
      install-task.ps1
      start-hidden.vbs
    linux/
      opencode-laptop-bridge.service
    tailscale.md
  opencode.example.json
```

Pinned versions:

- Node.js 24.x
- supergateway 4.2.1
- @wonderwhy-er/desktop-commander 0.3.1
- @modelcontextprotocol/sdk 1.32.2 for the smoke test only

## 8. Startup Contract

`start-bridge.mjs` must:

1. Require `LAPTOP_MCP_TOKEN`.
2. Resolve the installed supergateway and DesktopCommander entry points locally.
3. Start supergateway on `127.0.0.1:${BRIDGE_PORT:-8765}`.
4. Use Streamable HTTP at `/mcp`.
5. Enable stateful sessions with a long session timeout.
6. Expose only the five process tools listed above.
7. Enable API key authentication and JSON logging.
8. Expose `/healthz`.
9. Keep the process in the foreground and propagate termination to the child.

Reference arguments:

```text
--stdio "node <desktop-commander-entry>"
--outputTransport streamableHttp
--host 127.0.0.1
--port 8765
--streamableHttpPath /mcp
--stateful
--sessionTimeout 1800000
--tools start_process
--tools read_process_output
--tools interact_with_process
--tools force_terminate
--tools list_sessions
--healthEndpoint /healthz
--healthCheck gateway
--logLevel info
--logFormat json
```

## 9. Tailscale

- Laptop and workstation are in the same tailnet.
- Run `tailscale serve --bg 8765` on the laptop.
- The resulting URL is typically `https://<laptop>.<tailnet>.ts.net/mcp`.
- Verify from the workstation with an MCP client and with the bearer token.
- Ensure the laptop is awake and Tailscale is connected before expecting tools.

## 10. Test Plan

### Automated smoke test

`scripts/smoke-test.mjs` must:

1. Start the bridge on a free/known port.
2. Wait for `/healthz`.
3. Assert an unauthenticated request is rejected.
4. Connect using the MCP SDK with the bearer token.
5. Assert exactly the five allowed tools are listed.
6. Call `start_process` with `echo bridge-ok` and a short timeout; assert output contains `bridge-ok`.
7. Call `start_process` with a command that exceeds its timeout and continues; use `read_process_output` to read more; call `force_terminate`.
8. Call `interact_with_process` against an interactive process if practical.
9. Stop the bridge and fail cleanly if any assertion fails.

`adb devices` is an optional manual check when a device is connected; it is not a required automated test.

### OpenCode integration test

- Configure the remote server as `laptop`.
- Enable it with the `mcp` tool.
- Confirm the model sees `laptop_start_process` etc.
- Call `laptop_start_process` with `echo $env:COMPUTERNAME` or `hostname` and verify the laptop hostname, not the workstation hostname.
- Stop the bridge and confirm the tools fail/are unavailable; no local fallback.

## 11. Acceptance Criteria

- Bridge starts on Windows and Linux with the pinned dependencies.
- `/healthz` is reachable on loopback.
- Unauthenticated MCP requests return 401.
- Authenticated MCP requests list exactly the five process tools.
- A one-shot command returns stdout/stderr/exit information.
- A long-running process can be read and terminated.
- Interactive input works for a simple process.
- OpenCode exposes the tools as `laptop_*`.
- The laptop hostname is returned by a bridged command.
- No token or credential is stored in the repository.
- Tailscale is the only network path to the bridge.

## 12. Future Work

- Add a thin `execute_command` alias or adapter if `start_process` is confusing to the model.
- Add a generic PTY/serial tool only if the process tools are insufficient.
- Add command policy/audit outside DesktopCommander.
- Add a first-class installer and service manager.
- Pin and publish compatibility with specific OpenCode versions.
- Consider OAuth or mTLS if bearer tokens are insufficient.

## 13. Open Questions

- Does DesktopCommander's `start_process` interactive detection cover the user's serial monitor use case?
- Should the bridge use `start_process` directly or add a thin adapter for `cwd`?
- Should the token be a file-backed secret rather than an environment variable?
- Should `enabled` default to true on an always-on laptop?

## 14. Packaging Decision

Accepted delivery forms:

- portable/green directory
- single-file executable
- lightweight GUI

Decision for the first release: **portable/green directory**, built on demand for the target platform. This keeps the current Node/supergateway/DesktopCommander process model intact and avoids pretending a multi-process Node stack is a single binary.

Planned portable layout:

```text
opencode-laptop-bridge-portable-<platform>-<arch>/
  start.cmd / start.sh
  runtime/node(.exe)
  app/
    package.json
    scripts/
    node_modules/
    opencode.example.json
  data/token          # generated on first run, never committed
  logs/
  README-PORTABLE.txt
```

- The portable build bundles the target Node runtime.
- `data/` and `logs/` stay beside the executable; uninstall is deleting the directory.
- No registry, installer, or admin rights.
- The token is generated on first run and stored in `data/token` with user-only permissions.
- Tailscale is an external prerequisite; the bridge does not bundle or install it.
- Distribution is target-specific: Windows x64/arm64 and Linux x64/arm64 are separate builds.

Single-file executable is deferred. The current bridge spawns Node-based supergateway and DesktopCommander children; a real single-file build would require embedding a runtime plus child-process bootstrap, and risks native dependency and antivirus issues. It is not the first packaging target.

A lightweight GUI is a later control surface, not a second bridge implementation. Preferred shape: a Tauri tray/window app that starts/stops the portable core, shows health and Tailscale URL, opens logs, and manages the token. Electron is out of scope. The headless portable directory must remain usable without the GUI.
