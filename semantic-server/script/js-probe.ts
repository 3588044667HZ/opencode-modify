#!/usr/bin/env bun
// JS/TS 语义工具探针（W8）：真实 IDEA/WebStorm 守护 + fixture 项目，验证 project_map（structure/
// dependencies）与 blast_radius（语法级定义/引用，不调用 TS 语言服务 resolve）。
//
// 用法：
//   SEMANTIC_IDE=idea SEMANTIC_JAR=... bun script/js-probe.ts [--jar path] [--ide-home path] [--keep]
//
// 退出码 0 = 全部通过；1 = 有失败。默认使用 .tmp/js-probe-sandbox 并在结束后清理。
import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import { connectLocator } from "./connect"

const SERVER_DIR = path.resolve(import.meta.dir, "..")
const PROJECT = path.join(SERVER_DIR, "fixtures", "js-project")
const TMP_DIR = path.join(SERVER_DIR, ".tmp")
const LOCATOR = path.join(TMP_DIR, "js.port")
const LOG = path.join(TMP_DIR, "js-probe.log")
const SANDBOX = path.join(TMP_DIR, "js-probe-sandbox")

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
  console.error(`[js-probe] jar 不存在: ${jar}（先运行 build-local.sh，或用 SEMANTIC_JAR/--jar 指定）`)
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
  SEMANTIC_IDE: process.env.SEMANTIC_IDE ?? "idea",
  SEMANTIC_SANDBOX: SANDBOX,
  ...(ideHome ? { SEMANTIC_IDE_HOME: ideHome } : {}),
}
const logFd = fs.openSync(LOG, "w")
const server = Bun.spawn(
  [java, "-Djava.awt.headless=true", "-jar", jar, PROJECT, LOCATOR, "--idle-seconds", "300"],
  { cwd: SERVER_DIR, env, stdout: logFd, stderr: logFd },
)
fs.closeSync(logFd)
console.log(`[js-probe] 守护已启动 (pid=${server.pid})，日志: ${LOG}`)

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
  console.log("[js-probe] connected")

  let ready = false
  for (let i = 0; i < 240; i++) {
    const ping = await conn.request("ping")
    if (ping?.indexing === false) {
      ready = true
      break
    }
    await sleep(500)
  }
  check("[J1] 索引 ready", ready, ready ? "ping.indexing=false" : "240 次 ping 仍未 ready")
  if (!ready) throw new Error("indexing not ready")

  let structure: any
  for (let i = 0; i < 120; i++) {
    structure = await conn.request("project_map", { view: "structure" }, 120_000)
    if (structure?.building !== true) break
    await sleep(500)
  }
  check(
    "[J2] project_map structure 完成",
    structure !== undefined && structure.building !== true,
    `modules=${structure?.modules?.length ?? 0} files=${structure?.project?.total_files ?? 0}`,
  )
  const modulePaths: string[] = (structure?.modules ?? []).map((module: any) => module.path)
  check(
    "[J3] JS/TS 目录模块",
    ["src", "lib", "tests"].every((value) => modulePaths.includes(value)),
    modulePaths.join(", "),
  )
  const rootFiles: string[] = structure?.root_files ?? []
  check(
    "[J4] 根清单文件",
    rootFiles.includes("package.json") && rootFiles.includes("tsconfig.json"),
    rootFiles.join(", "),
  )

  const entries: Array<{ file: string; symbol: string; kind: string }> = structure?.entry_points ?? []
  check(
    "[J5] package.json main 入口",
    entries.some((entry) => entry.file === "src/index.js" && entry.kind === "main" && entry.line === 1),
    entries.map((entry) => `${entry.file}:${entry.symbol}(${entry.kind})`).join(", "),
  )
  check(
    "[J6] Express 路由入口",
    entries.some(
      (entry) => entry.file === "src/app.js" && entry.symbol === "handleCalc" && entry.kind === "route",
    ),
    entries
      .filter((entry) => entry.kind === "route")
      .map((entry) => `${entry.file}:${entry.symbol}`)
      .join(", "),
  )
  check(
    "[J7] 顶层 main 函数入口",
    entries.some((entry) => entry.file === "src/index.js" && entry.symbol === "main" && entry.kind === "main"),
    entries
      .filter((entry) => entry.kind === "main")
      .map((entry) => `${entry.file}:${entry.symbol}`)
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
    "[J8] tsconfig 别名 + 相对 import 依赖（src→lib、tests→src）",
    ["src|lib", "tests|src"].every((edge) =>
      edges.some((dependency) => `${dependency.from}|${dependency.to}` === edge),
    ),
    edges.map((dependency) => `${dependency.from}→${dependency.to}`).join(", "),
  )

  const hot = await conn.request("project_map", { view: "hot" }, 60_000)
  check(
    "[J9] hot 视图保持空数组",
    Array.isArray(hot?.hot_files) && hot.hot_files.length === 0,
    `hot_files=${hot?.hot_files?.length ?? "?"}`,
  )

  const started = Date.now()
  const blast = await conn.request("blast_radius", { symbol: "add" }, 120_000)
  const elapsed = Date.now() - started
  check(
    "[J10] 定义解析到 src/core.js:2（method）",
    blast?.definition?.file === "src/core.js" &&
      blast.definition.line === 2 &&
      blast.definition.kind === "method",
    `${blast?.definition?.file}:${blast?.definition?.line} (${blast?.definition?.kind})`,
  )
  check("[J11] 查询无卡死（< 30s）", elapsed < 30_000, `elapsed=${elapsed}ms`)
  const callers: Array<{ file: string; context: string; is_test: boolean }> = blast?.callers ?? []
  check(
    "[J12] 名称级调用者（main/handleCalc/测试标记）",
    callers.some((caller) => caller.file === "src/index.js" && caller.context === "main") &&
      callers.some((caller) => caller.file === "src/app.js" && caller.context === "handleCalc") &&
      callers.some((caller) => caller.file === "tests/core.test.js" && caller.is_test === true),
    callers.map((caller) => `${caller.file}:${caller.context}${caller.is_test ? " [test]" : ""}`).join(", "),
  )
  check(
    "[J13] 受影响测试与入口点",
    (blast?.tests_affected ?? []).some((test: any) => test.file === "tests/core.test.js") &&
      (blast?.entry_points ?? []).some((entry: any) => entry.context === "main"),
    `tests=${blast?.tests_affected?.length ?? 0} entries=${blast?.entry_points?.length ?? 0}`,
  )

  const qualified = await conn.request("blast_radius", { symbol: "Calculator.add" }, 120_000)
  check(
    "[J14] 限定符号（Class.name）解析一致",
    qualified?.definition?.file === blast?.definition?.file &&
      qualified?.definition?.line === blast?.definition?.line,
    `${qualified?.definition?.file}:${qualified?.definition?.line}`,
  )

  const scoped = await conn.request(
    "blast_radius",
    { symbol: "add", scope: "file:src/index.js" },
    120_000,
  )
  check(
    "[J15] file: scope 限定引用扫描",
    (scoped?.callers ?? []).length > 0 &&
      (scoped?.callers ?? []).every((caller: any) => caller.file === "src/index.js"),
    (scoped?.callers ?? []).map((caller: any) => `${caller.file}:${caller.line}`).join(", "),
  )

  let missingCode = 0
  try {
    await conn.request("blast_radius", { symbol: "no_such_js_symbol_xyz" }, 60_000)
  } catch (error) {
    missingCode = (error as { rpc?: { code?: number } }).rpc?.code ?? 0
  }
  check("[J16] 未知符号返回 -32002", missingCode === -32002, `code=${missingCode}`)
} catch (error) {
  console.error(`[js-probe] 失败: ${(error as Error).message}`)
  check("[J0] 探针执行完成", false, (error as Error).message)
} finally {
  conn?.close()
  if (!keep) {
    Bun.spawnSync(["taskkill", "/PID", String(server.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    await sleep(500)
    fs.rmSync(LOCATOR, { force: true })
  }
}

const failed = checks.filter((entry) => !entry.ok)
console.log(`\nJS PROBE ${failed.length === 0 ? "PASS" : "FAIL"} ${checks.length - failed.length}/${checks.length}`)
for (const entry of failed) console.log(`  FAIL ${entry.name}: ${entry.detail}`)
process.exit(failed.length > 0 ? 1 : 0)
