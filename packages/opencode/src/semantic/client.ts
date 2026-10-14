import * as Protocol from "./protocol"
import * as Transport from "./transport"

export interface Client {
  readonly ping: () => Promise<Protocol.PingResult>
  readonly subscribe: () => Promise<void>
  readonly readView: (input: Protocol.ReadViewRequest) => Promise<Protocol.ReadViewResult>
  readonly blastRadius: (input: Protocol.BlastRadiusRequest) => Promise<Protocol.BlastRadiusResult>
  readonly editBatch: (input: Protocol.EditBatchRequest) => Promise<Protocol.EditBatchResult>
  readonly verifyTest: (input: Protocol.VerifyTestRequest) => Promise<Protocol.VerifyTestResult>
  readonly shutdown: () => Promise<void>
  readonly onIndexing: (listener: (notification: Protocol.IndexingNotification) => void) => () => void
  readonly onClose: (listener: (error?: Error) => void) => () => void
  readonly close: () => void
}

export interface ClientOptions {
  readonly connect_timeout_ms?: number
  readonly request_timeout_ms?: number
}

export async function connect(path: string, options?: ClientOptions): Promise<Client> {
  const transport = await Transport.connect(path, { timeout_ms: options?.connect_timeout_ms })
  const requestTimeoutMs = options?.request_timeout_ms ?? Protocol.Defaults.requestTimeoutMs
  const pending = new Map<
    number,
    {
      readonly method: string
      readonly resolve: (value: unknown) => void
      readonly reject: (error: Protocol.SemanticError) => void
      readonly timer: ReturnType<typeof setTimeout>
    }
  >()
  const notifications = new Map<string, Set<(params: unknown) => void>>()
  let nextID = 1
  let closed = false

  const offMessage = transport.onMessage((message) => {
    if (Protocol.isResponse(message)) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if ("error" in message) {
        entry.reject(
          new Protocol.RpcError({
            code: message.error.code,
            message: message.error.message,
            data: message.error.data,
          }),
        )
        return
      }
      entry.resolve(message.result)
      return
    }
    const listeners = notifications.get(message.method)
    if (!listeners) return
    for (const listener of [...listeners]) listener(message.params)
  })

  const offClose = transport.onClose(() => {
    closed = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Protocol.ConnectionError({ message: `semantic socket closed while awaiting ${entry.method}` }))
    }
    pending.clear()
  })

  const request = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) {
        reject(new Protocol.ConnectionError({ message: "semantic socket is closed" }))
        return
      }
      const id = nextID++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new Protocol.TimeoutError({
            message: `semantic request ${method} timed out after ${requestTimeoutMs}ms`,
            method,
            timeout_ms: requestTimeoutMs,
          }),
        )
      }, requestTimeoutMs)
      pending.set(id, { method, resolve, reject, timer })
      transport.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
    })

  function decodeFailure(what: string) {
    return new Protocol.RpcError({ code: Protocol.ErrorCode.internalError, message: `malformed ${what} response` })
  }

  function close() {
    if (closed) return
    closed = true
    offMessage()
    offClose()
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Protocol.ConnectionError({ message: "semantic client closed" }))
    }
    pending.clear()
    transport.close()
  }

  return {
    ping: async () => {
      const decoded = Protocol.decodeOption(Protocol.PingResult, await request("ping"))
      if (decoded === undefined) throw decodeFailure("ping")
      return decoded
    },
    subscribe: async () => {
      const decoded = Protocol.decodeOption(Protocol.SubscribeResult, await request("subscribe"))
      if (decoded === undefined) throw decodeFailure("subscribe")
    },
    readView: async (input) => {
      const decoded = Protocol.decodeOption(Protocol.ReadViewResult, await request("read_view", input))
      if (decoded === undefined) throw decodeFailure("read_view")
      return decoded
    },
    blastRadius: async (input) => {
      const decoded = Protocol.decodeOption(Protocol.BlastRadiusResult, await request("blast_radius", input))
      if (decoded === undefined) throw decodeFailure("blast_radius")
      return decoded
    },
    editBatch: async (input) => {
      const decoded = Protocol.decodeOption(Protocol.EditBatchResult, await request("edit_batch", input))
      if (decoded === undefined) throw decodeFailure("edit_batch")
      return decoded
    },
    verifyTest: async (input) => {
      const decoded = Protocol.decodeOption(Protocol.VerifyTestResult, await request("verify_test", input))
      if (decoded === undefined) throw decodeFailure("verify_test")
      return decoded
    },
    shutdown: async () => {
      try {
        const decoded = Protocol.decodeOption(Protocol.ShutdownResult, await request("shutdown"))
        if (decoded === undefined) throw decodeFailure("shutdown")
      } finally {
        close()
      }
    },
    onIndexing: (listener) => {
      const set = notifications.get("notifications/indexing") ?? new Set()
      notifications.set("notifications/indexing", set)
      const wrapped = (params: unknown) => {
        const decoded = Protocol.decodeOption(Protocol.IndexingNotification, params)
        if (decoded !== undefined) listener(decoded)
      }
      set.add(wrapped)
      return () => set.delete(wrapped)
    },
    onClose: (listener) => transport.onClose(listener),
    close,
  }
}
