import type { Transport } from "./transport.js"

export type MessagePortLike = {
  postMessage(value: unknown): void
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
    options?: { once?: boolean },
  ): void
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  start?(): void
  close?(): void
}

export function createMessagePortTransport(port: MessagePortLike): Transport {
  const handlers = new Set<(message: string) => void>()
  const closeHandlers = new Set<(error?: Error) => void>()
  let closed = false

  const onMessage = (event: { data: unknown }) => {
    if (closed) return
    if (typeof event.data !== "string") {
      closed = true
      port.removeEventListener("message", onMessage)
      for (const handler of closeHandlers) handler(new Error("IPC MessagePort expects string messages"))
      closeHandlers.clear()
      return
    }
    for (const handler of handlers) handler(event.data)
  }

  port.addEventListener("message", onMessage)
  port.start?.()

  return {
    send(message) {
      if (closed) return Promise.reject(new Error("IPC transport is closed"))
      port.postMessage(message)
      return Promise.resolve()
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    onClose(handler) {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },
    close() {
      if (closed) return
      closed = true
      port.removeEventListener("message", onMessage)
      for (const handler of closeHandlers) handler()
      closeHandlers.clear()
    },
  }
}
