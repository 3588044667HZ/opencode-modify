#!/usr/bin/env bun
// Deploy the standalone headless server to a Linux host over SSH.
// Defaults target the home worker (xhx@192.168.0.9). All remote paths and the
// service name are configurable; no credentials are printed or stored.

import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const has = (name: string) => args.includes(`--${name}`)
const value = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const help = `用法: bun run script/deploy-headless.ts [选项]

同步当前工作区到远端，构建 standalone server，备份并替换二进制，重启用户级 systemd 服务，健康检查失败自动回滚。

  --host <ip>           远端主机（默认 192.168.0.9）
  --user <name>         SSH 用户（默认 xhx）
  --key <path>          SSH 私钥（默认 OPENCODE_DEPLOY_KEY 或 E:\\opencode-tools\\ssh\\backup_deploy）
  --remote-src <dir>    远端源码目录（默认 /home/xhx/opencode-source）
  --binary <path>       远端运行中的二进制（默认 /home/xhx/opencode-server/opencode）
  --data-dir <dir>      远端 opencode 数据目录（默认 /home/xhx/.local/share/opencode）
  --backup-root <dir>   部署回滚备份目录（默认 /home/xhx/backup）
  --env-file <path>     systemd EnvironmentFile，用于健康检查认证（默认 /home/xhx/.config/opencode-server.env）
  --service <name>      systemd 服务名（默认 opencode-server）
  --scope <user|system> systemd 作用域（默认 user）
  --remote-bun <path>   远端 bun（默认 /home/xhx/.bun/bin/bun，找不到时回退 PATH）
  --port <port>         健康检查端口（默认 4096）
  --health-retries <n> 健康检查重试次数（默认 30）
  --wait-backup <sec>  重启前若有备份在跑，最多等待秒数（默认 300）
  --force              备份仍在跑时也继续重启（可能中断备份）
  --channel <name>      构建 channel（默认 local）
  --install             构建前强制执行 bun install --frozen-lockfile
  --skip-sync           跳过源码同步
  --skip-build          跳过构建，直接部署远端已有产物
  --no-restart          只同步/构建，不替换二进制、不重启服务
  --dry-run             只打印计划，不连远端、不写文件
  -h, --help            显示帮助

示例:
  bun run deploy:headless --dry-run
  bun run deploy:headless
  bun run deploy:headless --host 192.168.0.9 --user xhx --no-restart
`

if (has("help") || has("-h")) {
  console.log(help)
  process.exit(0)
}

const host = value("host", "192.168.0.9")
const user = value("user", "xhx")
const key = value(
  "key",
  process.env.OPENCODE_DEPLOY_KEY ??
    (process.platform === "win32"
      ? "E:\\opencode-tools\\ssh\\backup_deploy"
      : path.join(os.homedir(), ".ssh", "opencode-deploy")),
)
const remoteSrc = value("remote-src", "/home/xhx/opencode-source")
const binary = value("binary", "/home/xhx/opencode-server/opencode")
const dataDir = value("data-dir", "/home/xhx/.local/share/opencode")
const backupRoot = value("backup-root", "/home/xhx/backup")
const envFile = value("env-file", "/home/xhx/.config/opencode-server.env")
const service = value("service", "opencode-server")
const scope = value("scope", "user")
const remoteBun = value("remote-bun", "/home/xhx/.bun/bin/bun")
const port = value("port", "4096")
const healthRetries = Number(value("health-retries", "30"))
const waitBackup = Number(value("wait-backup", "300"))
const force = has("force")
const channel = value("channel", "local")
const install = has("install")
const skipSync = has("skip-sync")
const skipBuild = has("skip-build")
const noRestart = has("no-restart")
const dryRun = has("dry-run")
if (!Number.isInteger(waitBackup) || waitBackup < 0) {
  console.error("--wait-backup must be a non-negative integer")
  process.exit(2)
}
if (!Number.isInteger(healthRetries) || healthRetries < 1) {
  console.error("--health-retries must be a positive integer")
  process.exit(2)
}

if (scope !== "user" && scope !== "system") {
  console.error("--scope must be user or system")
  process.exit(2)
}
if (!dryRun && !existsSync(key)) {
  console.error(`SSH key not found: ${key}`)
  process.exit(2)
}

const target = `${user}@${host}`
const sshArgs = ["-i", key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"]
const shq = (input: string) => `'${input.replaceAll("'", "'\\''")}'`
const buildPath = `${remoteSrc}/packages/opencode/dist-server/opencode-linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')/bin/opencode`

type RunOptions = { stream?: boolean; allowFailure?: boolean }
async function run(argv: string[], options: RunOptions = {}) {
  if (dryRun) {
    console.log(`[dry] ${argv.join(" ")}`)
    return { code: 0, stdout: "", stderr: "" }
  }
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: options.stream ? "inherit" : "pipe",
    stderr: options.stream ? "inherit" : "pipe",
  })
  const stdout = proc.stdout ? await new Response(proc.stdout).text() : ""
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : ""
  const code = await proc.exited
  if (code !== 0 && !options.allowFailure) {
    if (!options.stream) {
      if (stderr) console.error(stderr.trimEnd())
      if (stdout) console.error(stdout.trimEnd())
    }
    throw new Error(`command failed (${code}): ${argv[0]}`)
  }
  return { code, stdout, stderr }
}

async function remote(script: string, options: RunOptions = {}) {
  const encoded = Buffer.from(script, "utf8").toString("base64")
  return run(["ssh", ...sshArgs, target, `echo ${encoded} | base64 -d | bash`], options)
}

function remoteScript(body: string, header = "") {
  return `set -u\n${header}\n${body}`
}

console.log(`==> deploy ${target} (${dryRun ? "dry-run" : "apply"})`)
console.log(`    source: ${remoteSrc}`)
console.log(`    binary: ${binary}`)
console.log(`    service: ${scope}/${service}`)

let temp: string | undefined
try {
  if (!skipSync) {
    console.log("==> packaging working tree")
    temp = await mkdtemp(path.join(os.tmpdir(), "opencode-headless-"))
    const archive = path.join(temp, "source.tgz")
    const excludes = [
      ".git",
      "node_modules",
      "*/node_modules",
      ".opencode",
      "backup-server",
      "packages/*/dist",
      "packages/*/dist-server",
      "packages/*/out",
      "packages/*/.cache",
      "packages/desktop/dist-lan",
      "*/.tmp",
      "*.sock",
      "*.log",
    ].flatMap((item) => ["--exclude", item])
    await run(["tar", "-czf", archive, "-C", root, ...excludes, "."])
    const remoteArchive = `${remoteSrc}/.opencode-deploy-${Date.now()}.tgz`
    console.log("==> uploading source")
    await run(
      ["scp", "-i", key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", archive, `${target}:${remoteArchive}`],
      {
        stream: true,
      },
    )
    console.log("==> extracting source")
    await remote(
      remoteScript(
        `mkdir -p ${shq(remoteSrc)}
tar -xzf ${shq(remoteArchive)} -C ${shq(remoteSrc)}
rm -f ${shq(remoteArchive)}`,
      ),
      { stream: true },
    )
  } else {
    console.log("==> source sync skipped")
  }

  if (!skipBuild) {
    console.log("==> building standalone server")
    await remote(
      remoteScript(
        `cd ${shq(remoteSrc)}
if [ -x ${shq(remoteBun)} ]; then BUN=${shq(remoteBun)}; else BUN=$(command -v bun); fi
if [ -z "$BUN" ]; then echo "bun not found on remote" >&2; exit 1; fi
export PATH="$(dirname "$BUN"):$PATH"
if [ "${install ? "1" : "0"}" = "1" ] || [ ! -d node_modules ]; then
  "$BUN" install --frozen-lockfile
fi
export OPENCODE_CHANNEL=${shq(channel)}
"$BUN" run build:server --skip-install
ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; esac
BUILT=${shq(remoteSrc)}/packages/opencode/dist-server/opencode-linux-$ARCH/bin/opencode
test -x "$BUILT"
"$BUILT" --version
echo "BUILT=$BUILT"`,
      ),
      { stream: true },
    )
  } else {
    console.log("==> build skipped")
  }

  if (noRestart) {
    console.log("==> no-restart requested; leaving service untouched")
    process.exit(0)
  }

  console.log("==> deploying and restarting service")
  const deploy = await remote(
    remoteScript(
      `SERVICE=${shq(service)}
BIN=${shq(binary)}
DATA=${shq(dataDir)}
ENV_FILE=${shq(envFile)}
PORT=${shq(port)}
BUILT=${buildPath}
if [ "${scope}" = "user" ]; then
  export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  systemctl_cmd() { systemctl --user "$@"; }
else
  systemctl_cmd() { systemctl "$@"; }
fi
if [ ! -x "$BUILT" ]; then echo "built binary not found: $BUILT" >&2; exit 1; fi
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE" || true; set +a
fi
backup_running() {
  if [ -n "\${OPENCODE_SERVER_USERNAME:-}" ] && [ -n "\${OPENCODE_SERVER_PASSWORD:-}" ]; then
    curl -sf -m 3 -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" "http://127.0.0.1:$PORT/api/backup/status" 2>/dev/null | grep -q '"running":true'
    return $?
  fi
  return 1
}
if backup_running; then
  if [ "${force ? "1" : "0"}" = "1" ]; then
    echo "backup is running; --force specified, continuing"
  else
    echo "backup is running; waiting up to ${waitBackup}s (use --force to skip)"
    waited=0
    while backup_running; do
      sleep 5
      waited=$((waited + 5))
      if [ "$waited" -ge "${waitBackup}" ]; then
        echo "backup still running after ${waitBackup}s; aborting (use --force)" >&2
        exit 1
      fi
    done
  fi
fi
TS=$(date +%Y%m%d-%H%M%S)
BAK="$BIN.bak-$TS"
DBBAK=${shq(backupRoot)}/opencode-deploy-$TS
echo "backup binary: $BAK"
echo "backup data:   $DBBAK"
systemctl_cmd stop "$SERVICE" >/dev/null 2>&1 || true
sleep 2
mkdir -p "$DBBAK"
cp -a "$BIN" "$BAK"
cp -a "$DATA"/opencode*.db* "$DBBAK"/ 2>/dev/null || true
cp -a "$DATA"/auth.json "$DBBAK"/ 2>/dev/null || true
cp "$BUILT" "$BIN.new"
chmod 755 "$BIN.new"
mv "$BIN.new" "$BIN"
systemctl_cmd start "$SERVICE"

health() {
  if [ -f "$ENV_FILE" ]; then
    set -a; . "$ENV_FILE" || return 1; set +a
    if [ -n "\${OPENCODE_SERVER_USERNAME:-}" ] && [ -n "\${OPENCODE_SERVER_PASSWORD:-}" ]; then
      curl -sf -m 3 -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" "http://127.0.0.1:$PORT/global/health" >/dev/null 2>&1
      return $?
    fi
  fi
  CODE=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/global/health" 2>/dev/null || echo 000)
  [ "$CODE" != "000" ] && [ -n "$CODE" ]
}
ready=0
for i in $(seq 1 ${healthRetries}); do
  if systemctl_cmd is-active --quiet "$SERVICE" && health; then ready=1; break; fi
  sleep 1
done
if [ "$ready" = "1" ]; then
  "$BIN" --version
  echo "deployed"
  exit 0
fi
echo "health check failed; rolling back" >&2
systemctl_cmd stop "$SERVICE" >/dev/null 2>&1 || true
cp -a "$BAK" "$BIN"
cp -a "$DBBAK"/opencode*.db* "$DATA"/ 2>/dev/null || true
systemctl_cmd start "$SERVICE"
sleep 2
systemctl_cmd is-active "$SERVICE" || true
echo "recent service logs:" >&2
if [ "${scope}" = "user" ]; then
  XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" journalctl --user -u "$SERVICE" -n 40 --no-pager >&2 || true
else
  journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
fi
exit 1`,
    ),
    { stream: true },
  )
  if (deploy.code !== 0) process.exit(deploy.code)
  console.log("==> done")
} catch (error) {
  console.error(`deploy failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
} finally {
  if (temp) await rm(temp, { recursive: true, force: true })
}
