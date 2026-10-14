#!/usr/bin/env bun
// project_map 探针：raw NDJSON 连接 → ping → 可选 --wait-ready（building 轮询到 ready）
// → 发送 {view, scope?}；打印原始响应帧与耗时；--out 时把 result 美化落盘（fixtures 生成用）。
// --parallel N 时开 N 条连接并发发起同一请求并在 ready 后比较结果是否一致。
// 用法: bun script/map-probe.ts [socket] [--view structure|dependencies|hot] [--scope s]
//        [--out file] [--normalize-root] [--wait-ready] [--parallel N] [--raw]
//        [--params-json '{...}'] [--fail-fast] [--timeout secs] [--no-wait] [--shutdown]
import net from "node:net"
import path from "node:path"
import fs from "node:fs"

const argv = process.argv.slice(2)
const options = {
  socket: "",
  view: "structure",
  scope: "",
  out: "",
  normalizeRoot: false,
  waitReady: false,
  parallel: 0,
  raw: false,
  timeout: 300,
  waitDaemon: true,
  shutdown: false,
  paramsJson: "",
  failFast: false,
}
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === "--view") options.view = argv[++i] ?? "structure"
  else if (arg === "--scope") options.scope = argv[++i] ?? ""
  else if (arg === "--out") options.out = argv[++i] ?? ""
  else if (arg === "--normalize-root") options.normalizeRoot = true
  else if (arg === "--wait-ready") options.waitReady = true
  else if (arg === "--parallel") options.parallel = Math.max(1, Number(argv[++i] ?? "10") || 10)
  else if (arg === "--raw") options.raw = true
  else if (arg === "--params-json") options.paramsJson = argv[++i] ?? ""
  else if (arg === "--fail-fast") options.failFast = true
  else if (arg === "--timeout") options.timeout = Number(argv[++i] ?? "300")
  else if (arg === "--no-wait") options.waitDaemon = false
  else if (arg === "--shutdown") options.shutdown = true
  else positional.push(arg)
}
const scriptDir = import.meta.dir
options.socket = positional[0] ?? path.resolve(scriptDir, "../.tmp/map.sock")
if (options.failFast) options.waitDaemon = false

if (!options.paramsJson && !["structure", "dependencies", "hot"].includes(options.view)) {
  console.error(`[map-probe] invalid --view: ${options.view}`)
  process.exit(2)
}
const params: Record<string, unknown> = options.paramsJson
  ? JSON.parse(options.paramsJson)
  : { view: options.view }
if (!options.paramsJson && options.scope) params.scope = options.scope

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type Pending = { resolve: (message: any) => void; timer: ReturnType<typeof setTimeout> }

class Conn {
  private socket!: net.Socket
  private buffer = ""
  private pending = new Map<number, Pending>()
  private nextId = 0

  async connect(deadlineMs: number): Promise<void> {
    const started = Date.now()
    for (;;) {
      const candidate = net.createConnection({ path: options.socket })
      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once("connect", resolve)
          candidate.once("error", reject)
        })
        this.socket = candidate
        this.attach()
        return
      } catch (error) {
        candidate.destroy()
        if (Date.now() - started > deadlineMs) throw error
        await sleep(500)
      }
    }
  }

  private attach() {
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8")
      let index: number
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim()
        this.buffer = this.buffer.slice(index + 1)
        if (!line) continue
        if (options.raw) console.log(`[map-probe] <- ${line}`)
        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          console.error("[map-probe] bad frame:", line.slice(0, 300))
          continue
        }
        if (message.id !== undefined && this.pending.has(message.id)) {
          const entry = this.pending.get(message.id)!
          this.pending.delete(message.id)
          clearTimeout(entry.timer)
          entry.resolve(message)
        } else if (message.method === "notifications/indexing") {
          console.log("[map-probe] notif:", JSON.stringify(message.params))
        }
      }
    })
    this.socket.on("error", (error) => console.error("[map-probe] socket error:", error.message))
  }

  call(method: string, callParams: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<any> {
    const id = ++this.nextId
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params: callParams })
    if (options.raw) console.log(`[map-probe] -> ${frame}`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      this.socket.write(frame + "\n")
    })
  }

  async waitDaemonReady(): Promise<void> {
    const deadline = Date.now() + options.timeout * 1000
    for (;;) {
      const ping = await this.call("ping")
      if (ping.result?.indexing === false) {
        console.log("[map-probe] ping ->", JSON.stringify(ping.result))
        return
      }
      if (Date.now() > deadline) {
        console.log("[map-probe] timeout waiting for daemon ready; continuing anyway")
        return
      }
      await sleep(400)
    }
  }

  /** -32000 索引未就绪时轮询重试（OC 客户端预期行为）。 */
  async callWithIndexingRetry(callParams: Record<string, unknown>): Promise<any> {
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await this.call("project_map", callParams, 30_000)
      if (!response.error || response.error.code !== -32000) return response
      if (options.failFast) return response
      await sleep(500)
    }
    return this.call("project_map", callParams, 30_000)
  }

  /** --wait-ready：building:true 时轮询到 ready（或超时）。 */
  async callUntilReady(callParams: Record<string, unknown>): Promise<any> {
    const deadline = Date.now() + options.timeout * 1000
    for (;;) {
      const response = await this.callWithIndexingRetry(callParams)
      if (response.error || response.result?.building !== true) return response
      if (Date.now() > deadline) {
        console.log("[map-probe] timeout waiting for ready; returning building result")
        return response
      }
      console.log(
        `[map-probe] building ${Math.round((response.result.progress ?? 0) * 100)}%, waiting...`,
      )
      await sleep(250)
    }
  }

  close() {
    try {
      this.socket?.end()
    } catch {
      // ignore
    }
  }
}

function normalizeRoot(result: any): any {
  const copy = JSON.parse(JSON.stringify(result))
  if (copy?.project && typeof copy.project.root === "string") copy.project.root = "<root>"
  return copy
}

function summarize(result: any): string {
  if (!result) return "(no result)"
  const error = result.error ?? (typeof result.code === "number" ? result : undefined)
  if (error) return `error ${error.code} ${error.message}`
  const building = result.building === true ? ` building progress=${result.progress}` : ""
  if ("modules" in result) {
    return `${building} modules=${result.modules.length} entries=${result.entry_points.length} root_files=${result.root_files.length} total_files=${result.project.total_files} total_modules=${result.project.total_modules}`
  }
  if ("dependencies" in result) {
    return `${building} deps=${result.dependencies.length} cycles=${result.cycles.length} total_files=${result.project.total_files}`
  }
  return `${building} hot_files=${result.hot_files.length} hot_modules=${result.hot_modules.length}`
}

function writeOut(result: any) {
  if (!options.out) return
  const value = options.normalizeRoot ? normalizeRoot(result) : result
  fs.writeFileSync(options.out, JSON.stringify(value, null, 2) + "\n")
  console.log(`[map-probe] wrote ${options.out}`)
}

async function runSingle() {
  const conn = new Conn()
  await conn.connect(10_000)
  console.log("[map-probe] connected:", options.socket, `params=${JSON.stringify(params)}`)
  if (options.waitDaemon) await conn.waitDaemonReady()

  const started = Date.now()
  const response = options.waitReady
    ? await conn.callUntilReady(params)
    : await conn.callWithIndexingRetry(params)
  const elapsed = Date.now() - started
  console.log(`[map-probe] project_map <- ${JSON.stringify(response.result ?? response.error)}`)
  console.log(`[map-probe] project_map done in ${elapsed}ms ->${summarize(response.result ?? response.error)}`)
  if (response.error) process.exitCode = 1
  else writeOut(response.result)

  if (options.shutdown) {
    console.log("[map-probe] shutdown ->", JSON.stringify((await conn.call("shutdown")).result))
    await sleep(1500)
  }
  conn.close()
}

async function runParallel() {
  const count = options.parallel
  const conns: Conn[] = []
  for (let i = 0; i < count; i++) {
    const conn = new Conn()
    await conn.connect(10_000)
    conns.push(conn)
  }
  console.log(`[map-probe] connected ${count} clients:`, options.socket, `params=${JSON.stringify(params)}`)
  if (options.waitDaemon) {
    await Promise.all(conns.map((conn) => conn.waitDaemonReady()))
  }

  const started = Date.now()
  const responses = await Promise.all(
    conns.map((conn) => (options.waitReady ? conn.callUntilReady(params) : conn.callWithIndexingRetry(params))),
  )
  const elapsed = Date.now() - started

  const results = responses.map((response) => response.result ?? response.error)
  const fingerprints = results.map((result) => JSON.stringify(result))
  const failures = results.filter((result) => result?.error).length
  const allEqual = fingerprints.every((value) => value === fingerprints[0])
  for (let i = 0; i < results.length; i++) {
    console.log(`[map-probe] parallel #${i + 1}: ${summarize(results[i])}`)
  }
  console.log(
    `[map-probe] parallel ${count}: all_equal=${allEqual} errors=${failures} elapsed=${elapsed}ms`,
  )
  if (!allEqual || failures > 0) process.exitCode = 1
  if (!results[0]?.error) writeOut(results[0])

  if (options.shutdown) {
    console.log("[map-probe] shutdown ->", JSON.stringify((await conns[0].call("shutdown")).result))
    await sleep(1500)
  }
  for (const conn of conns) conn.close()
}

if (options.parallel > 0) await runParallel()
else await runSingle()
process.exit(process.exitCode ?? 0)
