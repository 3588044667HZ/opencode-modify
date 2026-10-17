import net from "node:net"
import { randomBytes } from "node:crypto"

export interface FakeServer {
  readonly endpoint: { readonly host: string; readonly port: number; readonly token: string }
  readonly first: () => Promise<net.Socket>
  readonly close: () => Promise<void>
}

export interface FakeServerOptions {
  // silent：hello 不回包（测试握手超时）；malformed：回 ok:false（测试畸形响应）。
  readonly hello?: "silent" | "malformed"
}

export function listenServer(
  onMessage?: (message: any, socket: net.Socket) => void,
  options?: FakeServerOptions,
): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const token = randomBytes(16).toString("hex")
    const sockets: net.Socket[] = []
    const waiters: Array<(socket: net.Socket) => void> = []
    const server = net.createServer((socket) => {
      sockets.push(socket)
      waiters.shift()?.(socket)
      socket.on("error", () => {})
      // 与真实守护一致：hello 是第一条请求，未认证前的其它方法一律 -32019 并断开。
      let authed = false
      let closed = false
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line || closed) continue
          let message: any
          try {
            message = JSON.parse(line)
          } catch {
            // ignore malformed test input
            continue
          }
          if (message.method === "hello") {
            if (options?.hello === "silent") continue
            if (options?.hello === "malformed") {
              socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: false } }) + "\n")
              continue
            }
            if (message.params?.token !== token) {
              socket.end(
                JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32019, message: "unauthorized" } }) +
                  "\n",
              )
              closed = true
              continue
            }
            authed = true
            socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\n")
            continue
          }
          if (!authed) {
            socket.end(
              JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32019, message: "unauthorized" } }) +
                "\n",
            )
            closed = true
            continue
          }
          onMessage?.(message, socket)
        }
      })
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) {
        reject(new Error("fake-server: failed to resolve listening port"))
        return
      }
      resolve({
        endpoint: { host: "127.0.0.1", port: address.port, token },
        first: () => (sockets[0] ? Promise.resolve(sockets[0]) : new Promise((done) => waiters.push(done))),
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

export function frame(message: unknown): string {
  return JSON.stringify(message) + "\n"
}
