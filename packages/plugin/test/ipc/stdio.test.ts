import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { createPeer } from "../../src/ipc/peer"
import { createStdioTransport } from "../../src/ipc/stdio"

describe("ipc stdio transport", () => {
  test("exchanges newline-delimited JSON", async () => {
    const aToB = new PassThrough()
    const bToA = new PassThrough()

    const a = createPeer(createStdioTransport({ input: bToA, output: aToB }))
    const b = createPeer(createStdioTransport({ input: aToB, output: bToA }))
    b.onRequest("echo", (params) => params)

    await expect(a.request("echo", { value: 1 })).resolves.toEqual({ value: 1 })

    await Promise.all([a.close(), b.close()])
  })

  test("handles split and concatenated frames", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = createStdioTransport({ input, output })
    const messages: string[] = []
    transport.onMessage((message) => messages.push(message))

    input.write('{"a":')
    input.write('1}\n{"b":2}\n')
    await Promise.resolve()
    expect(messages).toEqual(['{"a":1}', '{"b":2}'])

    await transport.close?.()
  })
})
