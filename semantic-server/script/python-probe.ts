#!/usr/bin/env bun
// Python 语义工具探针（W7）：真实 PyCharm 守护 + fixture 项目，验证 project_map（structure/dependencies）
// 与 blast_radius（定义/引用/分类）的 Python 路径。
//
// 前置：先构建插件 jar（build-local 或 scratch）。用法：
//   SEMANTIC_IDE=pycharm \
//   SEMANTIC_JAR=semantic-server/.tmp/semantic-server-w7.jar \
//   bun script/python-probe.ts [--jar path] [--ide-home path] [--keep]
//
// 退出码 0 = 全部通过；1 = 有失败。默认使用 .tmp/python-probe-sandbox 并在结束后清理。
import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import { connectLocator } from "./connect"

const SERVER_DIR = path.resolve(import.meta.dir, "..")
const PROJECT = path.join(SERVER_DIR, "fixtures", "python-project")
const TMP_DIR = path.join(SERVER_DIR, ".tmp")
const LOCATOR = path.join(TMP_DIR, "python.port")
const LOG = path.join(TMP_DIR, "python-probe.log")
const SANDBOX = path.join(TMP_DIR, "python-probe-sandbox")

const argv = process.argv.slice(2)
let jar = process.env.SEMANTIC_JAR ?? path.join(SERVER_DIR, "build-local", "semantic-server.jar")
let ideHome = process.env.SEMANTIC_IDE_HOME ?? ""
let keep = false
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--jar") jar = argv[++i] ?? jar
  else if (argv[i] === "--ide-home") ideHome = argv[++i] ?? ideHome
  else if (argv[i] === "--keep") keep = true
}
if (!fs.existsSync(jar)) {
  console.error(`[python-probe] jar 不存在: ${jar}（先运行 build-local.sh，或用 SEMANTIC_JAR/--jar 指定）`)
  process.exit(2)
}

const java =
  process.env.SEMANTIC_JAVA ??
  (process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java")

fs.mkdirSync(TMP_DIR, { recursive: true })
fs.rmSync(LOCATOR, { force: true })
if (!keep) fs.rmSync(SANDBOX, { recursive: true, force: true })

const env: Record<string, string | undefined> = {
  ...process.env,
  SEMANTIC_IDE: process.env.SEMANTIC_IDE ?? "pycharm",
  SEMANTIC_SANDBOX: SANDBOX,
  ...(ideHome ? { SEMANTIC_IDE_HOME: ideHome } : {}),
}
const logFd = fs.openSync(LOG, "w")
const server = Bun.spawn(
  [
    java,
    "-Djava.awt.headless=true",
    "-jar",
    jar,
    PROJECT,
    LOCATOR,
    "--idle-seconds",
    "300",
  ],
  { cwd: SERVER_DIR, env, stdout: logFd, stderr: logFd },
)
fs.closeSync(logFd)
console.log(`[python-probe] 守护已启动 (pid=${server.pid})，日志: ${LOG}`)

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

class Conn {
  private socket: net.Socket
  private buffer: string
  private pending = new Map<number, Pending>()
  private nextId = 2

  constructor(connection: { socket: net.Socket; leftover: string }) {
    this.socket = connection.socket
    this.buffer = connection.leftover
    this.socket.on("data", (chunk) => this.onData(chunk.toString("utf8")))
    this.socket.on("error", (error) => {
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
    })
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 90_000): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  close() {
    this.socket.destroy()
  }

  private onData(chunk: string) {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof message.id !== "number") continue
      const entry = this.pending.get(message.id)
      if (entry === undefined) continue
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined) {
        entry.reject(Object.assign(new Error(message.error.message ?? "rpc error"), { rpc: message.error }))
      } else {
        entry.resolve(message.result)
      }
    }
  }
}

const checks: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let conn: Conn | undefined
try {
  const connection = await connectLocator(LOCATOR, {
    deadlineMs: 240_000,
    attemptTimeoutMs: 1_000,
    retryDelayMs: 500,
  })
  conn = new Conn(connection)
  console.log("[python-probe] connected")

  let ready = false
  for (let i = 0; i < 240; i++) {
    const ping = await conn.request("ping")
    if (ping?.indexing === false) {
      ready = true
      break
    }
    await sleep(500)
  }
  check("[P1] 索引 ready", ready, ready ? "ping.indexing=false" : "240 次 ping 仍未 ready")
  if (!ready) throw new Error("indexing not ready")

  let structure: any
  for (let i = 0; i < 120; i++) {
    structure = await conn.request("project_map", { view: "structure" }, 120_000)
    if (structure?.building !== true) break
    await sleep(500)
  }
  check(
    "[P2] project_map structure 完成",
    structure !== undefined && structure.building !== true,
    `modules=${structure?.modules?.length ?? 0} files=${structure?.project?.total_files ?? 0}`,
  )
  const modulePaths: string[] = (structure?.modules ?? []).map((module: any) => module.path)
  check(
    "[P3] Python 目录模块",
    ["core", "app/views", "tests"].every((value) => modulePaths.includes(value)),
    modulePaths.slice(0, 6).join(", "),
  )
  const rootFiles: string[] = structure?.root_files ?? []
  check("[P4] 根文件列在 root_files", rootFiles.includes("main.py"), rootFiles.join(", "))

  const entries: Array<{ file: string; symbol: string; kind: string }> = structure?.entry_points ?? []
  check(
    "[P5] Flask 路由装饰器入口",
    entries.some(
      (entry) => entry.file === "app/views/routes.py" && entry.symbol === "health" && entry.kind === "route",
    ),
    entries
      .filter((entry) => entry.kind === "route")
      .map((entry) => `${entry.file}:${entry.symbol}`)
      .slice(0, 5)
      .join(", "),
  )
  check(
    "[P6] __main__ 守卫内调用的 main 入口",
    entries.some((entry) => entry.file === "main.py" && entry.symbol === "main" && entry.kind === "main"),
    entries
      .filter((entry) => entry.kind === "main")
      .map((entry) => `${entry.file}:${entry.symbol}`)
      .slice(0, 5)
      .join(", "),
  )

  let deps: any
  for (let i = 0; i < 120; i++) {
    deps = await conn.request("project_map", { view: "dependencies" }, 120_000)
    if (deps?.building !== true) break
    await sleep(500)
  }
  const edges: Array<{ from: string; to: string }> = deps?.dependencies ?? []
  check(
    "[P7] Python import 依赖（app/views→core、tests→core、app→app/views 相对导入）",
    ["app/views|core", "tests|core", "app|app/views"].every((edge) =>
      edges.some((dependency) => `${dependency.from}|${dependency.to}` === edge),
    ),
    edges
      .map((dependency) => `${dependency.from}→${dependency.to}`)
      .slice(0, 8)
      .join(", "),
  )

  const hot = await conn.request("project_map", { view: "hot" }, 60_000)
  check(
    "[P8] hot 视图保持空数组",
    Array.isArray(hot?.hot_files) && hot.hot_files.length === 0,
    `hot_files=${hot?.hot_files?.length ?? "?"}`,
  )

  const blast = await conn.request("blast_radius", { symbol: "add_user_message" }, 120_000)
  check(
    "[P9] 定义解析到 core/memory.py:72",
    blast?.definition?.file === "core/memory.py" && blast.definition.line === 9 && blast.definition.kind === "method",
    `${blast?.definition?.file}:${blast?.definition?.line} (${blast?.definition?.kind})`,
  )
  const callers: Array<{ file: string; context: string; is_test: boolean }> = blast?.callers ?? []
  check(
    "[P10] 调用者上下文（run_stream + 测试标记）",
    callers.some((caller) => caller.file === "core/loop.py" && caller.context === "run_stream") &&
      callers.some((caller) => caller.file === "tests/test_memory.py" && caller.is_test === true),
    callers.map((caller) => `${caller.file}:${caller.context}${caller.is_test ? " [test]" : ""}`).join(", "),
  )
  check(
    "[P11] callees 含 add_message",
    (blast?.callees ?? []).some(
      (callee: any) => callee.file === "core/memory.py" && callee.symbol === "add_message",
    ),
    (blast?.callees ?? []).map((callee: any) => `${callee.symbol}@${callee.file}`).join(", "),
  )
  check(
    "[P12] 受影响测试与入口点",
    (blast?.tests_affected ?? []).some((test: any) => test.file === "tests/test_memory.py") &&
      (blast?.entry_points ?? []).some((entry: any) => entry.context === "main"),
    `tests=${blast?.tests_affected?.length ?? 0} entries=${blast?.entry_points?.length ?? 0}`,
  )

  const qualified = await conn.request("blast_radius", { symbol: "MemoryManager.add_user_message" }, 120_000)
  check(
    "[P13] 限定符号（Class.method）解析一致",
    qualified?.definition?.file === blast?.definition?.file &&
      qualified?.definition?.line === blast?.definition?.line,
    `${qualified?.definition?.file}:${qualified?.definition?.line}`,
  )

  const scoped = await conn.request(
    "blast_radius",
    { symbol: "add_user_message", scope: "file:core/loop.py" },
    120_000,
  )
  check(
    "[P14] file: scope 限定引用搜索",
    (scoped?.callers ?? []).length > 0 &&
      (scoped?.callers ?? []).every((caller: any) => caller.file === "core/loop.py"),
    (scoped?.callers ?? []).map((caller: any) => `${caller.file}:${caller.line}`).join(", "),
  )

  let missingCode = 0
  try {
    await conn.request("blast_radius", { symbol: "no_such_python_symbol_xyz" }, 60_000)
  } catch (error) {
    missingCode = (error as { rpc?: { code?: number } }).rpc?.code ?? 0
  }
  check("[P15] 未知符号返回 -32002", missingCode === -32002, `code=${missingCode}`)
} catch (error) {
  console.error(`[python-probe] 失败: ${(error as Error).message}`)
  check("[P0] 探针执行完成", false, (error as Error).message)
} finally {
  conn?.close()
  if (!keep) {
    Bun.spawnSync(["taskkill", "/PID", String(server.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    await sleep(500)
    fs.rmSync(LOCATOR, { force: true })
  }
}

const failed = checks.filter((entry) => !entry.ok)
console.log(`\nPYTHON PROBE ${failed.length === 0 ? "PASS" : "FAIL"} ${checks.length - failed.length}/${checks.length}`)
for (const entry of failed) console.log(`  FAIL ${entry.name}: ${entry.detail}`)
process.exit(failed.length > 0 ? 1 : 0)
