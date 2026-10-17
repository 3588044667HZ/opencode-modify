// Minimal fake semantic daemon for tests. Implements the frozen JSON-RPC
// protocol over loopback TCP with the `hello` handshake gate.
//
// Usage: bun fake-daemon.ts [--indexing | --indexing-forever] [--read-view-error=indexing|notfound] [--read-view-reconcile=delta|full] [--blast-radius-error=indexing|symbol] [--edit-batch-error=anchor|conflict|protected|lock|mismatch|mismatch-full] [--edit-transaction-error=anchor|lock|journal|mismatch] [--verify-test=success|failure|unrecognized] [--project-map=structure|dependencies|hot] [--record-env=<file>] [--record-argv=<file>] <project_dir> <locator_path>
import net from "node:net"
import fs from "node:fs"
import { randomBytes } from "node:crypto"
import {
  SAMPLE_BLAST_RESULT,
  SAMPLE_EDIT_BATCH_FAILURE,
  SAMPLE_EDIT_BATCH_MISMATCH,
  SAMPLE_EDIT_BATCH_MISMATCH_FULL,
  SAMPLE_EDIT_BATCH_SUCCESS,
  SAMPLE_EDIT_TRANSACTION_FAILURE,
  SAMPLE_EDIT_TRANSACTION_MISMATCH,
  SAMPLE_EDIT_TRANSACTION_SUCCESS,
  SAMPLE_PROJECT_MAP_DEPENDENCIES,
  SAMPLE_PROJECT_MAP_HOT,
  SAMPLE_PROJECT_MAP_STRUCTURE,
  SAMPLE_READ_DELTA,
  SAMPLE_READ_RECONCILE_FULL,
  SAMPLE_RESULT,
  SAMPLE_VERIFY_FAILURE,
  SAMPLE_VERIFY_SUCCESS,
  SAMPLE_VERIFY_UNRECOGNIZED,
} from "./fixture"

const argv = process.argv.slice(2)
const flags = argv.filter((arg) => arg.startsWith("--"))
const positional = argv.filter((arg) => !arg.startsWith("--"))
const locatorPath = positional.at(-1) ?? ""

if (locatorPath.length === 0) {
  process.stderr.write("fake-daemon: missing locator path\n")
  process.exit(2)
}

// 与真实守护一致：token 每次启动随机 128-bit，仅写入 locator 文件。
const token = randomBytes(16).toString("hex")

const mode = {
  indexing: flags.includes("--indexing"),
  forever: flags.includes("--indexing-forever"),
  readViewError: flags.find((flag) => flag.startsWith("--read-view-error="))?.split("=")[1],
  readViewReconcile: flags.find((flag) => flag.startsWith("--read-view-reconcile="))?.split("=")[1],
  blastRadiusError: flags.find((flag) => flag.startsWith("--blast-radius-error="))?.split("=")[1],
  editBatchError: flags.find((flag) => flag.startsWith("--edit-batch-error="))?.split("=")[1],
  editTransactionError: flags.find((flag) => flag.startsWith("--edit-transaction-error="))?.split("=")[1],
  verifyTest: flags.find((flag) => flag.startsWith("--verify-test="))?.split("=")[1],
  projectMap: flags.find((flag) => flag.startsWith("--project-map="))?.split("=")[1],
}

// 先于 listen 落盘：manager 观察到可连接时文件必然已就绪。
// 记录需断言的注入环境变量；未注入的一律为空字符串。
const recordEnv = flags.find((flag) => flag.startsWith("--record-env="))?.split("=")[1]
if (recordEnv)
  fs.writeFileSync(
    recordEnv,
    JSON.stringify({
      exclude: process.env.OPENCODE_SEMANTIC_EXCLUDE ?? "",
      ide: process.env.SEMANTIC_IDE ?? "",
      ideHome: process.env.SEMANTIC_IDE_HOME ?? "",
      jdkHome: process.env.SEMANTIC_JDK_HOME ?? "",
    }),
  )
// 记录 manager 追加的位置参数（<project_dir> <locator_path>），供 spawn argv 断言。
const recordArgv = flags.find((flag) => flag.startsWith("--record-argv="))?.split("=")[1]
if (recordArgv) fs.writeFileSync(recordArgv, JSON.stringify(positional))

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

const UNAUTHORIZED = -32019

const server = net.createServer((socket) => {
  socket.on("error", () => {})
  let authed = false
  let closed = false
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line || closed) continue
      const message = JSON.parse(line)
      if (message.method === "hello") {
        // hello 幂等：重复携带正确 token 仍回 ok；错误 token 一律 -32019 并断开。
        if (message.params?.token !== token) {
          respondError(socket, message.id, UNAUTHORIZED, "unauthorized")
          socket.end()
          closed = true
          continue
        }
        authed = true
        respond(socket, message.id, { ok: true })
        continue
      }
      if (!authed) {
        // 握手门禁：hello 之前调用任何方法都 -32019，响应发出后关闭连接。
        respondError(socket, message.id, UNAUTHORIZED, "unauthorized")
        socket.end()
        closed = true
        continue
      }
      void handle(socket, message)
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
      if (mode.readViewReconcile === "delta") {
        respond(socket, message.id, SAMPLE_READ_DELTA)
        return
      }
      if (mode.readViewReconcile === "full") {
        respond(socket, message.id, SAMPLE_READ_RECONCILE_FULL)
        return
      }
      // 版本一致 → unchanged 微响应，不重发内容。
      if (message.params?.known_version === SAMPLE_RESULT.version) {
        respond(socket, message.id, { unchanged: true, version: SAMPLE_RESULT.version })
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
      if (mode.editBatchError === "mismatch") {
        respond(socket, message.id, SAMPLE_EDIT_BATCH_MISMATCH)
        return
      }
      if (mode.editBatchError === "mismatch-full") {
        respond(socket, message.id, SAMPLE_EDIT_BATCH_MISMATCH_FULL)
        return
      }
      if (mode.editBatchError === "conflict") {
        respond(socket, message.id, {
          applied: false,
          file: "engine.ts",
          changes_total: 3,
          error: {
            code: -32016,
            message: "CHANGE_CONFLICT",
            detail: { change_index: 2, conflict_with_index: 0 },
          },
        })
        return
      }
      if (mode.editBatchError === "protected") {
        respond(socket, message.id, {
          applied: false,
          file: "engine.ts",
          changes_total: 3,
          error: {
            code: -32013,
            message: "PATH_PROTECTED",
            detail: { path: "engine.ts" },
          },
        })
        return
      }
      if (mode.editBatchError === "lock") {
        // 回显请求里的 lock_timeout_ms，让工具测试能验证参数已透传到守护进程。
        respond(socket, message.id, {
          applied: false,
          file: "engine.ts",
          changes_total: Array.isArray(message.params?.changes) ? message.params.changes.length : 0,
          error: {
            code: -32017,
            message: "LOCK_TIMEOUT",
            detail: {
              file: "engine.ts",
              waited_ms: message.params?.options?.lock_timeout_ms ?? 30000,
            },
            hint: "文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本",
          },
        })
        return
      }
      respond(socket, message.id, SAMPLE_EDIT_BATCH_SUCCESS)
      return
    case "edit_transaction":
      if (mode.editTransactionError === "anchor") {
        respond(socket, message.id, SAMPLE_EDIT_TRANSACTION_FAILURE)
        return
      }
      if (mode.editTransactionError === "mismatch") {
        respond(socket, message.id, SAMPLE_EDIT_TRANSACTION_MISMATCH)
        return
      }
      if (mode.editTransactionError === "journal") {
        // -32018 是 RPC 级错误（只读门），不属于结果联合。
        respondError(socket, message.id, -32018, "JOURNAL_RECOVERY_FAILED")
        return
      }
      if (mode.editTransactionError === "lock") {
        // 回显请求里的 lock_timeout_ms，让工具测试能验证参数已透传到守护进程。
        respond(socket, message.id, {
          applied: false,
          error: {
            code: -32017,
            message: "LOCK_TIMEOUT",
            detail: {
              file: "src/core/engine.ts",
              waited_ms: message.params?.options?.lock_timeout_ms ?? 30000,
            },
            hint: "文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本",
          },
        })
        return
      }
      respond(socket, message.id, SAMPLE_EDIT_TRANSACTION_SUCCESS)
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
    case "project_map":
      respond(
        socket,
        message.id,
        mode.projectMap === "dependencies"
          ? SAMPLE_PROJECT_MAP_DEPENDENCIES
          : mode.projectMap === "hot"
            ? SAMPLE_PROJECT_MAP_HOT
            : SAMPLE_PROJECT_MAP_STRUCTURE,
      )
      return
    case "shutdown":
      respond(socket, message.id, { ok: true })
      setTimeout(() => {
        // 优雅退出删除 locator；硬杀残留由 manager 在连接失败后删除。
        fs.rmSync(locatorPath, { force: true })
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

server.listen(0, "127.0.0.1", () => {
  const address = server.address()
  if (typeof address !== "object" || address === null) {
    process.stderr.write("fake-daemon: failed to resolve listening port\n")
    process.exit(1)
  }
  // 绑定成功后才发布 locator（单行 JSON）：manager 以"locator 可读 + hello 成功"为就绪信号。
  fs.writeFileSync(locatorPath, JSON.stringify({ v: 1, port: address.port, token, pid: process.pid }) + "\n")
  process.stderr.write(`fake-daemon: listening on 127.0.0.1:${address.port}\n`)
})
