import { StringDecoder } from "node:string_decoder"
import type { Readable, Writable } from "node:stream"
import type { Transport } from "./transport.js"

export type StdioTransportOptions = {
  input: Readable
  output: Writable
  maxMessageBytes?: number
}

export function createStdioTransport(options: StdioTransportOptions): Transport {
  const maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024
  const decoder = new StringDecoder("utf8")
  const handlers = new Set<(message: string) => void>()
  const closeHandlers = new Set<(error?: Error) => void>()
  const buffered: string[] = []
  let buffer = ""
  let closed = false

  const fail = (error: Error) => {
    if (closed) return
    closed = true
    for (const handler of closeHandlers) handler(error)
    closeHandlers.clear()
  }

  const emit = (message: string) => {
    if (handlers.size === 0) {
      buffered.push(message)
      return
    }
    for (const handler of handlers) handler(message)
  }

  const onData = (chunk: Buffer | string) => {
    if (closed) return
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk)
    if (Buffer.byteLength(buffer) > maxMessageBytes && !buffer.includes("\n")) {
      fail(new Error("IPC message exceeds the configured maximum size"))
      return
    }
    let index = buffer.indexOf("\n")
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      if (line) emit(line)
      index = buffer.indexOf("\n")
    }
  }

  const onEnd = () => {
    const rest = `${buffer}${decoder.end()}`.replace(/\r$/, "")
    buffer = ""
    if (rest) emit(rest)
    fail(new Error("IPC input closed"))
  }

  options.input.on("data", onData)
  options.input.once("end", onEnd)
  options.input.once("close", onEnd)
  options.input.once("error", (error: Error) => fail(error))
  options.output.once("error", (error: Error) => fail(error))

  const send = (message: string) => {
    if (closed) return Promise.reject(new Error("IPC transport is closed"))
    return new Promise<void>((resolve, reject) => {
      const write = options.output.write(`${message}\n`)
      if (write) {
        resolve()
        return
      }
      const onDrain = () => {
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        options.output.off("drain", onDrain)
        options.output.off("error", onError)
      }
      options.output.once("drain", onDrain)
      options.output.once("error", onError)
    })
  }

  return {
    send,
    onMessage(handler) {
      handlers.add(handler)
      if (buffered.length > 0) {
        const messages = buffered.splice(0)
        for (const message of messages) handler(message)
      }
      return () => handlers.delete(handler)
    },
    onClose(handler) {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },
    close() {
      if (closed) return
      closed = true
      options.input.off("data", onData)
      options.input.off("end", onEnd)
      options.input.off("close", onEnd)
      for (const handler of closeHandlers) handler()
      closeHandlers.clear()
    },
  }
}
