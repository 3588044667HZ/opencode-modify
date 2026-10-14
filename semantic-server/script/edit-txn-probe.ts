#!/usr/bin/env bun
// edit_transaction 探针：raw NDJSON 连接 → ping/subscribe → 等 ready →
// 按请求把 fixtures/edit_transaction/templates/<basename> copy 回目标文件（重置样本）→
// 逐文件 read_view 取 version 注入 baseVersion → 发送 edit_transaction →
// 打印结果；--out 时把 result 美化落盘（fixtures 生成用），--normalize 把 files[].old_version/
// new_version 归一为 "<version>"。
// 用法: bun script/edit-txn-probe.ts [socket_path] [--params file.json] [--params-json '{...}']
//        [--base-version v | --base-version N=v] [--lock-timeout-ms n] [--out file] [--normalize]
//        [--raw] [--copy|--no-copy] [--no-inject] [--no-wait] [--timeout secs] [--shutdown]
//        [--parallel n]
import net from "node:net"
import path from "node:path"
import fs from "node:fs"

const argv = process.argv.slice(2)
const options = {
  socket: "",
  params: "",
  paramsJson: "",
  baseVersions: [] as string[],
  lockTimeoutMs: null as number | null,
  out: "",
  normalize: false,
  raw: false,
  copy: null as boolean | null,
  inject: true,
  wait: true,
  timeout: 300,
  shutdown: false,
  parallel: 1,
}
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === "--params") options.params = argv[++i] ?? ""
  else if (arg === "--params-json") options.paramsJson = argv[++i] ?? ""
  else if (arg === "--base-version") options.baseVersions.push(argv[++i] ?? "")
  else if (arg === "--lock-timeout-ms") options.lockTimeoutMs = Number(argv[++i] ?? "NaN")
  else if (arg === "--out") options.out = argv[++i] ?? ""
  else if (arg === "--normalize") options.normalize = true
  else if (arg === "--raw") options.raw = true
  else if (arg === "--copy") options.copy = true
  else if (arg === "--no-copy") options.copy = false
  else if (arg === "--no-inject") options.inject = false
  else if (arg === "--no-wait") options.wait = false
  else if (arg === "--timeout") options.timeout = Number(argv[++i] ?? "300")
  else if (arg === "--shutdown") options.shutdown = true
  else if (arg === "--parallel") options.parallel = Number(argv[++i] ?? "1")
  else positional.push(arg)
}
if (options.lockTimeoutMs !== null && !Number.isFinite(options.lockTimeoutMs)) {
  console.error("[edit-txn-probe] --lock-timeout-ms requires a number")
  process.exit(2)
}
if (!Number.isInteger(options.parallel) || options.parallel < 1) {
  console.error("[edit-txn-probe] --parallel requires a positive integer")
  process.exit(2)
}
const scriptDir = import.meta.dir
options.socket = positional[0] ?? path.resolve(scriptDir, "../.tmp/txn.sock")
const projectRoot = path.resolve(scriptDir, "../sample-project")
const templatesDir = path.resolve(scriptDir, "../fixtures/edit_transaction/templates")
const defaultParamsPath = path.resolve(scriptDir, "../fixtures/edit_transaction/input.json")
const paramsOverridden = Boolean(options.params || options.paramsJson)
if (options.copy === null) options.copy = !paramsOverridden

const params: any = options.paramsJson
  ? JSON.parse(options.paramsJson)
  : JSON.parse(fs.readFileSync(options.params || defaultParamsPath, "utf8"))
if (options.lockTimeoutMs !== null) {
  params.options = {
    ...(typeof params.options === "object" && params.options !== null ? params.options : {}),
    lock_timeout_ms: options.lockTimeoutMs,
  }
}

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
      if (options.raw) console.log(`[edit-txn-probe] raw << ${line}`)
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        console.error("[edit-txn-probe] bad frame:", line.slice(0, 300))
        continue
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id)!
        pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      } else if (message.method === "notifications/indexing") {
        console.log("[edit-txn-probe] notif:", JSON.stringify(message.params))
      } else {
        console.log("[edit-txn-probe] push:", line.slice(0, 300))
      }
    }
  })
  connected.on("error", (error) => console.error("[edit-txn-probe] socket error:", error.message))
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
    if (options.raw) console.log(`[edit-txn-probe] raw >> ${payload}`)
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
      console.log(`[edit-txn-probe] ${method} stalled, reconnecting and retrying...`)
      await reconnect()
      continue
    }
    if (!response.error || response.error.code !== -32000) return response
    if (attempt === 0) console.log(`[edit-txn-probe] ${method} got -32000 indexing; retrying...`)
    await sleep(1000)
  }
  return call(method, callParams)
}

function targetPath(file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(projectRoot, file)
}

function displayRelative(target: string): string {
  return path.relative(projectRoot, target).replace(/\\/g, "/")
}

/** 按请求重置样本：templates/<basename> → 目标（模板缺失时跳过，便于错误码用例）。 */
function resetFromTemplate(file: string): void {
  const target = targetPath(file)
  const template = path.join(templatesDir, path.basename(file))
  if (!fs.existsSync(template)) {
    console.log("[edit-txn-probe] no template for", file)
    return
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(template, target)
  console.log("[edit-txn-probe] reset", displayRelative(target))
}

function requestFiles(request: any): string[] {
  if (!Array.isArray(request?.changes)) return []
  return request.changes.map((entry: any) => entry?.file).filter((file: unknown): file is string => typeof file === "string" && file.length > 0)
}

function readVersions(request: any): Promise<Map<string, string>> {
  return (async () => {
    const versions = new Map<string, string>()
    for (const file of requestFiles(request)) {
      if (versions.has(file)) continue
      const read = await callWithIndexingRetry("read_view", { file, view: "entry" })
      if (read.error) throw new Error(`read_view failed for ${file}: ${JSON.stringify(read.error)}`)
      versions.set(file, read.result.version)
      console.log(`[edit-txn-probe] read_view version ${file} -> ${read.result.version}`)
    }
    return versions
  })()
}

function applyBaseVersions(request: any, versions: Map<string, string>): void {
  let plain = ""
  const indexed = new Map<number, string>()
  for (const spec of options.baseVersions) {
    const eq = spec.indexOf("=")
    if (eq > 0) indexed.set(Number(spec.slice(0, eq)), spec.slice(eq + 1))
    else plain = spec
  }
  request.changes.forEach((entry: any, offset: number) => {
    if (typeof entry.baseVersion === "string" && entry.baseVersion.length > 0 && !indexed.has(offset + 1)) return
    if (indexed.has(offset + 1)) entry.baseVersion = indexed.get(offset + 1)
    else if (plain) entry.baseVersion = plain
    else if (versions.has(entry.file)) entry.baseVersion = versions.get(entry.file)
  })
}

function normalizeResult(result: any): any {
  if (!options.normalize) return result
  const copy = structuredClone(result)
  for (const file of copy.files ?? []) {
    if (file.old_version) file.old_version = "<version>"
    if (file.new_version) file.new_version = "<version>"
  }
  return copy
}

// ---- 并发模式：N 个独立 socket，共用同一组 baseline 版本，barrier 后同时发送 ----

type WorkerConn = {
  index: number
  socket: net.Socket | null
  buffer: string
  nextId: number
  pending: Map<number, Pending>
}

function openSocket(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const candidate = net.createConnection({ path: options.socket })
    candidate.once("connect", () => resolve(candidate))
    candidate.once("error", (error) => {
      candidate.destroy()
      reject(error)
    })
  })
}

async function openSocketWithRetry(deadlineMs: number): Promise<net.Socket> {
  const started = Date.now()
  for (;;) {
    try {
      return await openSocket()
    } catch (error) {
      if (Date.now() - started > deadlineMs) throw error
      await sleep(200)
    }
  }
}

function attachWorker(worker: WorkerConn) {
  worker.socket!.on("data", (chunk) => {
    worker.buffer += chunk.toString("utf8")
    let index: number
    while ((index = worker.buffer.indexOf("\n")) >= 0) {
      const line = worker.buffer.slice(0, index).trim()
      worker.buffer = worker.buffer.slice(index + 1)
      if (!line) continue
      if (options.raw) console.log(`[edit-txn-probe] #${worker.index} raw << ${line}`)
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        console.error(`[edit-txn-probe] #${worker.index} bad frame:`, line.slice(0, 300))
        continue
      }
      if (message.id !== undefined && worker.pending.has(message.id)) {
        const entry = worker.pending.get(message.id)!
        worker.pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      } else {
        console.log(`[edit-txn-probe] #${worker.index} push:`, line.slice(0, 300))
      }
    }
  })
  worker.socket!.on("error", (error) => console.error(`[edit-txn-probe] #${worker.index} socket error:`, error.message))
}

function workerCall(worker: WorkerConn, method: string, callParams: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const id = ++worker.nextId
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: callParams })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.pending.delete(id)
      reject(new Error(`${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    worker.pending.set(id, { resolve, timer })
    if (options.raw) console.log(`[edit-txn-probe] #${worker.index} raw >> ${payload}`)
    worker.socket!.write(payload + "\n")
  })
}

async function runParallel(count: number): Promise<number> {
  const request = structuredClone(params)
  const files = requestFiles(request)
  if (options.copy) for (const file of files) resetFromTemplate(file)
  const versions = options.inject ? await readVersions(request) : new Map<string, string>()
  const workers = Array.from({ length: count }, (_, offset) => ({
    index: offset + 1,
    request: structuredClone(request),
  }))
  for (const worker of workers) applyBaseVersions(worker.request, versions)

  let releaseBarrier!: () => void
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve
  })
  let readyCount = 0
  const markReady = () => {
    readyCount++
    if (readyCount === count) releaseBarrier()
  }

  const outcomes = await Promise.all(
    workers.map(async (worker): Promise<{ index: number; ok: boolean; elapsedMs?: number; response?: any; error?: string }> => {
      const conn: WorkerConn = { index: worker.index, socket: null, buffer: "", nextId: 0, pending: new Map() }
      try {
        conn.socket = await openSocketWithRetry(10_000)
        attachWorker(conn)
        markReady()
        await barrier
        const lockTimeout =
          typeof worker.request.options?.lock_timeout_ms === "number" ? worker.request.options.lock_timeout_ms : 30_000
        const started = Date.now()
        const response = await workerCall(conn, "edit_transaction", worker.request, Math.max(60_000, lockTimeout + 20_000))
        const elapsedMs = Date.now() - started
        console.log(`[edit-txn-probe] #${worker.index} elapsed_ms=${elapsedMs} -> ${JSON.stringify(response.error ?? response.result)}`)
        return { index: worker.index, ok: true, elapsedMs, response }
      } catch (error) {
        console.error(`[edit-txn-probe] #${worker.index} failed: ${(error as Error).message}`)
        return { index: worker.index, ok: false, error: (error as Error).message }
      } finally {
        conn.socket?.end()
      }
    }),
  )

  const successes = outcomes.filter((outcome) => outcome.ok)
  const applied = successes.filter((outcome) => outcome.response.result?.applied === true).length
  const codes: Record<string, number> = {}
  for (const outcome of successes) {
    const key =
      outcome.response.error !== undefined
        ? String(outcome.response.error.code)
        : outcome.response.result?.applied === true
          ? "applied"
          : outcome.response.result?.error?.code !== undefined
            ? String(outcome.response.result.error.code)
            : "unknown"
    codes[key] = (codes[key] ?? 0) + 1
  }
  const elapsedAll = successes.map((outcome) => outcome.elapsedMs ?? 0)
  console.log(
    `[edit-txn-probe] parallel summary total=${count} applied=${applied} codes=${JSON.stringify(codes)}` +
      (elapsedAll.length === 0 ? "" : ` elapsed_ms=${Math.min(...elapsedAll)}..${Math.max(...elapsedAll)}`),
  )
  return outcomes.every((outcome) => outcome.ok) ? 0 : 1
}

// ---- 主流程 ----

await connectWithRetry(10_000)
console.log("[edit-txn-probe] connected:", options.socket)
console.log("[edit-txn-probe] ping ->", JSON.stringify((await call("ping")).result ?? {}))
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
      console.log("[edit-txn-probe] ping stalled, reconnecting...")
      await reconnect()
      continue
    }
    if (ping.result?.indexing === false) {
      console.log("[edit-txn-probe] ready:", JSON.stringify(ping.result))
      ready = true
      break
    }
  }
  if (!ready) console.log("[edit-txn-probe] timeout waiting for ready; continuing anyway")
}

let exitCode = 0
if (options.parallel > 1) {
  exitCode = await runParallel(options.parallel)
} else {
  const request = params
  if (!Array.isArray(request.changes)) {
    console.error("[edit-txn-probe] params.changes is required")
    process.exit(2)
  }
  if (options.copy) {
    for (const file of requestFiles(request)) resetFromTemplate(file)
  }
  if (options.inject) {
    const versions = await readVersions(request)
    applyBaseVersions(request, versions)
  }

  console.log("[edit-txn-probe] edit_transaction params ->", JSON.stringify(request, null, 2))
  const started = Date.now()
  const response = await callWithIndexingRetry("edit_transaction", request)
  const elapsedMs = Date.now() - started
  console.log(`[edit-txn-probe] edit_transaction elapsed_ms=${elapsedMs}`)
  console.log(`[edit-txn-probe] edit_transaction -> ${JSON.stringify(response.error ?? response.result, null, 2)}`)

  if (response.error) {
    exitCode = 1
  } else if (response.result?.applied === false) {
    exitCode = 1
  } else if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
    fs.writeFileSync(options.out, JSON.stringify(normalizeResult(response.result), null, 2) + "\n")
    console.log(`[edit-txn-probe] wrote ${options.out}`)
  }
}

if (options.shutdown) {
  console.log("[edit-txn-probe] shutdown ->", JSON.stringify((await call("shutdown")).result ?? {}))
  await sleep(1500)
}

socket.end()
process.exit(exitCode)
