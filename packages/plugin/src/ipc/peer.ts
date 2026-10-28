import {
  ErrorCodes,
  IpcError,
  isNotification,
  isRequest,
  isRecord,
  isResponse,
  parseMessage,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./protocol.js"
import type { Transport } from "./transport.js"

export type RequestContext = {
  id: JsonRpcId
  method: string
  signal: AbortSignal
}

export type RequestHandler = (params: unknown, context: RequestContext) => unknown
export type NotificationHandler = (params: unknown) => void | Promise<void>

export type RequestOptions = {
  timeoutMs?: number | null
  signal?: AbortSignal
}

export type PeerOptions = {
  defaultTimeoutMs?: number
  maxPendingRequests?: number
  onError?: (error: unknown) => void
}

export type Peer = {
  readonly closed: boolean
  request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T>
  notify(method: string, params?: unknown): Promise<void>
  onRequest(method: string, handler: RequestHandler): () => void
  onNotification(method: string, handler: NotificationHandler): () => void
  onClose(handler: (error?: Error) => void): () => void
  close(error?: Error): Promise<void>
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  cleanup?: () => void
}

const closedError = () => new IpcError(ErrorCodes.InternalError, "IPC peer is closed")

function abortError(signal: AbortSignal) {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  return new IpcError(ErrorCodes.RequestCancelled, "Request cancelled")
}

export function createPeer(transport: Transport, options: PeerOptions = {}): Peer {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
  const maxPendingRequests = options.maxPendingRequests ?? 1_000
  const pending = new Map<JsonRpcId, PendingRequest>()
  const requests = new Map<string, RequestHandler>()
  const notifications = new Map<string, NotificationHandler>()
  const inFlight = new Map<JsonRpcId, AbortController>()
  const cancelled = new Set<JsonRpcId>()
  const closeHandlers = new Set<(error?: Error) => void>()
  let closed = false
  let nextId = 0
  const idPrefix = Math.random().toString(36).slice(2, 10)
  let sendQueue: Promise<void> = Promise.resolve()

  const report = (error: unknown) => {
    options.onError?.(error)
  }

  const enqueue = (message: JsonRpcMessage) => {
    const task = sendQueue.then(() => {
      if (closed) throw closedError()
      return transport.send(JSON.stringify(message))
    })
    sendQueue = task.catch(() => undefined)
    return task
  }

  const sendError = (id: JsonRpcId, error: JsonRpcErrorObject) => {
    void enqueue({ jsonrpc: "2.0", id, error }).catch(report)
  }

  const settle = (id: JsonRpcId, error: Error | undefined, value?: unknown) => {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    if (request.timer) clearTimeout(request.timer)
    request.cleanup?.()
    if (error) request.reject(error)
    else request.resolve(value)
  }

  const cancel = (id: JsonRpcId) => {
    inFlight.get(id)?.abort()
  }

  let unsubscribeMessage: () => void = () => undefined
  let unsubscribeClose: () => void = () => undefined

  const close = async (error?: Error) => {
    if (closed) return
    closed = true
    for (const [id, request] of pending) {
      if (request.timer) clearTimeout(request.timer)
      request.cleanup?.()
      request.reject(error ?? closedError())
      pending.delete(id)
    }
    for (const controller of inFlight.values()) controller.abort()
    inFlight.clear()
    cancelled.clear()
    unsubscribeMessage()
    unsubscribeClose()
    try {
      await transport.close?.()
    } catch (cause) {
      report(cause)
    }
    for (const handler of closeHandlers) handler(error)
    closeHandlers.clear()
  }

  const handleRequest = (message: JsonRpcMessage & { id: JsonRpcId; method: string; params?: unknown }) => {
    const handler = requests.get(message.method)
    if (!handler) {
      sendError(message.id, {
        code: ErrorCodes.MethodNotFound,
        message: `Unknown IPC method: ${message.method}`,
      })
      return
    }
    const controller = new AbortController()
    inFlight.set(message.id, controller)
    void Promise.resolve()
      .then(() => handler(message.params, { id: message.id, method: message.method, signal: controller.signal }))
      .then((result) => {
        if (cancelled.delete(message.id)) return
        void enqueue({ jsonrpc: "2.0", id: message.id, result }).catch(report)
      })
      .catch((error: unknown) => {
        if (cancelled.delete(message.id)) return
        const cancelledBySignal = controller.signal.aborted
        sendError(message.id, {
          code: cancelledBySignal
            ? ErrorCodes.RequestCancelled
            : error instanceof IpcError
              ? error.code
              : ErrorCodes.InternalError,
          message: error instanceof Error ? error.message : String(error),
          data: error instanceof IpcError ? error.data : undefined,
        })
      })
      .finally(() => {
        inFlight.delete(message.id)
        cancelled.delete(message.id)
      })
  }

  const handleMessage = (raw: string) => {
    let message: JsonRpcMessage
    try {
      message = parseMessage(raw)
    } catch (error) {
      void close(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (isResponse(message)) {
      const request = pending.get(message.id)
      if (!request) return
      if (message.error) {
        settle(message.id, new IpcError(message.error.code, message.error.message, message.error.data))
        return
      }
      settle(message.id, undefined, message.result)
      return
    }
    if (isRequest(message)) {
      handleRequest(message)
      return
    }
    if (!isNotification(message)) return
    if (message.method === "$/cancelRequest") {
      if (isRecord(message.params)) {
        const id = message.params.id
        if (typeof id === "string" || typeof id === "number") cancel(id)
      }
      return
    }
    const handler = notifications.get(message.method)
    if (!handler) return
    void Promise.resolve(handler(message.params)).catch(report)
  }

  const request = <T>(method: string, params?: unknown, requestOptions: RequestOptions = {}) => {
    if (closed) return Promise.reject(closedError())
    if (pending.size >= maxPendingRequests) {
      return Promise.reject(new IpcError(ErrorCodes.InternalError, "Too many pending IPC requests"))
    }
    const id = `${idPrefix}-${++nextId}`
    const timeoutMs = requestOptions.timeoutMs === undefined ? defaultTimeoutMs : requestOptions.timeoutMs
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- JSON-RPC results are untyped at the transport boundary; request<T> owns the declaration.
        resolve: (value) => resolve(value as T),
        reject,
      }
      if (timeoutMs !== null && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          settle(id, new IpcError(ErrorCodes.Timeout, `IPC request timed out: ${method}`))
          void enqueue({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }).catch(report)
        }, timeoutMs)
      }
      const signal = requestOptions.signal
      if (signal) {
        if (signal.aborted) {
          reject(abortError(signal))
          return
        }
        const onAbort = () => {
          settle(id, abortError(signal))
          void enqueue({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }).catch(report)
        }
        signal.addEventListener("abort", onAbort, { once: true })
        entry.cleanup = () => signal.removeEventListener("abort", onAbort)
      }
      pending.set(id, entry)
      void enqueue({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
        settle(id, error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  const notify = (method: string, params?: unknown) => {
    if (closed) return Promise.reject(closedError())
    return enqueue({ jsonrpc: "2.0", method, params })
  }

  const onRequest = (method: string, handler: RequestHandler) => {
    requests.set(method, handler)
    return () => {
      if (requests.get(method) === handler) requests.delete(method)
    }
  }

  const onNotification = (method: string, handler: NotificationHandler) => {
    notifications.set(method, handler)
    return () => {
      if (notifications.get(method) === handler) notifications.delete(method)
    }
  }

  const onClose = (handler: (error?: Error) => void) => {
    if (closed) {
      handler()
      return () => undefined
    }
    closeHandlers.add(handler)
    return () => closeHandlers.delete(handler)
  }

  unsubscribeMessage = transport.onMessage(handleMessage)
  unsubscribeClose = transport.onClose?.(() => void close()) ?? (() => undefined)

  return {
    get closed() {
      return closed
    },
    request,
    notify,
    onRequest,
    onNotification,
    onClose,
    close,
  }
}
