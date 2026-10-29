// 冷启动基准：spawn 一个全新的 serve 进程，测量到 GET /session/<seed id>/message 返回已 seed 的对话的耗时。
// 用法（在 packages/opencode 下）：
//   bun script/bench-cold-start.ts
//   COLD_START_RUNS=1 COLD_START_TIMEOUT_MS=60000 bun script/bench-cold-start.ts
//   COLD_START_SERVER="bun /abs/path/src/index.ts serve --port 0 --hostname 127.0.0.1" bun script/bench-cold-start.ts
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const HOST = "127.0.0.1"
const SEED_TEXT = "cold start seed"
const SEED_MODEL = "test/test"
const INDEX = path.resolve(import.meta.dir, "../src/index.ts")
const RUNS = readPositiveInt("COLD_START_RUNS", 5)
const TIMEOUT_MS = readPositiveInt("COLD_START_TIMEOUT_MS", 60_000)
const SERVER_OVERRIDE = Bun.env.COLD_START_SERVER?.trim()
const SERVER_COMMAND = SERVER_OVERRIDE
  ? process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", SERVER_OVERRIDE]
    : ["/bin/sh", "-c", SERVER_OVERRIDE]
  : [process.execPath, INDEX, "serve", "--port", "0", "--hostname", HOST]

type ServerProcess = Bun.Subprocess<"ignore", "pipe", "pipe">
type Capture = { stdout: () => string; stderr: () => string }
type ColdRun = { run: number; total: number; listen: number; session: number; messages: number }

const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-cold-start-"))
const project = path.join(root, "project")
const live = new Set<ServerProcess>()
let cleaning = false

const cleanup = async () => {
  if (cleaning) return
  cleaning = true
  for (const proc of live) {
    try {
      await stopServer(proc)
    } catch (error) {
      console.error(`warning: failed to stop server process ${proc.pid}: ${errorMessage(error)}`)
    }
  }
  live.clear()
  await removeRoot(root)
}

process.on("SIGINT", () => void cleanup().finally(() => process.exit(130)))
process.on("SIGTERM", () => void cleanup().finally(() => process.exit(130)))

try {
  await fs.mkdir(project, { recursive: true })
  const env = await makeEnv(root, project)

  console.log("opencode cold-start benchmark")
  console.log(`  project: ${project}`)
  console.log(
    `  server:  ${SERVER_OVERRIDE ?? `${quote(process.execPath)} ${quote(INDEX)} serve --port 0 --hostname ${HOST}`}`,
  )
  console.log(`  runs:    ${RUNS} (timeout ${TIMEOUT_MS}ms)`)
  console.log("")

  const seed = await seedSession(project, env)
  console.log(`seed: session ${seed.sessionID} + 1 user message (noReply), ${formatMs(seed.ms)}ms`)
  console.log("")

  const runs: ColdRun[] = []
  for (let index = 0; index < RUNS; index++) {
    const result = await coldRun(index, seed.sessionID, project, env)
    runs.push(result)
    console.log(
      `run ${result.run}: cold_start=${formatMs(result.total)}ms listen=${formatMs(result.listen)}ms session=${formatMs(result.session)}ms messages=${formatMs(result.messages)}ms`,
    )
  }

  console.log("")
  report(runs, seed.ms)
} finally {
  await cleanup()
}

async function seedSession(project: string, env: Record<string, string>) {
  const started = performance.now()
  const proc = spawnServer(project, env)
  const capture = captureServer(proc)
  const deadline = started + TIMEOUT_MS
  try {
    const port = await waitForListen(proc, capture, deadline)
    const base = `http://${HOST}:${port}`
    await waitForReady(base, project, proc, capture, deadline)

    const create = await fetchUntil(
      `${base}/session`,
      {
        method: "POST",
        headers: sessionHeaders(project, true),
        body: JSON.stringify({ title: "cold-start-seed" }),
      },
      deadline,
    )
    const createText = await create.text()
    if (create.status !== 200) throw new Error(`POST /session returned ${create.status}: ${createText.slice(0, 500)}`)
    const created = JSON.parse(createText) as unknown
    if (!isRecord(created) || typeof created.id !== "string" || created.id.length === 0) {
      throw new Error(`POST /session did not return a session id: ${createText.slice(0, 500)}`)
    }
    const sessionID = created.id

    const message = await fetchUntil(
      `${base}/session/${encodeURIComponent(sessionID)}/message`,
      {
        method: "POST",
        headers: sessionHeaders(project, true),
        body: JSON.stringify({ parts: [{ type: "text", text: SEED_TEXT }], noReply: true }),
      },
      deadline,
    )
    const messageText = await message.text()
    if (message.status !== 200) {
      throw new Error(`POST /session/${sessionID}/message returned ${message.status}: ${messageText.slice(0, 500)}`)
    }
    const admitted = JSON.parse(messageText) as unknown
    if (!isRecord(admitted) || !isRecord(admitted.info) || admitted.info.role !== "user") {
      throw new Error(`seed message was not admitted as a user message: ${messageText.slice(0, 500)}`)
    }
    const parts = admitted.parts
    if (
      !Array.isArray(parts) ||
      !parts.some((part) => isRecord(part) && part.type === "text" && part.text === SEED_TEXT)
    ) {
      throw new Error(`seed message parts do not contain "${SEED_TEXT}": ${messageText.slice(0, 500)}`)
    }

    // 确认没有 assistant 回复，即 noReply 路径没有触发任何 LLM 调用。
    const listed = await fetchUntil(
      `${base}/session/${encodeURIComponent(sessionID)}/message`,
      { headers: sessionHeaders(project) },
      deadline,
    )
    const listedText = await listed.text()
    if (listed.status !== 200) {
      throw new Error(`GET /session/${sessionID}/message returned ${listed.status}: ${listedText.slice(0, 500)}`)
    }
    const messages = JSON.parse(listedText) as unknown
    const only = Array.isArray(messages) && messages.length === 1 ? messages[0] : undefined
    if (!isRecord(only) || !isRecord(only.info) || only.info.role !== "user") {
      throw new Error(`expected exactly one seeded user message, got: ${listedText.slice(0, 500)}`)
    }

    return { sessionID, ms: performance.now() - started }
  } finally {
    await stopServer(proc)
    live.delete(proc)
  }
}

async function coldRun(
  index: number,
  sessionID: string,
  project: string,
  env: Record<string, string>,
): Promise<ColdRun> {
  const started = performance.now()
  const proc = spawnServer(project, env)
  const capture = captureServer(proc)
  const deadline = started + TIMEOUT_MS
  try {
    const port = await waitForListen(proc, capture, deadline)
    const timeToListen = performance.now() - started
    const url = `http://${HOST}:${port}/session/${encodeURIComponent(sessionID)}`
    let lastStatus = "none"
    let lastError = ""

    while (performance.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(`cold server exited with code ${proc.exitCode}\n${tails(capture)}`)
      }
      const requestStarted = performance.now()
      let response: Response
      try {
        response = await fetchUntil(url, { headers: sessionHeaders(project) }, deadline)
      } catch (error) {
        lastError = errorMessage(error)
        await Bun.sleep(50)
        continue
      }
      lastStatus = String(response.status)
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `GET /session/${sessionID} returned ${response.status}; the child inherited server auth settings`,
        )
      }
      if (response.status !== 200) {
        lastError = (await response.text()).slice(0, 500)
        await Bun.sleep(50)
        continue
      }
      const body = (await response.json()) as unknown
      if (!isRecord(body) || body.id !== sessionID) {
        throw new Error(`GET returned session ${isRecord(body) ? String(body.id) : "unknown"}, expected ${sessionID}`)
      }
      const session = performance.now() - started
      const messagesAt = performance.now()
      const messages = await fetchUntil(`${url}/message`, { headers: sessionHeaders(project) }, deadline)
      const messagesText = await messages.text()
      if (messages.status !== 200) {
        throw new Error(`GET /session/${sessionID}/message returned ${messages.status}: ${messagesText.slice(0, 500)}`)
      }
      const list = JSON.parse(messagesText) as unknown
      if (
        !Array.isArray(list) ||
        !list.some(
          (item) =>
            isRecord(item) &&
            Array.isArray(item.parts) &&
            item.parts.some((part) => isRecord(part) && part.type === "text" && part.text === SEED_TEXT),
        )
      ) {
        throw new Error(`seed conversation was not returned: ${messagesText.slice(0, 500)}`)
      }
      return {
        run: index + 1,
        total: performance.now() - started,
        listen: timeToListen,
        session,
        messages: performance.now() - messagesAt,
      }
    }

    throw new Error(
      `cold run ${index + 1} timed out after ${TIMEOUT_MS}ms (last HTTP ${lastStatus}, ${lastError})\n${tails(capture)}`,
    )
  } finally {
    await stopServer(proc)
    live.delete(proc)
  }
}

async function waitForReady(base: string, project: string, proc: ServerProcess, capture: Capture, deadline: number) {
  let lastStatus = "none"
  let lastError = ""
  while (performance.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`setup server exited with code ${proc.exitCode} before becoming ready\n${tails(capture)}`)
    }
    try {
      const response = await fetchUntil(`${base}/session`, { headers: sessionHeaders(project) }, deadline)
      lastStatus = String(response.status)
      const text = await response.text()
      if (response.status === 200) return
      lastError = text.slice(0, 500)
    } catch (error) {
      lastError = errorMessage(error)
    }
    await Bun.sleep(50)
  }
  throw new Error(`setup server did not become ready (last HTTP ${lastStatus}, ${lastError})\n${tails(capture)}`)
}

async function waitForListen(proc: ServerProcess, capture: Capture, deadline: number) {
  while (performance.now() < deadline) {
    const match = capture.stdout().match(/opencode server listening on https?:\/\/([^\s/:]+):(\d+)/)
    if (match) return Number(match[2])
    if (proc.exitCode !== null) {
      throw new Error(`server exited with code ${proc.exitCode} before listening\n${tails(capture)}`)
    }
    await Bun.sleep(25)
  }
  throw new Error(`timed out after ${TIMEOUT_MS}ms waiting for the server listen line\n${tails(capture)}`)
}

async function makeEnv(root: string, project: string) {
  const dirs = {
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    OPENCODE_TEST_HOME: path.join(root, "home"),
  }
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // 继承的 OPENCODE_* 通常来自当前运行中的 opencode 应用；OPENCODE_SERVER_PASSWORD 会让子服务
    // 强制启用 Basic Auth，健康检查将得到 401。基准测试必须使用干净的隔离环境。
    if (key.startsWith("OPENCODE_")) continue
    if (key.startsWith("XDG_")) continue
    env[key] = value
  }
  Object.assign(env, dirs)
  env.PWD = project
  env.OPENCODE_DISABLE_MODELS_FETCH = "1"
  env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  // noReply 的 seed 消息仍会解析默认模型；提供假模型避免依赖本机 provider/auth（不会触发 LLM 调用）。
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: SEED_MODEL })
  return env
}

function spawnServer(project: string, env: Record<string, string>) {
  const proc: ServerProcess = Bun.spawn(SERVER_COMMAND, {
    cwd: project,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  live.add(proc)
  return proc
}

function captureServer(proc: ServerProcess): Capture {
  const out: string[] = []
  const err: string[] = []
  drain(proc.stdout, out)
  drain(proc.stderr, err)
  return { stdout: () => out.join(""), stderr: () => err.join("") }
}

function drain(stream: ReadableStream<Uint8Array<ArrayBuffer>>, sink: string[]) {
  const decoder = new TextDecoder()
  void (async () => {
    const reader = stream.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return
        if (chunk.value) sink.push(decoder.decode(chunk.value, { stream: true }))
      }
    } catch {
      // 进程被强杀时流会报错，忽略即可。
    } finally {
      reader.releaseLock()
    }
  })()
}

async function stopServer(proc: ServerProcess) {
  if (proc.exitCode !== null) return
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    await Promise.race([proc.exited, Bun.sleep(3_000)])
    return
  }
  try {
    proc.kill("SIGTERM")
  } catch {}
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(3_000).then(() => false)])
  if (exited) return
  try {
    proc.kill("SIGKILL")
  } catch {}
  await Promise.race([proc.exited, Bun.sleep(2_000)])
}

async function removeRoot(root: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(root, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 4) {
        console.error(`warning: failed to remove ${root}: ${errorMessage(error)}`)
        return
      }
      await Bun.sleep(200)
    }
  }
}

function sessionHeaders(project: string, json = false) {
  return {
    "x-opencode-directory": project,
    ...(json ? { "content-type": "application/json" } : {}),
  }
}

function fetchUntil(url: string, init: RequestInit, deadline: number) {
  const remaining = Math.max(1, Math.ceil(deadline - performance.now()))
  return fetch(url, { ...init, signal: AbortSignal.timeout(remaining) })
}

function tails(capture: Capture) {
  const stdout = capture.stdout().trim()
  const stderr = capture.stderr().trim()
  return [
    stdout ? `stdout:\n${stdout.slice(-2_000)}` : "stdout: <empty>",
    stderr ? `stderr:\n${stderr.slice(-2_000)}` : "stderr: <empty>",
  ].join("\n")
}

function report(runs: ColdRun[], seedMs: number) {
  const total = runs.map((run) => run.total)
  const listen = runs.map((run) => run.listen)
  const session = runs.map((run) => run.session)
  const messages = runs.map((run) => run.messages)
  const min = Math.min(...total)
  const max = Math.max(...total)
  const mean = total.reduce((sum, value) => sum + value, 0) / total.length
  const p50 = percentile(total, 50)
  const p95 = percentile(total, 95)
  console.log(
    `summary: cold_start min=${formatMs(min)} p50=${formatMs(p50)} p95=${formatMs(p95)} max=${formatMs(max)} mean=${formatMs(mean)}`,
  )
  console.log(`         listen      p50=${formatMs(percentile(listen, 50))} p95=${formatMs(percentile(listen, 95))}`)
  console.log(`         session     p50=${formatMs(percentile(session, 50))} p95=${formatMs(percentile(session, 95))}`)
  console.log(
    `         messages    p50=${formatMs(percentile(messages, 50))} p95=${formatMs(percentile(messages, 95))}`,
  )
  console.log("")
  console.log(`METRIC cold_start_runs=${runs.length}`)
  console.log(`METRIC cold_start_timeout_ms=${TIMEOUT_MS}`)
  console.log(`METRIC cold_start_min_ms=${formatMs(min)}`)
  console.log(`METRIC cold_start_p50_ms=${formatMs(p50)}`)
  console.log(`METRIC cold_start_p95_ms=${formatMs(p95)}`)
  console.log(`METRIC cold_start_max_ms=${formatMs(max)}`)
  console.log(`METRIC cold_start_mean_ms=${formatMs(mean)}`)
  console.log(`METRIC cold_start_time_to_listen_p50_ms=${formatMs(percentile(listen, 50))}`)
  console.log(`METRIC cold_start_time_to_listen_p95_ms=${formatMs(percentile(listen, 95))}`)
  console.log(`METRIC cold_start_session_p50_ms=${formatMs(percentile(session, 50))}`)
  console.log(`METRIC cold_start_session_p95_ms=${formatMs(percentile(session, 95))}`)
  console.log(`METRIC cold_start_messages_p50_ms=${formatMs(percentile(messages, 50))}`)
  console.log(`METRIC cold_start_messages_p95_ms=${formatMs(percentile(messages, 95))}`)
  console.log(`METRIC cold_start_seed_session_ms=${formatMs(seedMs)}`)
}

function percentile(values: number[], p: number) {
  const sorted = values.toSorted((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readPositiveInt(name: string, fallback: number) {
  const raw = Bun.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`${name} must be a positive integer, got: ${raw}`)
    process.exit(1)
  }
  return value
}

function formatMs(value: number) {
  return value.toFixed(1)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function quote(value: string) {
  return /\s/.test(value) ? JSON.stringify(value) : value
}
