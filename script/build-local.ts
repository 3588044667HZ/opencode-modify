#!/usr/bin/env bun
// 一次性本地构建：服务端 bundle（packages/opencode/dist/node）+ 桌面 GUI（packages/desktop/out）。
// 可选 --package 走 electron-builder 打包（win），--deploy <dir> 把 win-unpacked 覆盖到运行目录。
//
// 刻意不调用 packages/desktop/scripts/prebuild.ts 里的 downloadCliToResources()：
// 它会联网下载固定版本的官方 CLI 覆盖 resources/opencode-cli.exe，与本地源码无关。
// 之前的坑：只跑 electron-builder 会复用陈旧的 dist/node 与 out/，导致新代码打不进去。
import { $ } from "bun"
import { cp, readdir, stat } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const opencodeDir = path.join(root, "packages/opencode")
const desktopDir = path.join(root, "packages/desktop")

type Channel = "dev" | "beta" | "prod"

const args = process.argv.slice(2)
const has = (flag: string) => args.includes(flag)
const value = (flag: string) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

const HELP = `用法: bun run build:local [选项]

  --package        构建后执行 electron-builder --win 打包（可能需联网下载 electron/nsis 资源）
  --deploy <dir>   把 packages/desktop/dist/win-unpacked 覆盖到 <dir>（例如 D:/opencode-desktop-dev）
                   需先 --package；请先完全退出目标目录里正在运行的 OpenCode
  --channel <c>    dev | beta | prod（默认 dev，决定 appId/productName/图标）
  -h, --help       显示帮助

默认（无参数）只做两步：服务端 bundle + 桌面 GUI bundle。`

if (has("--help") || has("-h")) {
  console.log(HELP)
  process.exit(0)
}

const channelArg = value("--channel")
if (channelArg && !["dev", "beta", "prod"].includes(channelArg)) {
  throw new Error(`未知 channel: ${channelArg}（可选 dev|beta|prod）`)
}
const channel: Channel = (channelArg as Channel) ?? "dev"
process.env.OPENCODE_CHANNEL = channel

const startedAt = Date.now()
const step = (name: string) => console.log(`\n==> ${name}`)

step("构建服务端 bundle（packages/opencode → dist/node）")
await $`bun script/build-node.ts`.cwd(opencodeDir)

step("构建桌面 GUI（packages/desktop → out）")
await $`bunx electron-vite build`.cwd(desktopDir)

// 防陈旧校验：产物必须是本次运行生成的，且 GUI 内嵌的服务端 chunk 不早于 dist/node。
step("校验产物")
const serverFile = path.join(opencodeDir, "dist", "node", "node.js")
const serverStat = await stat(serverFile).catch(() => undefined)
if (!serverStat || serverStat.size < 1_000_000)
  throw new Error(`服务端 bundle 缺失或异常: ${serverFile}`)
if (serverStat.mtimeMs + 5_000 < startedAt)
  throw new Error(`服务端 bundle 未重新生成（mtime 早于本次构建）: ${serverFile}`)

const chunksDir = path.join(desktopDir, "out", "main", "chunks")
const chunks = (await readdir(chunksDir).catch(() => [])).filter((name) => /^node-.*\.js$/.test(name))
if (chunks.length === 0) throw new Error(`GUI bundle 缺少内嵌服务端 chunk: ${chunksDir}`)
const chunkStats = await Promise.all(
  chunks.map(async (name) => ({ name, stat: await stat(path.join(chunksDir, name)) })),
)
const newest = chunkStats.toSorted((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]!
if (newest.stat.mtimeMs + 5_000 < serverStat.mtimeMs)
  throw new Error(`GUI bundle 陈旧：out/main/chunks/${newest.name} 早于 dist/node/node.js，请确认 electron-vite build 成功`)

console.log(`  server: dist/node/node.js (${(serverStat.size / 1e6).toFixed(1)} MB)`)
console.log(`  gui:    out/main/chunks/${newest.name} (${(newest.stat.size / 1e6).toFixed(1)} MB)`)

if (has("--package")) {
  step(`打包（electron-builder --win，channel=${channel}）`)
  await $`bun ./scripts/copy-icons.ts ${channel}`.cwd(desktopDir)
  await $`bun ./scripts/copy-metainfo.ts ${channel}`.cwd(desktopDir)
  await $`bun run package:win`.cwd(desktopDir)
}

const deployDir = value("--deploy")
if (deployDir) {
  if (!has("--package")) throw new Error("--deploy 需要与 --package 一起使用")
  const from = path.join(desktopDir, "dist", "win-unpacked")
  const statFrom = await stat(from).catch(() => undefined)
  if (!statFrom?.isDirectory()) throw new Error(`未找到打包产物: ${from}`)
  const target = path.resolve(deployDir)
  step(`部署到 ${target}`)
  console.log("  提示：请先完全退出目标目录里正在运行的 OpenCode，否则文件占用会导致复制失败")
  await cp(from, target, { recursive: true, force: true })
}

console.log(`\n完成，用时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`)
