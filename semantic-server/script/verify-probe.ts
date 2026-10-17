#!/usr/bin/env bun
// verify_test 探针：读 locator → TCP 连接（raw NDJSON）→ ping/subscribe → 等 ready → 发送 verify_test 参数 →
// 打印结构化结果；--raw 打印原始请求/响应帧；--out 时把 result 美化落盘（fixtures 生成用）。
// 用法: bun script/verify-probe.ts [locator_path] [--params file.json] [--params-json '{...}']
//        [--command cmd] [--cwd dir] [--timeout-ms n] [--out file] [--normalize] [--raw]
//        [--no-wait] [--timeout secs] [--shutdown]
import net from "node:net"
import path from "node:path"
import fs from "node:fs"
import { connectLocator } from "./connect"

const argv = process.argv.slice(2)
const options = {
  locator: "",
  params: "",
  paramsJson: "",
  command: "",
  cwd: "",
  timeoutMs: "",
  out: "",
  normalize: false,
  raw: false,
  wait: true,
  timeout: 300,
  shutdown: false,
}
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === "--params") options.params = argv[++i] ?? ""
  else if (arg === "--params-json") options.paramsJson = argv[++i] ?? ""
  else if (arg === "--command") options.command = argv[++i] ?? ""
  else if (arg === "--cwd") options.cwd = argv[++i] ?? ""
  else if (arg === "--timeout-ms") options.timeoutMs = argv[++i] ?? ""
  else if (arg === "--out") options.out = argv[++i] ?? ""
  else if (arg === "--normalize") options.normalize = true
  else if (arg === "--raw") options.raw = true
  else if (arg === "--no-wait") options.wait = false
  else if (arg === "--timeout") options.timeout = Number(argv[++i] ?? "300")
  else if (arg === "--shutdown") options.shutdown = true
  else positional.push(arg)
}
const scriptDir = import.meta.dir
options.locator = positional[0] ?? path.resolve(scriptDir, "../.tmp/verify.port")
const defaultParamsPath = path.resolve(scriptDir, "../fixtures/verify_test/input.json")

function buildParams(): Record<string, unknown> {
  if (options.paramsJson) return JSON.parse(options.paramsJson)
  if (options.params) return JSON.parse(fs.readFileSync(options.params, "utf8"))
  if (options.command) {
    const params: Record<string, unknown> = { command: options.command }
    const extra: Record<string, unknown> = {}
    if (options.cwd) extra.cwd = options.cwd
    if (options.timeoutMs !== "") extra.timeout_ms = Number(options.timeoutMs)
    if (Object.keys(extra).length > 0) params.options = extra
    return params
  }
  return JSON.parse(fs.readFileSync(defaultParamsPath, "utf8"))
}
const params = buildParams()

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
      if (options.raw) console.log("[verify-probe] <", line)
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        console.error("[verify-probe] bad frame:", line.slice(0, 300))
        continue
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id)!
        pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      } else if (message.method === "notifications/indexing") {
        console.log("[verify-probe] notif:", JSON.stringify(message.params))
      } else {
        console.log("[verify-probe] push:", line.slice(0, 300))
      }
    }
  })
  connected.on("error", (error) => console.error("[verify-probe] socket error:", error.message))
}

function call(method: string, callParams: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<any> {
  const id = ++nextId
  const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params: callParams })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    if (options.raw) console.log("[verify-probe] >", frame)
    socket.write(frame + "\n")
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function connectWithRetry(deadlineMs: number): Promise<void> {
  const connection = await connectLocator(options.locator, { deadlineMs })
  socket = connection.socket
  buffer = connection.leftover
  attach(socket)
}

function printResult(label: string, message: any) {
  console.log(`[verify-probe] ${label} -> ${JSON.stringify(message.error ?? message.result, null, 2)}`)
}

await connectWithRetry(10_000)
console.log("[verify-probe] connected:", options.locator)
console.log("[verify-probe] params:", JSON.stringify(params))

printResult("ping", await call("ping"))
printResult("subscribe", await call("subscribe"))

if (options.wait) {
  const deadline = Date.now() + options.timeout * 1000
  let ready = false
  while (Date.now() < deadline) {
    await sleep(400)
    let ping: any
    try {
      ping = await call("ping")
    } catch {
      console.log("[verify-probe] ping stalled, reconnecting...")
      await reconnect()
      continue
    }
    if (ping.result?.indexing === false) {
      console.log("[verify-probe] ping ->", JSON.stringify(ping.result))
      ready = true
      break
    }
  }
  if (!ready) console.log("[verify-probe] timeout waiting for ready; continuing anyway")
}

// verify_test 的 timeout_ms 可大于默认调用超时；按命令自身超时加宽等待
const commandTimeoutMs =
  typeof (params as any).options?.timeout_ms === "number" ? (params as any).options.timeout_ms : 0
const message = await callWithIndexingRetry("verify_test", params, Math.max(60_000, commandTimeoutMs + 30_000))
printResult("verify_test", message)

if (!message.error && options.out) {
  const result = structuredClone(message.result)
  if (options.normalize) {
    // fixtures 归一：duration_ms 与输出全文为运行期变量，其余（含 failures）原样保留
    result.duration_ms = -1
    result.output_head = "<output>"
    result.output_tail = "<output>"
  }
  fs.writeFileSync(options.out, JSON.stringify(result, null, 2) + "\n")
  console.log(`[verify-probe] wrote ${options.out}`)
}
if (message.error) process.exitCode = 1

if (options.shutdown) {
  printResult("shutdown", await call("shutdown"))
  await sleep(1500)
}

socket.end()
process.exit(process.exitCode ?? 0)

/** -32000 indexing 时轮询重试；连接卡住（超时）时重连后重试（OC 客户端的预期行为）。 */
async function callWithIndexingRetry(
  method: string,
  callParams: Record<string, unknown>,
  timeoutMs: number,
): Promise<any> {
  for (let attempt = 0; attempt < 60; attempt++) {
    let response: any
    try {
      response = await call(method, callParams, timeoutMs)
    } catch {
      console.log(`[verify-probe] ${method} stalled, reconnecting and retrying...`)
      await reconnect()
      continue
    }
    if (!response.error || response.error.code !== -32000) return response
    if (attempt === 0) console.log(`[verify-probe] ${method} got -32000 indexing; retrying...`)
    await sleep(1000)
  }
  return call(method, callParams, timeoutMs)
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
