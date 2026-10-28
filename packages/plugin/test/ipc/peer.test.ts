import { describe, expect, test } from "bun:test"
import { createPeer } from "../../src/ipc/peer"
import { ErrorCodes, isRecord } from "../../src/ipc/protocol"
import type { Transport } from "../../src/ipc/transport"

type Side = {
  messages: Set<(message: string) => void>
  closes: Set<(error?: Error) => void>
  closed: boolean
}

function pair(): [Transport, Transport] {
  const makeSide = (): Side => ({ messages: new Set(), closes: new Set(), closed: false })
  const left = makeSide()
  const right = makeSide()
  const transport = (self: Side, peer: Side): Transport => ({
    send(message) {
      if (self.closed) return Promise.reject(new Error("closed"))
      queueMicrotask(() => {
        for (const handler of peer.messages) handler(message)
      })
      return Promise.resolve()
    },
    onMessage(handler) {
      self.messages.add(handler)
      return () => self.messages.delete(handler)
    },
    onClose(handler) {
      self.closes.add(handler)
      return () => self.closes.delete(handler)
    },
    close() {
      if (self.closed) return
      self.closed = true
      for (const handler of self.closes) handler()
      for (const handler of peer.closes) handler(new Error("peer closed"))
      self.closes.clear()
      peer.closes.clear()
    },
  })
  return [transport(left, right), transport(right, left)]
}

describe("ipc peer", () => {
  test("handles requests and notifications", async () => {
    const [left, right] = pair()
    const a = createPeer(left)
    const b = createPeer(right)
    b.onRequest("add", (params) => {
      if (!isRecord(params)) throw new Error("invalid params")
      if (typeof params.a !== "number" || typeof params.b !== "number") throw new Error("invalid params")
      return params.a + params.b
    })
    const received: unknown[] = []
    b.onNotification("event", (params) => {
      received.push(params)
    })

    expect(await a.request("add", { a: 2, b: 3 })).toBe(5)
    await a.notify("event", { ok: true })
    await Promise.resolve()
    expect(received).toEqual([{ ok: true }])

    await Promise.all([a.close(), b.close()])
  })

  test("returns method-not-found and handler errors", async () => {
    const [left, right] = pair()
    const a = createPeer(left)
    const b = createPeer(right)
    b.onRequest("fail", () => {
      throw new Error("boom")
    })

    await expect(a.request("missing")).rejects.toMatchObject({ code: ErrorCodes.MethodNotFound })
    await expect(a.request("fail")).rejects.toMatchObject({ code: ErrorCodes.InternalError, message: "boom" })

    await Promise.all([a.close(), b.close()])
  })

  test("times out and cancels the remote handler", async () => {
    const [left, right] = pair()
    const a = createPeer(left)
    const b = createPeer(right)
    let signal: AbortSignal | undefined
    b.onRequest("wait", (_params, context) => {
      signal = context.signal
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
      })
    })

    await expect(a.request("wait", {}, { timeoutMs: 20 })).rejects.toMatchObject({ code: ErrorCodes.Timeout })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(signal?.aborted).toBe(true)

    await Promise.all([a.close(), b.close()])
  })

  test("aborts a pending request when the caller signal fires", async () => {
    const [left, right] = pair()
    const a = createPeer(left)
    const b = createPeer(right)
    let signal: AbortSignal | undefined
    b.onRequest("wait", (_params, context) => {
      signal = context.signal
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
      })
    })

    const controller = new AbortController()
    const pending = a.request("wait", {}, { signal: controller.signal, timeoutMs: null })
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(signal?.aborted).toBe(true)

    await Promise.all([a.close(), b.close()])
  })

  test("rejects pending requests when closed", async () => {
    const [left, right] = pair()
    const a = createPeer(left)
    const b = createPeer(right)
    b.onRequest("wait", () => new Promise(() => undefined))

    const pending = a.request("wait", {}, { timeoutMs: null })
    await Promise.resolve()
    await a.close(new Error("closed by test"))
    await expect(pending).rejects.toThrow("closed by test")

    await b.close()
  })
})
