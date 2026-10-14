import net from "node:net"
import * as Protocol from "./protocol"

export interface Transport {
  readonly write: (message: Protocol.Message) => void
  readonly onMessage: (listener: (message: Protocol.Message) => void) => () => void
  readonly onClose: (listener: (error?: Error) => void) => () => void
  readonly close: () => void
}

const NEWLINE = 0x0a

// Connects to a JSON-RPC endpoint. `path` is a unix domain socket path on POSIX
// and a named pipe path (`\\.\pipe\name`) on Windows; node:net handles both.
export function connect(path: string, options?: { timeout_ms?: number }): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path)
    const timeout = options?.timeout_ms ?? Protocol.Defaults.connectTimeoutMs
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Protocol.ConnectionError({ message: `timed out connecting to semantic socket ${path}` }))
    }, timeout)

    socket.once("connect", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(create(socket))
    })

    socket.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(
        new Protocol.ConnectionError({ message: `failed to connect to semantic socket ${path}: ${error.message}` }),
      )
    })
  })
}

function create(socket: net.Socket): Transport {
  const messageListeners = new Set<(message: Protocol.Message) => void>()
  const closeListeners = new Set<(error?: Error) => void>()
  let buffer = Buffer.alloc(0)
  let closed = false

  const emitClose = (error?: Error) => {
    if (closed) return
    closed = true
    for (const listener of [...closeListeners]) listener(error)
  }

  socket.on("data", (chunk) => {
    // NDJSON framing: concatenate chunks and split on `\n` bytes. Frames can be
    // split across chunks or arrive glued together; a partial trailing frame
    // stays buffered until the next chunk.
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    let index: number
    while ((index = buffer.indexOf(NEWLINE)) >= 0) {
      const frame = buffer.subarray(0, index)
      buffer = buffer.subarray(index + 1)
      const text = frame.toString("utf8").replace(/\r$/, "")
      if (!text.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        continue
      }
      if (typeof parsed !== "object" || parsed === null) continue
      for (const listener of [...messageListeners]) listener(parsed as Protocol.Message)
    }
  })

  socket.on("error", (error) => emitClose(error))
  socket.on("close", () => emitClose())

  return {
    write: (message) => {
      if (closed) return
      socket.write(JSON.stringify(message) + "\n")
    },
    onMessage: (listener) => {
      messageListeners.add(listener)
      return () => messageListeners.delete(listener)
    },
    onClose: (listener) => {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    close: () => {
      closed = true
      socket.destroy()
    },
  }
}
