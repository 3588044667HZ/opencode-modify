#!/usr/bin/env bun
// Bun 探针：连接 semantic-server 的 unix socket，依次发送 ping / subscribe / read_view / shutdown
// 用法: bun script/probe.ts [socket_path] [--file path] [--symbol name] [--shutdown] [--timeout secs] [--no-wait]
import net from "node:net"
import path from "node:path"

const argv = process.argv.slice(2)
const options = { socket: "", file: "", symbol: "", shutdown: false, timeout: 300, wait: true, earlyRead: false }
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === "--file") options.file = argv[++i] ?? ""
  else if (arg === "--symbol") options.symbol = argv[++i] ?? ""
  else if (arg === "--shutdown") options.shutdown = true
  else if (arg === "--timeout") options.timeout = Number(argv[++i] ?? "300")
  else if (arg === "--no-wait") options.wait = false
  else if (arg === "--early-read") options.earlyRead = true
  else positional.push(arg)
}
const scriptDir = import.meta.dir
options.socket = positional[0] ?? path.resolve(scriptDir, "../.tmp/semantic.sock")
options.file = options.file || path.resolve(scriptDir, "../sample-project/src/main/java/demo/Main.java")

type Pending = { resolve: (message: any) => void; timer: ReturnType<typeof setTimeout> }
const pending = new Map<number, Pending>()
let nextId = 0
let buffer = ""
let lastNotification = ""
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
        console.error("[probe] bad frame:", line.slice(0, 300))
        continue
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id)!
        pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      } else if (message.method === "notifications/indexing") {
        const text = JSON.stringify(message.params)
        if (text !== lastNotification) {
          lastNotification = text
          console.log("[probe] notif:", text)
        }
      } else {
        console.log("[probe] push:", line.slice(0, 300))
      }
    }
  })
  connected.on("error", (error) => console.error("[probe] socket error:", error.message))
}

function call(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<any> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
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
  if (message.error) console.log(`[probe] ${label} -> error ${JSON.stringify(message.error)}`)
  else console.log(`[probe] ${label} -> ${JSON.stringify(message.result)}`)
}

await connectWithRetry(10_000)
console.log("[probe] connected:", options.socket)

printResult("ping", await call("ping"))
printResult("subscribe", await call("subscribe"))

if (options.earlyRead) {
  const early = await call("read_view", { file: options.file, view: "entry" })
  console.log("[probe] early read_view ->", JSON.stringify(early.result ?? early.error))
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
      console.log("[probe] ping stalled, reconnecting...")
      await reconnect()
      continue
    }
    if (ping.result) {
      console.log("[probe] ping ->", JSON.stringify(ping.result))
      if (ping.result.indexing === false) {
        ready = true
        break
      }
    }
  }
  if (!ready) console.log("[probe] timeout waiting for ready; continuing anyway")
}

const entry = await callReadView({ file: options.file, view: "entry" })
console.log("[probe] read_view entry:")
console.log(JSON.stringify(entry.result ?? entry.error, null, 2))

if (options.symbol) {
  const definition = await callReadView({ file: options.file, view: "definition", symbol: options.symbol })
  console.log(`[probe] read_view definition ${options.symbol}:`)
  console.log(JSON.stringify(definition.result ?? definition.error, null, 2))
}

if (options.shutdown) {
  printResult("shutdown", await call("shutdown"))
  await sleep(1500)
}

socket.end()
process.exit(0)

/** -32000 indexing 时轮询重试；连接卡住（超时）时重连后重试（OC 客户端的预期行为）。 */
async function callReadView(params: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 60; attempt++) {
    let response: any
    try {
      response = await call("read_view", params, 15_000)
    } catch {
      console.log("[probe] read_view stalled, reconnecting and retrying...")
      await reconnect()
      continue
    }
    if (!response.error || response.error.code !== -32000) return response
    if (attempt === 0) console.log("[probe] read_view got -32000 indexing; retrying...")
    await sleep(1000)
  }
  return call("read_view", params)
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
  lastNotification = ""
  await connectWithRetry(20_000)
}
