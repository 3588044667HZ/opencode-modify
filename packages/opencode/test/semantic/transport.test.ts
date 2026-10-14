import { describe, expect, test } from "bun:test"
import * as Protocol from "@/semantic/protocol"
import * as Transport from "@/semantic/transport"
import { frame, listenServer } from "./fake-server"

describe("semantic transport", () => {
  test("reassembles split frames and splits glued frames", async () => {
    const server = await listenServer()
    const transport = await Transport.connect(server.path, { timeout_ms: 2_000 })
    const received: Protocol.Message[] = []
    transport.onMessage((message) => received.push(message))

    const socket = await server.first()
    const payload = frame({ jsonrpc: "2.0", id: 1, result: { indexing: false } })
    const second = frame({ jsonrpc: "2.0", id: 2, result: { indexing: true } })
    socket.write(payload.slice(0, 12))
    await Bun.sleep(20)
    socket.write(payload.slice(12) + second)
    await Bun.sleep(20)

    expect(received).toEqual([
      { jsonrpc: "2.0", id: 1, result: { indexing: false } },
      { jsonrpc: "2.0", id: 2, result: { indexing: true } },
    ])

    transport.close()
    await server.close()
  })

  test("ignores malformed frames and handles CRLF", async () => {
    const server = await listenServer()
    const transport = await Transport.connect(server.path, { timeout_ms: 2_000 })
    const received: Protocol.Message[] = []
    transport.onMessage((message) => received.push(message))

    const socket = await server.first()
    socket.write("not json\n" + frame({ jsonrpc: "2.0", id: 7, result: { ok: true } }).replace("\n", "\r\n"))
    await Bun.sleep(20)

    expect(received).toEqual([{ jsonrpc: "2.0", id: 7, result: { ok: true } }])

    transport.close()
    await server.close()
  })

  test("notifies onClose when the peer disconnects", async () => {
    const server = await listenServer()
    const transport = await Transport.connect(server.path, { timeout_ms: 2_000 })
    const closed = new Promise<void>((resolve) => transport.onClose(() => resolve()))

    const socket = await server.first()
    socket.destroy()
    await closed

    transport.close()
    await server.close()
  })

  test("rejects connect when nothing is listening", async () => {
    const server = await listenServer()
    const path = server.path
    await server.close()

    await expect(Transport.connect(path, { timeout_ms: 500 })).rejects.toBeInstanceOf(Protocol.ConnectionError)
  })
})
