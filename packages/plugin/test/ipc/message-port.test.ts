import { describe, expect, test } from "bun:test"
import { createMessagePortTransport } from "../../src/ipc/message-port"
import { createPeer } from "../../src/ipc/peer"

describe("ipc MessagePort transport", () => {
  test("exchanges messages between two ports", async () => {
    const channel = new MessageChannel()
    const a = createPeer(createMessagePortTransport(channel.port1))
    const b = createPeer(createMessagePortTransport(channel.port2))
    b.onRequest("echo", (params) => params)

    await expect(a.request("echo", { value: 2 })).resolves.toEqual({ value: 2 })

    await Promise.all([a.close(), b.close()])
  })
})
