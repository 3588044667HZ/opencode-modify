// HTTP/SSE load-test harness for a running OpenCode server.
// Client-only: this script never starts or stops the server.
//
// Env:
//   OPENCODE_URL          base URL (default http://127.0.0.1:4096)
//   BENCH_MODE            http | sse (default http)
//   BENCH_CONCURRENCY     closed-loop workers / SSE connections (default 10)
//   BENCH_DURATION_MS     measured duration (default 10000)
//   BENCH_WARMUP_MS       warmup duration, results discarded (default 1000)
//   BENCH_REQUEST_TIMEOUT_MS  per-request timeout (default 10000)
//   BENCH_PATH            target path override (GET only)
//   SESSION_ID            target /session/<id> when BENCH_PATH is unset
//   OPENCODE_AUTH         user:password for Basic auth
//   OPENCODE_DIRECTORY    x-opencode-directory header value
//
// Examples:
//   bun run packages/opencode/script/bench-load.ts
//   BENCH_CONCURRENCY=32 BENCH_DURATION_MS=30000 bun run packages/opencode/script/bench-load.ts
//   BENCH_MODE=sse BENCH_PATH=/event bun run packages/opencode/script/bench-load.ts
//   SESSION_ID=ses_123 OPENCODE_AUTH=user:pass bun run packages/opencode/script/bench-load.ts

const DEFAULT_URL = "http://127.0.0.1:4096"
const RECONNECT_DELAY_MS = 250

type Mode = "http" | "sse"

interface Config {
  mode: Mode
  target: string
  concurrency: number
  durationMs: number
  warmupMs: number
  requestTimeoutMs: number
  headers: Record<string, string>
}

interface HttpResult {
  count: number
  errors: number
  statuses: Map<number, number>
  failures: Map<string, number>
  latencies: number[]
  startedAt: number
  endedAt: number
}

interface SseResult {
  attempts: number
  successes: number
  failures: number
  events: number
  disconnects: number
  reconnects: number
  firstEventLatencies: number[]
  failuresByReason: Map<string, number>
  startedAt: number
  endedAt: number
}

try {
  await main()
} catch (error) {
  console.error(`bench-load: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

async function main() {
  const config = readConfig()
  console.log(
    `bench-load mode=${config.mode} target=${config.target} concurrency=${config.concurrency} warmup_ms=${config.warmupMs} duration_ms=${config.durationMs}`,
  )

  if (config.warmupMs > 0) {
    if (config.mode === "http") {
      const warmup = await runHttp(config, performance.now() + config.warmupMs)
      console.log(`warmup requests=${warmup.count} errors=${warmup.errors}`)
    } else {
      const warmup = await runSse(config, performance.now() + config.warmupMs)
      console.log(`warmup connections=${warmup.successes} failures=${warmup.failures} events=${warmup.events}`)
    }
  }

  const deadline = performance.now() + config.durationMs
  if (config.mode === "http") reportHttp(await runHttp(config, deadline))
  else reportSse(await runSse(config, deadline))
}

function readConfig(): Config {
  const mode = (Bun.env.BENCH_MODE ?? "http").toLowerCase()
  if (mode !== "http" && mode !== "sse") throw new Error("BENCH_MODE must be http or sse")

  const concurrency = integerEnv("BENCH_CONCURRENCY", 10, 1)
  const durationMs = integerEnv("BENCH_DURATION_MS", 10_000, 1)
  const warmupMs = integerEnv("BENCH_WARMUP_MS", 1_000, 0)
  const requestTimeoutMs = integerEnv("BENCH_REQUEST_TIMEOUT_MS", 10_000, 1)

  const base = (Bun.env.OPENCODE_URL ?? DEFAULT_URL).replace(/\/+$/, "")
  const baseURL = new URL(base)
  if (baseURL.protocol !== "http:" && baseURL.protocol !== "https:") {
    throw new Error("OPENCODE_URL must be an http(s) URL")
  }

  const sessionPath = Bun.env.SESSION_ID ? `/session/${encodeURIComponent(Bun.env.SESSION_ID)}` : "/global/health"
  const path = Bun.env.BENCH_PATH ?? (mode === "sse" ? "/event" : sessionPath)
  if (!path.startsWith("/")) throw new Error("BENCH_PATH must start with /")
  if (mode === "http" && !isHttpGetPath(new URL(path, "http://bench.invalid").pathname)) {
    throw new Error("BENCH_PATH must be one of /global/health, /project, /session, /session/<id> for HTTP mode")
  }

  const headers: Record<string, string> = { accept: mode === "sse" ? "text/event-stream" : "application/json" }
  if (Bun.env.OPENCODE_AUTH) headers.authorization = `Basic ${Buffer.from(Bun.env.OPENCODE_AUTH).toString("base64")}`
  if (Bun.env.OPENCODE_DIRECTORY) {
    headers["x-opencode-directory"] = encodeURIComponent(Bun.env.OPENCODE_DIRECTORY)
  }

  return { mode, target: base + path, concurrency, durationMs, warmupMs, requestTimeoutMs, headers }
}

function integerEnv(name: string, fallback: number, min: number) {
  const raw = Bun.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`)
  return value
}

function isHttpGetPath(pathname: string) {
  if (pathname === "/global/health" || pathname === "/project" || pathname === "/session") return true
  return /^\/session\/[^/]+(?:\/(?:message|children|todo))?$/.test(pathname)
}

async function runHttp(config: Config, deadline: number): Promise<HttpResult> {
  const result: HttpResult = {
    count: 0,
    errors: 0,
    statuses: new Map(),
    failures: new Map(),
    latencies: [],
    startedAt: performance.now(),
    endedAt: 0,
  }

  const worker = async () => {
    while (true) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) return

      const started = performance.now()
      try {
        const response = await fetch(config.target, {
          method: "GET",
          headers: config.headers,
          redirect: "manual",
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        })
        await response.arrayBuffer()
        const latency = performance.now() - started

        result.count++
        result.latencies.push(latency)
        addCount(result.statuses, response.status)
        if (response.status < 200 || response.status >= 300) {
          result.errors++
          addCount(result.failures, `http_${response.status}`)
        }
      } catch (error) {
        result.count++
        result.errors++
        result.latencies.push(performance.now() - started)
        addCount(result.failures, errorName(error))
      }
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, worker))
  result.endedAt = performance.now()
  return result
}

async function runSse(config: Config, deadline: number): Promise<SseResult> {
  const result: SseResult = {
    attempts: 0,
    successes: 0,
    failures: 0,
    events: 0,
    disconnects: 0,
    reconnects: 0,
    firstEventLatencies: [],
    failuresByReason: new Map(),
    startedAt: performance.now(),
    endedAt: 0,
  }

  const worker = async () => {
    let firstAttempt = true
    while (performance.now() < deadline) {
      if (!firstAttempt) result.reconnects++
      firstAttempt = false
      result.attempts++

      const started = performance.now()
      let connected = false
      try {
        const remaining = deadline - performance.now()
        if (remaining <= 0) return
        const response = await fetch(config.target, {
          method: "GET",
          headers: config.headers,
          redirect: "manual",
          signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining))),
        })
        const contentType = response.headers.get("content-type") ?? ""

        if (!response.ok) {
          result.failures++
          addCount(result.failuresByReason, `http_${response.status}`)
          await discard(response.body)
        } else if (!contentType.startsWith("text/event-stream")) {
          result.failures++
          addCount(result.failuresByReason, "content_type")
          await discard(response.body)
        } else if (!response.body) {
          result.failures++
          addCount(result.failuresByReason, "missing_body")
        } else {
          connected = true
          result.successes++
          let firstEvent = true
          await readEvents(response.body, () => {
            result.events++
            if (!firstEvent) return
            firstEvent = false
            result.firstEventLatencies.push(performance.now() - started)
          })
          if (performance.now() < deadline) result.disconnects++
        }
      } catch (error) {
        if (connected) {
          if (performance.now() < deadline) result.disconnects++
        } else {
          result.failures++
          addCount(result.failuresByReason, errorName(error))
        }
      }

      const pause = Math.min(RECONNECT_DELAY_MS, deadline - performance.now())
      if (pause > 0) await Bun.sleep(pause)
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, worker))
  result.endedAt = performance.now()
  return result
}

async function readEvents(body: ReadableStream<Uint8Array>, onEvent: () => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let hasData = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        if (line === "") {
          if (hasData) {
            hasData = false
            onEvent()
          }
        } else if (line.startsWith("data:")) {
          hasData = true
        }
        newline = buffer.indexOf("\n")
      }
    }
    if (hasData) onEvent()
  } finally {
    reader.releaseLock()
  }
}

async function discard(body: ReadableStream<Uint8Array> | null) {
  if (!body) return
  try {
    await body.cancel()
  } catch {
    // 连接已被中止或 body 已失效，无需处理
  }
}

function reportHttp(result: HttpResult) {
  const elapsed = result.endedAt - result.startedAt
  const seconds = elapsed / 1000
  const latencies = result.latencies.toSorted((a, b) => a - b)
  const p50 = percentile(latencies, 0.5)
  const p95 = percentile(latencies, 0.95)
  const p99 = percentile(latencies, 0.99)
  const max = latencies.at(-1) ?? 0
  const rps = seconds > 0 ? result.count / seconds : 0
  const errorRate = result.count > 0 ? (result.errors / result.count) * 100 : 0

  console.log(
    `http count=${result.count} elapsed_ms=${elapsed.toFixed(0)} rps=${rps.toFixed(2)} errors=${result.errors} error_rate=${errorRate.toFixed(2)}%`,
  )
  console.log(`http latency_ms p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} p99=${p99.toFixed(2)} max=${max.toFixed(2)}`)
  console.log(`http status ${formatNumberCounts(result.statuses)}`)
  if (result.failures.size > 0) console.log(`http failures ${formatNameCounts(result.failures)}`)

  for (const line of [
    `http_requests_total=${result.count}`,
    `http_errors_total=${result.errors}`,
    `http_error_rate_pct=${errorRate.toFixed(3)}`,
    `http_rps=${rps.toFixed(3)}`,
    `http_latency_p50_ms=${p50.toFixed(3)}`,
    `http_latency_p95_ms=${p95.toFixed(3)}`,
    `http_latency_p99_ms=${p99.toFixed(3)}`,
    `http_latency_max_ms=${max.toFixed(3)}`,
    `http_duration_ms=${elapsed.toFixed(0)}`,
  ]) {
    console.log(`METRIC ${line}`)
  }
}

function reportSse(result: SseResult) {
  const elapsed = result.endedAt - result.startedAt
  const seconds = elapsed / 1000
  const firstEvent = result.firstEventLatencies.toSorted((a, b) => a - b)
  const p50 = percentile(firstEvent, 0.5)
  const p95 = percentile(firstEvent, 0.95)
  const max = firstEvent.at(-1) ?? 0
  const eventsPerSecond = seconds > 0 ? result.events / seconds : 0

  console.log(
    `sse connections=${result.attempts} successes=${result.successes} failures=${result.failures} events=${result.events} disconnects=${result.disconnects} reconnects=${result.reconnects} elapsed_ms=${elapsed.toFixed(0)}`,
  )
  console.log(
    `sse first_event_ms p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} max=${max.toFixed(2)} samples=${firstEvent.length}`,
  )
  if (result.failuresByReason.size > 0) {
    console.log(`sse failures ${formatNameCounts(result.failuresByReason)}`)
  }

  for (const line of [
    `sse_connection_attempts_total=${result.attempts}`,
    `sse_connection_successes_total=${result.successes}`,
    `sse_connection_failures_total=${result.failures}`,
    `sse_events_total=${result.events}`,
    `sse_events_per_sec=${eventsPerSecond.toFixed(3)}`,
    `sse_disconnects_total=${result.disconnects}`,
    `sse_reconnect_attempts_total=${result.reconnects}`,
    `sse_first_event_p50_ms=${p50.toFixed(3)}`,
    `sse_first_event_p95_ms=${p95.toFixed(3)}`,
    `sse_first_event_max_ms=${max.toFixed(3)}`,
    `sse_duration_ms=${elapsed.toFixed(0)}`,
  ]) {
    console.log(`METRIC ${line}`)
  }
}

function percentile(sorted: number[], fraction: number) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

function addCount<K>(counts: Map<K, number>, key: K) {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function formatNumberCounts(counts: Map<number, number>) {
  const values = [...counts.entries()].toSorted((a, b) => a[0] - b[0])
  return values.length > 0 ? values.map(([key, count]) => `${key}=${count}`).join(" ") : "(none)"
}

function formatNameCounts(counts: Map<string, number>) {
  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}=${count}`)
    .join(" ")
}

function errorName(error: unknown) {
  return error instanceof Error && error.name ? error.name : "Unknown"
}
