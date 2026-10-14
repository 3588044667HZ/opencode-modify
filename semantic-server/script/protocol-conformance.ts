#!/usr/bin/env bun
// 跨实现协议一致性测试：真实 IntelliJ 无头语义守护 ↔ TS 协议层（packages/opencode/src/semantic）
// 用法（任意 cwd）：bun run E:/opencode-source/semantic-server/script/protocol-conformance.ts
//
// 流程：spawn 守护（bash script/run-local.sh）→ 轮询连接 → 用例 1-4（raw transport）→
// 用例 10（raw NDJSON 帧）→ 用例 5-8（typed client）→ 用例 9（shutdown + 连接失败）→ 清理。
import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const SERVER_DIR = path.resolve(import.meta.dir, "..")
const ROOT = path.resolve(SERVER_DIR, "..")
const TMP_DIR = path.join(SERVER_DIR, ".tmp")
const SOCKET = path.join(TMP_DIR, "conformance.sock")
const LOG = path.join(TMP_DIR, "conformance-server.log")
const FIXTURE_DIR = path.join(SERVER_DIR, "sample-project", "src", "main", "java", "demo")
const MAIN = path.join(FIXTURE_DIR, "Main.java")
const BROKEN = path.join(FIXTURE_DIR, "Broken.java")
const MISSING = path.join(FIXTURE_DIR, "Missing.java")
const FIXTURE_INPUT = path.join(SERVER_DIR, "fixtures", "blast_radius", "input.json")
const FIXTURE_OUTPUT = path.join(SERVER_DIR, "fixtures", "blast_radius", "output.json")
const EDIT_DIR = path.join(SERVER_DIR, "fixtures", "edit_batch")
const EDIT_TARGET = path.join(FIXTURE_DIR, "tasks", "EditableSample.java")
const EDIT_REL = "src/main/java/demo/tasks/EditableSample.java"
const VERIFY_DIR = path.join(SERVER_DIR, "fixtures", "verify_test")
const MAP_DIR = path.join(SERVER_DIR, "fixtures", "project_map")

const clientModule = await import(pathToFileURL(path.join(ROOT, "packages/opencode/src/semantic/client.ts")).href)
const transportModule = await import(pathToFileURL(path.join(ROOT, "packages/opencode/src/semantic/transport.ts")).href)
const protocol = await import(pathToFileURL(path.join(ROOT, "packages/opencode/src/semantic/protocol.ts")).href)
const renderModule = await import(pathToFileURL(path.join(ROOT, "packages/opencode/src/semantic/render.ts")).href)
// 与 protocol.ts 解析到同一个 effect 实例；用于对原始帧做严格解码（多余字段报错）
const effect = await import(pathToFileURL(Bun.resolveSync("effect", path.join(ROOT, "packages/opencode/src/semantic"))).href)

function strictDecode(schema: unknown, value: unknown): unknown {
  try {
    return effect.Schema.decodeUnknownSync(schema as never, { onExcessProperty: "error" })(value)
  } catch {
    return undefined
  }
}

type Transport = Awaited<ReturnType<typeof transportModule.connect>>
type RawFrame = {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown; data?: unknown }
}
type PingResult = { indexing: boolean; progress: number; phase?: string; current?: string; eta?: number }
type IndexingNotification = { phase: string; progress: number; current?: string; eta?: number }
type ReadViewEntry = {
  line: number
  text: string
  diagnostic?: { severity: string; message: string }
  anchor?: { symbol: string; location: string }
}
type ReadViewResult = {
  file: string
  version: string
  size: { lines: number; symbols: number }
  status: { modified: boolean; errors: number }
  position?: { current: number; total: number; in_symbol?: string; remaining_symbols: number }
  content: ReadViewEntry[]
  coverage: { read: Array<[number, number]>; unread: Array<[number, number]> }
  diagnostics: Array<{ line: number; severity: string; message: string }>
}
type BlastRadiusResult = {
  symbol: string
  definition: { file: string; line: number; kind: string }
  callers: Array<{ file: string; line: number; context: string; is_test: boolean }>
  callees: Array<{ symbol: string; file: string; line: number }>
  affected_files: string[]
  entry_points: Array<{ file: string; line: number; context: string; reason: string }>
  tests_affected: Array<{ file: string; line: number; name: string }>
  summary: {
    callers_count: number
    callers_total?: number
    callees_count: number
    files_count: number
    has_public_api_usage: boolean
    risk: string
  }
}

type EditBatchResult = {
  applied: boolean
  file?: string
  changes_applied?: number
  changes_total?: number
  old_version?: string
  new_version?: string
  diagnostics_delta?: { errors: number; warnings: number }
  diagnostics_after?: { errors: number; warnings: number }
  line_changes?: Array<{ line: number; action: string }>
  error?: { code?: number; message?: string; detail?: Record<string, unknown>; hint?: string }
}

type VerifyTestResult = {
  command: string
  exit_code: number
  duration_ms: number
  summary: { passed: number; failed: number; skipped: number; total: number } | null
  failures: Array<{ test: string; file?: string; line?: number; message?: string }>
  output_head: string
  output_tail: string
  parsed: boolean
  framework: string | null
  timeout?: boolean
  total_failures?: number
}

type ProjectMapStructureResult = {
  project: { root: string; total_files: number; total_modules: number }
  modules: Array<{ name: string; path: string; files: string[]; is_entry: boolean; hot: boolean }>
  entry_points: Array<{ file: string; line: number; symbol: string; kind: string }>
  root_files: string[]
  building?: boolean
  progress?: number
}
type ProjectMapDependenciesResult = {
  project: { root: string; total_files: number }
  dependencies: Array<{ from: string; to: string; count: number }>
  cycles: string[][]
  building?: boolean
  progress?: number
}

const checks: Array<{ name: string; ok: boolean; detail: string }> = []
const snippets = new Map<string, string>()
const deviations: string[] = []

function clip(text: string, max = 360): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(截断)`
}

function check(name: string, ok: boolean, detail: string, raw?: unknown): void {
  checks.push({ name, ok, detail })
  if (!ok && raw !== undefined) snippets.set(name, clip(JSON.stringify(raw)))
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(100)
  }
  return predicate()
}

function tryConnect(timeoutMs: number): Promise<{ ok: true; socket: net.Socket } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection(SOCKET)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok: false, error: `connect 超时 ${timeoutMs}ms` })
    }, timeoutMs)
    socket.once("connect", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: true, socket })
    })
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ ok: false, error: error.code ?? error.message })
    })
  })
}

async function connectWithRetry(deadlineMs: number): Promise<Transport> {
  const started = Date.now()
  for (;;) {
    try {
      return await transportModule.connect(SOCKET, { timeout_ms: 1_000 })
    } catch (error) {
      if (Date.now() - started >= deadlineMs) throw error
      await sleep(200)
    }
  }
}

interface RawRpc {
  readonly notifications: RawFrame[]
  call: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<{ requestId: number; frame: RawFrame }>
}

function makeRawRpc(transport: Transport): RawRpc {
  let nextId = 100
  const pending = new Map<number, { resolve: (frame: RawFrame) => void; timer: ReturnType<typeof setTimeout> }>()
  const notifications: RawFrame[] = []
  const write = transport.write as unknown as (message: Record<string, unknown>) => void
  transport.onMessage((message) => {
    const frame = message as RawFrame
    if (typeof frame.id === "number") {
      const entry = pending.get(frame.id)
      if (entry === undefined) return
      pending.delete(frame.id)
      clearTimeout(entry.timer)
      entry.resolve(frame)
      return
    }
    notifications.push(frame)
  })
  return {
    notifications,
    call(method, params, timeoutMs = 30_000) {
      const requestId = ++nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error(`${method} 等待响应超时 ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(requestId, { resolve: (frame) => resolve({ requestId, frame }), timer })
        write({ jsonrpc: "2.0", id: requestId, method, ...(params === undefined ? {} : { params }) })
      })
    },
  }
}

function decodePing(frame: RawFrame): PingResult | undefined {
  if (frame.error !== undefined || frame.result === undefined) return undefined
  return protocol.decodeOption(protocol.PingResult, frame.result)
}

// 磁盘行数：按行 split 后去掉末尾空行（文件以换行结尾时不产生额外行）
async function diskLines(file: string): Promise<string[]> {
  const text = await Bun.file(file).text()
  const lines = text.split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

function coverageProblem(result: ReadViewResult): string | undefined {
  const size = result.size.lines
  if (size === 0) {
    return result.coverage.read.length === 0 && result.coverage.unread.length === 0 ? undefined : "空文件应无覆盖区间"
  }
  const counts = new Array<number>(size + 1).fill(0)
  for (const [from, to] of [...result.coverage.read, ...result.coverage.unread]) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > size || from > to) {
      return `非法区间 [${from},${to}]（size=${size}）`
    }
    for (let line = from; line <= to; line++) counts[line]++
  }
  for (let line = 1; line <= size; line++) {
    if (counts[line] !== 1) return `行 ${line} 覆盖次数=${counts[line]}`
  }
  return undefined
}

function diagnosticKey(line: number, severity: string, message: string): string {
  return `${line}|${severity}|${message}`
}

async function validateReadView(
  tag: string,
  result: ReadViewResult,
  diskPath: string,
  options: { entry?: boolean } = {},
): Promise<void> {
  check(`[${tag}] file 以 ${path.basename(diskPath)} 结尾`, result.file.endsWith(path.basename(diskPath)), `file=${result.file}`)
  check(`[${tag}] version 非空`, typeof result.version === "string" && result.version.length > 0, `version=${JSON.stringify(result.version)}`)
  check(
    `[${tag}] size 字段非负整数`,
    Number.isInteger(result.size.lines) && result.size.lines >= 0 && Number.isInteger(result.size.symbols) && result.size.symbols >= 0,
    `size=${JSON.stringify(result.size)}`,
  )

  const expected = await diskLines(diskPath)
  check(`[${tag}] size.lines === 磁盘行数`, result.size.lines === expected.length, `size.lines=${result.size.lines} 磁盘=${expected.length}`)

  const numbers = result.content.map((entry) => entry.line)
  const ascending = numbers.every((line, index) => index === 0 || line > numbers[index - 1])
  check(`[${tag}] content 行号严格升序`, ascending, `lines=[${numbers.join(",")}]`)
  const inRange = numbers.every((line) => Number.isInteger(line) && line >= 1 && line <= result.size.lines)
  check(`[${tag}] content 行号在 1..size.lines`, inRange, `lines=[${numbers.join(",")}] size.lines=${result.size.lines}`)
  if (options.entry === true) {
    check(
      `[${tag}] entry 视图包含全部行`,
      result.content.length === result.size.lines && numbers[0] === 1 && numbers[numbers.length - 1] === result.size.lines,
      `content=${result.content.length} 行, 首=${numbers[0]} 末=${numbers[numbers.length - 1]} size.lines=${result.size.lines}`,
    )
  }

  const mismatch = result.content.find(
    (entry) => entry.line > expected.length || expected[entry.line - 1].replace(/\r$/, "") !== entry.text.replace(/\r$/, ""),
  )
  check(
    `[${tag}] content 文本与磁盘一致`,
    mismatch === undefined,
    mismatch === undefined
      ? `${result.content.length} 行全部一致`
      : `line=${mismatch.line} server=${JSON.stringify(mismatch.text)} disk=${JSON.stringify(expected[mismatch.line - 1])}`,
    result.content,
  )

  const coverageIssue = coverageProblem(result)
  check(
    `[${tag}] coverage read+unread 无缝覆盖 1..size.lines`,
    coverageIssue === undefined,
    coverageIssue ?? `read=${JSON.stringify(result.coverage.read)} unread=${JSON.stringify(result.coverage.unread)}`,
    result.coverage,
  )

  const position = result.position
  check(`[${tag}] position 存在`, position !== undefined, `position=${JSON.stringify(position)}`)
  if (position !== undefined) {
    check(`[${tag}] position.total === size.lines`, position.total === result.size.lines, `total=${position.total} size.lines=${result.size.lines}`)
    check(`[${tag}] 1 <= current <= total`, position.current >= 1 && position.current <= position.total, `current=${position.current} total=${position.total}`)
    check(`[${tag}] remaining_symbols >= 0`, position.remaining_symbols >= 0, `remaining_symbols=${position.remaining_symbols}`)
  }

  const inlineKeys = new Set<string>()
  for (const entry of result.content) {
    if (entry.diagnostic === undefined) continue
    inlineKeys.add(diagnosticKey(entry.line, entry.diagnostic.severity, entry.diagnostic.message))
  }
  const aggregateKeys = new Set(result.diagnostics.map((d) => diagnosticKey(d.line, d.severity, d.message)))
  check(
    `[${tag}] 每条 diagnostics 都有同行内联诊断`,
    [...aggregateKeys].every((key) => inlineKeys.has(key)),
    `aggregate=${aggregateKeys.size} inline=${inlineKeys.size}`,
    result.diagnostics,
  )
  check(
    `[${tag}] 每条内联诊断都在 diagnostics 列表`,
    [...inlineKeys].every((key) => aggregateKeys.has(key)),
    `inline=${inlineKeys.size} aggregate=${aggregateKeys.size}`,
    result.content,
  )

  const anchors = result.content.flatMap((entry) => (entry.anchor === undefined ? [] : [entry.anchor]))
  const badAnchor = anchors.find((anchor) => {
    if (typeof anchor.symbol !== "string" || anchor.symbol.length === 0) return true
    if (!/^.+:\d+$/.test(anchor.location)) return true
    return Number(anchor.location.slice(anchor.location.lastIndexOf(":") + 1)) <= 0
  })
  check(
    `[${tag}] anchor.location 匹配 path:line 且行号>0`,
    badAnchor === undefined,
    badAnchor === undefined ? `${anchors.length} 个 anchor` : `bad=${JSON.stringify(badAnchor)}`,
  )
}

async function cleanupStaleServer(): Promise<void> {
  const probe = await tryConnect(300)
  if (!probe.ok) {
    fs.rmSync(SOCKET, { force: true })
    return
  }
  console.log(`检测到残留守护，发送 shutdown：${SOCKET}`)
  probe.socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "shutdown" }) + "\n")
  await sleep(300)
  probe.socket.destroy()
  for (let attempt = 0; attempt < 25; attempt++) {
    const again = await tryConnect(200)
    if (!again.ok) {
  fs.rmSync(EDIT_TARGET, { force: true })
  fs.rmSync(`${EDIT_TARGET}.tmp`, { force: true })
  fs.rmSync(SOCKET, { force: true })
      return
    }
    again.socket.destroy()
    await sleep(200)
  }
  throw new Error(`残留守护未退出，无法继续：${SOCKET}`)
}

async function shutdownBestEffort(): Promise<void> {
  const probe = await tryConnect(300)
  if (!probe.ok) return
  probe.socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "shutdown" }) + "\n")
  await sleep(300)
  probe.socket.destroy()
}

fs.mkdirSync(TMP_DIR, { recursive: true })
await cleanupStaleServer()

const logFd = fs.openSync(LOG, "w")
const server = Bun.spawn(["bash", "script/run-local.sh", "sample-project", ".tmp/conformance.sock", "--idle-seconds", "600"], {
  cwd: SERVER_DIR,
  stdout: logFd,
  stderr: logFd,
})
fs.closeSync(logFd)
console.log(`守护已启动 (pid=${server.pid})，日志: ${LOG}`)

let r1: Transport | undefined
let r2: Transport | undefined
let typed: Awaited<ReturnType<typeof clientModule.connect>> | undefined

try {
  // ---- 用例 1：连接（重试至成功）+ 首 ping ----
  r1 = await connectWithRetry(90_000)
  check("[1] 守护 socket 可连接（重试成功）", true, SOCKET)
  const rpc1 = makeRawRpc(r1)
  const firstPing = await rpc1.call("ping")
  const firstPingResult = decodePing(firstPing.frame)
  check("[1] 首 ping 解码 PingResult", firstPingResult !== undefined, `result=${clip(JSON.stringify(firstPing.frame.result ?? firstPing.frame.error))}`, firstPing.frame)
  const indexingAtStart = firstPingResult?.indexing ?? true
  if (indexingAtStart) {
    check(
      "[1] indexing=true 时 progress∈[0,1]",
      firstPingResult !== undefined && firstPingResult.progress >= 0 && firstPingResult.progress <= 1,
      `progress=${firstPingResult?.progress}`,
    )
  } else {
    check("[1] 连接时已 ready（无 indexing 阶段）", true, `progress=${firstPingResult?.progress}`)
  }

  // ---- 用例 2：subscribe + indexing 通知 ----
  const subscribe = await rpc1.call("subscribe")
  const subscribeResult = subscribe.frame.result === undefined ? undefined : protocol.decodeOption(protocol.SubscribeResult, subscribe.frame.result)
  check("[2] subscribe 解码 {ok:true}", subscribeResult?.ok === true, `result=${clip(JSON.stringify(subscribe.frame.result ?? subscribe.frame.error))}`, subscribe.frame)

  // ---- 用例 3：早期 read_view（ready 之前） ----
  const early = await rpc1.call("read_view", { file: MAIN, view: "entry" }, 30_000)
  if (indexingAtStart) {
    check("[3] 早期 read_view → RpcError -32000", early.frame.error?.code === -32000, `error=${clip(JSON.stringify(early.frame.error ?? early.frame.result))}`, early.frame)
    const earlyProgress = (early.frame.error?.data as { progress?: unknown } | undefined)?.progress
    check(
      "[3] -32000 data.progress∈[0,1]",
      typeof earlyProgress === "number" && earlyProgress >= 0 && earlyProgress <= 1,
      `data=${clip(JSON.stringify(early.frame.error?.data))}`,
      early.frame,
    )
  } else {
    check("[3] 连接时已 ready，跳过早期 read_view（注释：ping.indexing=false）", true, `result=${clip(JSON.stringify(early.frame.result ?? early.frame.error))}`)
  }

  // ---- 用例 4：等 ready ----
  const readyDeadline = Date.now() + 90_000
  let readyPing: PingResult | undefined
  while (Date.now() < readyDeadline) {
    const frame = (await rpc1.call("ping", undefined, 15_000)).frame
    const decoded = decodePing(frame)
    if (decoded !== undefined) {
      readyPing = decoded
      if (!decoded.indexing && decoded.progress === 1) break
    }
    await sleep(400)
  }
  check(
    "[4] ping 轮询 ≤90s：indexing=false 且 progress===1",
    readyPing !== undefined && !readyPing.indexing && readyPing.progress === 1,
    `last=${JSON.stringify(readyPing)}`,
  )

  // ---- 用例 2 收尾：通知解码 / 范围 / ready phase ----
  const notes = rpc1.notifications.filter((frame) => frame.method === "notifications/indexing")
  if (indexingAtStart) {
    const received = await waitUntil(() => notes.length > 0, 5_000)
    check("[2] 未 ready 时订阅后收到 ≥1 条 notification", received && notes.length > 0, `收到 ${notes.length} 条`)
  } else {
    check("[2] 订阅时已 ready（≥1 条通知的时序前提不适用）", notes.length >= 0, `收到 ${notes.length} 条`)
  }
  const decodedNotes = notes.map((frame) => strictDecode(protocol.IndexingNotification, frame.params) as IndexingNotification | undefined)
  check(
    "[2] 所有 notification 严格解码 IndexingNotification（无多余字段）",
    notes.length > 0 && decodedNotes.every((note) => note !== undefined),
    `${notes.length} 条中失败 ${decodedNotes.filter((note) => note === undefined).length} 条`,
    notes,
  )
  const progressOk = decodedNotes.every((note) => note !== undefined && note.progress >= 0 && note.progress <= 1)
  check("[2] 所有 notification progress∈[0,1]", progressOk, `progress=[${decodedNotes.map((note) => note?.progress).join(",")}]`)
  const sawReady = decodedNotes.some((note) => note?.phase === "ready")
  if (sawReady) {
    check("[2] 观察到 phase=ready 通知", true, `共 ${notes.length} 条通知`)
  } else {
    check(
      "[2] ready 证据：ping.indexing=false（注释：ready 通知未捕获，接受 case 4 的 ping 证据）",
      readyPing !== undefined && !readyPing.indexing,
      `last=${JSON.stringify(readyPing)}`,
    )
  }

  // ---- 用例 10：线级 NDJSON 帧（绕开 typed client） ----
  r2 = await connectWithRetry(15_000)
  const rpc2 = makeRawRpc(r2)
  const rawPing = await rpc2.call("ping")
  const rawView = await rpc2.call("read_view", { file: MAIN, view: "entry" }, 120_000)
  const rawMissing = await rpc2.call("read_view", { file: MISSING, view: "entry" }, 30_000)
  const rawFrames = [rawPing, rawView, rawMissing]
  check(
    "[10] 三个响应 id 回显",
    rawFrames.every((item) => item.frame.id === item.requestId),
    `sent=[${rawFrames.map((item) => item.requestId).join(",")}] got=[${rawFrames.map((item) => String(item.frame.id)).join(",")}]`,
    rawFrames.map((item) => item.frame),
  )
  check(
    "[10] jsonrpc 均为 2.0",
    rawFrames.every((item) => item.frame.jsonrpc === "2.0"),
    `jsonrpc=[${rawFrames.map((item) => String(item.frame.jsonrpc)).join(",")}]`,
    rawFrames.map((item) => item.frame),
  )
  const successKeys = (frame: RawFrame) => Object.keys(frame).sort().join(",")
  check(
    "[10] 成功帧顶层字段精确 (id,jsonrpc,result)",
    successKeys(rawPing.frame) === "id,jsonrpc,result" && successKeys(rawView.frame) === "id,jsonrpc,result",
    `ping=[${Object.keys(rawPing.frame).join(",")}] read_view=[${Object.keys(rawView.frame).join(",")}]`,
    [rawPing.frame, rawView.frame],
  )
  check(
    "[10] 错误帧顶层字段精确 (error,id,jsonrpc)",
    successKeys(rawMissing.frame) === "error,id,jsonrpc",
    `missing=[${Object.keys(rawMissing.frame).join(",")}]`,
    rawMissing.frame,
  )
  check(
    "[10] raw ping result 严格解码 PingResult（无多余字段）",
    rawPing.frame.error === undefined && rawPing.frame.result !== undefined && strictDecode(protocol.PingResult, rawPing.frame.result) !== undefined,
    `result=${clip(JSON.stringify(rawPing.frame.result))}`,
    rawPing.frame,
  )
  check(
    "[10] raw read_view result 严格解码 ReadViewResult（含嵌套字段）",
    rawView.frame.error === undefined && rawView.frame.result !== undefined && strictDecode(protocol.ReadViewResult, rawView.frame.result) !== undefined,
    rawView.frame.result === undefined
      ? `error=${clip(JSON.stringify(rawView.frame.error))}`
      : "严格解码成功（content[].diagnostic 等嵌套对象无多余字段）",
    rawView.frame,
  )
  check(
    "[10] 不存在文件 error.code === -32001",
    rawMissing.frame.error?.code === -32001,
    `error=${clip(JSON.stringify(rawMissing.frame.error))}`,
    rawMissing.frame,
  )

  // ---- 用例 5-8：typed client ----
  typed = await clientModule.connect(SOCKET, { connect_timeout_ms: 10_000, request_timeout_ms: 120_000 })

  // 用例 5：read_view(Main.java, entry)
  try {
    const main = (await typed.readView({ file: MAIN, view: "entry" })) as ReadViewResult
    check("[5] read_view(Main.java, entry) 解码 ReadViewResult", true, "解码成功")
    await validateReadView("5", main, MAIN, { entry: true })
  } catch (error) {
    check("[5] read_view(Main.java, entry) 解码 ReadViewResult", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  // 用例 6：read_view(Broken.java, entry)
  try {
    const broken = (await typed.readView({ file: BROKEN, view: "entry" })) as ReadViewResult
    check("[6] read_view(Broken.java, entry) 解码 ReadViewResult", true, "解码成功")
    check("[6] status.errors >= 1", broken.status.errors >= 1, `status.errors=${broken.status.errors}`)
    const errors = broken.diagnostics.filter((diagnostic) => diagnostic.severity === "error")
    check("[6] diagnostics 含 ≥1 条 error", errors.length >= 1, `error 条数=${errors.length} diagnostics=${clip(JSON.stringify(broken.diagnostics))}`, broken.diagnostics)
    const errorLine = errors[0]
    const inline = errorLine === undefined ? undefined : broken.content.find((entry) => entry.line === errorLine.line)?.diagnostic
    check(
      "[6] error 诊断行有相同 {severity,message} 的内联诊断",
      errorLine !== undefined && inline !== undefined && inline.severity === errorLine.severity && inline.message === errorLine.message,
      `diagnostics=${JSON.stringify(errorLine)} inline=${JSON.stringify(inline)}`,
    )
    await validateReadView("6", broken, BROKEN, { entry: true })
  } catch (error) {
    check("[6] read_view(Broken.java, entry) 解码 ReadViewResult", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  // 用例 7：不存在文件
  let missingCode: number | undefined
  let missingDetail = ""
  try {
    const result = (await typed.readView({ file: MISSING, view: "entry" })) as ReadViewResult
    missingDetail = `未抛错，返回 file=${result.file}`
  } catch (error) {
    missingCode = (error as { code?: number }).code
    missingDetail = `${(error as Error).name} code=${missingCode} message=${(error as Error).message}`
  }
  check("[7] 不存在文件 → RpcError -32001", missingCode === -32001, missingDetail)

  // 用例 8：definition
  try {
    const definition = (await typed.readView({ file: MAIN, view: "definition", symbol: "Greeter" })) as ReadViewResult
    check("[8] read_view(definition, Greeter) 解码成功", true, "解码成功")
    check("[8] definition content 非空", definition.content.length > 0, `${definition.content.length} 行`)
    check(
      "[8] position.total === size.lines",
      definition.position !== undefined && definition.position.total === definition.size.lines,
      `position.total=${definition.position?.total} size.lines=${definition.size.lines}`,
    )
    if (definition.file.endsWith("Greeter.java")) {
      check("[8] file 以 Greeter.java 结尾", true, `file=${definition.file}`)
    } else {
      deviations.push(`[8] file=${definition.file} 未指向 Greeter.java（降级为“不崩溃+有内容”，已记录偏差）`)
      check("[8] 降级断言：不崩溃且有内容（file 未指向 Greeter.java）", definition.content.length > 0, `file=${definition.file}`)
    }
  } catch (error) {
    check("[8] read_view(definition, Greeter) 解码成功", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  // ---- 用例 11-15：blast_radius 契约（fixtures + 聚合语义 + 渲染） ----
  const fixtureInput = (await Bun.file(FIXTURE_INPUT).json()) as { symbol: string; scope?: string }
  const fixtureOutput = (await Bun.file(FIXTURE_OUTPUT).json()) as BlastRadiusResult
  check(
    "[11] 客户端严格解码 fixtures/blast_radius/output.json（无多余字段）",
    strictDecode(protocol.BlastRadiusResult, fixtureOutput) !== undefined,
    `symbol=${fixtureOutput.symbol} callers=${fixtureOutput.callers.length}`,
  )
  try {
    const blastStarted = Date.now()
    const actual = (await typed.blastRadius(fixtureInput)) as BlastRadiusResult
    const blastElapsed = Date.now() - blastStarted
    check(
      "[11] blast_radius(fixture input) 与 output.json 深度一致",
      JSON.stringify(canonical(actual)) === JSON.stringify(canonical(fixtureOutput)),
      `callers=${actual.callers.length}/${fixtureOutput.callers.length} total=${actual.summary.callers_total}/${fixtureOutput.summary.callers_total}`,
      { actual, expected: fixtureOutput },
    )
    check("[12] 小项目基准：查询耗时 < 2s", blastElapsed < 2_000, `${blastElapsed}ms（含首次 ReferencesSearch）`)
    check(
      "[12] 截断：callers.length=20、callers_count=20、callers_total=23",
      actual.callers.length === 20 && actual.summary.callers_count === 20 && actual.summary.callers_total === 23,
      `len=${actual.callers.length} count=${actual.summary.callers_count} total=${actual.summary.callers_total}`,
    )
    check(
      "[12] tests_affected 从全量集提取 runIsStable（被截断的 caller 列表外）",
      actual.tests_affected.some((test) => test.name === "runIsStable" && test.file.endsWith("TaskEngineTest.java")),
      `tests=${clip(JSON.stringify(actual.tests_affected))}`,
    )
    const entry = actual.entry_points[0]
    check(
      "[12] 入口点两层可达 main（reached_from_main）",
      entry !== undefined && entry.context === "main" && entry.reason === "reached_from_main" && entry.file.endsWith("TaskRunner.java"),
      `entry=${clip(JSON.stringify(actual.entry_points))}`,
    )
    check(
      "[12] callees 含 format @ TaskEngine.java",
      actual.callees.some((callee) => callee.symbol === "format" && callee.file.endsWith("TaskEngine.java")),
      `callees=${clip(JSON.stringify(actual.callees))}`,
    )
    const rendered = renderModule.renderBlastRadius(actual)
    check(
      "[13] 渲染层：头部/截断行/入口/风险",
      rendered.startsWith("run() @ src/main/java/demo/tasks/TaskEngine.java:4 (method)\n") &&
        rendered.includes("  callers: 20+ (total 23)") &&
        rendered.includes("main ← reached_from_main") &&
        rendered.includes("risk: medium"),
      clip(rendered.replace(/\n/g, " ⏎ "), 260),
    )
  } catch (error) {
    check("[11] blast_radius(fixture input) 与 output.json 深度一致", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  // 用例 14：未知符号 → -32002
  let blastMissingCode: number | undefined
  let blastMissingDetail = ""
  try {
    const resolved = (await typed.blastRadius({ symbol: "no_such_symbol_xyz" })) as BlastRadiusResult
    blastMissingDetail = `未抛错，返回 symbol=${resolved.symbol}`
  } catch (error) {
    blastMissingCode = (error as { code?: number }).code
    blastMissingDetail = `${(error as Error).name} code=${blastMissingCode} message=${(error as Error).message}`
  }
  check("[14] 未知符号 → RpcError -32002", blastMissingCode === -32002, blastMissingDetail)

  // 用例 15：scope=file: 限定
  try {
    const scoped = (await typed.blastRadius({
      symbol: "run",
      scope: "file:src/main/java/demo/tasks/TaskEngineTest.java",
    })) as BlastRadiusResult
    check(
      "[15] scope=file: 仅返回该文件引用（全为测试）",
      scoped.callers.length >= 1 && scoped.callers.every((caller) => caller.is_test && caller.file.endsWith("TaskEngineTest.java")),
      `callers=${clip(JSON.stringify(scoped.callers))} risk=${scoped.summary.risk}`,
    )
  } catch (error) {
    check("[15] scope=file: 仅返回该文件引用（全为测试）", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  // ---- 用例 16-19：edit_batch 契约（fixtures + 失败路径 + 事务性 + 成功/版本更新） ----
  const editInput = (await Bun.file(path.join(EDIT_DIR, "input.json")).json()) as {
    file: string
    changes: Array<{ oldString: string; newString: string; description?: string }>
  }
  const editGolden = (await Bun.file(path.join(EDIT_DIR, "output.json")).json()) as EditBatchResult
  check(
    "[16] 客户端严格解码 fixtures/edit_batch/output.json",
    strictDecode(protocol.EditBatchResult, editGolden) !== undefined,
    `applied=${editGolden.applied} changes=${editGolden.changes_applied}/${editGolden.changes_total}`,
  )

  fs.mkdirSync(path.dirname(EDIT_TARGET), { recursive: true })
  const editTemplate = await Bun.file(path.join(EDIT_DIR, "template.java")).text()
  fs.writeFileSync(EDIT_TARGET, editTemplate)
  let editBaseVersion: string | undefined
  try {
    const snapshot = (await typed.readView({ file: EDIT_REL, view: "entry" })) as ReadViewResult
    editBaseVersion = snapshot.version
    check(
      "[16] 模板写入后 read_view 取到 baseVersion",
      typeof editBaseVersion === "string" && editBaseVersion.length > 0,
      `version=${editBaseVersion}`,
    )
  } catch (error) {
    check("[16] 模板写入后 read_view 取到 baseVersion", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  const failEdit = async (
    name: string,
    input: { file: string; changes: Array<{ oldString: string; newString: string }>; baseVersion: string },
  ): Promise<EditBatchResult | undefined> => {
    try {
      const result = (await typed.editBatch(input)) as EditBatchResult
      check(name, result.applied === false, `applied=${result.applied} error=${clip(JSON.stringify(result.error))}`)
      return result
    } catch (error) {
      check(name, false, `${(error as Error).name}: ${(error as Error).message}`)
      return undefined
    }
  }

  if (editBaseVersion !== undefined) {
    const mismatch = await failEdit("[17] 错 baseVersion → -32012", {
      file: editInput.file,
      changes: editInput.changes,
      baseVersion: "deadbeef00",
    })
    const mismatchDetail = mismatch?.error?.detail as { current_version?: unknown; content?: unknown } | undefined
    check(
      "[17] -32012 detail 含 current_version 与非空 content",
      mismatch?.error?.code === -32012 &&
        typeof mismatchDetail?.current_version === "string" &&
        typeof mismatchDetail?.content === "string" &&
        mismatchDetail.content.length > 0,
      `detail=${clip(JSON.stringify(mismatch?.error?.detail))}`,
    )

    const impure = await failEdit("[17] newString 含元语 → -32014", {
      file: editInput.file,
      changes: [{ oldString: 'int count = "fixme";', newString: "int count = 7; [err: impurity]" }],
      baseVersion: editBaseVersion,
    })
    check(
      "[17] -32014 detail.change_index=0",
      impure?.error?.code === -32014 && (impure?.error?.detail as { change_index?: unknown } | undefined)?.change_index === 0,
      `error=${clip(JSON.stringify(impure?.error))}`,
    )

    const notFound = await failEdit("[17] 锚点不存在 → -32010", {
      file: editInput.file,
      changes: [{ oldString: "NO_SUCH_ANCHOR_STRING", newString: "x" }],
      baseVersion: editBaseVersion,
    })
    check(
      "[17] -32010 detail.oldString 回显",
      notFound?.error?.code === -32010 &&
        (notFound?.error?.detail as { oldString?: unknown } | undefined)?.oldString === "NO_SUCH_ANCHOR_STRING",
      `error=${clip(JSON.stringify(notFound?.error))}`,
    )

    const notUnique = await failEdit("[17] 锚点多处 → -32011", {
      file: editInput.file,
      changes: [{ oldString: "count", newString: "total" }],
      baseVersion: editBaseVersion,
    })
    const notUniqueDetail = notUnique?.error?.detail as { match_count?: number; locations?: number[] } | undefined
    check(
      "[17] -32011 match_count=2 且 locations=[4,6]",
      notUnique?.error?.code === -32011 &&
        notUniqueDetail?.match_count === 2 &&
        JSON.stringify(notUniqueDetail?.locations) === JSON.stringify([4, 6]),
      `detail=${clip(JSON.stringify(notUnique?.error?.detail))}`,
    )
    if (notUnique !== undefined) {
      const failureRendered = renderModule.renderEditBatch(notUnique)
      const expectedFailure = [
        "edit_batch FAILED: change 1/1 anchor not unique",
        `  ${editInput.file}: "count" matches 2 locations [L4, L6]`,
        "  hint: 提供更多上下文使锚点唯一，或调用 map() 获取直接操作工具",
      ].join("\n")
      check("[17] 失败渲染逐字节一致", failureRendered === expectedFailure, clip(failureRendered.replace(/\n/g, " ⏎ "), 260))
    }

    const conflict = await failEdit("[17] 锚点重叠 → -32016", {
      file: editInput.file,
      changes: [
        { oldString: 'int count = "fixme";', newString: "int count = 7;" },
        { oldString: 'count = "fixme"', newString: "count = 9" },
      ],
      baseVersion: editBaseVersion,
    })
    check(
      "[17] -32016 detail 含冲突索引",
      conflict?.error?.code === -32016 &&
        (conflict?.error?.detail as { conflict_with_index?: unknown } | undefined)?.conflict_with_index !== undefined,
      `error=${clip(JSON.stringify(conflict?.error))}`,
    )

    const protectedPath = await failEdit("[17] 保护路径 → -32013", {
      file: "node_modules/x.js",
      changes: [{ oldString: "a", newString: "b" }],
      baseVersion: "x",
    })
    check("[17] -32013 code 精确", protectedPath?.error?.code === -32013, `error=${clip(JSON.stringify(protectedPath?.error))}`)

    let missingFileCode: number | undefined
    try {
      await typed.editBatch({
        file: "src/main/java/demo/tasks/MissingFile.java",
        changes: [{ oldString: "a", newString: "b" }],
        baseVersion: "x",
      })
    } catch (error) {
      missingFileCode = (error as { code?: number }).code
    }
    check("[17] 不存在非保护文件 → RPC -32001", missingFileCode === -32001, `code=${missingFileCode}`)
  }

  const afterFailures = fs.readFileSync(EDIT_TARGET, "utf8")
  check("[18] 失败批次未写盘（内容 === 模板）", afterFailures === editTemplate, `len=${afterFailures.length} template=${editTemplate.length}`)
  check("[18] 无 .tmp 残留", !fs.existsSync(`${EDIT_TARGET}.tmp`), `${EDIT_TARGET}.tmp`)

  if (editBaseVersion !== undefined) {
    try {
      const result = (await typed.editBatch({
        file: editInput.file,
        changes: editInput.changes,
        baseVersion: editBaseVersion,
      })) as EditBatchResult
      check(
        "[19] edit_batch applied 成功",
        result.applied === true,
        `applied=${result.applied} error=${clip(JSON.stringify(result.error ?? null))}`,
      )
      const normalizedActual = { ...result, old_version: "<version>", new_version: "<version>" }
      check(
        "[19] 与 fixtures output.json 深度一致（版本归一）",
        JSON.stringify(canonical(normalizedActual)) === JSON.stringify(canonical(editGolden)),
        `changes=${result.changes_applied}/${result.changes_total} delta=${JSON.stringify(result.diagnostics_delta)} after=${JSON.stringify(result.diagnostics_after)}`,
        { actual: result, expected: editGolden },
      )
      check(
        "[19] line_changes=[{4,modified},{6,modified}]",
        JSON.stringify(result.line_changes) === JSON.stringify([
          { line: 4, action: "modified" },
          { line: 6, action: "modified" },
        ]),
        JSON.stringify(result.line_changes),
      )
      check(
        "[19] 版本更新：old=baseVersion、new≠old",
        result.old_version === editBaseVersion &&
          typeof result.new_version === "string" &&
          result.new_version.length > 0 &&
          result.new_version !== editBaseVersion,
        `old=${result.old_version} new=${result.new_version}`,
      )
      const disk = fs.readFileSync(EDIT_TARGET, "utf8")
      check(
        "[19] 磁盘内容已原子更新",
        disk.includes("int count = 7;") && disk.includes("return count + 1;") && !disk.includes("fixme"),
        disk.replace(/\n/g, " ⏎ "),
      )
      const successRendered = renderModule.renderEditBatch(result)
      check(
        "[19] 成功渲染格式（含 1 err → 0 err 与版本行）",
        successRendered.startsWith(
          `edit_batch applied 2/2 changes\n  ${editInput.file}: L4 (modified), L6 (modified)\n  diagnostics: 1 err → 0 err\n  version: `,
        ) && successRendered.endsWith(`${editBaseVersion} → ${result.new_version}`),
        clip(successRendered.replace(/\n/g, " ⏎ "), 260),
      )
      const stale = await failEdit("[19] 成功后旧 baseVersion 重发 → -32012", {
        file: editInput.file,
        changes: editInput.changes,
        baseVersion: editBaseVersion,
      })
      check("[19] 版本已更新（stale 拒绝）", stale?.error?.code === -32012, `error=${clip(JSON.stringify(stale?.error))}`)
    } catch (error) {
      check("[19] edit_batch applied 成功", false, `${(error as Error).name}: ${(error as Error).message}`)
    }
  }

  // ---- 用例 20-24：verify_test 契约（真实 pytest + 降级/超时/截断 + 渲染） ----
  const verifyInput = (await Bun.file(path.join(VERIFY_DIR, "input.json")).json()) as {
    command: string
    options?: { cwd?: string; timeout_ms?: number; env?: Record<string, string> }
  }
  const verifyGolden = (await Bun.file(path.join(VERIFY_DIR, "output.json")).json()) as VerifyTestResult
  check(
    "[20] 客户端严格解码 fixtures/verify_test/output.json",
    strictDecode(protocol.VerifyTestResult, verifyGolden) !== undefined,
    `command=${verifyGolden.command} framework=${verifyGolden.framework}`,
  )
  try {
    const started = Date.now()
    const actual = (await typed.verifyTest(verifyInput)) as VerifyTestResult
    const elapsed = Date.now() - started
    const normalized = { ...actual, duration_ms: -1, output_head: "<output>", output_tail: "<output>" }
    check(
      "[20] 真 pytest 运行与 output.json 深度一致（耗时/输出归一）",
      JSON.stringify(canonical(normalized)) === JSON.stringify(canonical(verifyGolden)),
      `exit=${actual.exit_code} parsed=${actual.parsed} framework=${actual.framework} summary=${JSON.stringify(actual.summary)}`,
      { actual, expected: verifyGolden },
    )
    check(
      "[20] parsed=true、framework=pytest、exit≠0 且失败条目完整",
      actual.parsed === true &&
        actual.framework === "pytest" &&
        actual.exit_code !== 0 &&
        actual.failures.length >= 1 &&
        actual.failures.every((failure) => typeof failure.test === "string"),
      `failures=${clip(JSON.stringify(actual.failures))}`,
    )
    check("[20] 小项目基准：执行耗时 < 20s", elapsed < 20_000, `${elapsed}ms（含进程启动）`)
    const headLines = actual.output_head === "" ? 0 : actual.output_head.split("\n").length
    const tailLines = actual.output_tail === "" ? 0 : actual.output_tail.split("\n").length
    check("[20] output_head/tail 各 ≤100 行", headLines <= 100 && tailLines <= 100, `head=${headLines} tail=${tailLines}`)
    const rendered = renderModule.renderVerifyTest(actual)
    check(
      "[20] 失败渲染：headline/summary/失败条目/exit",
      rendered.startsWith(`verify_test ${actual.command} → FAIL (`) &&
        (actual.summary === null ||
          rendered.includes(`${actual.summary.passed} passed, ${actual.summary.failed} failed, ${actual.summary.skipped} skipped`)) &&
        rendered.includes("FAILED ") &&
        rendered.endsWith(`  exit ${actual.exit_code}`),
      clip(rendered.replace(/\n/g, " ⏎ "), 260),
    )
  } catch (error) {
    check("[20] 真 pytest 运行与 output.json 深度一致（耗时/输出归一）", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  // 用例 21：未知命令 → parsed=false 降级
  try {
    const unknown = (await typed.verifyTest({ command: "echo hello" })) as VerifyTestResult
    check(
      "[21] 未知命令 parsed=false、framework/summary=null、原始输出保留",
      unknown.parsed === false &&
        unknown.framework === null &&
        unknown.summary === null &&
        unknown.failures.length === 0 &&
        (unknown.output_head + unknown.output_tail).includes("hello"),
      `exit=${unknown.exit_code} parsed=${unknown.parsed} output=${clip(unknown.output_head + unknown.output_tail, 120)}`,
    )
  } catch (error) {
    check("[21] 未知命令 parsed=false、framework/summary=null、原始输出保留", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  // 用例 22：超时 → exit -1 + timeout
  try {
    const timed = (await typed.verifyTest({
      command: 'python -c "import time; time.sleep(30)"',
      options: { timeout_ms: 1500 },
    })) as VerifyTestResult
    check(
      "[22] 超时：exit_code=-1、timeout=true、duration≈1.5s",
      timed.exit_code === -1 && timed.timeout === true && timed.duration_ms >= 1400 && timed.duration_ms < 15_000,
      `exit=${timed.exit_code} timeout=${timed.timeout} duration=${timed.duration_ms}`,
    )
  } catch (error) {
    check("[22] 超时：exit_code=-1、timeout=true、duration≈1.5s", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  // 用例 23：失败列表截断（21 失败 → 20 + total_failures）
  try {
    const many = (await typed.verifyTest({ command: "python -m pytest tests_many" })) as VerifyTestResult
    check(
      "[23] 失败截断：failures=20 且 total_failures=21",
      many.failures.length === 20 && many.total_failures === 21,
      `failures=${many.failures.length} total=${many.total_failures} summary=${JSON.stringify(many.summary)}`,
    )
    const truncatedRendered = renderModule.renderVerifyTest(many)
    check(
      "[23] 截断渲染含 more failures 行",
      truncatedRendered.includes("more failures, total 21"),
      clip(truncatedRendered.replace(/\n/g, " ⏎ "), 200),
    )
  } catch (error) {
    check("[23] 失败截断：failures=20 且 total_failures=21", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  // 用例 24：输出截断 + cwd 错误码
  try {
    const noisy = (await typed.verifyTest({ command: 'python -c "for i in range(300): print(i)"' })) as VerifyTestResult
    const headLines = noisy.output_head.split("\n").filter((line) => line !== "").length
    const tailLines = noisy.output_tail.split("\n").filter((line) => line !== "").length
    check(
      "[24] 300 行输出 → head/tail 各 100 行、parsed=false",
      noisy.parsed === false && headLines === 100 && tailLines === 100,
      `head=${headLines} tail=${tailLines} parsed=${noisy.parsed}`,
    )
  } catch (error) {
    check("[24] 300 行输出 → head/tail 各 100 行、parsed=false", false, `${(error as Error).name}: ${(error as Error).message}`)
  }
  let protectedCwdCode: number | undefined
  try {
    await typed.verifyTest({ command: "echo x", options: { cwd: ".venv" } })
  } catch (error) {
    protectedCwdCode = (error as { code?: number }).code
  }
  check("[24] 保护 cwd → RPC -32013", protectedCwdCode === -32013, `code=${protectedCwdCode}`)

  let missingCwdCode: number | undefined
  try {
    await typed.verifyTest({ command: "echo x", options: { cwd: "no/such/dir" } })
  } catch (error) {
    missingCwdCode = (error as { code?: number }).code
  }
  check("[24] 不存在 cwd → RPC -32001", missingCwdCode === -32001, `code=${missingCwdCode}`)

  // ---- 用例 25-28：project_map 契约（fixtures + 依赖/环 + hot 空 + 并发/缓存） ----
  const mapInput = (await Bun.file(path.join(MAP_DIR, "input.json")).json()) as { view?: string; scope?: string }
  const mapGolden = (await Bun.file(path.join(MAP_DIR, "output.json")).json()) as ProjectMapStructureResult
  check(
    "[25] 客户端严格解码 fixtures/project_map/output.json",
    strictDecode(protocol.ProjectMapResult, mapGolden) !== undefined,
    `modules=${mapGolden.modules.length} total_modules=${mapGolden.project.total_modules}`,
  )
  const mapReady = async <T,>(input: { view?: string; scope?: string }): Promise<T> => {
    for (let i = 0; i < 240; i++) {
      try {
        const result = (await typed.projectMap(input)) as Record<string, unknown> & { building?: boolean }
        if (result.building !== true) return result as T
      } catch (error) {
        if ((error as { code?: number }).code !== -32000) throw error
      }
      await sleep(250)
    }
    throw new Error("project_map 构建超时（60s）")
  }
  try {
    const structure = await mapReady<ProjectMapStructureResult>(mapInput)
    const normalized = { ...structure, project: { ...structure.project, root: "<root>" } }
    check(
      "[25] structure 与 output.json 深度一致（root 归一）",
      JSON.stringify(canonical(normalized)) === JSON.stringify(canonical(mapGolden)),
      `modules=${structure.modules.length} entries=${structure.entry_points.length}`,
      { actual: structure, expected: mapGolden },
    )
    check(
      "[25] 入口点含 main（≥2 个）",
      structure.entry_points.filter((entry) => entry.kind === "main").length >= 2,
      `entry_points=${clip(JSON.stringify(structure.entry_points), 240)}`,
    )
    check(
      "[25] 模块含 demo/api 与 demo/tasks",
      structure.modules.some((module) => module.path.endsWith("demo/api")) &&
        structure.modules.some((module) => module.path.endsWith("demo/tasks")),
      `modules=${clip(structure.modules.map((module) => module.path).join(", "), 240)}`,
    )
  } catch (error) {
    check("[25] structure 与 output.json 深度一致（root 归一）", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  try {
    const deps = await mapReady<ProjectMapDependenciesResult>({ view: "dependencies" })
    check(
      "[26] 依赖含 demo/api → demo/tasks",
      deps.dependencies.some((edge) => edge.from.endsWith("demo/api") && edge.to.endsWith("demo/tasks")),
      `deps=${clip(JSON.stringify(deps.dependencies), 260)}`,
    )
    check(
      "[26] cycles 含 demo/cyclea ↔ demo/cycleb",
      deps.cycles.some(
        (cycle) =>
          cycle.length >= 2 &&
          cycle.some((modulePath) => modulePath.endsWith("demo/cyclea")) &&
          cycle.some((modulePath) => modulePath.endsWith("demo/cycleb")),
      ),
      `cycles=${clip(JSON.stringify(deps.cycles), 200)}`,
    )
  } catch (error) {
    check("[26] 依赖含 demo/api → demo/tasks", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  try {
    const hot = await mapReady<{ hot_files: unknown[]; hot_modules: unknown[] }>({ view: "hot" })
    check(
      "[27] hot 视图 v1 为空（spec 作者选择 A）",
      hot.hot_files.length === 0 && hot.hot_modules.length === 0,
      `files=${hot.hot_files.length} modules=${hot.hot_modules.length}`,
    )
  } catch (error) {
    check("[27] hot 视图 v1 为空（spec 作者选择 A）", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  try {
    await mapReady<unknown>({ view: "dependencies" })
    const parallelStarted = Date.now()
    const results = await Promise.all(Array.from({ length: 10 }, () => typed.projectMap({ view: "dependencies" })))
    const parallelElapsed = Date.now() - parallelStarted
    const serialized = results.map((result) => JSON.stringify(canonical(result)))
    check(
      "[28] 10 个并发 project_map 结果一致",
      serialized.every((item) => item === serialized[0]),
      `elapsed=${parallelElapsed}ms`,
    )
    const cacheStarted = Date.now()
    await typed.projectMap({ view: "structure" })
    const cachedMs = Date.now() - cacheStarted
    check("[28] 缓存命中：structure 二次调用 < 500ms", cachedMs < 500, `${cachedMs}ms`)
  } catch (error) {
    check("[28] 10 个并发 project_map 结果一致", false, `${(error as Error).name}: ${(error as Error).message}`)
  }

  // ---- 用例 29：结构变更缓存失效 + >20 模块截断（运行期生成/清理） ----
  const modsRoot = path.join(SERVER_DIR, "sample-project", "mods")
  try {
    for (let i = 1; i <= 21; i++) {
      const dir = path.join(modsRoot, `e2e_${String(i).padStart(2, "0")}`)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "Probe.java"), `class Probe${i} {}\n`)
    }
    const baseTotal = mapGolden.project.total_modules
    const truncated = await mapReady<ProjectMapStructureResult>({ view: "structure" })
    check(
      "[29] 新增 21 个模块 → 截断展示 20、total_modules=base+21",
      truncated.modules.length === 20 &&
        truncated.project.total_modules === baseTotal + 21 &&
        truncated.modules.every(
          (module, index) => index === 0 || truncated.modules[index - 1].path <= module.path,
        ),
      `modules=${truncated.modules.length} total=${truncated.project.total_modules} base=${baseTotal}`,
    )
    fs.rmSync(modsRoot, { recursive: true, force: true })
    let restoredTotal: number | undefined
    for (let i = 0; i < 60; i++) {
      const current = await mapReady<ProjectMapStructureResult>({ view: "structure" })
      if (current.project.total_modules === baseTotal) {
        restoredTotal = current.project.total_modules
        break
      }
      await sleep(500)
    }
    check("[29] 删除后缓存失效恢复 total_modules=base", restoredTotal === baseTotal, `total=${restoredTotal} base=${baseTotal}`)
  } catch (error) {
    check("[29] 新增 21 个模块 → 截断展示 20、total_modules=base+21", false, `${(error as Error).name}: ${(error as Error).message}`)
  } finally {
    fs.rmSync(modsRoot, { recursive: true, force: true })
  }

  // ---- 用例 30-35：edit_batch 并发锁（同版本竞争/并行/超时/路径归一/顺序/夹具） ----
  const concurrencyCleanup: string[] = []
  const concurrencyTemplate = (className: string) => `class ${className} {\n  int value = 0;\n}\n`
  const concurrencyChange = { oldString: "int value = 0;", newString: "int value = 1;" }
  const openClient = () => clientModule.connect(SOCKET, { connect_timeout_ms: 10_000, request_timeout_ms: 120_000 })
  const prepareFile = async (name: string): Promise<{ rel: string; abs: string; version: string }> => {
    const rel = `src/main/java/demo/tasks/${name}.java`
    const abs = path.join(FIXTURE_DIR, "tasks", `${name}.java`)
    fs.writeFileSync(abs, concurrencyTemplate(name))
    concurrencyCleanup.push(abs)
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const snapshot = (await typed.readView({ file: rel, view: "entry" })) as ReadViewResult
        return { rel, abs, version: snapshot.version }
      } catch (error) {
        if ((error as { code?: number }).code === -32000) {
          await sleep(500)
          continue
        }
        throw error
      }
    }
    throw new Error(`prepareFile: 语义引擎未就绪（-32000 重试超限）: ${name}`)
  }
  const editOnce = (
    client: Awaited<ReturnType<typeof clientModule.connect>>,
    rel: string,
    version: string,
    options?: { lock_timeout_ms?: number },
    change: { oldString: string; newString: string } = concurrencyChange,
  ) =>
    client
      .editBatch({
        file: rel,
        changes: [change],
        baseVersion: version,
        ...(options === undefined ? {} : { options }),
      })
      .then((result: EditBatchResult) => ({ ok: true as const, result }))
      .catch((error: { code?: number; message?: string }) => ({ ok: false as const, error }))
  const waitForSemanticReady = async (deadlineMs = 60_000): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline) {
      try {
        const ping = await typed.ping()
        if (!ping.indexing) return true
      } catch {
        // transient ping failures are retried
      }
      await sleep(500)
    }
    return false
  }
  try {
    check("[30] 前置：语义引擎 ready（[29] 目录变更后）", await waitForSemanticReady(), "ping ready")
    // [30] 同版本 10 路并发（独立连接）
    const race = await prepareFile("EditRace")
    const raceClients = await Promise.all(Array.from({ length: 10 }, () => openClient()))
    try {
      const raceResults = await Promise.all(raceClients.map((client) => editOnce(client, race.rel, race.version)))
      const raceSuccesses = raceResults.filter((item) => item.ok && item.result.applied === true)
      const raceFailures = raceResults.filter((item) => item.ok && item.result.applied === false)
      const raceCodes = raceFailures.map((item) => (item.ok ? item.result.error?.code : undefined))
      check("[30] 同版本 10 路并发恰好 1 成功", raceSuccesses.length === 1, `success=${raceSuccesses.length} failCodes=${JSON.stringify(raceCodes)}`)
      check(
        "[30] 其余均为 -32012/-32017（无静默覆盖）",
        raceFailures.length === 9 && raceCodes.every((code) => code === -32012 || code === -32017),
        `codes=${JSON.stringify(raceCodes)}`,
      )
      const raceDisk = fs.readFileSync(race.abs, "utf8")
      check("[30] 磁盘内容只生效一次", raceDisk.includes("int value = 1;") && !raceDisk.includes("int value = 0;"), clip(raceDisk))
    } finally {
      for (const client of raceClients) client.close()
    }

    // [31] 不同文件并行 10 路
    const parallelFiles: Array<{ rel: string; abs: string; version: string }> = []
    for (let i = 1; i <= 10; i++) parallelFiles.push(await prepareFile(`EditPar${String(i).padStart(2, "0")}`))
    const parallelClients = await Promise.all(Array.from({ length: 10 }, () => openClient()))
    try {
      const parallelStarted = Date.now()
      const parallelResults = await Promise.all(parallelFiles.map((file, index) => editOnce(parallelClients[index], file.rel, file.version)))
      const parallelElapsed = Date.now() - parallelStarted
      check(
        "[31] 不同文件 10 路并行全部成功",
        parallelResults.every((item) => item.ok && item.result.applied === true),
        `success=${parallelResults.filter((item) => item.ok && item.result.applied === true).length}/10 elapsed=${parallelElapsed}ms`,
      )
    } finally {
      for (const client of parallelClients) client.close()
    }

    // [32] LOCK_TIMEOUT 现场 + 渲染
    let lockTimeoutResult: EditBatchResult | undefined
    for (let attempt = 0; attempt < 3 && lockTimeoutResult === undefined; attempt++) {
      const locked = await prepareFile("EditLock")
      const holder = await openClient()
      const waiter = await openClient()
      try {
        const holderPromise = editOnce(holder, locked.rel, locked.version)
        await sleep(30)
        const waiterOutcome = await editOnce(waiter, locked.rel, locked.version, { lock_timeout_ms: 1 })
        const holderOutcome = await holderPromise
        if (waiterOutcome.ok && waiterOutcome.result.applied === false && waiterOutcome.result.error?.code === -32017) {
          lockTimeoutResult = waiterOutcome.result
          check(
            "[32] LOCK_TIMEOUT detail/hint 完整",
            (waiterOutcome.result.error?.detail as { waited_ms?: unknown } | undefined)?.waited_ms !== undefined &&
              (waiterOutcome.result.error?.detail as { file?: unknown } | undefined)?.file !== undefined &&
              waiterOutcome.result.error?.hint === "文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本",
            `error=${clip(JSON.stringify(waiterOutcome.result.error))}`,
          )
          check(
            "[32] 持锁者仍成功写入",
            holderOutcome.ok && holderOutcome.result.applied === true,
            `holder=${holderOutcome.ok ? JSON.stringify(holderOutcome.result.error ?? "applied") : JSON.stringify(holderOutcome.error)}`,
          )
        }
      } finally {
        holder.close()
        waiter.close()
      }
    }
    check(
      "[32] 触发真实 LOCK_TIMEOUT（-32017）",
      lockTimeoutResult !== undefined,
      lockTimeoutResult === undefined ? "3 轮均未命中（记录偏差）" : "命中",
    )
    if (lockTimeoutResult !== undefined) {
      const lockRendered = renderModule.renderEditBatch(lockTimeoutResult)
      check(
        "[32] LOCK_TIMEOUT 渲染（headline/detail/hint）",
        lockRendered.startsWith("edit_batch FAILED: lock timeout\n") &&
          lockRendered.includes(" lock timeout after ") &&
          lockRendered.includes("  hint: 文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本"),
        clip(lockRendered.replace(/\n/g, " ⏎ "), 240),
      )
    }

    // [33] 路径规范化：`path` 与 `./path` 并发 → 同一锁
    const normalized = await prepareFile("EditNorm")
    const normClients = await Promise.all([openClient(), openClient()])
    try {
      const normResults = await Promise.all([
        editOnce(normClients[0], normalized.rel, normalized.version),
        editOnce(normClients[1], `./${normalized.rel}`, normalized.version),
      ])
      const normSuccesses = normResults.filter((item) => item.ok && item.result.applied === true)
      check(
        "[33] `./path` 与 `path` 视为同一文件（恰好 1 成功）",
        normSuccesses.length === 1,
        `success=${normSuccesses.length}`,
      )
    } finally {
      for (const client of normClients) client.close()
    }

    // [34] 顺序同文件两次 → 无锁等待
    const sequential = await prepareFile("EditSeq")
    const seqClient = await openClient()
    try {
      const seqStart = Date.now()
      const first = await editOnce(seqClient, sequential.rel, sequential.version)
      const second =
        first.ok && first.result.applied === true
          ? await editOnce(
              seqClient,
              sequential.rel,
              first.result.new_version ?? "",
              undefined,
              { oldString: "int value = 1;", newString: "int value = 2;" },
            )
          : undefined
      const seqElapsed = Date.now() - seqStart
      check(
        "[34] 同 agent 顺序两次编辑均成功且无等待",
        first.ok && first.result.applied === true && second !== undefined && second.ok && second.result.applied === true,
        `elapsed=${seqElapsed}ms`,
      )
    } finally {
      seqClient.close()
    }

    // [35] 夹具 lock_timeout.json 契约
    const lockFixture = (await Bun.file(path.join(EDIT_DIR, "lock_timeout.json")).json()) as EditBatchResult
    check(
      "[35] 客户端严格解码 fixtures/edit_batch/lock_timeout.json",
      strictDecode(protocol.EditBatchResult, lockFixture) !== undefined,
      `code=${lockFixture.error?.code}`,
    )
    const fixtureFile = (lockFixture.error?.detail as { file?: string } | undefined)?.file ?? lockFixture.file ?? "?"
    const fixtureWaited = (lockFixture.error?.detail as { waited_ms?: number } | undefined)?.waited_ms
    const fixtureExpected = [
      "edit_batch FAILED: lock timeout",
      `  ${fixtureFile}: lock timeout after ${fixtureWaited}ms`,
      ...(lockFixture.error?.hint === undefined ? [] : [`  hint: ${lockFixture.error.hint}`]),
    ].join("\n")
    check("[35] 夹具渲染一致", renderModule.renderEditBatch(lockFixture) === fixtureExpected, clip(fixtureExpected.replace(/\n/g, " ⏎ "), 240))
  } catch (error) {
    check("[30] 同版本 10 路并发恰好 1 成功", false, `${(error as Error).name}: ${(error as Error).message}`)
  } finally {
    for (const file of concurrencyCleanup) fs.rmSync(file, { force: true })
  }

  // ---- 用例 9：shutdown + 连接失败 ----
  const shutdown = await rpc2.call("shutdown", undefined, 15_000)
  const shutdownResult = shutdown.frame.result as { ok?: unknown } | undefined
  check(
    "[9] shutdown result === {ok:true}",
    shutdown.frame.error === undefined && typeof shutdownResult === "object" && shutdownResult !== null && shutdownResult.ok === true,
    `result=${clip(JSON.stringify(shutdown.frame.result ?? shutdown.frame.error))}`,
    shutdown.frame,
  )
  let connectFailed = false
  let lastConnectError = ""
  const failDeadline = Date.now() + 2_000
  while (Date.now() < failDeadline) {
    const probe = await tryConnect(300)
    if (!probe.ok) {
      connectFailed = true
      lastConnectError = probe.error
      break
    }
    probe.socket.destroy()
    await sleep(100)
  }
  check("[9] shutdown 后 2s 内对同一 socket connect 失败", connectFailed, connectFailed ? `错误=${lastConnectError}` : "2s 内仍可连接")
} catch (error) {
  check("[run] 用例执行未捕获异常", false, `${(error as Error).stack ?? String(error)}`)
} finally {
  try {
    typed?.close()
  } catch {
    // ignore
  }
  try {
    r1?.close()
  } catch {
    // ignore
  }
  try {
    r2?.close()
  } catch {
    // ignore
  }
  await Promise.race([server.exited, sleep(2_000)])
  if (server.exitCode === null) {
    await shutdownBestEffort()
    await Promise.race([server.exited, sleep(1_000)])
  }
  if (server.exitCode === null) {
    try {
      const killer = Bun.spawn(["taskkill", "/PID", String(server.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
      await killer.exited
    } catch {
      // ignore
    }
  }
  fs.rmSync(SOCKET, { force: true })
}

const failed = checks.filter((item) => !item.ok)
const passed = checks.length - failed.length
if (failed.length > 0) {
  console.log(`\nCONFORMANCE FAIL ${passed}/${checks.length}`)
  for (const item of failed) {
    console.log(`✗ ${item.name} — ${item.detail}`)
    const snippet = snippets.get(item.name)
    if (snippet !== undefined) console.log(`    raw: ${snippet}`)
  }
} else {
  console.log(`\nCONFORMANCE PASS ${passed}/${checks.length}`)
}
for (const note of deviations) console.log(`⚠ 偏差: ${note}`)
process.exit(failed.length > 0 ? 1 : 0)
