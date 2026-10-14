import net from "node:net"
import os from "node:os"
import path from "node:path"

export interface FakeServer {
  readonly path: string
  readonly first: () => Promise<net.Socket>
  readonly close: () => Promise<void>
}

let counter = 0

export function listenServer(onMessage?: (message: any, socket: net.Socket) => void): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const sockets: net.Socket[] = []
    const waiters: Array<(socket: net.Socket) => void> = []
    const server = net.createServer((socket) => {
      sockets.push(socket)
      waiters.shift()?.(socket)
      socket.on("error", () => {})
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line) continue
          try {
            onMessage?.(JSON.parse(line), socket)
          } catch {
            // ignore malformed test input
          }
        }
      })
    })
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\opencode-semantic-test-${process.pid}-${counter++}`
        : path.join(os.tmpdir(), `opencode-semantic-test-${process.pid}-${counter++}.sock`)
    server.on("error", reject)
    server.listen(socketPath, () =>
      resolve({
        path: socketPath,
        first: () => (sockets[0] ? Promise.resolve(sockets[0]) : new Promise((done) => waiters.push(done))),
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => {
              if (process.platform !== "win32") void import("node:fs/promises").then((fs) => fs.unlink(socketPath).catch(() => {}))
              done()
            })
          }),
      }),
    )
  })
}

export function frame(message: unknown): string {
  return JSON.stringify(message) + "\n"
}
