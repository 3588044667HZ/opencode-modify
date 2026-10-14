// Minimal fake semantic daemon for tests. Implements the frozen JSON-RPC
// protocol over a unix socket / Windows named pipe.
//
// Usage: bun fake-daemon.ts [--indexing | --indexing-forever] [--read-view-error=indexing|notfound] [--blast-radius-error=indexing|symbol] [--edit-batch-error=anchor] [--verify-test=success|failure|unrecognized] <project_dir> <socket_path>
import net from "node:net"
import {
  SAMPLE_BLAST_RESULT,
  SAMPLE_EDIT_BATCH_FAILURE,
  SAMPLE_EDIT_BATCH_SUCCESS,
  SAMPLE_RESULT,
  SAMPLE_VERIFY_FAILURE,
  SAMPLE_VERIFY_SUCCESS,
  SAMPLE_VERIFY_UNRECOGNIZED,
} from "./fixture"

const argv = process.argv.slice(2)
const flags = argv.filter((arg) => arg.startsWith("--"))
const socketPath = argv.filter((arg) => !arg.startsWith("--")).at(-1)

if (!socketPath) {
  process.stderr.write("fake-daemon: missing socket path\n")
  process.exit(2)
}

const mode = {
  indexing: flags.includes("--indexing"),
  forever: flags.includes("--indexing-forever"),
  readViewError: flags.find((flag) => flag.startsWith("--read-view-error="))?.split("=")[1],
  blastRadiusError: flags.find((flag) => flag.startsWith("--blast-radius-error="))?.split("=")[1],
  editBatchError: flags.find((flag) => flag.startsWith("--edit-batch-error="))?.split("=")[1],
  verifyTest: flags.find((flag) => flag.startsWith("--verify-test="))?.split("=")[1],
}

const state = {
  indexed: !mode.indexing && !mode.forever,
  progress: mode.forever ? 0.42 : 0.25,
}

function send(socket: net.Socket, message: unknown) {
  if (socket.destroyed) return
  socket.write(JSON.stringify(message) + "\n")
}

function respond(socket: net.Socket, id: number, result: unknown) {
  send(socket, { jsonrpc: "2.0", id, result })
}

function respondError(socket: net.Socket, id: number, code: number, message: string, data?: unknown) {
  send(socket, { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

function pingResult() {
  return state.indexed
    ? { indexing: false, progress: 1, phase: "ready" }
    : { indexing: true, progress: state.progress, phase: "indexing", current: "src/a.ts" }
}

function scheduleIndexing(socket: net.Socket) {
  if (state.indexed) return
  if (mode.forever) return
  setTimeout(() => {
    state.progress = 0.5
    send(socket, {
      jsonrpc: "2.0",
      method: "notifications/indexing",
      params: { phase: "indexing", progress: 0.5, current: "src/a.ts" },
    })
  }, 150)
  setTimeout(() => {
    state.indexed = true
    state.progress = 1
    send(socket, {
      jsonrpc: "2.0",
      method: "notifications/indexing",
      params: { phase: "ready", progress: 1 },
    })
  }, 300)
}

const server = net.createServer((socket) => {
  socket.on("error", () => {})
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      void handle(socket, JSON.parse(line))
    }
  })
})

async function handle(socket: net.Socket, message: any) {
  switch (message.method) {
    case "ping":
      respond(socket, message.id, pingResult())
      return
    case "subscribe":
      respond(socket, message.id, { ok: true })
      scheduleIndexing(socket)
      return
    case "read_view":
      if (mode.readViewError === "indexing") {
        respondError(socket, message.id, -32000, "indexing", { progress: state.progress })
        return
      }
      if (mode.readViewError === "notfound") {
        respondError(socket, message.id, -32001, "file not found")
        return
      }
      respond(socket, message.id, SAMPLE_RESULT)
      return
    case "blast_radius":
      if (mode.blastRadiusError === "indexing") {
        respondError(socket, message.id, -32000, "indexing", { progress: state.progress })
        return
      }
      if (mode.blastRadiusError === "symbol") {
        respondError(socket, message.id, -32002, "symbol not found")
        return
      }
      respond(socket, message.id, SAMPLE_BLAST_RESULT)
      return
    case "edit_batch":
      if (mode.editBatchError === "anchor") {
        respond(socket, message.id, SAMPLE_EDIT_BATCH_FAILURE)
        return
      }
      respond(socket, message.id, SAMPLE_EDIT_BATCH_SUCCESS)
      return
    case "verify_test":
      if (mode.verifyTest === "failure") {
        respond(socket, message.id, SAMPLE_VERIFY_FAILURE)
        return
      }
      if (mode.verifyTest === "unrecognized") {
        respond(socket, message.id, SAMPLE_VERIFY_UNRECOGNIZED)
        return
      }
      respond(socket, message.id, SAMPLE_VERIFY_SUCCESS)
      return
    case "shutdown":
      respond(socket, message.id, { ok: true })
      setTimeout(() => {
        server.close()
        process.exit(0)
      }, 20)
      return
    default:
      respondError(socket, message.id, -32603, "internal error")
  }
}

server.on("error", (error) => {
  process.stderr.write(`fake-daemon: ${error.message}\n`)
  process.exit(1)
})

process.on("SIGTERM", () => process.exit(0))

server.listen(socketPath, () => {
  process.stderr.write(`fake-daemon: listening on ${socketPath}\n`)
})
