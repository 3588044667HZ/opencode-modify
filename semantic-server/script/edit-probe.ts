#!/usr/bin/env bun
// edit_batch 探针：raw NDJSON 连接 → ping/subscribe → 等 ready →
// copy fixtures/edit_batch/template.java 到目标文件 → read_view 取 version →
// 读取 fixtures/edit_batch/input.json（可用 --params/--params-json 覆盖，
// --file/--changes-json/--lock-timeout-ms 为薄覆盖参数）并按需注入 baseVersion →
// 发送 edit_batch → 打印结果；--out 时把 result 美化落盘（fixtures 生成用）。
// --parallel N：开 N 个独立 socket；所有 worker 先并发取版本（或共用 --base-version），
// 等全部就绪后同时发送同一请求；请求 JSON 中的 "{i}" 会替换为 worker 序号（1 起），
// 便于一次对 N 个不同文件做并发验证。
// 用法: bun script/edit-probe.ts [socket_path] [--params file.json] [--params-json '{...}']
//        [--file path] [--changes-json '[{...}]'] [--lock-timeout-ms n] [--parallel n]
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
  file: "",
  changesJson: "",
  lockTimeoutMs: null as number | null,
  parallel: 1,
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
  else if (arg === "--file") options.file = argv[++i] ?? ""
  else if (arg === "--changes-json") options.changesJson = argv[++i] ?? ""
  else if (arg === "--lock-timeout-ms") options.lockTimeoutMs = Number(argv[++i] ?? "NaN")
  else if (arg === "--parallel") options.parallel = Number(argv[++i] ?? "1")
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
if (options.lockTimeoutMs !== null && !Number.isFinite(options.lockTimeoutMs)) {
  console.error("[edit-probe] --lock-timeout-ms requires a number")
  process.exit(2)
}
if (!Number.isInteger(options.parallel) || options.parallel < 1) {
  console.error("[edit-probe] --parallel requires a positive integer")
  process.exit(2)
}
const scriptDir = import.meta.dir
options.socket = positional[0] ?? path.resolve(scriptDir, "../.tmp/edit.sock")
const projectRoot = path.resolve(scriptDir, "../sample-project")
const templatePath = path.resolve(scriptDir, "../fixtures/edit_batch/template.java")
const defaultParamsPath = path.resolve(scriptDir, "../fixtures/edit_batch/input.json")
const paramsOverridden = Boolean(options.params || options.paramsJson || options.file || options.changesJson)
if (options.copy === null) options.copy = !paramsOverridden

const params: any = options.paramsJson
  ? JSON.parse(options.paramsJson)
  : JSON.parse(fs.readFileSync(options.params || defaultParamsPath, "utf8"))

if (options.file) params.file = options.file
if (options.changesJson) {
  try {
    params.changes = JSON.parse(options.changesJson)
  } catch (error) {
    console.error("[edit-probe] --changes-json is not valid JSON:", (error as Error).message)
    process.exit(2)
  }
}
if (options.lockTimeoutMs !== null) {
  params.options = { ...(typeof params.options === "object" && params.options !== null ? params.options : {}), lock_timeout_ms: options.lockTimeoutMs }
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

function displayRelative(target: string): string {
  return path.relative(projectRoot, target).replace(/\\/g, "/")
}

function copyTemplate(target: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(templatePath, target)
  console.log("[edit-probe] copied template ->", displayRelative(target))
}

// ---- 并发模式：N 个独立 socket，各自取版本后同时发送同一请求 ----

type WorkerConn = {
  index: number
  socket: net.Socket | null
  buffer: string
  nextId: number
  pending: Map<number, Pending>
}

type WorkerOutcome =
  | { index: number; ok: true; elapsedMs: number; response: any }
  | { index: number; ok: false; error: string }

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
      if (options.raw) console.log(`[edit-probe] #${worker.index} raw << ${line}`)
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        console.error(`[edit-probe] #${worker.index} bad frame:`, line.slice(0, 300))
        continue
      }
      if (message.id !== undefined && worker.pending.has(message.id)) {
        const entry = worker.pending.get(message.id)!
        worker.pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      } else {
        console.log(`[edit-probe] #${worker.index} push:`, line.slice(0, 300))
      }
    }
  })
  worker.socket!.on("error", (error) => console.error(`[edit-probe] #${worker.index} socket error:`, error.message))
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
    if (options.raw) console.log(`[edit-probe] #${worker.index} raw >> ${payload}`)
    worker.socket!.write(payload + "\n")
  })
}

async function workerReconnect(worker: WorkerConn): Promise<void> {
  for (const [id, entry] of [...worker.pending]) {
    clearTimeout(entry.timer)
    worker.pending.delete(id)
    entry.resolve({ error: { code: -32000, message: "reconnect" } })
  }
  try {
    worker.socket?.destroy()
  } catch {
    // ignore
  }
  worker.buffer = ""
  worker.socket = await openSocketWithRetry(20_000)
  attachWorker(worker)
}

/** worker 版 callWithIndexingRetry：-32000 轮询重试；连接卡住（超时）时重连后重试。 */
async function workerCallWithIndexingRetry(
  worker: WorkerConn,
  method: string,
  callParams: Record<string, unknown>,
  timeoutMs: number,
): Promise<any> {
  for (let attempt = 0; attempt < 60; attempt++) {
    let response: any
    try {
      response = await workerCall(worker, method, callParams, timeoutMs)
    } catch {
      console.log(`[edit-probe] #${worker.index} ${method} stalled, reconnecting and retrying...`)
      await workerReconnect(worker)
      continue
    }
    if (!response.error || response.error.code !== -32000) return response
    if (attempt === 0) console.log(`[edit-probe] #${worker.index} ${method} got -32000 indexing; retrying...`)
    await sleep(1000)
  }
  return workerCall(worker, method, callParams, timeoutMs)
}

async function runParallel(count: number): Promise<number> {
  const usesPlaceholder = JSON.stringify(params).includes("{i}")
  const materialize = (index: number): any => JSON.parse(JSON.stringify(params).replaceAll("{i}", String(index)))
  const workerParams = Array.from({ length: count }, (_, offset) => materialize(offset + 1))

  // 先落盘并逐个读取版本（读不加锁；避免并发 read_view 的索引风暴），再让 worker 同时写
  if (options.copy) {
    const targets = usesPlaceholder ? workerParams.map((item) => targetPath(item.file)) : [targetPath(params.file)]
    for (const target of [...new Set(targets)]) copyTemplate(target)
  }

  const versionCache = new Map<string, string>()
  if (options.inject) {
    for (const workerParam of workerParams) {
      if (typeof workerParam.file !== "string" || !workerParam.file) {
        throw new Error("params.file is required")
      }
      if (typeof workerParam.baseVersion === "string") continue
      if (options.baseVersion) {
        workerParam.baseVersion = options.baseVersion
        continue
      }
      let version = versionCache.get(workerParam.file)
      if (version === undefined) {
        const read = await callWithIndexingRetry("read_view", { file: workerParam.file, view: "entry" })
        if (read.error) throw new Error(`read_view failed for ${workerParam.file}: ${JSON.stringify(read.error)}`)
        version = read.result.version
        versionCache.set(workerParam.file, version)
        console.log(`[edit-probe] read_view version ${workerParam.file} -> ${version}`)
      }
      workerParam.baseVersion = version
    }
  }

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
    workerParams.map(async (workerParam, offset): Promise<WorkerOutcome> => {
      const index = offset + 1
      const worker: WorkerConn = { index, socket: null, buffer: "", nextId: 0, pending: new Map() }
      try {
        worker.socket = await openSocketWithRetry(10_000)
        attachWorker(worker)
        markReady()
        await barrier
        const lockTimeout =
          typeof workerParam.options?.lock_timeout_ms === "number" ? workerParam.options.lock_timeout_ms : 30_000
        const started = Date.now()
        const response = await workerCallWithIndexingRetry(
          worker,
          "edit_batch",
          workerParam,
          Math.max(60_000, lockTimeout + 20_000),
        )
        const elapsedMs = Date.now() - started
        console.log(`[edit-probe] #${index} elapsed_ms=${elapsedMs} -> ${JSON.stringify(response.error ?? response.result)}`)
        return { index, ok: true, elapsedMs, response }
      } catch (error) {
        console.error(`[edit-probe] #${index} failed: ${(error as Error).message}`)
        return { index, ok: false, error: (error as Error).message }
      } finally {
        worker.socket?.end()
      }
    }),
  )

  const successes = outcomes.filter((outcome): outcome is WorkerOutcome & { ok: true } => outcome.ok)
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
  const elapsedAll = successes.map((outcome) => outcome.elapsedMs)
  console.log(
    `[edit-probe] parallel summary total=${count} applied=${applied} codes=${JSON.stringify(codes)}` +
      (elapsedAll.length === 0 ? "" : ` elapsed_ms=${Math.min(...elapsedAll)}..${Math.max(...elapsedAll)}`),
  )

  if (options.out) {
    const results = outcomes.map((outcome) =>
      outcome.ok
        ? { index: outcome.index, elapsed_ms: outcome.elapsedMs, result: outcome.response.error ?? outcome.response.result }
        : { index: outcome.index, error: outcome.error },
    )
    fs.writeFileSync(options.out, JSON.stringify(results, null, 2) + "\n")
    console.log(`[edit-probe] wrote ${options.out}`)
  }

  if (options.cleanup) {
    const targets = new Set(
      workerParams
        .map((item) => item.file)
        .filter((file): file is string => typeof file === "string" && file.length > 0)
        .map((file) => targetPath(file)),
    )
    for (const target of targets) {
      fs.rmSync(target, { force: true })
      console.log("[edit-probe] removed", displayRelative(target))
    }
  }

  return outcomes.every((outcome) => outcome.ok) ? 0 : 1
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

let exitCode = 0
if (options.parallel > 1) {
  exitCode = await runParallel(options.parallel)
} else {
  const target = targetPath(params.file)

  if (options.copy) copyTemplate(target)

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
  const started = Date.now()
  const response = await callWithIndexingRetry("edit_batch", params)
  const elapsedMs = Date.now() - started
  console.log(`[edit-probe] edit_batch elapsed_ms=${elapsedMs}`)
  console.log(
    `[edit-probe] edit_batch -> ${JSON.stringify(response.error ?? response.result, null, 2)}`,
  )

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
    console.log("[edit-probe] removed", displayRelative(target))
  }
}

if (options.shutdown) {
  console.log("[edit-probe] shutdown ->", JSON.stringify((await call("shutdown")).result ?? {}))
  await sleep(1500)
}

socket.end()
process.exit(exitCode)
