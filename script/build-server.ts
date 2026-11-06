#!/usr/bin/env bun
// Standalone server build: Web UI + a single OpenCode CLI binary, no Electron.
// Desktop builds use `bun run build:local` and bundle their own sidecar.
//
// Output: packages/opencode/dist-server/opencode-<platform>-<arch>/bin/
// On Windows the script/windows launchers are copied next to opencode.exe.

import { $ } from "bun"
import { appendFile, cp, stat } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const opencodeDir = path.join(root, "packages/opencode")
const windowsDir = path.join(root, "script/windows")
const args = process.argv.slice(2)
const has = (flag: string) => args.includes(flag)
const noWeb = has("--no-web")
const skipInstall = has("--skip-install")
const help = `用法: bun run build:server [选项]

  --no-web          不嵌入 Web UI（只构建 API server）
  --skip-install    跳过构建前的跨平台可选依赖安装
  -h, --help        显示帮助

默认构建当前平台的 standalone server，并嵌入 Web UI。
输出目录: packages/opencode/dist-server/opencode-<platform>-<arch>/bin/
Windows 下会同时复制 script/windows 的启动/停止/自启脚本。`

if (has("--help") || has("-h")) {
  console.log(help)
  process.exit(0)
}
const now = new Date()
const pad = (value: number) => String(value).padStart(2, "0")
const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
const stamp = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
const sha = (
  await $`git rev-parse --short HEAD`
    .cwd(root)
    .text()
    .catch(() => "local")
).trim()
const dirty = await $`git status --porcelain`
  .cwd(root)
  .text()
  .then((value) => value.trim().length > 0)
  .catch(() => false)
const buildId = `${stamp}-${sha}${dirty ? "-dirty" : ""}`
process.env.OPENCODE_BUILD_ID = buildId
process.env.OPENCODE_BUILD_OUT = "dist-server"

console.log("opencode standalone server build")
console.log(`  build id: ${buildId}`)
console.log(`  output:   ${path.join(opencodeDir, "dist-server")}`)
console.log(`  web ui:   ${noWeb ? "disabled" : "embedded"}`)

const flags = ["--single"]
if (skipInstall) flags.push("--skip-install")
if (noWeb) flags.push("--skip-embed-web-ui")

console.log("\n==> 构建 standalone server")
const build = Bun.spawn(["bun", "run", "script/build.ts", ...flags], {
  cwd: opencodeDir,
  env: { ...process.env, OPENCODE_BUILD_ID: buildId, OPENCODE_BUILD_OUT: "dist-server" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
const buildCode = await build.exited
if (buildCode !== 0) process.exit(buildCode)

const platform = process.platform === "win32" ? "windows" : process.platform
const target = `opencode-${platform}-${process.arch}`
const binDir = path.join(opencodeDir, "dist-server", target, "bin")
const executable = path.join(binDir, process.platform === "win32" ? "opencode.exe" : "opencode")
await stat(executable)

if (process.platform === "win32") {
  console.log("\n==> 复制 Windows 启动器")
  await cp(windowsDir, binDir, { recursive: true })
}

console.log("\n==> 完成")
console.log(`  server: ${executable}`)
if (process.platform === "win32") {
  console.log(`  launch: ${path.join(binDir, "start-server.bat")}`)
  console.log(`  autostart: ${path.join(binDir, "enable-autostart.bat")}（默认不启用）`)
}
await appendFile(
  path.join(root, "BUILD.md"),
  `| ${time} | ${buildId} | ${sha} | feat(script): build:server 构建 standalone server（${noWeb ? "无 Web UI" : "嵌入 Web UI"}）+ Windows 启动器；输出 dist-server | ${buildId} | - |\n`,
  "utf8",
)
