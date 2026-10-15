import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Process } from "@/util/process"
import { SemanticEvent } from "@opencode-ai/schema/semantic-event"
import { Cause, Context, Effect, Layer, Queue, Scope, Semaphore, Stream } from "effect"
import { createHash } from "crypto"
import fs from "node:fs/promises"
import os from "os"
import path from "path"
import * as Client from "./client"
import * as Protocol from "./protocol"

export const Event = SemanticEvent

// idle 是惰性拉起的初始态：守护尚未启动，也还没有任何 warmup 事件；
// starting/indexing/ready/failed 与 semantic.indexing 事件语义一一对应。
export type Status = "disabled" | "idle" | "starting" | "indexing" | "ready" | "failed"

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

// 全局 spawn 串行闸门：所有目录共用，同一时刻最多一个目录处于“拉起 + 等待可连接”阶段。
// 桌面应用恢复大量工作区时会话首次用到语义工具才惰性拉起；没有这道闸门，
// 多个平台守护（每个 -Xmx2048m）会同时冷启动+索引，打满 CPU/内存并造成 socket 等待超时。
const spawnGate = Semaphore.makeUnsafe(1)

// failed 不是终态：距上次失败超过冷却后，下一次请求重置为 idle 重新拉起。
// 模块级可注入（测试缩短冷却）；生产默认 30s。
export const RetryPolicy = {
  failedCooldownMs: 30_000,
}

interface State {
  readonly directory: string
  readonly command: readonly string[]
  readonly socket: { readonly path: string; readonly dir?: string }
  readonly idleTimeoutMs?: number
  readonly scope: Scope.Scope
  status: Status
  progress: number
  phase?: string
  current?: string
  error?: string
  failureAt?: number
  client?: Client.Client
  child?: Process.Child
  spawned: boolean
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsutil = yield* FSUtil.Service

    // idle/disabled 没有任何可发布的事件语义（事件流只在真正拉起后出现），
    // 因此只对 starting/indexing/ready/failed 发布。
    const publish = (s: State) => {
      const status = s.status
      if (status !== "starting" && status !== "indexing" && status !== "ready" && status !== "failed") return Effect.void
      return events.publish(SemanticEvent.Indexing, {
        status,
        progress: s.progress,
        ...(s.current === undefined ? {} : { current: s.current }),
        ...(s.phase === undefined ? {} : { phase: s.phase }),
        ...(s.error === undefined ? {} : { error: s.error }),
      })
    }

    // 清理失败/停止后的守护现场：本进程 spawn 的子进程按所有权停止并删除 socket；
    // 复用的守护只断开连接。清理必须发生在重置为可重试之前。
    const markFailed = (s: State, message: string) =>
      Effect.gen(function* () {
        s.status = "failed"
        s.progress = 0
        s.phase = undefined
        s.current = undefined
        s.error = message
        s.failureAt = Date.now()
        const client = s.client
        s.client = undefined
        client?.close()
        const child = s.child
        s.child = undefined
        const spawned = s.spawned
        s.spawned = false
        if (spawned && child) yield* Effect.promise(() => Process.stop(child))
        if (spawned && s.socket.dir) yield* Effect.promise(() => fs.unlink(s.socket.path).catch(() => {}))
        yield* publish(s)
      })

    const supervise = (s: State) =>
      Effect.gen(function* () {
        yield* publish(s)
        // 惰性拉起的实际工作全部在收到首个请求后才被 fork 到这里。
        // 复用检查、spawn、等待 socket 可连接都在全局闸门内串行；
        // 一旦可连接即释放闸门，索引继续在后台进行、不占用其他目录的 spawn 名额。
        const client = yield* spawnGate.withPermit(
          Effect.gen(function* () {
            // socket 名按目录稳定：同项目已运行的守护（例如另一个 opencode server 进程先前
            // spawn 的实例）直接复用，不再 spawn。跨进程复用同一守护是可接受行为。
            const existing = yield* Effect.tryPromise({
              try: () => Client.connect(s.socket.path, { connect_timeout_ms: 500 }),
              catch: Protocol.toSemanticError,
            }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (existing) {
              yield* Effect.logInfo("reusing existing daemon", { socket: s.socket.path })
              return existing
            }
            // 连接失败但文件仍在：崩溃/退出残留的陈旧 socket，删除后再 spawn。
            yield* Effect.promise(() => fs.unlink(s.socket.path).catch(() => {}))
            const child = Process.spawn([...s.command, s.directory, s.socket.path], {
              cwd: s.directory,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              env:
                s.idleTimeoutMs === undefined ? undefined : { OPENCODE_SEMANTIC_IDLE_TIMEOUT_MS: String(s.idleTimeoutMs) },
            })
            s.child = child
            s.spawned = true
            return yield* waitForClient(child, s.socket.path)
          }),
        )
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
        yield* Stream.fromQueue(notifications).pipe(
          Stream.runForEach((notification) => Effect.suspend(() => (applyNotification(s, notification) ? publish(s) : Effect.void))),
          Effect.forkIn(s.scope),
          Effect.asVoid,
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
        const child = s.child
        const gone = child
          ? Effect.raceFirst(Effect.promise(() => child.exited), Queue.take(stopped))
          : Queue.take(stopped)
        yield* gone
        if (s.status !== "ready") return
        yield* markFailed(s, "semantic daemon stopped")
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterruptsOnly(cause)) return
            yield* markFailed(s, causeMessage(cause))
          }),
        ),
      )

    // 触发一次拉起：状态在 fork 前同步置为 starting，并发请求只会观察到 starting，
    // 不会重复 spawn。守护工作生命周期绑定实例 scope，随实例 dispose 中断。
    const startSpawn = (s: State) =>
      Effect.gen(function* () {
        s.status = "starting"
        s.progress = 0
        s.phase = undefined
        s.current = undefined
        s.error = undefined
        yield* supervise(s).pipe(Effect.forkIn(s.scope), Effect.asVoid)
      })

    // 惰性拉起入口：每个公开请求方法先经过这里。
    const ensureDaemon = (s: State) =>
      Effect.gen(function* () {
        if (s.status === "ready" && s.client) return
        if (s.status === "disabled") return
        if (s.status === "failed") {
          if (s.failureAt !== undefined && Date.now() - s.failureAt < RetryPolicy.failedCooldownMs) return
          // 冷却结束：failed 不再是终态，重置为 idle 后走正常拉起路径。
          s.status = "idle"
          s.progress = 0
          s.error = undefined
          s.failureAt = undefined
        }
        // starting/indexing 交给已在运行的 supervise 纤维，避免重复拉起。
        if (s.status !== "idle") return
        yield* startSpawn(s)
      })

    const dispatch = <A>(
      s: State,
      name: string,
      call: (client: Client.Client) => Promise<A>,
    ): Effect.Effect<A, Protocol.SemanticError> =>
      Effect.gen(function* () {
        yield* ensureDaemon(s)
        if (s.status === "disabled") {
          return yield* new Protocol.UnavailableError({
            message: `semantic engine is disabled; set \`semantic.enabled\` in the opencode config to use ${name}`,
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
        return yield* Effect.tryPromise({ try: () => call(client), catch: Protocol.toSemanticError })
      })

    const state = yield* InstanceState.make<State>(
      Effect.fn("Semantic.state")(function* (ctx) {
        const scope = yield* Effect.scope
        const semantic = (yield* config.get()).semantic
        const socket = socketPathFor(ctx.directory, semantic?.socket_dir)
        const s: State = {
          directory: ctx.directory,
          command: semantic?.command ?? [],
          socket,
          idleTimeoutMs: semantic?.idle_timeout_ms,
          scope,
          status: "idle",
          progress: 0,
          spawned: false,
        }
        if (semantic?.enabled !== true) {
          s.status = "disabled"
          return s
        }
        if (!semantic.command || semantic.command.length === 0) {
          s.status = "failed"
          s.error = "semantic.command is not configured"
          s.failureAt = Date.now()
          yield* publish(s)
          return s
        }
        if (socket.dir) yield* fsutil.ensureDir(socket.dir).pipe(Effect.orDie)

        // init/status 只物化状态，绝不启动守护——守护改由首个语义请求惰性拉起，
        // 避免恢复大量会话时每个目录并发冷启动一个平台实例。
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            const client = s.client
            s.client = undefined
            const child = s.child
            s.child = undefined
            const spawned = s.spawned
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
        return s
      }),
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
      return yield* dispatch(s, "read_view", (client) => client.readView(input))
    })

    const blastRadius = Effect.fn("Semantic.blastRadius")(function* (input: Protocol.BlastRadiusRequest) {
      const s = yield* InstanceState.get(state)
      return yield* dispatch(s, "blast_radius", (client) => client.blastRadius(input))
    })

    const editBatch = Effect.fn("Semantic.editBatch")(function* (input: Protocol.EditBatchRequest) {
      const s = yield* InstanceState.get(state)
      return yield* dispatch(s, "edit_batch", (client) => client.editBatch(input))
    })

    const editTransaction = Effect.fn("Semantic.editTransaction")(function* (input: Protocol.EditTransactionRequest) {
      const s = yield* InstanceState.get(state)
      return yield* dispatch(s, "edit_transaction", (client) => client.editTransaction(input))
    })

    const projectMap = Effect.fn("Semantic.projectMap")(function* (input: Protocol.ProjectMapRequest) {
      const s = yield* InstanceState.get(state)
      return yield* dispatch(s, "project_map", (client) => client.projectMap(input))
    })

    const verifyTest = Effect.fn("Semantic.verifyTest")(function* (input: Protocol.VerifyTestRequest) {
      const s = yield* InstanceState.get(state)
      return yield* dispatch(s, "verify_test", (client) => client.verifyTest(input))
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
