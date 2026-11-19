#!/usr/bin/env bun
// Split desktop build pipeline:
//   backend  -> packages/opencode/dist/node + standalone CLI copied into desktop resources
//   frontend -> packages/app/dist + packages/desktop/out (embeds the backend bundle)
//   desk     -> electron-builder package/deploy using existing artifacts
//   all      -> backend + frontend + desk
// Headless server remains `bun run build:server` + `bun run deploy:headless`.

import { $ } from "bun"
import { cp, mkdir, readdir, stat } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const opencodeDir = path.join(root, "packages/opencode")
const desktopDir = path.join(root, "packages/desktop")
const appDir = path.join(root, "packages/app")
const backendStateFile = path.join(opencodeDir, "dist/node/.build.json")
const frontendStateFile = path.join(desktopDir, "out/.build.json")

type State = {
  readonly id: string
  readonly sha: string
  readonly dirty: boolean
  readonly time: string
  readonly builtAt: number
}

const args = process.argv.slice(2)
const mode = args[0]
const has = (name: string) => args.includes(`--${name}`)
const value = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const help = `用法: bun run script/build-desktop.ts <backend|frontend|desk|all> [选项]

  backend   构建 packages/opencode/dist/node，构建 standalone CLI 并复制到 packages/desktop/resources
  frontend  构建 packages/app/dist 和 packages/desktop/out（需要先运行 backend）
  desk      只打包/部署现有 desktop 产物，不编译（需要 backend + frontend 的 build ID 一致）
  all       依次执行 backend、frontend、desk

选项:
  --channel <dev|beta|prod>  构建 channel（默认 env 或 dev）
  --semantic                 backend/all 时要求构建语义 jar
  --no-semantic              all 时跳过语义 jar
  --installer                desk 生成 NSIS 安装器（默认只生成 win-unpacked 目录）
  --deploy <dir>             desk 打包后覆盖到目标目录（目标 app 必须先完全退出）
  -h, --help                 显示帮助

示例:
  bun run build:backend --semantic
  bun run build:frontend
  bun run build:desk --deploy E:\\opencode-desktop-dev
  bun run build:desktop --semantic --deploy E:\\opencode-desktop-dev
`

if (!mode || has("help") || mode === "-h" || mode === "--help") {
  console.log(help)
  process.exit(mode ? 0 : 2)
}
if (!["backend", "frontend", "desk", "all"].includes(mode)) {
  console.error(`unknown mode: ${mode}`)
  console.log(help)
  process.exit(2)
}

const channel = (() => {
  const input = value("channel", process.env.OPENCODE_CHANNEL ?? "dev")
  if (input !== "dev" && input !== "beta" && input !== "prod") {
    console.error(`invalid channel: ${input}`)
    process.exit(2)
  }
  return input
})()
process.env.OPENCODE_CHANNEL = channel

const step = (name: string) => console.log(`\n==> ${name}`)

async function makeBuildId(): Promise<State> {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const stamp = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  const sha = (await $`git rev-parse --short HEAD`.cwd(root).text()).trim()
  const dirty = (await $`git status --porcelain`.cwd(root).text()).trim().length > 0
  return { id: `${stamp}-${sha}${dirty ? "-dirty" : ""}`, sha, dirty, time, builtAt: Date.now() }
}

async function readState(file: string): Promise<State | undefined> {
  const text = await Bun.file(file).text().catch(() => undefined)
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Partial<State>
    if (typeof value.id !== "string" || typeof value.sha !== "string" || typeof value.builtAt !== "number") return undefined
    return value as State
  } catch {
    return undefined
  }
}

async function writeState(file: string, state: State) {
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, JSON.stringify(state, null, 2) + "\n")
}

function platformTarget() {
  const platform = process.platform === "win32" ? "windows" : process.platform
  return `opencode-${platform}-${process.arch}`
}

function cliNames() {
  return process.platform === "win32"
    ? { built: "opencode.exe", resource: "opencode-cli.exe" }
    : { built: "opencode", resource: "opencode-cli" }
}

async function backend(semantic: boolean) {
  const state = await makeBuildId()
  process.env.OPENCODE_BUILD_ID = state.id
  step(`backend build ${state.id}`)

  step("构建服务端 sidecar bundle (dist/node)")
  await $`bun script/build-node.ts`.cwd(opencodeDir)

  step("构建 standalone CLI (无内嵌 Web UI)")
  await $`bun run build:server --skip-install --no-web`.cwd(root)

  const names = cliNames()
  const target = platformTarget()
  const built = path.join(opencodeDir, "dist-server", target, "bin", names.built)
  const info = await stat(built).catch(() => undefined)
  if (!info?.isFile()) throw new Error(`standalone CLI missing: ${built}`)
  const destination = path.join(desktopDir, "resources", names.resource)
  await cp(built, destination, { force: true })
  console.log(`  cli: ${destination} (${(info.size / 1e6).toFixed(1)} MB)`)

  if (semantic) {
    step("构建语义引擎 jar")
    await $`bun run script/build-semantic.ts --require`.cwd(root)
  }

  await writeState(backendStateFile, state)
  console.log(`\nbackend done: ${state.id}`)
}

async function frontend() {
  const backendState = await readState(backendStateFile)
  if (!backendState) throw new Error("missing backend build; run `bun run build:backend` first")
  process.env.OPENCODE_BUILD_ID = backendState.id
  step(`frontend build ${backendState.id}`)

  step("构建 Web UI (packages/app/dist)")
  await $`bun run build`.cwd(appDir)

  step("构建桌面 GUI (packages/desktop/out)")
  await $`bunx electron-vite build`.cwd(desktopDir)

  const serverFile = path.join(opencodeDir, "dist/node/node.js")
  const serverStat = await stat(serverFile).catch(() => undefined)
  if (!serverStat || serverStat.size < 1_000_000) throw new Error(`server bundle missing: ${serverFile}`)
  const chunksDir = path.join(desktopDir, "out/main/chunks")
  const chunks = (await readdir(chunksDir).catch(() => [])).filter((name) => /^node-.*\.js$/.test(name))
  if (chunks.length === 0) throw new Error(`GUI bundle missing embedded server chunk: ${chunksDir}`)
  const newest = (
    await Promise.all(chunks.map(async (name) => ({ name, info: await stat(path.join(chunksDir, name)) })))
  ).toSorted((a, b) => b.info.mtimeMs - a.info.mtimeMs)[0]!
  if (newest.info.mtimeMs + 5_000 < serverStat.mtimeMs)
    throw new Error(`GUI bundle is stale: out/main/chunks/${newest.name} is older than dist/node/node.js`)

  await writeState(frontendStateFile, { ...backendState, builtAt: Date.now() })
  console.log(`\nfrontend done: ${backendState.id}`)
}

async function desk(installer: boolean, deployDir: string | undefined) {
  const backendState = await readState(backendStateFile)
  const frontendState = await readState(frontendStateFile)
  if (!backendState || !frontendState) throw new Error("missing backend/frontend build state")
  if (backendState.id !== frontendState.id)
    throw new Error(`build ID mismatch: backend=${backendState.id} frontend=${frontendState.id}`)
  step(`desktop package ${backendState.id}`)

  await $`bun ./scripts/copy-icons.ts ${channel}`.cwd(desktopDir)
  await $`bun ./scripts/copy-metainfo.ts ${channel}`.cwd(desktopDir)

  const platform = process.platform === "win32" ? "--win" : process.platform === "darwin" ? "--mac" : "--linux"
  const builderArgs = ["bunx", "electron-builder", platform, ...(installer ? [] : ["--dir"]), "--config", "electron-builder.config.ts"]
  console.log(`  ${builderArgs.join(" ")}`)
  const proc = Bun.spawn(builderArgs, { cwd: desktopDir, stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  if (code !== 0) throw new Error(`electron-builder failed (${code})`)

  if (deployDir) {
    const source = path.join(desktopDir, "dist", process.platform === "win32" ? "win-unpacked" : process.platform === "darwin" ? "mac" : "linux-unpacked")
    const info = await stat(source).catch(() => undefined)
    if (!info?.isDirectory()) throw new Error(`packaged output missing: ${source}`)
    console.log("  提示：请先完全退出目标目录里的 OpenCode，否则文件占用会导致复制失败")
    await cp(source, path.resolve(deployDir), { recursive: true, force: true })
    console.log(`  deployed: ${path.resolve(deployDir)}`)
  }
  console.log(`\ndesktop package done: ${backendState.id}`)
}

try {
  if (mode === "backend") await backend(has("semantic"))
  if (mode === "frontend") await frontend()
  if (mode === "desk") await desk(has("installer"), value("deploy", ""))
  if (mode === "all") {
    await backend(!has("no-semantic"))
    await frontend()
    await desk(has("installer"), value("deploy", ""))
  }
} catch (error) {
  console.error(`build failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}