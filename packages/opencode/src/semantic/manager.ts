import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Process } from "@/util/process"
import { SemanticEvent } from "@opencode-ai/schema/semantic-event"
import { Cause, Context, Effect, Layer, Queue, Stream } from "effect"
import { createHash } from "crypto"
import fs from "node:fs/promises"
import os from "os"
import path from "path"
import * as Client from "./client"
import * as Protocol from "./protocol"

export const Event = SemanticEvent

export type Status = "disabled" | "starting" | "indexing" | "ready" | "failed"

export interface StatusInfo {
  readonly status: Status
  readonly progress: number
  readonly phase?: string
  readonly current?: string
  readonly error?: string
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<StatusInfo>
  readonly readView: (input: Protocol.ReadViewRequest) => Effect.Effect<Protocol.ReadViewResult, Protocol.SemanticError>
  readonly blastRadius: (input: Protocol.BlastRadiusRequest) => Effect.Effect<Protocol.BlastRadiusResult, Protocol.SemanticError>
  readonly editBatch: (input: Protocol.EditBatchRequest) => Effect.Effect<Protocol.EditBatchResult, Protocol.SemanticError>
  readonly editTransaction: (
    input: Protocol.EditTransactionRequest,
  ) => Effect.Effect<Protocol.EditTransactionResult, Protocol.SemanticError>
  readonly projectMap: (input: Protocol.ProjectMapRequest) => Effect.Effect<Protocol.ProjectMapResult, Protocol.SemanticError>
  readonly verifyTest: (input: Protocol.VerifyTestRequest) => Effect.Effect<Protocol.VerifyTestResult, Protocol.SemanticError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Semantic") {}

interface State {
  status: Status
  progress: number
  phase?: string
  current?: string
  error?: string
  client?: Client.Client
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsutil = yield* FSUtil.Service

    const publish = (s: State) =>
      events.publish(SemanticEvent.Indexing, {
        status: s.status === "disabled" ? ("failed" as const) : s.status,
        progress: s.progress,
        ...(s.current === undefined ? {} : { current: s.current }),
        ...(s.phase === undefined ? {} : { phase: s.phase }),
        ...(s.error === undefined ? {} : { error: s.error }),
      })

    const state = yield* InstanceState.make<State>(
      Effect.fn("Semantic.state")(function* (ctx) {
        const semantic = (yield* config.get()).semantic
        if (semantic?.enabled !== true) return { status: "disabled", progress: 0 } satisfies State
        if (!semantic.command || semantic.command.length === 0) {
          const s: State = { status: "failed", progress: 0, error: "semantic.command is not configured" }
          yield* publish(s)
          return s
        }

        const s: State = { status: "starting", progress: 0 }
        const socket = socketPathFor(ctx.directory, semantic.socket_dir)
        if (socket.dir) yield* fsutil.ensureDir(socket.dir).pipe(Effect.orDie)

        // socket 名按目录稳定：同项目已运行的守护（例如另一个 opencode server 进程先前
        // spawn 的实例）直接复用，不再 spawn。跨进程复用同一守护是可接受行为。
        const existing = yield* Effect.tryPromise({
          try: () => Client.connect(socket.path, { connect_timeout_ms: 500 }),
          catch: Protocol.toSemanticError,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const spawned = existing === undefined
        if (existing) {
          yield* Effect.logInfo("reusing existing daemon", { socket: socket.path })
        } else {
          // 连接失败但文件仍在：崩溃/退出残留的陈旧 socket，删除后再 spawn。
          yield* Effect.promise(() => fs.unlink(socket.path).catch(() => {}))
        }
        const child = spawned
          ? Process.spawn([...semantic.command, ctx.directory, socket.path], {
              cwd: ctx.directory,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              env:
                semantic.idle_timeout_ms === undefined
                  ? undefined
                  : { OPENCODE_SEMANTIC_IDLE_TIMEOUT_MS: String(semantic.idle_timeout_ms) },
            })
          : undefined

        yield* publish(s)

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            const client = s.client
            s.client = undefined
            // 复用的守护归最先启动它的实例所有：dispose 只断开连接，不发 shutdown、不删 socket，
            // 留给它的主父进程或守护自身的空闲超时回收。
            if (client && spawned) {
              // Never let a hung daemon stall instance disposal; kill it via
              // Process.stop below when shutdown does not answer quickly.
              await Promise.race([client.shutdown().catch(() => {}), new Promise((done) => setTimeout(done, 2_000))])
            }
            client?.close()
            if (!spawned) return
            if (child) await Process.stop(child)
            if (socket.dir) await fs.unlink(socket.path).catch(() => {})
          }),
        )

        yield* Effect.forkScoped(supervise(s, child, socket.path, existing))
        return s
      }),
    )

    const supervise = (s: State, child: Process.Child | undefined, socketPath: string, existing?: Client.Client) =>
      Effect.gen(function* () {
        const client = existing ?? (yield* waitForClient(child, socketPath))
        s.client = client
        yield* Effect.tryPromise({ try: () => client.subscribe(), catch: Protocol.toSemanticError })

        const notifications = yield* Queue.unbounded<Protocol.IndexingNotification>()
        const stopped = yield* Queue.unbounded<void>()
        client.onIndexing((notification) => {
          Queue.offerUnsafe(notifications, notification)
        })
        client.onClose(() => {
          Queue.offerUnsafe(stopped, undefined)
        })
        yield* Effect.forkScoped(
          Stream.fromQueue(notifications).pipe(
            Stream.runForEach((notification) =>
              Effect.suspend(() => (applyNotification(s, notification) ? publish(s) : Effect.void)),
            ),
          ),
        )

        const first = yield* Effect.tryPromise({ try: () => client.ping(), catch: Protocol.toSemanticError })
        if (applyPing(s, first)) yield* publish(s)

        while (s.status === "indexing") {
          yield* Effect.sleep(Protocol.Defaults.indexPollIntervalMs)
          const ping = yield* Effect.tryPromise({ try: () => client.ping(), catch: Protocol.toSemanticError })
          if (applyPing(s, ping)) yield* publish(s)
        }

        if (s.status !== "ready") return
        // 复用的守护没有子进程句柄：进程消失只能通过连接关闭（stopped）观测。
        const gone = child
          ? Effect.raceFirst(Effect.promise(() => child.exited), Queue.take(stopped))
          : Queue.take(stopped)
        yield* gone
        if (s.status !== "ready") return
        s.status = "failed"
        s.error = "semantic daemon stopped"
        yield* publish(s)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterruptsOnly(cause)) return
            s.status = "failed"
            s.error = causeMessage(cause)
            yield* publish(s)
          }),
        ),
      )

    const init = Effect.fn("Semantic.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("Semantic.status")(function* () {
      const s = yield* InstanceState.get(state)
      return {
        status: s.status,
        progress: s.progress,
        ...(s.phase === undefined ? {} : { phase: s.phase }),
        ...(s.current === undefined ? {} : { current: s.current }),
        ...(s.error === undefined ? {} : { error: s.error }),
      }
    })

    const readView = Effect.fn("Semantic.readView")(function* (input: Protocol.ReadViewRequest) {
      const s = yield* InstanceState.get(state)
      if (s.status === "disabled") {
        return yield* new Protocol.UnavailableError({
          message: "semantic engine is disabled; set `semantic.enabled` in the opencode config to use read_view",
        })
      }
      if (s.status === "failed") {
        return yield* new Protocol.UnavailableError({
          message: `semantic engine failed: ${s.error ?? "unknown error"}`,
          progress: s.progress,
        })
      }
      const client = s.client
      if (s.status !== "ready" || !client) {
        return yield* new Protocol.UnavailableError({
          message: `semantic engine is not ready yet (status: ${s.status})`,
          progress: s.progress,
        })
      }
      return yield* Effect.tryPromise({ try: () => client.readView(input), catch: Protocol.toSemanticError })
    })

    const blastRadius = Effect.fn("Semantic.blastRadius")(function* (input: Protocol.BlastRadiusRequest) {
      const s = yield* InstanceState.get(state)
      if (s.status === "disabled") {
        return yield* new Protocol.UnavailableError({
          message: "semantic engine is disabled; set `semantic.enabled` in the opencode config to use blast_radius",
        })
      }
      if (s.status === "failed") {
        return yield* new Protocol.UnavailableError({
          message: `semantic engine failed: ${s.error ?? "unknown error"}`,
          progress: s.progress,
        })
      }
      const client = s.client
      if (s.status !== "ready" || !client) {
        return yield* new Protocol.UnavailableError({
          message: `semantic engine is not ready yet (status: ${s.status})`,
          progress: s.progress,
        })
      }
      return yield* Effect.tryPromise({ try: () => client.blastRadius(input), catch: Protocol.toSemanticError })
    })

    const editBatch = Effect.fn("Semantic.editBatch")(function* (input: Protocol.EditBatchRequest) {
      const s = yield* InstanceState.get(state)
      if (s.status === "disabled") {
        return yield* new Protocol.UnavailableError({
          message: "semantic engine is disabled; set `semantic.enabled` in the opencode config to use edit_batch",
        })
      }
      if (s.status === "failed") {
        return yield* new Protocol.UnavailableError({
          message: `semantic engine failed: ${s.error ?? "unknown error"}`,
          progress: s.progress,
        })
      }
      const client = s.client
      if (s.status !== "ready" || !client) {
        return yield* new Protocol.UnavailableError({
          message: `semantic engine is not ready yet (status: ${s.status})`,
          progress: s.progress,
        })
      }
      return yield* Effect.tryPromise({ try: () => client.editBatch(input), catch: Protocol.toSemanticError })
    })

    const editTransaction = Effect.fn("Semantic.editTransaction")(function* (input: Protocol.EditTransactionRequest) {
      const s = yield* InstanceState.get(state)
      if (s.status === "disabled") {
        return yield* new Protocol.UnavailableError({
          message:
            "semantic engine is disabled; set `semantic.enabled` in the opencode config to use edit_transaction",
        })
      }
      if (s.status === "failed") {
        return yield* new Protocol.UnavailableError({
          message: `semantic engine failed: ${s.error ?? "unknown error"}`,
          progress: s.progress,
        })
      }
      const client = s.client
      if (s.status !== "ready" || !client) {
        return yield* new Protocol.UnavailableError({
          message: `semantic engine is not ready yet (status: ${s.status})`,
          progress: s.progress,
        })
      }
      return yield* Effect.tryPromise({ try: () => client.editTransaction(input), catch: Protocol.toSemanticError })
    })

    const projectMap = Effect.fn("Semantic.projectMap")(function* (input: Protocol.ProjectMapRequest) {
      const s = yield* InstanceState.get(state)
      if (s.status === "disabled") {
        return yield* new Protocol.UnavailableError({
          message: "semantic engine is disabled; set `semantic.enabled` in the opencode config to use project_map",
        })
      }
      if (s.status === "failed") {
        return yield* new Protocol.UnavailableError({
          message: `semantic engine failed: ${s.error ?? "unknown error"}`,
          progress: s.progress,
        })
      }
      const client = s.client
      if (s.status !== "ready" || !client) {
        return yield* new Protocol.UnavailableError({
          message: `semantic engine is not ready yet (status: ${s.status})`,
          progress: s.progress,
        })
      }
      return yield* Effect.tryPromise({ try: () => client.projectMap(input), catch: Protocol.toSemanticError })
    })

    const verifyTest = Effect.fn("Semantic.verifyTest")(function* (input: Protocol.VerifyTestRequest) {
      const s = yield* InstanceState.get(state)
      if (s.status === "disabled") {
        return yield* new Protocol.UnavailableError({
          message: "semantic engine is disabled; set `semantic.enabled` in the opencode config to use verify_test",
        })
      }
      if (s.status === "failed") {
        return yield* new Protocol.UnavailableError({
          message: `semantic engine failed: ${s.error ?? "unknown error"}`,
          progress: s.progress,
        })
      }
      const client = s.client
      if (s.status !== "ready" || !client) {
        return yield* new Protocol.UnavailableError({
          message: `semantic engine is not ready yet (status: ${s.status})`,
          progress: s.progress,
        })
      }
      return yield* Effect.tryPromise({ try: () => client.verifyTest(input), catch: Protocol.toSemanticError })
    })

    return Service.of({ init, status, readView, blastRadius, editBatch, editTransaction, projectMap, verifyTest })
  }),
)

const waitForClient = (child: Process.Child | undefined, socketPath: string) =>
  Effect.gen(function* () {
    let exitCode: number | undefined
    let spawnError: Error | undefined
    if (child) {
      void child.exited.then(
        (code) => {
          exitCode = code
        },
        (error: unknown) => {
          spawnError = error instanceof Error ? error : new Error(String(error))
        },
      )
    }
    const deadline = Date.now() + Protocol.Defaults.socketReadyTimeoutMs
    while (true) {
      if (spawnError) {
        return yield* new Protocol.ConnectionError({
          message: `failed to spawn semantic daemon: ${spawnError.message}`,
        })
      }
      if (exitCode !== undefined) {
        return yield* new Protocol.ConnectionError({
          message: `semantic daemon exited with code ${exitCode} before becoming ready`,
        })
      }
      const client = yield* Effect.tryPromise({
        try: () => Client.connect(socketPath, { connect_timeout_ms: 500 }),
        catch: Protocol.toSemanticError,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (client) return client
      if (Date.now() > deadline) {
        return yield* new Protocol.ConnectionError({
          message: `semantic daemon did not become ready within ${Protocol.Defaults.socketReadyTimeoutMs}ms`,
        })
      }
      yield* Effect.sleep(Protocol.Defaults.socketRetryIntervalMs)
    }
  })

function applyPing(s: State, ping: Protocol.PingResult) {
  const status: Status = ping.indexing ? (s.status === "starting" ? "indexing" : s.status) : "ready"
  const changed =
    s.status !== status || s.progress !== ping.progress || s.phase !== ping.phase || s.current !== ping.current
  s.status = status
  s.progress = ping.progress
  s.phase = ping.phase
  s.current = ping.current
  return changed
}

function applyNotification(s: State, notification: Protocol.IndexingNotification) {
  const changed =
    s.progress !== notification.progress || s.phase !== notification.phase || s.current !== notification.current
  s.progress = notification.progress
  s.phase = notification.phase
  s.current = notification.current
  return changed && s.status !== "failed"
}

function causeMessage(cause: Cause.Cause<Protocol.SemanticError>) {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

export function socketPathFor(directory: string, socketDir?: string): { path: string; dir?: string } {
  // 稳定 per-directory socket 名（无 pid/counter）：同项目不同 opencode 进程可复用同一守护。
  // 目录先 resolve/normalize，Windows 下统一小写，保证盘符/大小写/分隔符写法不同仍命中同一 socket。
  const resolved = path.normalize(path.resolve(directory))
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 10)
  // Windows 下守护进程（Java AF_UNIX）不能绑定命名管道路径，只能绑文件路径；
  // Bun 两端都支持文件路径，因此所有平台统一用 socket 文件。
  const dir = socketDir ?? os.tmpdir()
  return { path: path.join(dir, `opencode-semantic-${hash}.sock`), dir }
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, EventV2Bridge.node, FSUtil.node],
})

export * as Semantic from "./manager"
