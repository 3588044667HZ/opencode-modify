// 共享连接入口：读 locator（单行 JSON {v,port,token,pid}）→ TCP 连接 127.0.0.1 →
// hello 握手（每连接第一帧）。探针只共享"建立连接 + 握手"，各自的分帧与请求/通知处理不变。
import net from "node:net"
import fs from "node:fs"

export interface Locator {
  readonly port: number
  readonly token: string
  readonly pid?: number
}

export interface Connection {
  readonly socket: net.Socket
  readonly locator: Locator
  /** hello 响应解析后仍在缓冲中的剩余字节（正常为空）；attach 前并入接收缓冲以保持帧序 */
  readonly leftover: string
}

export interface ConnectOptions {
  /** 总等待上限（含重试），默认 10s */
  deadlineMs?: number
  /** 单次「TCP 连接 + hello」超时，默认 5s */
  attemptTimeoutMs?: number
  /** 重试间隔，默认 500ms */
  retryDelayMs?: number
}

/** 读 locator 并做边界校验；缺失/损坏/字段非法一律 undefined（与 manager.readLocator 口径一致）。 */
export function readLocator(locatorPath: string): Locator | undefined {
  let text: string
  try {
    text = fs.readFileSync(locatorPath, "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as { port?: unknown; token?: unknown; pid?: unknown }
  if (typeof record.port !== "number" || !Number.isInteger(record.port) || record.port <= 0 || record.port > 65_535) {
    return undefined
  }
  if (typeof record.token !== "string" || record.token.length === 0) return undefined
  return { port: record.port, token: record.token, ...(typeof record.pid === "number" ? { pid: record.pid } : {}) }
}

/** 读 locator → TCP 连接 → hello；失败按 retryDelayMs 重试直到 deadlineMs。 */
export async function connectLocator(locatorPath: string, options: ConnectOptions = {}): Promise<Connection> {
  const deadline = Date.now() + (options.deadlineMs ?? 10_000)
  for (;;) {
    try {
      return await connectOnce(locatorPath, options.attemptTimeoutMs ?? 5_000)
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await sleep(options.retryDelayMs ?? 500)
    }
  }
}

async function connectOnce(locatorPath: string, timeoutMs: number): Promise<Connection> {
  const locator = readLocator(locatorPath)
  if (locator === undefined) throw new Error(`semantic locator 不可用: ${locatorPath}`)

  const socket = net.createConnection({ host: "127.0.0.1", port: locator.port })
  try {
    await withTimeout(connectEvent(socket), timeoutMs, "TCP 连接超时")
    const leftover = await withTimeout(handshake(socket, locator.token), timeoutMs, "hello 超时")
    return { socket, locator, leftover }
  } catch (error) {
    socket.destroy()
    throw error
  }
}

function connectEvent(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
}

/** 发送 hello（id=1）并等待响应；返回该响应之后到达的剩余字节。 */
function handshake(socket: net.Socket, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ""
    const cleanup = () => {
      socket.off("data", onData)
      socket.off("error", onError)
    }
    const onData = (chunk: Buffer) => {
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
          continue
        }
        if (message.id !== 1) continue
        cleanup()
        if (message.error !== undefined || message.result?.ok !== true) {
          reject(new Error(`hello 被拒绝: ${JSON.stringify(message.error ?? message.result)}`))
          return
        }
        resolve(buffer)
        return
      }
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    socket.on("data", onData)
    socket.once("error", onError)
    socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { token } }) + "\n")
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（${timeoutMs}ms）`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
