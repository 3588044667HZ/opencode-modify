import { describe, expect, test } from "bun:test"
import { createPluginPeer } from "../../src/ipc/lifecycle"
import { createPeer } from "../../src/ipc/peer"
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

describe("ipc plugin lifecycle", () => {
  test("runs mount, unmount, and delete in order with automatic cleanup", async () => {
    const [left, right] = pair()
    const trace: string[] = []
    const plugin = createPluginPeer(left, {
      onMount(context) {
        trace.push("mount")
        context.effect(() => {
          trace.push("effect")
        })
        return () => {
          trace.push("returned")
        }
      },
      onUnmount(context) {
        trace.push(`unmount:${context.reason}`)
      },
      onDelete() {
        trace.push("delete")
      },
    })
    const host = createPeer(right)

    await host.request("onMount", { pluginId: "test" })
    expect(plugin.mounted).toBe(true)
    await host.request("onUnmount", { reason: "disable" })
    expect(plugin.mounted).toBe(false)
    expect(trace).toEqual(["mount", "unmount:disable", "returned", "effect"])

    await host.request("onMount", { pluginId: "test" })
    await host.request("onDelete", {})
    expect(plugin.deleted).toBe(true)
    expect(trace).toEqual([
      "mount",
      "unmount:disable",
      "returned",
      "effect",
      "mount",
      "unmount:uninstall",
      "returned",
      "effect",
      "delete",
    ])

    await Promise.all([plugin.peer.close(), host.close()])
  })

  test("cleans registered effects when mount fails", async () => {
    const [left, right] = pair()
    const trace: string[] = []
    const plugin = createPluginPeer(left, {
      onMount(context) {
        context.effect(() => {
          trace.push("cleanup")
        })
        throw new Error("mount failed")
      },
    })
    const host = createPeer(right)

    await expect(host.request("onMount", { pluginId: "test" })).rejects.toThrow("mount failed")
    expect(plugin.mounted).toBe(false)
    expect(trace).toEqual(["cleanup"])

    await Promise.all([plugin.peer.close(), host.close()])
  })

  test("cleans registered effects even when onUnmount fails", async () => {
    const [left, right] = pair()
    const trace: string[] = []
    const plugin = createPluginPeer(left, {
      onMount(context) {
        context.effect(() => {
          trace.push("cleanup")
        })
      },
      onUnmount() {
        throw new Error("unmount failed")
      },
    })
    const host = createPeer(right)

    await host.request("onMount", { pluginId: "test" })
    await expect(host.request("onUnmount", { reason: "disable" })).rejects.toThrow("unmount failed")
    expect(plugin.mounted).toBe(false)
    expect(trace).toEqual(["cleanup"])

    await Promise.all([plugin.peer.close(), host.close()])
  })
})
