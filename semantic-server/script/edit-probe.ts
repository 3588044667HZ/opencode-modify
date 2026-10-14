#!/usr/bin/env bun
// edit_batch 探针：raw NDJSON 连接 → ping/subscribe → 等 ready →
// copy fixtures/edit_batch/template.java 到目标文件 → read_view 取 version →
// 读取 fixtures/edit_batch/input.json（可用 --params/--params-json 覆盖）并按需注入 baseVersion →
// 发送 edit_batch → 打印结果；--out 时把 result 美化落盘（fixtures 生成用）。
// 用法: bun script/edit-probe.ts [socket_path] [--params file.json] [--params-json '{...}']
//        [--base-version v] [--out file] [--normalize-versions] [--raw] [--copy|--no-copy]
//        [--no-inject] [--no-wait] [--timeout secs] [--shutdown] [--cleanup]
import net from "node:net"
import path from "node:path"
import fs from "node:fs"

const argv = process.argv.slice(2)
const options = {
  socket: "",
  params: "",
  paramsJson: "",
  baseVersion: "",
  out: "",
  normalizeVersions: false,
  raw: false,
  copy: null as boolean | null,
  inject: true,
  wait: true,
  timeout: 300,
  shutdown: false,
  cleanup: false,
}
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === "--params") options.params = argv[++i] ?? ""
  else if (arg === "--params-json") options.paramsJson = argv[++i] ?? ""
  else if (arg === "--base-version") options.baseVersion = argv[++i] ?? ""
  else if (arg === "--out") options.out = argv[++i] ?? ""
  else if (arg === "--normalize-versions") options.normalizeVersions = true
  else if (arg === "--raw") options.raw = true
  else if (arg === "--copy") options.copy = true
  else if (arg === "--no-copy") options.copy = false
  else if (arg === "--no-inject") options.inject = false
  else if (arg === "--no-wait") options.wait = false
  else if (arg === "--timeout") options.timeout = Number(argv[++i] ?? "300")
  else if (arg === "--shutdown") options.shutdown = true
  else if (arg === "--cleanup") options.cleanup = true
  else positional.push(arg)
}
const scriptDir = import.meta.dir
options.socket = positional[0] ?? path.resolve(scriptDir, "../.tmp/edit.sock")
const projectRoot = path.resolve(scriptDir, "../sample-project")
const templatePath = path.resolve(scriptDir, "../fixtures/edit_batch/template.java")
const defaultParamsPath = path.resolve(scriptDir, "../fixtures/edit_batch/input.json")
const paramsOverridden = Boolean(options.params || options.paramsJson)
if (options.copy === null) options.copy = !paramsOverridden

const params: any = options.paramsJson
  ? JSON.parse(options.paramsJson)
  : JSON.parse(fs.readFileSync(options.params || defaultParamsPath, "utf8"))

type Pending = { resolve: (message: any) => void; timer: ReturnType<typeof setTimeout> }
const pending = new Map<number, Pending>()
let nextId = 0
let buffer = ""
let socket: net.Socket

function attach(connected: net.Socket) {
  connected.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    let index: number
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      if (options.raw) console.log(`[edit-probe] raw << ${line}`)
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        console.error("[edit-probe] bad frame:", line.slice(0, 300))
        continue
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id)!
        pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      } else if (message.method === "notifications/indexing") {
        console.log("[edit-probe] notif:", JSON.stringify(message.params))
      } else {
        console.log("[edit-probe] push:", line.slice(0, 300))
      }
    }
  })
  connected.on("error", (error) => console.error("[edit-probe] socket error:", error.message))
}

function call(method: string, callParams: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<any> {
  const id = ++nextId
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: callParams })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    if (options.raw) console.log(`[edit-probe] raw >> ${payload}`)
    socket.write(payload + "\n")
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function connectWithRetry(deadlineMs: number): Promise<void> {
  const started = Date.now()
  for (;;) {
    const candidate = net.createConnection({ path: options.socket })
    try {
      await new Promise<void>((resolve, reject) => {
        candidate.once("connect", resolve)
        candidate.once("error", reject)
      })
      socket = candidate
      attach(socket)
      return
    } catch (error) {
      candidate.destroy()
      if (Date.now() - started > deadlineMs) throw error
      await sleep(500)
    }
  }
}

async function reconnect(): Promise<void> {
  for (const [id, entry] of [...pending]) {
    clearTimeout(entry.timer)
    pending.delete(id)
    entry.resolve({ error: { code: -32000, message: "reconnect" } })
  }
  try {
    socket?.destroy()
  } catch {
    // ignore
  }
  buffer = ""
  await connectWithRetry(20_000)
}

/** -32000 indexing 时轮询重试；连接卡住（超时）时重连后重试。 */
async function callWithIndexingRetry(method: string, callParams: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 60; attempt++) {
    let response: any
    try {
      response = await call(method, callParams, 15_000)
    } catch {
      console.log(`[edit-probe] ${method} stalled, reconnecting and retrying...`)
      await reconnect()
      continue
    }
    if (!response.error || response.error.code !== -32000) return response
    if (attempt === 0) console.log(`[edit-probe] ${method} got -32000 indexing; retrying...`)
    await sleep(1000)
  }
  return call(method, callParams)
}

function targetPath(file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(projectRoot, file)
}

await connectWithRetry(10_000)
console.log("[edit-probe] connected:", options.socket)
console.log(
  "[edit-probe] ping ->",
  JSON.stringify((await call("ping")).result ?? {}),
)
await call("subscribe")

if (options.wait) {
  const deadline = Date.now() + options.timeout * 1000
  let ready = false
  while (Date.now() < deadline) {
    await sleep(400)
    let ping: any
    try {
      ping = await call("ping")
    } catch {
      console.log("[edit-probe] ping stalled, reconnecting...")
      await reconnect()
      continue
    }
    if (ping.result?.indexing === false) {
      console.log("[edit-probe] ready:", JSON.stringify(ping.result))
      ready = true
      break
    }
  }
  if (!ready) console.log("[edit-probe] timeout waiting for ready; continuing anyway")
}

if (typeof params.file !== "string" || !params.file) {
  console.error("[edit-probe] params.file is required")
  process.exit(2)
}
const target = targetPath(params.file)

if (options.copy) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(templatePath, target)
  console.log("[edit-probe] copied template ->", path.relative(projectRoot, target).replace(/\\/g, "/"))
}

if (options.inject && typeof params.baseVersion !== "string") {
  if (options.baseVersion) {
    params.baseVersion = options.baseVersion
  } else {
    const read = await callWithIndexingRetry("read_view", { file: params.file, view: "entry" })
    if (read.error) {
      console.error("[edit-probe] read_view failed:", JSON.stringify(read.error))
      process.exit(1)
    }
    params.baseVersion = read.result.version
    console.log("[edit-probe] read_view version:", params.baseVersion)
  }
}
if (options.baseVersion && params.baseVersion !== options.baseVersion) {
  params.baseVersion = options.baseVersion
}

console.log("[edit-probe] edit_batch params ->", JSON.stringify(params, null, 2))
const response = await callWithIndexingRetry("edit_batch", params)
console.log(
  `[edit-probe] edit_batch -> ${JSON.stringify(response.error ?? response.result, null, 2)}`,
)

let exitCode = 0
if (response.error) {
  exitCode = 1
} else if (response.result?.applied === false) {
  exitCode = 1
} else if (options.out) {
  const result = { ...response.result }
  if (options.normalizeVersions) {
    if (result.old_version) result.old_version = "<version>"
    if (result.new_version) result.new_version = "<version>"
  }
  fs.writeFileSync(options.out, JSON.stringify(result, null, 2) + "\n")
  console.log(`[edit-probe] wrote ${options.out}`)
}

if (options.cleanup) {
  fs.rmSync(target, { force: true })
  console.log("[edit-probe] removed", path.relative(projectRoot, target).replace(/\\/g, "/"))
}

if (options.shutdown) {
  console.log("[edit-probe] shutdown ->", JSON.stringify((await call("shutdown")).result ?? {}))
  await sleep(1500)
}

socket.end()
process.exit(exitCode)
