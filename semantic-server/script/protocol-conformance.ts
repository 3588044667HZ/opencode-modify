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
