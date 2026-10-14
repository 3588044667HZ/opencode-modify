#!/usr/bin/env bun
// blast_radius 探针：raw NDJSON 连接 → ping/subscribe → （可选 --early 立即发一次）→ 等 ready →
// 发送 fixtures/blast_radius/input.json（可覆盖）→ 打印结果；--out 时把 result 美化落盘（fixtures 生成用）。
// 用法: bun script/blast-probe.ts [socket_path] [--params file.json] [--params-json '{...}'] [--out file]
//        [--repeat N] [--early] [--no-wait] [--timeout secs] [--shutdown] [--refresh project-relative-file]
import net from "node:net"
import path from "node:path"
import fs from "node:fs"

const argv = process.argv.slice(2)
const options = {
  socket: "",
  params: "",
  paramsJson: "",
  out: "",
  repeat: 1,
  early: false,
  wait: true,
  timeout: 300,
  shutdown: false,
  refresh: "",
}
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === "--params") options.params = argv[++i] ?? ""
  else if (arg === "--params-json") options.paramsJson = argv[++i] ?? ""
  else if (arg === "--out") options.out = argv[++i] ?? ""
  else if (arg === "--repeat") options.repeat = Math.max(1, Number(argv[++i] ?? "1"))
  else if (arg === "--early") options.early = true
  else if (arg === "--no-wait") options.wait = false
  else if (arg === "--timeout") options.timeout = Number(argv[++i] ?? "300")
  else if (arg === "--shutdown") options.shutdown = true
  else if (arg === "--refresh") options.refresh = argv[++i] ?? ""
  else positional.push(arg)
}
const scriptDir = import.meta.dir
options.socket = positional[0] ?? path.resolve(scriptDir, "../.tmp/blast.sock")
const paramsPath = options.params || path.resolve(scriptDir, "../fixtures/blast_radius/input.json")

const params = options.paramsJson
  ? JSON.parse(options.paramsJson)
  : JSON.parse(fs.readFileSync(paramsPath, "utf8"))

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
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        console.error("[blast-probe] bad frame:", line.slice(0, 300))
        continue
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id)!
        pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      } else if (message.method === "notifications/indexing") {
        console.log("[blast-probe] notif:", JSON.stringify(message.params))
      } else {
        console.log("[blast-probe] push:", line.slice(0, 300))
      }
    }
  })
  connected.on("error", (error) => console.error("[blast-probe] socket error:", error.message))
}

function call(method: string, callParams: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<any> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: callParams }) + "\n")
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

function printResult(label: string, message: any) {
  console.log(`[blast-probe] ${label} -> ${JSON.stringify(message.error ?? message.result, null, 2)}`)
}

await connectWithRetry(10_000)
console.log("[blast-probe] connected:", options.socket)

printResult("ping", await call("ping"))
printResult("subscribe", await call("subscribe"))

if (options.early) {
  printResult("early blast_radius (indexing expected)", await call("blast_radius", params, 15_000))
}

if (options.wait) {
  const deadline = Date.now() + options.timeout * 1000
  let ready = false
  while (Date.now() < deadline) {
    await sleep(400)
    let ping: any
    try {
      ping = await call("ping")
    } catch {
      console.log("[blast-probe] ping stalled, reconnecting...")
      await reconnect()
      continue
    }
    if (ping.result?.indexing === false) {
      console.log("[blast-probe] ping ->", JSON.stringify(ping.result))
      ready = true
      break
    }
  }
  if (!ready) console.log("[blast-probe] timeout waiting for ready; continuing anyway")
}

if (options.refresh) {
  // 触发服务端按 mtime refresh VFS（read_view 行为），用于缓存失效证据
  const refreshed = await callWithIndexingRetry("read_view", { file: options.refresh, view: "entry" })
  console.log(
    `[blast-probe] refresh read_view ${options.refresh} ->`,
    refreshed.error ? JSON.stringify(refreshed.error) : `ok (version ${refreshed.result?.version})`,
  )
}

for (let attempt = 1; attempt <= options.repeat; attempt++) {
  const message = await callWithIndexingRetry("blast_radius", params)
  printResult(`blast_radius #${attempt}`, message)
  if (!message.error && options.out) {
    fs.writeFileSync(options.out, JSON.stringify(message.result, null, 2) + "\n")
    console.log(`[blast-probe] wrote ${options.out}`)
  }
  if (message.error) process.exitCode = 1
}

if (options.shutdown) {
  printResult("shutdown", await call("shutdown"))
  await sleep(1500)
}

socket.end()
process.exit(process.exitCode ?? 0)

/** -32000 indexing 时轮询重试；连接卡住（超时）时重连后重试（OC 客户端的预期行为）。 */
async function callWithIndexingRetry(method: string, callParams: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 60; attempt++) {
    let response: any
    try {
      response = await call(method, callParams, 15_000)
    } catch {
      console.log(`[blast-probe] ${method} stalled, reconnecting and retrying...`)
      await reconnect()
      continue
    }
    if (!response.error || response.error.code !== -32000) return response
    if (attempt === 0) console.log(`[blast-probe] ${method} got -32000 indexing; retrying...`)
    await sleep(1000)
  }
  return call(method, callParams)
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
