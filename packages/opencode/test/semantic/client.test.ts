import { describe, expect, test } from "bun:test"
import * as Client from "@/semantic/client"
import * as Protocol from "@/semantic/protocol"
import { frame, listenServer } from "./fake-server"
import { SAMPLE_RESULT } from "./fixture"

describe("semantic client", () => {
  test("correlates responses by id even when they arrive out of order", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method === "ping") {
        setTimeout(() => socket.write(frame({ jsonrpc: "2.0", id: message.id, result: { indexing: true, progress: 0.5 } })), 50)
        return
      }
      if (message.method === "read_view") {
        socket.write(frame({ jsonrpc: "2.0", id: message.id, result: SAMPLE_RESULT }))
      }
    })
    const client = await Client.connect(server.path, { connect_timeout_ms: 2_000 })

    const [ping, view] = await Promise.all([
      client.ping(),
      client.readView({ file: "engine.ts", view: "entry" }),
    ])
    expect(ping).toEqual({ indexing: true, progress: 0.5 })
    expect(view).toEqual(SAMPLE_RESULT)

    client.close()
    await server.close()
  })

  test("maps JSON-RPC errors to typed RpcError", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method === "read_view") {
        socket.write(
          frame({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "file not found" } }),
        )
      }
    })
    const client = await Client.connect(server.path, { connect_timeout_ms: 2_000 })

    const error = await client.readView({ file: "missing.ts", view: "entry" }).catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.RpcError)
    expect(error.code).toBe(Protocol.ErrorCode.fileNotFound)
    expect(error.message).toBe("file not found")

    client.close()
    await server.close()
  })

  test("times out requests with a typed TimeoutError", async () => {
    const server = await listenServer(() => {})
    const client = await Client.connect(server.path, { connect_timeout_ms: 2_000, request_timeout_ms: 100 })

    const error = await client.ping().catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.TimeoutError)
    expect(error.timeout_ms).toBe(100)

    client.close()
    await server.close()
  })

  test("delivers notifications/indexing notifications", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method === "subscribe") {
        socket.write(frame({ jsonrpc: "2.0", id: message.id, result: { ok: true } }))
        socket.write(
          frame({
            jsonrpc: "2.0",
            method: "notifications/indexing",
            params: { phase: "parsing", progress: 0.25, current: "src/a.ts", eta: 5 },
          }),
        )
        socket.write(
          frame({
            jsonrpc: "2.0",
            method: "notifications/indexing",
            params: { phase: "done", progress: 1 },
          }),
        )
      }
    })
    const client = await Client.connect(server.path, { connect_timeout_ms: 2_000 })
    const seen: Protocol.IndexingNotification[] = []
    const done = new Promise<void>((resolve) => {
      client.onIndexing((notification) => {
        seen.push(notification)
        if (seen.length === 2) resolve()
      })
    })

    await client.subscribe()
    await done
    expect(seen).toEqual([
      { phase: "parsing", progress: 0.25, current: "src/a.ts", eta: 5 },
      { phase: "done", progress: 1 },
    ])

    client.close()
    await server.close()
  })

  test("rejects pending requests when the connection closes", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method === "ping") socket.destroy()
    })
    const client = await Client.connect(server.path, { connect_timeout_ms: 2_000 })

    const error = await client.ping().catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.ConnectionError)

    client.close()
    await server.close()
  })
})
