import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "os"
import path from "path"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as Client from "@/semantic/client"
import { RetryPolicy, Semantic, socketPathFor } from "@/semantic/manager"
import * as Protocol from "@/semantic/protocol"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import {
  disposeAllInstancesEffect,
  provideInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { SAMPLE_RESULT } from "./fixture"

const fakeDaemon = path.join(import.meta.dir, "fake-daemon.ts")
const slowDaemon = path.join(import.meta.dir, "slow-daemon.ts")
const command = (...flags: string[]) => [process.execPath, fakeDaemon, ...flags]

const semanticLayer = () => LayerNode.compile(LayerNode.group([Semantic.node, EventV2Bridge.node]))
const it = testEffect(semanticLayer())

const statusOf = (event: { data: unknown }) => (event.data as { status?: string }).status

// 需要真实 InstanceStore（而非 it.instance 的固定 config 选项）：socket_dir / 预启动守护
// 必须依赖运行期生成的临时目录，因此手动用 tmpdirScoped + provideInstance 搭实例。
const withInstanceStores = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)))

const canConnect = async (socketPath: string) => {
  const client = await Client.connect(socketPath, { connect_timeout_ms: 200 }).catch(() => undefined)
  if (!client) return false
  client.close()
  return true
}

// Windows 下已绑定的 AF_UNIX socket 文件 fs.stat 会 EACCES，用 fs.access 判断存在性。
const exists = (p: string) => fs.access(p).then(() => true, () => false)

const spawnFakeDaemon = (args: string[]) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.spawn([process.execPath, fakeDaemon, ...args], { stdout: "ignore", stderr: "ignore" })),
    (daemon) =>
      Effect.promise(async () => {
        daemon.kill()
        await daemon.exited.catch(() => {})
      }),
  )

const waitForSocket = (socketPath: string) =>
  pollWithTimeout(
    Effect.promise(async () => ((await canConnect(socketPath)) ? true : undefined)),
    `no daemon listening on ${socketPath}`,
    "10 seconds",
  )

const pollReady = (semantic: Semantic.Interface) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const current = yield* semantic.status()
      return current.status === "ready" ? current : undefined
    }),
    "semantic engine never became ready",
    "15 seconds",
  )

// 惰性拉起：首次公开请求会触发后台 spawn，该请求本身立即以 UnavailableError 返回。
const triggerSpawn = (semantic: Semantic.Interface) =>
  semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.catch(() => Effect.void))

const countLines = (file: string) =>
  Effect.promise(() =>
    fs.readFile(file, "utf8").then(
      (text) => text.trim().split("\n").filter(Boolean).length,
      () => 0,
    ),
  )

describe("semantic manager", () => {
  it.instance("reports disabled when semantic is not enabled", () =>
    Effect.gen(function* () {
      const semantic = yield* Semantic.Service
      const status = yield* semantic.status()
      expect(status.status).toBe("disabled")

      const error = yield* semantic.readView({ file: "a.py", view: "entry" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Protocol.UnavailableError)
      expect(error.message).toContain("disabled")
    }),
  )

  it.instance(
    "fails when command is not configured and publishes the failure",
    () =>
      Effect.gen(function* () {
        const semantic = yield* Semantic.Service
        const events = yield* EventV2Bridge.Service
        const failed = yield* Deferred.make<void>()
        const seen: string[] = []
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== "semantic.indexing") return Effect.void
          seen.push(statusOf(event) ?? "")
          if (statusOf(event) === "failed") Deferred.doneUnsafe(failed, Effect.void)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* semantic.init()
        yield* awaitWithTimeout(Deferred.await(failed), "no failed semantic.indexing event")

        const status = yield* semantic.status()
        expect(status.status).toBe("failed")
        expect(status.error).toBe("semantic.command is not configured")
        expect(seen.at(-1)).toBe("failed")
      }),
    { config: { semantic: { enabled: true } } },
    20_000,
  )

  it.live(
    "materializes an idle state on init without spawning the configured command",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const marker = path.join(socketDir, "spawned.marker")
        const dir = yield* tmpdirScoped({
          config: {
            semantic: {
              enabled: true,
              socket_dir: socketDir,
              // 一旦被执行的 command 会写 marker 并退出 3；marker 不存在即证明 init 没有 spawn。
              command: [
                process.execPath,
                "-e",
                `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(3)`,
              ],
            },
          },
        })

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          expect((yield* semantic.status()).status).toBe("idle")
          // 给潜在的错误 spawn 留出真实时间。
          yield* Effect.sleep("500 millis")
          expect(yield* Effect.promise(() => exists(marker))).toBe(false)
          expect((yield* semantic.status()).status).toBe("idle")
        }).pipe(provideInstance(dir))
      }).pipe(withInstanceStores),
    20_000,
  )

  it.instance(
    "first readView lazily spawns the daemon and eventually answers",
    () =>
      Effect.gen(function* () {
        const semantic = yield* Semantic.Service
        const events = yield* EventV2Bridge.Service
        const statuses: string[] = []
        const unsubscribe = yield* events.listen((event) => {
          if (event.type === "semantic.indexing") statuses.push(statusOf(event) ?? "")
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* semantic.init()
        expect((yield* semantic.status()).status).toBe("idle")
        expect(statuses).toEqual([])

        // 首次请求触发惰性拉起：本请求立即返回 starting，warmup 在后台继续。
        const error = yield* semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.flip)
        if (!(error instanceof Protocol.UnavailableError)) throw new Error(`unexpected error: ${String(error)}`)
        expect(error.message).toContain("not ready")

        const status = yield* pollReady(semantic)
        expect(status.progress).toBe(1)
        expect(statuses[0]).toBe("starting")
        expect(statuses).toContain("indexing")
        expect(statuses.at(-1)).toBe("ready")

        const result = yield* semantic.readView({ file: "engine.ts", view: "entry" })
        expect(result).toEqual(SAMPLE_RESULT)
      }),
    { config: { semantic: { enabled: true, command: command("--indexing") } } },
    20_000,
  )

  it.instance(
    "reports progress while indexing after the lazy spawn",
    () =>
      Effect.gen(function* () {
        const semantic = yield* Semantic.Service
        yield* semantic.init()
        yield* triggerSpawn(semantic)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const current = yield* semantic.status()
            return current.status === "indexing" ? current : undefined
          }),
          "semantic engine never reported indexing",
          "15 seconds",
        )

        const error = yield* semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.flip)
        if (!(error instanceof Protocol.UnavailableError)) throw new Error(`unexpected error: ${String(error)}`)
        expect(error.progress).toBe(0.42)
        expect(error.message).toContain("not ready")
      }),
    { config: { semantic: { enabled: true, command: command("--indexing-forever") } } },
    20_000,
  )

  it.instance(
    "marks failed when the daemon exits early",
    () =>
      Effect.gen(function* () {
        const semantic = yield* Semantic.Service
        yield* semantic.init()
        yield* triggerSpawn(semantic)
        const status = yield* pollWithTimeout(
          Effect.gen(function* () {
            const current = yield* semantic.status()
            return current.status === "failed" ? current : undefined
          }),
          "semantic engine never reported failure",
          "15 seconds",
        )
        expect(status.error).toContain("exited with code 3")

        const error = yield* semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Protocol.UnavailableError)
        expect(error.message).toContain("semantic engine failed")
      }),
    { config: { semantic: { enabled: true, command: [process.execPath, "-e", "process.exit(3)"] } } },
    20_000,
  )

  it.live("uses a 180s socket ready timeout for cold daemon starts", () =>
    Effect.sync(() => {
      expect(Protocol.Defaults.socketReadyTimeoutMs).toBe(180_000)
    }),
  )
})

describe("semantic manager socket reuse", () => {
  it.live("uses a stable per-directory socket path", () =>
    Effect.sync(() => {
      const dir = path.join(os.tmpdir(), "opencode-semantic-manager-path")
      const socketDir = path.join(os.tmpdir(), "opencode-semantic-manager-path-sockets")
      const first = socketPathFor(dir, socketDir)
      const name = path.basename(first.path)
      expect(name).toMatch(/^opencode-semantic-[0-9a-f]{10}\.sock$/)
      expect(first.path).toBe(path.join(socketDir, name))
      expect(socketPathFor(dir, socketDir)).toEqual(first)
      expect(path.basename(socketPathFor(dir).path)).toBe(name)
      expect(socketPathFor(dir).dir).toBe(os.tmpdir())
      expect(socketPathFor(path.join(dir, "nested"), socketDir).path).not.toBe(first.path)
      if (process.platform === "win32") {
        expect(socketPathFor(dir.toUpperCase(), socketDir)).toEqual(first)
        expect(socketPathFor(dir.replace(/\\/g, "/"), socketDir)).toEqual(first)
      }
    }),
  )

  it.live(
    "reuses an existing daemon instead of spawning the configured command",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const marker = path.join(socketDir, "spawned.marker")
        const dir = yield* tmpdirScoped({
          config: {
            semantic: {
              enabled: true,
              socket_dir: socketDir,
              // 一旦被执行的 command 会写 marker 并退出 3；marker 不存在即证明复用路径没有 spawn。
              command: [
                process.execPath,
                "-e",
                `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(3)`,
              ],
            },
          },
        })
        const socket = socketPathFor(dir, socketDir)
        const daemon = yield* spawnFakeDaemon([socket.path])
        yield* waitForSocket(socket.path)

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          expect((yield* semantic.status()).status).toBe("idle")
          yield* triggerSpawn(semantic)
          const status = yield* pollReady(semantic)
          expect(status.progress).toBe(1)
          expect(yield* semantic.readView({ file: "engine.ts", view: "entry" })).toEqual(SAMPLE_RESULT)
        }).pipe(provideInstance(dir))

        expect(daemon.exitCode).toBe(null)
        expect(yield* Effect.promise(() => exists(marker))).toBe(false)
      }).pipe(withInstanceStores),
    20_000,
  )

  it.live(
    "removes a stale socket file and spawns a fresh daemon",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, socket_dir: socketDir, command: command() } },
        })
        const socket = socketPathFor(dir, socketDir)
        yield* Effect.promise(() => fs.writeFile(socket.path, "stale"))
        expect(yield* Effect.promise(() => exists(socket.path))).toBe(true)

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          yield* triggerSpawn(semantic)
          yield* pollReady(semantic)
          expect(yield* semantic.readView({ file: "engine.ts", view: "entry" })).toEqual(SAMPLE_RESULT)
        }).pipe(provideInstance(dir))
      }).pipe(withInstanceStores),
    20_000,
  )

  it.live(
    "keeps a reused daemon and its socket alive when the instance is disposed",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const marker = path.join(socketDir, "spawned.marker")
        const dir = yield* tmpdirScoped({
          config: {
            semantic: {
              enabled: true,
              socket_dir: socketDir,
              command: [
                process.execPath,
                "-e",
                `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(3)`,
              ],
            },
          },
        })
        const socket = socketPathFor(dir, socketDir)
        const daemon = yield* spawnFakeDaemon([socket.path])
        yield* waitForSocket(socket.path)

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          yield* triggerSpawn(semantic)
          yield* pollReady(semantic)
          yield* disposeAllInstancesEffect
        }).pipe(provideInstance(dir))

        // dispose 后守护不收到 shutdown、socket 不删：等一段真实时间再确认进程仍存活且可 ping。
        yield* Effect.sleep("300 millis")
        expect(daemon.exitCode).toBe(null)
        expect(yield* Effect.promise(() => exists(socket.path))).toBe(true)
        expect(yield* Effect.promise(() => exists(marker))).toBe(false)
        const client = yield* Effect.promise(() => Client.connect(socket.path, { connect_timeout_ms: 500 }))
        const ping = yield* Effect.promise(() => client.ping())
        expect(ping.indexing).toBe(false)
        client.close()
      }).pipe(withInstanceStores),
    20_000,
  )

  it.live(
    "cleans up a daemon it spawned when the instance is disposed",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const dir = yield* tmpdirScoped({
          config: { semantic: { enabled: true, socket_dir: socketDir, command: command() } },
        })
        const socket = socketPathFor(dir, socketDir)

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          yield* triggerSpawn(semantic)
          yield* pollReady(semantic)
          yield* disposeAllInstancesEffect
        }).pipe(provideInstance(dir))

        yield* pollWithTimeout(
          Effect.promise(async () => ((await canConnect(socket.path)) ? undefined : true)),
          "socket still accepted connections after dispose",
          "10 seconds",
        )
        expect(yield* Effect.promise(() => exists(socket.path))).toBe(false)
      }).pipe(withInstanceStores),
    20_000,
  )
})

describe("semantic manager spawn serialization", () => {
  it.live(
    "serializes daemon cold starts across directories through the global gate",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const markerA = path.join(socketDir, "a.marker")
        const markerB = path.join(socketDir, "b.marker")
        const dirA = yield* tmpdirScoped({
          config: {
            semantic: { enabled: true, socket_dir: socketDir, command: [process.execPath, slowDaemon, markerA] },
          },
        })
        const dirB = yield* tmpdirScoped({
          config: {
            semantic: { enabled: true, socket_dir: socketDir, command: [process.execPath, slowDaemon, markerB] },
          },
        })

        const start = (dir: string) =>
          Effect.gen(function* () {
            const semantic = yield* Semantic.Service
            yield* semantic.init()
            yield* triggerSpawn(semantic)
            yield* pollReady(semantic)
          }).pipe(provideInstance(dir))

        // 两个目录同时请求（各自的首次 readView），但冷启动必须全局串行。
        yield* Effect.all([start(dirA), start(dirB)], { concurrency: "unbounded" })

        const readMarker = (file: string) =>
          Effect.promise(async () => {
            const text = await fs.readFile(file, "utf8")
            return text
              .trim()
              .split("\n")
              .map((line) => {
                const [kind, ts] = line.split(" ")
                return { kind, ts: Number(ts) }
              })
          })
        const a = yield* readMarker(markerA)
        const b = yield* readMarker(markerB)
        expect(a.map((entry) => entry.kind)).toEqual(["start", "end"])
        expect(b.map((entry) => entry.kind)).toEqual(["start", "end"])
        // 单目录区间合法，且两个 [start, end] 区间不允许重叠。
        expect(a[0].ts).toBeLessThan(a[1].ts)
        expect(b[0].ts).toBeLessThan(b[1].ts)
        expect(a[1].ts < b[0].ts || b[1].ts < a[0].ts).toBe(true)
      }).pipe(withInstanceStores),
    30_000,
  )
})

describe("semantic manager failure retry", () => {
  it.live(
    "does not spawn again before the cooldown and retries after it",
    () =>
      Effect.gen(function* () {
        const socketDir = yield* tmpdirScoped()
        const marker = path.join(socketDir, "attempts.log")
        const dir = yield* tmpdirScoped({
          config: {
            semantic: {
              enabled: true,
              socket_dir: socketDir,
              command: [
                process.execPath,
                "-e",
                `require("fs").appendFileSync(${JSON.stringify(marker)}, Date.now() + "\\n"); process.exit(3)`,
              ],
            },
          },
        })

        const previous = RetryPolicy.failedCooldownMs
        RetryPolicy.failedCooldownMs = 1_000
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            RetryPolicy.failedCooldownMs = previous
          }),
        )

        yield* Effect.gen(function* () {
          const semantic = yield* Semantic.Service
          yield* semantic.init()
          yield* triggerSpawn(semantic)
          const failed = yield* pollWithTimeout(
            Effect.gen(function* () {
              const current = yield* semantic.status()
              return current.status === "failed" ? current : undefined
            }),
            "semantic engine never reported failure",
            "15 seconds",
          )
          expect(failed.error).toContain("exited with code 3")
          expect(yield* countLines(marker)).toBe(1)

          // 冷却期内：请求只报告 failed，不重新 spawn。
          const error = yield* semantic.readView({ file: "engine.ts", view: "entry" }).pipe(Effect.flip)
          expect(error).toBeInstanceOf(Protocol.UnavailableError)
          expect(error.message).toContain("semantic engine failed")
          expect(yield* countLines(marker)).toBe(1)

          // 冷却结束后：下一次请求重置为 idle 并重新拉起（再次失败，attempts 增长）。
          yield* Effect.sleep("1200 millis")
          yield* triggerSpawn(semantic)
          yield* pollWithTimeout(
            Effect.gen(function* () {
              return (yield* countLines(marker)) >= 2 ? true : undefined
            }),
            "semantic engine never retried the spawn after the cooldown",
            "15 seconds",
          )
        }).pipe(provideInstance(dir))
      }).pipe(withInstanceStores),
    30_000,
  )
})
