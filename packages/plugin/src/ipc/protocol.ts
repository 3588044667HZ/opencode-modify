export const IPC_PROTOCOL_VERSION = 1

export type JsonRpcId = string | number

export type JsonRpcErrorObject = {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcRequest = {
  jsonrpc: "2.0"
  id: JsonRpcId
  method: string
  params?: unknown
}

export type JsonRpcNotification = {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcErrorObject
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  RequestCancelled: -32800,
  Timeout: -32000,
} as const

export class IpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "IpcError"
    this.code = code
    this.data = data
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
}

function isErrorObject(value: unknown): value is JsonRpcErrorObject {
  return isRecord(value) && typeof value.code === "number" && typeof value.message === "string"
}

export function parseMessage(input: string): JsonRpcMessage {
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch {
    throw new IpcError(ErrorCodes.ParseError, "Invalid JSON-RPC payload")
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    throw new IpcError(ErrorCodes.InvalidRequest, "Invalid JSON-RPC message")
  }
  if (typeof value.method === "string") {
    if ("id" in value) {
      if (!isId(value.id)) throw new IpcError(ErrorCodes.InvalidRequest, "Invalid JSON-RPC id")
      return { jsonrpc: "2.0", id: value.id, method: value.method, params: value.params }
    }
    return { jsonrpc: "2.0", method: value.method, params: value.params }
  }
  if (!isId(value.id)) throw new IpcError(ErrorCodes.InvalidRequest, "Invalid JSON-RPC response id")
  if ("error" in value && value.error !== undefined) {
    if (!isErrorObject(value.error)) throw new IpcError(ErrorCodes.InvalidRequest, "Invalid JSON-RPC error")
    return { jsonrpc: "2.0", id: value.id, error: value.error }
  }
  return { jsonrpc: "2.0", id: value.id, result: value.result }
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "id" in message && "method" in message
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return !("id" in message) && "method" in message
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && !("method" in message)
}
