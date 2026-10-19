#!/usr/bin/env bun
// 语义工具小规模 A/B：同一模型、同一任务，semantic.enabled=false（基线）与 true（语义工具）各跑一次。
// 任务：Java/Python/TS 各一个定义+调用点检索，Python 一个编辑+测试任务。
// 用法（在 packages/opencode 下）：
//   bun script/semantic-ab.ts [--model provider/model] [--only java,python,ts,edit] [--condition baseline,semantic]
// 结果写入 semantic-server/.tmp/semantic-ab-results.json，并打印汇总表。
import fs from "node:fs/promises"
import os from "node:os"
import path from "path"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

const REPO = path.resolve(import.meta.dir, "../../..")
const INDEX = path.resolve(import.meta.dir, "../src/index.ts")
const FIXTURES = path.join(REPO, "semantic-server", "fixtures")
const SAMPLE = path.join(REPO, "semantic-server", "sample-project")
const JAR = path.join(REPO, "semantic-server", "build-local", "semantic-server.jar")
const OUT = path.join(REPO, "semantic-server", ".tmp", "semantic-ab-results.json")
const MODEL = process.env.SEMANTIC_AB_MODEL ?? "deepseek-2/deepseek-flash"
const REAL_PYTHON = process.env.SEMANTIC_AB_PYTHON_PROJECT
const REAL_TS = path.join(REPO, "packages", "opencode")
const COPY_EXCLUDED = new Set([
  ".git",
  ".idea",
  ".venv",
  "venv",
  "env",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".turbo",
  "coverage",
])
const copyCache = new Map<string, string>()

const args = process.argv.slice(2)
const only = new Set(
  (args.includes("--only") ? (args[args.indexOf("--only") + 1] ?? "") : "java,python,ts,edit")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
)
const conditions = (
  args.includes("--condition")
    ? (args[args.indexOf("--condition") + 1] ?? "baseline,semantic")
    : "baseline,semantic"
)
  .split(",")
  .map((value) => value.trim())
  .filter((value): value is Condition => value === "baseline" || value === "semantic")

const repeats = Math.max(
  1,
  Number(args.includes("--repeat") ? (args[args.indexOf("--repeat") + 1] ?? "1") : "1") || 1,
)

type Condition = "baseline" | "semantic"

type RetrievalExpected = {
  readonly definition: { readonly file: string; readonly line: number }
  readonly callers: ReadonlyArray<{ readonly file: string; readonly line: number }>
}

type ImpactExpected = {
  readonly definition: { readonly file: string; readonly line: number }
  readonly production: readonly string[]
  readonly tests: readonly string[]
}

type Task = {
  readonly id: string
  readonly language: "java" | "python" | "ts" | "edit"
  readonly project: string
  readonly prompt: string
  /** 语义条件强制使用工具的提示（能力测试）；基线不提供该工具。 */
  readonly forcedPrompt?: string
  readonly copy?: boolean
  readonly expected?: RetrievalExpected
  readonly expectedImpact?: ImpactExpected
}

const tasks: Task[] = [
  {
    id: "java-run",
    language: "java",
    project: SAMPLE,
    copy: true,
    prompt: [
      "Find the definition of TaskEngine.run and every call site of it in this project.",
      "Return only JSON, no prose:",
      '{"definition":{"file":"project-relative/path","line":N},"callers":[{"file":"project-relative/path","line":N}]}',
      "Include all tests and call sites.",
      "Prefer precise semantic/IDE tools when available (they may ask you to retry while indexing); otherwise use grep/read.",
    ].join("\n"),
    forcedPrompt: [
      "Use the blast_radius tool with symbol \"run\" to answer. If it returns indexing, wait briefly and retry it.",
      "Return only JSON, no prose:",
      '{"definition":{"file":"project-relative/path","line":N},"callers":[{"file":"project-relative/path","line":N}]}',
      "Include all tests and call sites.",
    ].join("\n"),
    expected: {
      definition: { file: "src/main/java/demo/tasks/TaskEngine.java", line: 4 },
      callers: [
        ...Array.from({ length: 21 }, (_, index) => ({
          file: "src/main/java/demo/tasks/ManyCallers.java",
          line: 6 + index,
        })),
        { file: "src/main/java/demo/tasks/TaskEngineTest.java", line: 5 },
        { file: "src/main/java/demo/tasks/TaskWorker.java", line: 6 },
      ],
    },
  },
  {
    id: "python-add-user-message",
    language: "python",
    project: path.join(FIXTURES, "python-project"),
    copy: true,
    prompt: [
      "Find the definition of MemoryManager.add_user_message and every call site in this project.",
      "Return only JSON, no prose:",
      '{"definition":{"file":"project-relative/path","line":N},"callers":[{"file":"project-relative/path","line":N}]}',
      "Include tests.",
      "Prefer precise semantic/IDE tools when available (they may ask you to retry while indexing); otherwise use grep/read.",
    ].join("\n"),
    forcedPrompt: [
      "Use the blast_radius tool with symbol \"add_user_message\" to answer. If it returns indexing, wait briefly and retry it.",
      "Return only JSON, no prose:",
      '{"definition":{"file":"project-relative/path","line":N},"callers":[{"file":"project-relative/path","line":N}]}',
      "Include tests.",
    ].join("\n"),
    expected: {
      definition: { file: "core/memory.py", line: 9 },
      callers: [
        { file: "core/loop.py", line: 9 },
        { file: "app/views/routes.py", line: 12 },
        { file: "tests/test_memory.py", line: 6 },
      ],
    },
  },
  {
    id: "ts-calculator-add",
    language: "ts",
    project: path.join(FIXTURES, "js-project"),
    copy: true,
    prompt: [
      "Find the definition of Calculator.add and every call site in this project.",
      "Return only JSON, no prose:",
      '{"definition":{"file":"project-relative/path","line":N},"callers":[{"file":"project-relative/path","line":N}]}',
      "Include tests.",
      "Prefer precise semantic/IDE tools when available (they may ask you to retry while indexing); otherwise use grep/read.",
    ].join("\n"),
    forcedPrompt: [
      "Use the blast_radius tool with symbol \"Calculator.add\" to answer. If it returns indexing, wait briefly and retry it.",
      "Return only JSON, no prose:",
      '{"definition":{"file":"project-relative/path","line":N},"callers":[{"file":"project-relative/path","line":N}]}',
      "Include tests.",
    ].join("\n"),
    expected: {
      definition: { file: "src/core.js", line: 2 },
      callers: [
        { file: "src/index.js", line: 6 },
        { file: "src/app.js", line: 7 },
        { file: "tests/core.test.js", line: 5 },
      ],
    },
  },
  {
    id: "python-edit-validation",
    language: "edit",
    project: path.join(FIXTURES, "python-project"),
    copy: true,
    prompt: [
      "In core/memory.py, make MemoryManager.add_user_message raise ValueError when text is empty or whitespace-only,",
      "and do not append to messages in that case.",
      "Add a pytest case in tests/test_memory.py covering empty and whitespace input.",
      "Run the tests. Keep changes minimal.",
    ].join(" "),
  },
  ...(REAL_PYTHON
    ? [
        {
          id: "python-real-impact",
          language: "python" as const,
          project: REAL_PYTHON,
          copy: true,
          prompt: [
            "In this project, find the definition of MemoryManager.add_user_message.",
            "List the production files that call it and the test files that reference it. Do not modify files.",
            "Do not include the definition file itself in production_files or test_files.",
            "Return only JSON, no prose:",
            '{"definition":{"file":"project-relative/path","line":N},"production_files":["..."],"test_files":["..."]}',
          ].join("\n"),
          forcedPrompt: [
            'Use the blast_radius tool with symbol "MemoryManager.add_user_message" (or "add_user_message") to answer.',
            "If it returns indexing, wait briefly and retry. Do not modify files.",
            "Do not include the definition file itself in production_files or test_files.",
            "Return only JSON, no prose:",
            '{"definition":{"file":"project-relative/path","line":N},"production_files":["..."],"test_files":["..."]}',
          ].join("\n"),
          expectedImpact: {
            definition: { file: "core/memory_manager.py", line: 72 },
            production: ["core/loop.py", "core/session.py", "core/skill_agent.py", "core/subagent.py"],
            tests: ["scripts/test_team_tools.py", "scripts/test_tool_pairing.py"],
          },
        },
      ]
    : []),
  {
    id: "ts-real-impact",
    language: "ts",
    project: REAL_TS,
    copy: true,
    prompt: [
      "In this project, find the definition of renderProjectMap.",
      "List the production files that reference it and the test files that reference it. Do not modify files.",
      "Do not include the definition file itself in production_files or test_files.",
      "Return only JSON, no prose:",
      '{"definition":{"file":"project-relative/path","line":N},"production_files":["..."],"test_files":["..."]}',
    ].join("\n"),
    forcedPrompt: [
      'Use the blast_radius tool with symbol "renderProjectMap" to answer.',
      "If it returns indexing, wait briefly and retry. Do not modify files.",
      "Do not include the definition file itself in production_files or test_files.",
      "Return only JSON, no prose:",
      '{"definition":{"file":"project-relative/path","line":N},"production_files":["..."],"test_files":["..."]}',
    ].join("\n"),
    expectedImpact: {
      definition: { file: "src/semantic/render.ts", line: 405 },
      production: ["src/tool/project-map.ts"],
      tests: ["test/semantic/project-map.test.ts"],
    },
  },
]

type RunResult = {
  readonly task: string
  readonly repeat: number
  readonly language: Task["language"]
  readonly condition: Condition
  readonly ok: boolean
  readonly score: number
  readonly definitionOk: boolean
  readonly callerF1: number
  readonly productionF1?: number
  readonly testF1?: number
  readonly precision: number
  readonly recall: number
  readonly tokens: number
  readonly cost: number
  readonly elapsedMs: number
  readonly tools: Record<string, number>
  readonly answer: string
  readonly warmupMs?: number
  readonly error?: string
  readonly dir: string
}

function config(condition: Condition): string {
  const javaHome = process.env.JAVA_HOME
  const java = javaHome
    ? path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java"
  const semantic =
    condition === "semantic"
      ? { enabled: true, command: [java, "-Djava.awt.headless=true", "-jar", JAR] }
      : { enabled: false }
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    permission: {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      edit: "allow",
      bash: "allow",
      external_directory: "allow",
    },
    semantic,
  })
}

async function run(task: Task, condition: Condition, repeat: number): Promise<RunResult> {
  const dir = task.copy ? await copyFor(task) : task.project
  const warm = condition === "semantic" ? await warmDaemon(dir) : undefined
  const started = Date.now()
  const prompt = condition === "semantic" && task.forcedPrompt ? task.forcedPrompt : task.prompt
  const proc = Bun.spawn(
    [
      process.execPath,
      INDEX,
      "run",
      prompt,
      "--model",
      MODEL,
      "--format",
      "json",
      "--title",
      `ab-${task.id}-${condition}`,
    ],
    {
      cwd: dir,
      // opencode run 用 PWD 优先解析项目根；Bun.spawn 只改 cwd 不改继承的 PWD。
      env: { ...process.env, PWD: dir, OPENCODE_CONFIG_CONTENT: config(condition) },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timeout = setTimeout(() => killTree(proc.pid), condition === "semantic" ? 300_000 : 180_000)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  clearTimeout(timeout)
  const code = await proc.exited
  await stopWarm(warm)
  const elapsedMs = Date.now() - started

  const text: string[] = []
  const tools: Record<string, number> = {}
  let tokens = 0
  let cost = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === "text" && event.part?.time?.end) text.push(event.part.text ?? "")
    if (event.type === "tool_use" && typeof event.part?.tool === "string") {
      tools[event.part.tool] = (tools[event.part.tool] ?? 0) + 1
    }
    if (event.type === "step_finish" && event.part?.tokens) {
      tokens += Number(event.part.tokens.total ?? 0)
      cost += Number(event.part.cost ?? 0)
    }
  }
  const answer = text.join("\n").trim()

  if (code !== 0) {
    return {
      task: task.id,
      repeat,
      language: task.language,
      condition,
      ok: false,
      score: 0,
      definitionOk: false,
      callerF1: 0,
      precision: 0,
      recall: 0,
      tokens,
      cost,
      elapsedMs,
      tools,
      answer,
      error: (stderr.trim() || `exit ${code}`).slice(0, 2000),
      dir,
    }
  }

  if (task.language === "edit") {
    const edit = await gradeEdit(dir)
    return {
      task: task.id,
      repeat,
      language: task.language,
      condition,
      ok: edit.pass,
      score: edit.score,
      definitionOk: edit.behavior,
      callerF1: edit.tests ? 1 : 0,
      precision: 0,
      recall: 0,
      tokens,
      cost,
      elapsedMs,
      tools,
      answer,
      ...(warm ? { warmupMs: warm.elapsedMs } : {}),
      ...(edit.error ? { error: edit.error } : {}),
      dir,
    }
  }

  if (task.expectedImpact) {
    const impact = gradeImpact(answer, task.expectedImpact)
    return {
      task: task.id,
      repeat,
      language: task.language,
      condition,
      ok: impact.definitionOk && impact.productionF1 > 0.99 && impact.testF1 > 0.99,
      score: impact.score,
      definitionOk: impact.definitionOk,
      callerF1: impact.productionF1,
      productionF1: impact.productionF1,
      testF1: impact.testF1,
      precision: impact.productionPrecision,
      recall: impact.productionRecall,
      tokens,
      cost,
      elapsedMs,
      tools,
      answer: answer.slice(0, 4000),
      ...(warm ? { warmupMs: warm.elapsedMs } : {}),
      ...(impact.error ? { error: impact.error } : {}),
      dir,
    }
  }

  const retrieval = gradeRetrieval(answer, task.expected!)
  return {
    task: task.id,
    repeat,
    language: task.language,
    condition,
    ok: retrieval.definitionOk && retrieval.callerF1 > 0.99,
    score: retrieval.score,
    definitionOk: retrieval.definitionOk,
    callerF1: retrieval.callerF1,
    precision: retrieval.precision,
    recall: retrieval.recall,
    tokens,
    cost,
    elapsedMs,
    tools,
    answer: answer.slice(0, 4000),
    ...(warm ? { warmupMs: warm.elapsedMs } : {}),
    ...(retrieval.error ? { error: retrieval.error } : {}),
    dir,
  }
}

function javaPath(): string {
  const javaHome = process.env.JAVA_HOME
  return javaHome
    ? path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java"
}

function locatorFor(directory: string): string {
  const resolved = path.normalize(path.resolve(directory))
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 10)
  return path.join(os.tmpdir(), `opencode-semantic-${hash}.port`)
}

// 与桌面端 warmup 等价：先拉起并等到 indexing=false，再让 agent 复用该守护；
// 否则每次 CLI 单次运行都会把冷启动算进工具耗时。
async function warmDaemon(directory: string) {
  const started = Date.now()
  const locator = locatorFor(directory)
  await fs.rm(locator, { force: true })
  const log = path.join(REPO, "semantic-server", ".tmp", "semantic-ab-warm.log")
  await fs.mkdir(path.dirname(log), { recursive: true })
  const fd = await fs.open(log, "a")
  const child = Bun.spawn(
    [javaPath(), "-Djava.awt.headless=true", "-jar", JAR, directory, locator, "--idle-seconds", "600"],
    {
      cwd: directory,
      env: { ...process.env, PWD: directory },
      stdout: fd.fd,
      stderr: fd.fd,
    },
  )
  await fd.close()
  try {
    const { connectLocator } = await import(
      pathToFileURL(path.join(REPO, "semantic-server", "script", "connect.ts")).href
    )
    const connection = await connectLocator(locator, {
      deadlineMs: 180_000,
      attemptTimeoutMs: 1_000,
      retryDelayMs: 500,
    })
    const socket = connection.socket
    let buffer = connection.leftover
    let id = 2
    const wait = new Map<number, (message: any) => void>()
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      let index: number
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        const message = JSON.parse(line)
        wait.get(message.id)?.(message)
        wait.delete(message.id)
      }
    })
    const request = (method: string) =>
      new Promise<any>((resolve, reject) => {
        const current = id++
        const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 30_000)
        wait.set(current, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params: {} }) + "\n")
      })
    for (let attempt = 0; attempt < 240; attempt++) {
      const message = await request("ping")
      if (message.result?.indexing === false) break
      await new Promise((done) => setTimeout(done, 500))
    }
    socket.destroy()
    return { locator, elapsedMs: Date.now() - started }
  } catch (error) {
    stopPid(child.pid)
    await fs.rm(locator, { force: true })
    return { locator, elapsedMs: Date.now() - started, error: (error as Error).message }
  }
}

async function stopWarm(warm: { locator: string } | undefined) {
  if (!warm) return
  const text = await fs.readFile(warm.locator, "utf8").catch(() => undefined)
  if (text) {
    try {
      const pid = (JSON.parse(text) as { pid?: number }).pid
      if (typeof pid === "number") stopPid(pid)
    } catch {
      // locator 损坏：忽略
    }
  }
  await fs.rm(warm.locator, { force: true })
  await new Promise((done) => setTimeout(done, 300))
}

function stopPid(pid: number | undefined) {
  if (pid === undefined) return
  Bun.spawnSync(
    process.platform === "win32"
      ? ["taskkill", "/PID", String(pid), "/T", "/F"]
      : ["kill", "-9", String(pid)],
    { stdout: "ignore", stderr: "ignore" },
  )
}

async function copyFor(task: Task): Promise<string> {
  // 检索任务在同一副本上重复运行，避免每次复制整个项目；编辑任务每次用新副本。
  if (task.language === "edit") return copyProject(task)
  const cached = copyCache.get(task.id)
  if (cached) return cached
  const dir = await copyProject(task)
  copyCache.set(task.id, dir)
  return dir
}

async function cleanupCopies() {
  for (const dir of copyCache.values()) await fs.rm(dir, { recursive: true, force: true })
  copyCache.clear()
}

async function copyProject(task: Task): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `semantic-ab-${task.id}-`))
  await fs.cp(task.project, dir, {
    recursive: true,
    filter: (source) => !COPY_EXCLUDED.has(path.basename(source)),
  })
  return dir
}

function gradeRetrieval(answer: string, expected: RetrievalExpected) {
  const parsed = parseAnswer(answer)
  if (!parsed) {
    return { definitionOk: false, callerF1: 0, precision: 0, recall: 0, score: 0, error: "answer is not parseable JSON" }
  }
  const definitionOk =
    normalize(parsed.definition?.file) === normalize(expected.definition.file) &&
    Number(parsed.definition?.line) === expected.definition.line
  const got = new Set(
    (Array.isArray(parsed.callers) ? parsed.callers : [])
      .map((caller: any) => `${normalize(caller?.file)}:${Number(caller?.line)}`)
      .filter((value: string) => !value.startsWith("undefined:") && !value.endsWith("NaN")),
  )
  const want = new Set(expected.callers.map((caller) => `${normalize(caller.file)}:${caller.line}`))
  const truePositives = [...got].filter((value) => want.has(value)).length
  const precision = got.size === 0 ? 0 : truePositives / got.size
  const recall = want.size === 0 ? 1 : truePositives / want.size
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return {
    definitionOk,
    callerF1: f1,
    precision,
    recall,
    score: (definitionOk ? 1 : 0) + f1,
  }
}

function gradeImpact(answer: string, expected: ImpactExpected) {
  const parsed = parseAnswer(answer)
  if (!parsed) {
    return {
      definitionOk: false,
      productionF1: 0,
      testF1: 0,
      productionPrecision: 0,
      productionRecall: 0,
      score: 0,
      error: "answer is not parseable JSON",
    }
  }
  const definitionOk =
    normalize(parsed.definition?.file) === normalize(expected.definition.file) &&
    Number(parsed.definition?.line) === expected.definition.line
  const production = setF1(parsed.production_files, expected.production)
  const tests = setF1(parsed.test_files, expected.tests)
  return {
    definitionOk,
    productionF1: production.f1,
    testF1: tests.f1,
    productionPrecision: production.precision,
    productionRecall: production.recall,
    score: (definitionOk ? 1 : 0) + production.f1 + tests.f1,
  }
}

function setF1(value: unknown, expected: readonly string[]) {
  const got = new Set(
    (Array.isArray(value) ? value : []).map((entry) => normalize(entry)).filter((entry) => entry.length > 0),
  )
  const want = new Set(expected.map((entry) => normalize(entry)))
  const truePositives = [...got].filter((entry) => want.has(entry)).length
  const precision = got.size === 0 ? 0 : truePositives / got.size
  const recall = want.size === 0 ? 1 : truePositives / want.size
  return {
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  }
}

function parseAnswer(answer: string): any {
  const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], answer]
  for (const candidate of candidates) {
    if (!candidate) continue
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start < 0 || end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      // try next
    }
  }
  return undefined
}

function normalize(value: unknown): string {
  if (typeof value !== "string") return ""
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "")
}

async function gradeEdit(dir: string) {
  const behaviorScript = [
    "from core.memory import MemoryManager",
    "m = MemoryManager()",
    "for value in ('', '   '):",
    "    before = len(m.messages)",
    "    try:",
    "        m.add_user_message(value)",
    "    except ValueError:",
    "        pass",
    "    else:",
    "        raise SystemExit('expected ValueError')",
    "    if len(m.messages) != before:",
    "        raise SystemExit('appended on invalid input')",
    "if m.add_user_message('hi') != 1:",
    "    raise SystemExit('unexpected return value')",
  ].join("\n")
  const pytest = Bun.spawnSync(["python", "-m", "pytest", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const behavior = Bun.spawnSync(["python", "-c", behaviorScript], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const tests = pytest.exitCode === 0
  const behaviorOk = behavior.exitCode === 0
  return {
    tests,
    behavior: behaviorOk,
    pass: tests && behaviorOk,
    score: (tests ? 1 : 0) + (behaviorOk ? 1 : 0),
    error: tests
      ? behaviorOk
        ? undefined
        : behavior.stderr.toString()
      : `${pytest.stdout.toString()}\n${pytest.stderr.toString()}`.slice(0, 2000),
  }
}

function killTree(pid: number) {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
  } else {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
}

await fs.mkdir(path.dirname(OUT), { recursive: true })
const selected = tasks.filter((task) => only.has(task.id) || only.has(task.language))
const results: RunResult[] = []
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const task of selected) {
    for (const condition of conditions) {
      process.stdout.write(`\n[${task.id}] ${condition} #${repeat} ... `)
      const result = await run(task, condition, repeat)
      results.push(result)
      console.log(
        `score=${result.score.toFixed(2)} def=${result.definitionOk ? "Y" : "N"} f1=${result.callerF1.toFixed(2)} ` +
          `tokens=${result.tokens} time=${(result.elapsedMs / 1000).toFixed(1)}s` +
          (result.error ? ` error=${result.error.split("\n")[0].slice(0, 120)}` : ""),
      )
    }
  }
}
await cleanupCopies()

const summary = conditions.map((condition) => {
  const rows = results.filter((result) => result.condition === condition)
  const retrieval = rows.filter((result) => result.language !== "edit")
  return {
    condition,
    runs: rows.length,
    avgScore: rows.reduce((sum, result) => sum + result.score, 0) / Math.max(1, rows.length),
    avgRetrievalScore:
      retrieval.reduce((sum, result) => sum + result.score, 0) / Math.max(1, retrieval.length),
    avgF1: retrieval.reduce((sum, result) => sum + result.callerF1, 0) / Math.max(1, retrieval.length),
    definitionRate: retrieval.filter((result) => result.definitionOk).length / Math.max(1, retrieval.length),
    avgTokens: rows.reduce((sum, result) => sum + result.tokens, 0) / Math.max(1, rows.length),
    avgSeconds: rows.reduce((sum, result) => sum + result.elapsedMs, 0) / Math.max(1, rows.length) / 1000,
    avgWarmupSeconds:
      rows.filter((result) => result.warmupMs !== undefined).reduce((sum, result) => sum + (result.warmupMs ?? 0), 0) /
      Math.max(1, rows.filter((result) => result.warmupMs !== undefined).length) /
      1000,
    cost: rows.reduce((sum, result) => sum + result.cost, 0),
  }
})

console.table(summary)
const byTask = [...new Set(results.map((result) => result.task))].flatMap((task) =>
  conditions.map((condition) => {
    const rows = results.filter((result) => result.task === task && result.condition === condition)
    return {
      task,
      condition,
      runs: rows.length,
      avgScore: rows.reduce((sum, result) => sum + result.score, 0) / Math.max(1, rows.length),
      defRate: rows.filter((result) => result.definitionOk).length / Math.max(1, rows.length),
      prodF1:
        rows.reduce((sum, result) => sum + (result.productionF1 ?? result.callerF1), 0) /
        Math.max(1, rows.length),
      testF1:
        rows.reduce((sum, result) => sum + (result.testF1 ?? 0), 0) / Math.max(1, rows.length),
      avgTokens: Math.round(rows.reduce((sum, result) => sum + result.tokens, 0) / Math.max(1, rows.length)),
      avgSeconds:
        rows.reduce((sum, result) => sum + result.elapsedMs, 0) / Math.max(1, rows.length) / 1000,
      avgWarmup:
        rows.reduce((sum, result) => sum + (result.warmupMs ?? 0), 0) / Math.max(1, rows.length) / 1000,
    }
  }),
)
console.table(byTask)
for (const row of results) {
  console.table([
    {
      task: row.task,
      repeat: row.repeat,
      condition: row.condition,
      score: row.score.toFixed(2),
      def: row.definitionOk ? "Y" : "N",
      f1: row.callerF1.toFixed(2),
      testF1: row.testF1?.toFixed(2) ?? "-",
      tokens: row.tokens,
      seconds: (row.elapsedMs / 1000).toFixed(1),
      warmup: row.warmupMs === undefined ? "-" : (row.warmupMs / 1000).toFixed(1),
      tools: Object.entries(row.tools).map(([name, count]) => `${name}:${count}`).join(" "),
    },
  ])
}
await fs.writeFile(OUT, JSON.stringify({ model: MODEL, summary, results }, null, 2))
console.log(`\nresults: ${OUT}`)
