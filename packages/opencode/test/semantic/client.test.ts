import { describe, expect, test } from "bun:test"
import * as Client from "@/semantic/client"
import * as Protocol from "@/semantic/protocol"
import { frame, listenServer } from "./fake-server"
import { SAMPLE_DELTA, SAMPLE_READ_DELTA, SAMPLE_READ_RECONCILE_FULL, SAMPLE_RESULT, SAMPLE_RESULT_UNCHANGED } from "./fixture"

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
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    const [ping, view] = await Promise.all([
      client.ping(),
      client.readView({ file: "engine.ts", view: "entry" }),
    ])
    expect(ping).toEqual({ indexing: true, progress: 0.5 })
    expect(view).toEqual(SAMPLE_RESULT)

    client.close()
    await server.close()
  })

    test("forwards known_version and decodes the unchanged micro response", async () => {
      const requests: any[] = []
      const server = await listenServer((message, socket) => {
        if (message.method !== "read_view") return
        requests.push(message)
        socket.write(frame({ jsonrpc: "2.0", id: message.id, result: SAMPLE_RESULT_UNCHANGED }))
      })
      const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

      const result = await client.readView({ file: "engine.ts", view: "entry", known_version: "a3f9c2" })
      expect(result).toEqual(SAMPLE_RESULT_UNCHANGED)
      expect(requests[0]?.params).toEqual({ file: "engine.ts", view: "entry", known_version: "a3f9c2" })

      client.close()
      await server.close()
    })

    test("decodes a bounded delta response and the full reconciliation marker", async () => {
      let call = 0
      const server = await listenServer((message, socket) => {
        if (message.method !== "read_view") return
        call += 1
        socket.write(
          frame({ jsonrpc: "2.0", id: message.id, result: call === 1 ? SAMPLE_READ_DELTA : SAMPLE_READ_RECONCILE_FULL }),
        )
      })
      const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

      expect(await client.readView({ file: "engine.ts", view: "entry", known_version: "a3f9c2" })).toEqual(
        SAMPLE_READ_DELTA,
      )
      expect(await client.readView({ file: "engine.ts", view: "entry", known_version: "a3f9c2" })).toEqual(
        SAMPLE_READ_RECONCILE_FULL,
      )

      client.close()
      await server.close()
    })

    test("rejects malformed reconcile responses instead of silently ignoring fields", async () => {
      const server = await listenServer((message, socket) => {
        if (message.method !== "read_view") return
        socket.write(
          frame({
            jsonrpc: "2.0",
            id: message.id,
            result: { ...SAMPLE_RESULT_UNCHANGED, file: "engine.ts" },
          }),
        )
      })
      const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

      const error = await client.readView({ file: "engine.ts", view: "entry" }).catch((cause) => cause)
      expect(error).toBeInstanceOf(Protocol.RpcError)
      expect(error.code).toBe(Protocol.ErrorCode.internalError)
      expect(error.message).toBe("malformed read_view response")

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
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    const error = await client.readView({ file: "missing.ts", view: "entry" }).catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.RpcError)
    expect(error.code).toBe(Protocol.ErrorCode.fileNotFound)
    expect(error.message).toBe("file not found")

    client.close()
    await server.close()
  })

  test("times out requests with a typed TimeoutError", async () => {
    const server = await listenServer(() => {})
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000, request_timeout_ms: 100 })

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
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })
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
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    const error = await client.ping().catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.ConnectionError)

    client.close()
    await server.close()
  })

  test("rejects connect when the hello token is unauthorized", async () => {
    const server = await listenServer()
    const error = await Client.connect(
      { host: server.endpoint.host, port: server.endpoint.port, token: "0".repeat(32) },
      { connect_timeout_ms: 2_000 },
    ).catch((cause) => cause)

    expect(error).toBeInstanceOf(Protocol.ConnectionError)
    expect(error.message).toContain("-32019")

    await server.close()
  })

  test("rejects connect when the hello response is malformed", async () => {
    const server = await listenServer(undefined, { hello: "malformed" })
    const error = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 }).catch((cause) => cause)

    expect(error).toBeInstanceOf(Protocol.ConnectionError)
    expect(error.message).toContain("malformed hello")

    await server.close()
  })

  test("rejects connect when the hello handshake times out", async () => {
    const server = await listenServer(undefined, { hello: "silent" })
    const error = await Client.connect(server.endpoint, { connect_timeout_ms: 100 }).catch((cause) => cause)

    expect(error).toBeInstanceOf(Protocol.ConnectionError)
    expect(error.message).toContain("hello handshake timed out")

    await server.close()
  })

  describe("semantic read_view reconcile decoding", () => {
    test("accepts unchanged, delta, and full-marker responses", () => {
      expect(Protocol.decodeOption(Protocol.ReadViewResult, SAMPLE_RESULT_UNCHANGED)).toEqual(SAMPLE_RESULT_UNCHANGED)
      expect(Protocol.decodeOption(Protocol.ReadViewResult, SAMPLE_READ_DELTA)).toEqual(SAMPLE_READ_DELTA)
      expect(Protocol.decodeOption(Protocol.ReadViewResult, SAMPLE_READ_RECONCILE_FULL)).toEqual(SAMPLE_READ_RECONCILE_FULL)
    })

    test("rejects unknown fields at the top level and inside delta hunks", () => {
      expect(Protocol.decodeOption(Protocol.ReadViewResult, { ...SAMPLE_RESULT_UNCHANGED, extra: true })).toBeUndefined()
      expect(
        Protocol.decodeOption(Protocol.ReadViewResult, {
          ...SAMPLE_READ_DELTA,
          reconciliation: { ...SAMPLE_DELTA, hunks: [{ ...SAMPLE_DELTA.hunks[0], extra: true }] },
        }),
      ).toBeUndefined()
      expect(
        Protocol.decodeOption(Protocol.ReadViewResult, {
          ...SAMPLE_READ_DELTA,
          reconciliation: { ...SAMPLE_DELTA, hunks: [{ ...SAMPLE_DELTA.hunks[0], lines: [{ op: "moved", new_line: 1, text: "x" }] }] },
        }),
      ).toBeUndefined()
      expect(
        Protocol.decodeOption(Protocol.ReadViewResult, { ...SAMPLE_READ_DELTA, delta: SAMPLE_DELTA }),
      ).toBeUndefined()
    })

    test("rejects a mixed response that is neither unchanged nor a content view", () => {
      expect(
        Protocol.decodeOption(Protocol.ReadViewResult, { unchanged: true, version: "a3f9c2", content: [] }),
      ).toBeUndefined()
    })
  })
})
