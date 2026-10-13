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

const BUILD_FILE = path.join(root, "BUILD.md")
const TABLE_HEADER = "| 时间 | Build ID | 提交 | 本次更改 | 服务端标记 | GUI 标记 |"
const TABLE_DIVIDER = "| --- | --- | --- | --- | --- | --- |"
const BUILD_INTRO = `# 构建记录（Build Log）

本文件由 \`bun run build:local\` 自动维护：每次构建追加或更新一行，记录 Build ID 与两端运行时标记。
修改代码后请运行 \`bun run build:local\`（或手工追加一行说明本次更改），确保 GUI 与服务端标记来自同一次构建；两者不一致时先重新构建再验证。

${TABLE_HEADER}
${TABLE_DIVIDER}`

type Channel = "dev" | "beta" | "prod"

const args = process.argv.slice(2)
const has = (flag: string) => args.includes(flag)
const value = (flag: string) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

const HELP = `用法: bun run build:local [选项]

  --package        构建后打包未打包目录 win-unpacked（electron-builder --win --dir，快，用于本地部署）
  --installer      在打包基础上额外产出 NSIS 安装器（electron-builder --win，慢，用于分发给其他机器）
  --deploy <dir>   把 packages/desktop/dist/win-unpacked 覆盖到 <dir>（例如 D:/opencode-desktop-dev）
                   需先 --package 或 --installer；请先完全退出目标目录里正在运行的 OpenCode
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

// Build ID：<yyMMdd-HHmm>-<git short sha>[-dirty]。同一个值注入服务端与 GUI，
// 运行时两端标记不一致即说明有一端是陈旧构建。
step("计算 Build ID")
const now = new Date()
const pad = (value: number) => String(value).padStart(2, "0")
const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
const stamp = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
const sha = (await $`git rev-parse --short HEAD`.cwd(root).text()).trim()
const dirty = (await $`git status --porcelain`.cwd(root).text()).trim().length > 0
const buildId = `${stamp}-${sha}${dirty ? "-dirty" : ""}`
process.env.OPENCODE_BUILD_ID = buildId
console.log(`  build id: ${buildId}`)

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

step("更新 BUILD.md")
await updateBuildLog({ buildId, sha, dirty, time })
console.log(`  已记录 ${buildId}`)

const packageRequested = has("--package") || has("--installer")
const installer = has("--installer")

if (packageRequested) {
  step(
    installer
      ? `打包（electron-builder --win，含 NSIS 安装器，channel=${channel}）`
      : `打包（electron-builder --win --dir，仅 win-unpacked，channel=${channel}）`,
  )
  await $`bun ./scripts/copy-icons.ts ${channel}`.cwd(desktopDir)
  await $`bun ./scripts/copy-metainfo.ts ${channel}`.cwd(desktopDir)
  if (installer) {
    await $`bunx electron-builder --win --config electron-builder.config.ts`.cwd(desktopDir)
  } else {
    await $`bunx electron-builder --win --dir --config electron-builder.config.ts`.cwd(desktopDir)
  }
}

const deployDir = value("--deploy")
if (deployDir) {
  if (!packageRequested) throw new Error("--deploy 需要与 --package 或 --installer 一起使用")
  const from = path.join(desktopDir, "dist", "win-unpacked")
  const statFrom = await stat(from).catch(() => undefined)
  if (!statFrom?.isDirectory()) throw new Error(`未找到打包产物: ${from}`)
  const target = path.resolve(deployDir)
  step(`部署到 ${target}`)
  console.log("  提示：请先完全退出目标目录里正在运行的 OpenCode，否则文件占用会导致复制失败")
  await cp(from, target, { recursive: true, force: true })
}

console.log(`\n完成，用时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`)

// 同一「提交 + dirty 状态」只保留一行：重复构建仅刷新时间戳，避免刷屏。
async function updateBuildLog(input: { buildId: string; sha: string; dirty: boolean; time: string }) {
  const content = (await Bun.file(BUILD_FILE).text().catch(() => "")).replace(/\r\n/g, "\n")
  const lines = content.split("\n")
  const isDataRow = (line: string) => /^\|\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*\|/.test(line)
  const cells = (line: string) => line.split("|").slice(1, -1).map((cell) => cell.trim())
  const lastIndex = lines.findLastIndex(isDataRow)

  if (lastIndex !== -1) {
    const lastId = cells(lines[lastIndex])[1] ?? ""
    const lastSha = lastId.replace(/^\d{6}-\d{4}-/, "").replace(/-dirty$/, "")
    if (lastSha === input.sha && lastId.endsWith("-dirty") === input.dirty) {
      // 同一代码状态重复构建：刷新时间与 Build ID（保留提交与本次更改列），
      // 否则表格里的标记会与最新产物不一致。
      const previous = cells(lines[lastIndex])
      lines[lastIndex] = `| ${input.time} | ${input.buildId} | ${previous[2]} | ${previous[3]} | ${input.buildId} | ${input.buildId} |`
      await Bun.write(BUILD_FILE, lines.join("\n"))
      return
    }
  }

  const lastCommit = lastIndex === -1 ? undefined : cells(lines[lastIndex])[2]
  const changes = await describeChanges(lastCommit)
  const row = `| ${input.time} | ${input.buildId} | ${input.sha} | ${changes} | ${input.buildId} | ${input.buildId} |`
  const trimmed = content.replace(/\s+$/, "")
  const base = !trimmed ? BUILD_INTRO : content.includes(TABLE_HEADER) ? trimmed : `${trimmed}\n\n${BUILD_INTRO}`
  await Bun.write(BUILD_FILE, `${base}\n${row}\n`)
}

// 本次更改 = 自上一行记录的提交以来的提交主题，无新提交时按 dirty 状态说明。
async function describeChanges(lastCommit: string | undefined) {
  const output = lastCommit
    ? await $`git log --oneline ${lastCommit}..HEAD`.cwd(root).nothrow().text()
    : await $`git log --oneline -1`.cwd(root).nothrow().text()
  const subjects = output
    .trim()
    .split("\n")
    .map((line) => line.replace(/^[0-9a-f]+ /, "").replaceAll("|", "\\|").trim())
    .filter((line) => line.length > 0)
  if (subjects.length > 0) return subjects.join("; ")
  return dirty ? "未提交改动" : "—"
}
